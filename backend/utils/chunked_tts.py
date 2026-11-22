"""
Chunked TTS generation utilities.

Splits long text into sentence-boundary chunks, generates audio per-chunk
via any TTSBackend, and concatenates with crossfade.  All logic is
engine-agnostic — it wraps the standard ``TTSBackend.generate()`` interface.

Short text (≤ max_chunk_chars) uses the single-shot fast path with zero
overhead.
"""

from bisect import bisect_right
import inspect
import logging
import re
from numbers import Integral
from typing import List, Tuple

import numpy as np

from ..services.inference_scheduler import check_inference_cancelled
from .audio_leveling import match_chunk_loudness
from .inference import serialized_inference

logger = logging.getLogger("voicebox.chunked-tts")

# Default chunk size in characters.  Can be overridden per-request via
# the ``max_chunk_chars`` field on GenerationRequest.
DEFAULT_MAX_CHUNK_CHARS = 800
MAX_RUNAWAY_RETRIES = 2
MIN_RUNAWAY_RETRY_CHARS = 100

# Common abbreviations that should NOT be treated as sentence endings.
# Lowercase for case-insensitive matching.
_ABBREVIATIONS = frozenset(
    {
        "mr",
        "mrs",
        "ms",
        "dr",
        "prof",
        "sr",
        "jr",
        "st",
        "ave",
        "blvd",
        "inc",
        "ltd",
        "corp",
        "dept",
        "est",
        "approx",
        "vs",
        "etc",
        "e.g",
        "i.e",
        "a.m",
        "p.m",
        "u.s",
        "u.s.a",
        "u.k",
    }
)

# Paralinguistic tags used by Chatterbox Turbo.  The splitter must never
# cut inside one of these.
_PARA_TAG_RE = re.compile(r"\[[^\]]*\]")

# Engine-agnostic inline pause markers, e.g. [pause 400ms] or [pause 0.75s].
_PAUSE_MARKER_RE = re.compile(r"\[\s*pause\s+(\d+(?:\.\d+)?)\s*(ms|s)\s*\]", re.IGNORECASE)
MAX_PAUSE_SECONDS = 10.0


def split_pause_segments(text: str) -> List[Tuple[str, float]]:
    """Split *text* into ordered ``('speech', segment)`` / ``('pause', seconds)`` items.

    When no ``[pause ...]`` marker is present, returns a single speech entry
    so callers can take the standard zero-overhead path.
    """
    if not _PAUSE_MARKER_RE.search(text):
        return [("speech", text)] if text.strip() else []
    segments: List[Tuple[str, float]] = []
    cursor = 0
    for match in _PAUSE_MARKER_RE.finditer(text):
        before = text[cursor : match.start()].strip()
        if before:
            segments.append(("speech", before))
        amount = float(match.group(1))
        unit = match.group(2).lower()
        seconds = amount / 1000.0 if unit == "ms" else amount
        seconds = max(0.01, min(MAX_PAUSE_SECONDS, seconds))
        segments.append(("pause", seconds))
        cursor = match.end()
    after = text[cursor:].strip()
    if after:
        segments.append(("speech", after))
    return segments


def _apply_edge_fades(audio: np.ndarray, sample_rate: int, fade_ms: int = 10) -> np.ndarray:
    """Apply brief cosine edge fades around silence splices to prevent clicks."""
    fade_samples = min(int(sample_rate * fade_ms / 1000), len(audio) // 2)
    if fade_samples <= 0:
        return audio
    out = np.asarray(audio, dtype=np.float32).copy()
    ramp = (0.5 - 0.5 * np.cos(np.linspace(0.0, np.pi, fade_samples, dtype=np.float32)))
    out[:fade_samples] *= ramp
    out[-fade_samples:] *= ramp[::-1]
    return out


def split_text_into_chunks(text: str, max_chars: int = DEFAULT_MAX_CHUNK_CHARS) -> List[str]:
    """Split *text* at natural boundaries into chunks of at most *max_chars*.

    Priority: sentence-end (``.!?`` not preceded by an abbreviation and not
    inside brackets) → clause boundary (``;:,—``) → whitespace → hard cut.

    Paralinguistic tags like ``[laugh]`` are treated as atomic and will not
    be split across chunks.
    """
    if not isinstance(max_chars, Integral) or isinstance(max_chars, bool) or max_chars <= 0:
        raise ValueError("max_chars must be a positive integer")
    max_chars = int(max_chars)
    text = text.strip()
    if not text:
        return []
    if len(text) <= max_chars:
        return [text]

    chunks: List[str] = []
    all_tags = [(m.start(), m.end()) for m in _PARA_TAG_RE.finditer(text)]
    cursor = 0

    while cursor < len(text):
        while cursor < len(text) and text[cursor].isspace():
            cursor += 1
        if cursor >= len(text):
            break
        remaining = text[cursor:]
        if len(remaining) <= max_chars:
            chunks.append(remaining)
            break

        segment = remaining[:max_chars]
        index = bisect_right(all_tags, (cursor, len(text) + 1)) - 1
        if index < 0 or all_tags[index][1] <= cursor:
            index += 1
        tag_ranges = []
        while index < len(all_tags) and all_tags[index][0] < cursor + max_chars:
            start, end = all_tags[index]
            tag_ranges.append((start - cursor, end - cursor))
            index += 1

        # Try to split at the last real sentence ending
        split_pos = _find_last_sentence_end(segment, remaining, tag_ranges)
        if split_pos == -1:
            split_pos = _find_last_clause_boundary(segment, remaining, tag_ranges)
        if split_pos == -1:
            split_pos = next(
                (pos for pos in range(len(segment) - 1, -1, -1)
                 if segment[pos].isspace() and not _inside_bracket_tag(remaining, pos, tag_ranges)),
                -1,
            )
        if split_pos == -1:
            # Inspect the full remaining text: a tag may end beyond this segment.
            split_pos = _safe_hard_cut(remaining, max_chars, tag_ranges)

        chunk = remaining[: split_pos + 1].strip()
        if chunk:
            chunks.append(chunk)
        cursor += split_pos + 1

    return chunks


def _find_last_sentence_end(
    text: str, context: str | None = None, tag_ranges: list[tuple[int, int]] | None = None
) -> int:
    """Return the index of the last sentence-ending punctuation in *text*.

    Skips periods that follow common abbreviations (``Dr.``, ``Mr.``, etc.)
    and periods inside bracket tags (``[laugh]``).  Also handles CJK
    sentence-ending punctuation (``。！？``).
    """
    context = text if context is None else context
    best = -1
    # ASCII sentence ends
    for m in re.finditer(r"[.!?](?:\s|$)", text):
        pos = m.start()
        char = text[pos]
        # A truncated segment is not a sentence boundary if the next character
        # in the original text is not whitespace.
        if pos + 1 == len(text) and len(context) > len(text) and not context[pos + 1].isspace():
            continue
        if char == ".":
            word = re.search(r"([A-Za-z]+(?:\.[A-Za-z]+)*)$", text[:pos])
            if word and word.group(1).lower() in _ABBREVIATIONS:
                continue
        if _inside_bracket_tag(context, pos, tag_ranges):
            continue
        best = pos
    # CJK sentence-ending punctuation
    for m in re.finditer(r"[\u3002\uff01\uff1f]", text):
        if m.start() > best and not _inside_bracket_tag(context, m.start(), tag_ranges):
            best = m.start()
    return best


def _find_last_clause_boundary(
    text: str, context: str | None = None, tag_ranges: list[tuple[int, int]] | None = None
) -> int:
    """Return the index of the last clause-boundary punctuation."""
    context = text if context is None else context
    best = -1
    for m in re.finditer(r"[;:,\u2014](?:\s|$)", text):
        pos = m.start()
        if pos + 1 == len(text) and len(context) > len(text) and not context[pos + 1].isspace():
            continue
        if _inside_bracket_tag(context, pos, tag_ranges):
            continue
        best = pos
    return best


def _inside_bracket_tag(
    text: str, pos: int, tag_ranges: list[tuple[int, int]] | None = None
) -> bool:
    """Return True if *pos* falls inside a complete ``[...]`` tag."""
    if tag_ranges is None:
        tag_ranges = [(m.start(), m.end()) for m in _PARA_TAG_RE.finditer(text)]
    index = bisect_right(tag_ranges, (pos, len(text) + 1)) - 1
    return index >= 0 and tag_ranges[index][0] < pos < tag_ranges[index][1]


def _safe_hard_cut(
    text: str, max_chars: int, tag_ranges: list[tuple[int, int]] | None = None
) -> int:
    """Find a hard-cut position that doesn't split a complete ``[tag]``."""
    cut = max_chars - 1
    if tag_ranges is None:
        tag_ranges = [(m.start(), m.end()) for m in _PARA_TAG_RE.finditer(text)]
    for start, end in tag_ranges:
        if start <= cut < end - 1:
            if start == 0:
                raise ValueError("A speech tag exceeds the maximum chunk size")
            return start - 1
    return cut


def concatenate_audio_chunks(
    chunks: List[np.ndarray],
    sample_rate: int,
    crossfade_ms: int = 50,
) -> np.ndarray:
    """Concatenate audio arrays with a short crossfade to eliminate clicks.

    Each chunk is expected to be a 1-D float32 ndarray at *sample_rate* Hz.
    """
    if not chunks:
        return np.array([], dtype=np.float32)
    if len(chunks) == 1:
        return chunks[0]

    crossfade_samples = max(0, int(sample_rate * crossfade_ms / 1000))
    length = len(chunks[0])
    for chunk in chunks[1:]:
        length += len(chunk) - min(crossfade_samples, length, len(chunk))
    result = np.empty(length, dtype=np.float32)
    cursor = len(chunks[0])
    result[:cursor] = chunks[0]
    fades = {}

    for chunk in chunks[1:]:
        if len(chunk) == 0:
            continue
        overlap = min(crossfade_samples, cursor, len(chunk))
        if overlap > 0:
            if overlap not in fades:
                fades[overlap] = (
                    np.linspace(1.0, 0.0, overlap, dtype=np.float32),
                    np.linspace(0.0, 1.0, overlap, dtype=np.float32),
                )
            fade_out, fade_in = fades[overlap]
            result[cursor - overlap:cursor] = result[cursor - overlap:cursor] * fade_out + chunk[:overlap] * fade_in
        remaining = len(chunk) - overlap
        result[cursor:cursor + remaining] = chunk[overlap:]
        cursor += remaining

    return result


@serialized_inference
async def generate_chunked(backend, text, voice_prompt, language='en', seed=None,
                           instruct=None, max_chunk_chars=DEFAULT_MAX_CHUNK_CHARS,
                           crossfade_ms=50, trim_fn=None, runaway_detector=None,
                           generation_options=None):
    """Serialize TTS across callers, including after caller cancellation.

    The shielded operation owns the slot until its backend coroutine returns;
    cancelling the caller does not imply that native inference has stopped.
    """
    return await _generate_chunked(backend, text, voice_prompt, language, seed,
                                   instruct, max_chunk_chars, crossfade_ms,
                                   trim_fn, runaway_detector, generation_options)


async def _generate_chunked(
    backend,
    text: str,
    voice_prompt: dict,
    language: str = "en",
    seed: int | None = None,
    instruct: str | None = None,
    max_chunk_chars: int = DEFAULT_MAX_CHUNK_CHARS,
    crossfade_ms: int = 50,
    trim_fn=None,
    runaway_detector=None,
    generation_options: dict[str, float] | None = None,
) -> Tuple[np.ndarray, int]:
    """Generate audio with automatic chunking for long text.

    For text shorter than *max_chunk_chars* this is a thin wrapper around
    ``backend.generate()`` with zero overhead.

    For longer text the input is split at natural sentence boundaries,
    each chunk is generated independently, optionally trimmed (useful for
    Chatterbox engines that hallucinate trailing noise), and the results
    are concatenated with a crossfade (or hard cut if *crossfade_ms* is 0).

    Parameters
    ----------
    backend : TTSBackend
        Any backend implementing the ``generate()`` protocol.
    text : str
        Input text (may be arbitrarily long).
    voice_prompt, language, seed, instruct
        Forwarded to ``backend.generate()`` verbatim.
    max_chunk_chars : int
        Maximum characters per chunk (default 800).
    crossfade_ms : int
        Crossfade duration in milliseconds between chunks.  0 for a hard
        cut with no overlap (default 50).
    trim_fn : callable | None
        Optional ``(audio, sample_rate) -> audio`` post-processing
        function applied to each chunk before concatenation (e.g.
        ``trim_tts_output`` for Chatterbox engines). Callbacks accepting a
        ``text`` keyword receive the actual chunk or retry text; existing
        two-argument callbacks are unchanged.
    runaway_detector : callable | None
        Optional ``(audio, sample_rate) -> bool`` detector. When it flags
        unstable output, the affected text is split in half and retried.

    Returns
    -------
    (audio, sample_rate) : Tuple[np.ndarray, int]
    """
    accepts_text = False
    if trim_fn is not None:
        try:
            inspect.signature(trim_fn).bind(None, None, text="")
            accepts_text = True
        except (TypeError, ValueError):
            pass

    def trim_chunk(audio, sample_rate, chunk_text):
        if accepts_text:
            return trim_fn(audio, sample_rate, text=chunk_text)
        return trim_fn(audio, sample_rate)

    async def generate_one(
        chunk_text: str,
        chunk_seed: int | None,
        retry_depth: int = 0,
    ) -> tuple[np.ndarray, int]:
        check_inference_cancelled()
        chunk_audio, chunk_sr = await backend.generate(
            chunk_text,
            voice_prompt,
            language,
            chunk_seed,
            instruct,
            **({"generation_options": generation_options} if generation_options else {}),
        )

        check_inference_cancelled()
        if not isinstance(chunk_sr, Integral) or isinstance(chunk_sr, bool) or chunk_sr <= 0:
            raise ValueError("The audio sample rate is invalid during generation")
        chunk_sr = int(chunk_sr)
        if runaway_detector is not None and runaway_detector(chunk_audio, chunk_sr):
            if retry_depth >= MAX_RUNAWAY_RETRIES or len(chunk_text) <= MIN_RUNAWAY_RETRY_CHARS:
                if trim_fn is not None:
                    # Engines with a trim step (Chatterbox) already cut the
                    # silence-then-noise tail; prefer the trimmed clip over
                    # failing the whole generation when we cannot split further.
                    logger.warning(
                        "Unstable TTS output for %d chars could not be retried further; keeping trimmed output",
                        len(chunk_text),
                    )
                    return np.asarray(trim_chunk(chunk_audio, chunk_sr, chunk_text), dtype=np.float32), chunk_sr
                raise RuntimeError(
                    "TTS output remained unstable after retrying smaller text chunks"
                )

            retry_max_chars = max(MIN_RUNAWAY_RETRY_CHARS, len(chunk_text) // 2)
            retry_chunks = split_text_into_chunks(chunk_text, retry_max_chars)
            if len(retry_chunks) <= 1:
                raise RuntimeError("Unable to split unstable TTS output for retry")

            logger.warning(
                "Detected unstable TTS output for %d chars; retrying as %d smaller chunks",
                len(chunk_text),
                len(retry_chunks),
            )
            retry_audio: list[np.ndarray] = []
            retry_sample_rate = None
            for i, retry_text in enumerate(retry_chunks):
                retry_seed = (
                    chunk_seed + ((retry_depth + 1) * 1000) + i
                    if chunk_seed is not None
                    else None
                )
                audio, sample_rate = await generate_one(
                    retry_text,
                    retry_seed,
                    retry_depth + 1,
                )
                if retry_sample_rate is not None and sample_rate != retry_sample_rate:
                    raise ValueError("The audio sample rate changed during generation")
                retry_sample_rate = sample_rate
                retry_audio.append(np.asarray(audio, dtype=np.float32))

            return (
                concatenate_audio_chunks(
                    match_chunk_loudness(retry_audio, sample_rate),
                    sample_rate,
                    crossfade_ms=crossfade_ms,
                ),
                sample_rate,
            )

        if trim_fn is not None:
            chunk_audio = trim_chunk(chunk_audio, chunk_sr, chunk_text)
        return np.asarray(chunk_audio, dtype=np.float32), chunk_sr

    if _PAUSE_MARKER_RE.search(text):
        parts = split_pause_segments(text)
        timeline: list[tuple[str, float | np.ndarray]] = []
        speech_indices: list[int] = []
        sample_rate: int | None = None
        segment_index = 0
        for kind, value in parts:
            if kind == "pause":
                timeline.append(("pause", float(value)))
                continue
            seg_seed = (seed + segment_index * 100) if seed is not None else None
            segment_index += 1
            seg_audio, seg_sr = await _generate_chunked(
                backend,
                str(value),
                voice_prompt,
                language=language,
                seed=seg_seed,
                instruct=instruct,
                max_chunk_chars=max_chunk_chars,
                crossfade_ms=crossfade_ms,
                trim_fn=trim_fn,
                runaway_detector=runaway_detector,
                generation_options=generation_options,
            )
            if sample_rate is None:
                sample_rate = seg_sr
            elif sample_rate != seg_sr:
                raise ValueError("The audio sample rate changed during generation")
            speech_indices.append(len(timeline))
            timeline.append(("speech", seg_audio))
        if sample_rate is None:
            sample_rate = 24000
        if len(speech_indices) > 1:
            matched_speech = match_chunk_loudness([timeline[idx][1] for idx in speech_indices], sample_rate)
            for idx, matched in zip(speech_indices, matched_speech, strict=True):
                timeline[idx] = ("speech", matched)
        rendered: list[np.ndarray] = [
            np.zeros(round(float(val) * sample_rate), dtype=np.float32)
            if kind == "pause"
            else _apply_edge_fades(val, sample_rate)
            for kind, val in timeline
        ]
        if not rendered:
            return np.zeros(0, dtype=np.float32), sample_rate
        return np.concatenate(rendered).astype(np.float32), sample_rate

    chunks = split_text_into_chunks(text, max_chunk_chars)

    if len(chunks) <= 1:
        # Short text — single-shot fast path
        return await generate_one(text, seed)

    # Long text — chunked generation
    logger.info(
        "Splitting %d chars into %d chunks (max %d chars each)",
        len(text),
        len(chunks),
        max_chunk_chars,
    )
    audio_chunks: List[np.ndarray] = []
    sample_rate: int | None = None

    for i, chunk_text in enumerate(chunks):
        logger.info(
            "Generating chunk %d/%d (%d chars)",
            i + 1,
            len(chunks),
            len(chunk_text),
        )
        # Vary the seed per chunk to avoid correlated RNG artefacts,
        # but keep it deterministic so the same (text, seed) pair
        # always produces the same output.
        chunk_seed = (seed + i) if seed is not None else None

        chunk_audio, chunk_sr = await generate_one(
            chunk_text,
            chunk_seed,
        )

        audio_chunks.append(chunk_audio)
        if sample_rate is None:
            sample_rate = chunk_sr
        elif sample_rate != chunk_sr:
            raise ValueError("The audio sample rate changed during generation")

    audio = concatenate_audio_chunks(
        match_chunk_loudness(audio_chunks, sample_rate),
        sample_rate,
        crossfade_ms=crossfade_ms,
    )
    return audio, sample_rate
