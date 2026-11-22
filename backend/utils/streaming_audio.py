"""Bounded, incremental preview delivery without whole-file mastering.

Preview uses the requested text chunk boundaries, fixed unity gain and a
peak guard. Buffered/export paths retain full-file normalization and effects.
"""

from __future__ import annotations

import asyncio
import math
import struct
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import aclosing
from numbers import Integral

import numpy as np

from ..services.inference_scheduler import check_inference_cancelled, run_serialized_inference
from .audio import protect_audio_peak
from .chunked_tts import concatenate_audio_chunks, generate_chunked, split_text_into_chunks


async def iter_speech_audio(
    backend,
    text: str,
    voice_prompt: dict,
    *,
    language: str = "en",
    seed: int | None = None,
    instruct: str | None = None,
    max_chunk_chars: int = 800,
    crossfade_ms: int = 50,
    trim_fn=None,
    runaway_detector=None,
) -> AsyncIterator[tuple[np.ndarray, int]]:
    """Stream native frames, retaining buffered validation when it needs a whole utterance.

    Codec frames are consecutive samples. Only text-utterance boundaries are
    crossfaded. The caller owns serialized inference for this iterator's lifetime.
    """
    pending = np.empty(0, dtype=np.float32)
    sample_rate = None
    native = getattr(backend, "generate_stream", None)
    use_native = callable(native) and trim_fn is None and runaway_detector is None

    async def utterance_audio(chunk_text, chunk_seed):
        if use_native:
            async with aclosing(native(chunk_text, voice_prompt, language, chunk_seed, instruct)) as stream:
                async for audio, rate in stream:
                    yield audio, rate
        else:
            yield await generate_chunked(
                backend, chunk_text, voice_prompt, language=language,
                seed=chunk_seed, instruct=instruct, max_chunk_chars=max_chunk_chars,
                crossfade_ms=crossfade_ms, trim_fn=trim_fn,
                runaway_detector=runaway_detector,
            )

    for index, chunk_text in enumerate(split_text_into_chunks(text, max_chunk_chars)):
        check_inference_cancelled()
        started = False
        received = False
        head = np.empty(0, dtype=np.float32)
        async with aclosing(utterance_audio(chunk_text, seed + index if seed is not None else None)) as stream:
            async for audio, rate in stream:
                check_inference_cancelled()
                if (not isinstance(rate, Integral) or isinstance(rate, bool) or rate <= 0
                        or (sample_rate is not None and rate != sample_rate)):
                    raise ValueError("The audio sample rate changed or is invalid during incremental generation")
                sample_rate = int(rate)
                audio = np.asarray(audio, dtype=np.float32)
                if audio.ndim != 1:
                    raise ValueError("Incremental preview requires mono audio")
                audio = protect_audio_peak(audio)
                if not audio.size:
                    continue
                received = True
                overlap = int(sample_rate * crossfade_ms / 1000)
                if not started:
                    head = np.concatenate([head, audio]) if head.size else audio
                    if head.size < overlap:
                        continue
                    joined = concatenate_audio_chunks([pending, head], sample_rate, crossfade_ms) if pending.size else head
                    head = np.empty(0, dtype=np.float32)
                    started = True
                else:
                    joined = np.concatenate([pending, audio]) if pending.size else audio
                keep = min(overlap, joined.size)
                if joined.size > keep:
                    yield joined[:-keep] if keep else joined, sample_rate
                pending = joined[-keep:].copy() if keep else np.empty(0, dtype=np.float32)
        if not received:
            raise ValueError("The speech engine returned no audio")
        if not started:
            # An entire short utterance can be smaller than the requested join.
            joined = concatenate_audio_chunks([pending, head], sample_rate, crossfade_ms) if pending.size else head
            # Both the retained tail and this entire utterance fit in one
            # overlap, so their join remains a tail until more speech arrives.
            pending = joined.copy()
    if pending.size and sample_rate is not None:
        yield pending, sample_rate


def streaming_wav_header(sample_rate: int) -> bytes:
    """PCM16 mono RIFF header with unknown-length sentinel sizes.

    EOF terminates the data chunk. No Content-Length is promised, and clients
    that require a seekable finalized WAV should use the buffered endpoint.
    """
    return struct.pack(
        "<4sI4s4sIHHIIHH4sI", b"RIFF", 0xFFFFFFFF, b"WAVE", b"fmt ", 16,
        1, 1, sample_rate, sample_rate * 2, 2, 16, b"data", 0xFFFFFFFF,
    )


def pcm16_bytes(audio: np.ndarray) -> bytes:
    return (protect_audio_peak(audio) * 32767).astype("<i2").tobytes()


async def serialized_byte_stream(
    operation: Callable[[Callable[[bytes], Awaitable[None]]], Awaitable[None]],
    *,
    stall_timeout: float = 30.0,
) -> AsyncIterator[bytes]:
    """Bridge inference to a slow/disconnected client with bounded buffering.

    Closing the iterator cancels its caller task; the inference scheduler
    drains any synchronous engine worker before allowing the next request.
    Cancellation-aware queue writes cannot strand that worker on a full queue.
    """
    if not math.isfinite(stall_timeout) or stall_timeout <= 0:
        raise ValueError("Preview stall timeout must be positive and finite")
    queue: asyncio.Queue[bytes | Exception | None] = asyncio.Queue(maxsize=2)
    consumer_closed = False

    async def send(data: bytes) -> None:
        deadline = asyncio.get_running_loop().time() + stall_timeout
        while True:
            check_inference_cancelled()
            if consumer_closed:
                raise asyncio.CancelledError()
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                raise TimeoutError("Incremental preview client stalled; start a new preview to resume")
            try:
                await asyncio.wait_for(queue.put(data), min(0.1, remaining))
                return
            except TimeoutError:
                continue

    def _deliver_terminal(item: Exception | None) -> None:
        if consumer_closed:
            return
        while queue.full():
            try:
                queue.get_nowait()
            except asyncio.QueueEmpty:
                break
        try:
            queue.put_nowait(item)
        except asyncio.QueueFull:
            pass

    async def drive() -> None:
        try:
            await run_serialized_inference(lambda: operation(send))
        except Exception as error:
            _deliver_terminal(error)
        finally:
            if not consumer_closed and not queue.full():
                queue.put_nowait(None)
            elif not consumer_closed:
                # Preserve any terminal error already queued ahead of None.
                queued_items: list[bytes | Exception | None] = []
                while not queue.empty():
                    try:
                        queued_items.append(queue.get_nowait())
                    except asyncio.QueueEmpty:
                        break
                terminal = next((v for v in queued_items if isinstance(v, Exception)), None)
                if terminal is not None:
                    queue.put_nowait(terminal)
                else:
                    queue.put_nowait(None)

    producer = asyncio.create_task(drive())
    try:
        while True:
            value = await queue.get()
            if value is None:
                return
            if isinstance(value, Exception):
                raise value
            yield value
    finally:
        consumer_closed = True
        if not producer.done():
            producer.cancel()
        await asyncio.gather(producer, return_exceptions=True)
