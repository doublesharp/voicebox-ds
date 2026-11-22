"""MOSS-TTS-Nano ONNX: CPU cloning without changing the Torch/Transformers stack.

Only the upstream low-level ONNX runtime is imported. Its CLI audio reader,
normalizer, default voices, downloads and output-file writes are not used.
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import json
import math
import re
import threading
from collections import OrderedDict
from pathlib import Path

import numpy as np

from ..services.inference_scheduler import check_inference_cancelled, serialized_inference
from ..utils.audio_leveling import match_chunk_loudness
from .base import combine_voice_prompts as _combine_voice_prompts, model_load_progress

TTS_REPO = "OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX"
TTS_REVISION = "f52645cb467506d8e18e746ddd59482685b74e58"
CODEC_REPO = "OpenMOSS-Team/MOSS-Audio-Tokenizer-Nano-ONNX"
CODEC_REVISION = "ceff0d0749bfb3fa2d61149794ec6feef0d1e1ae"
SOURCE_REVISION = "8b7bcc9341b3b4ef3a3a58ba1338a7d85ff133eb"
PREPROCESS_VERSION = "sf-f32-polyphase-48k-stereo-first10s-v1"
LANGUAGES = (
    "zh",
    "en",
    "de",
    "es",
    "fr",
    "ja",
    "it",
    "hu",
    "ko",
    "ru",
    "fa",
    "ar",
    "pl",
    "pt",
    "cs",
    "da",
    "sv",
    "el",
    "tr",
)
TTS_FILES = (
    "browser_poc_manifest.json",
    "tts_browser_onnx_meta.json",
    "tokenizer.model",
    "moss_tts_prefill.onnx",
    "moss_tts_decode_step.onnx",
    "moss_tts_global_shared.data",
    "moss_tts_local_decoder.onnx",
    "moss_tts_local_cached_step.onnx",
    "moss_tts_local_fixed_sampled_frame.onnx",
    "moss_tts_local_shared.data",
)
CODEC_FILES = (
    "codec_browser_onnx_meta.json",
    "moss_audio_tokenizer_encode.onnx",
    "moss_audio_tokenizer_encode.data",
    "moss_audio_tokenizer_decode_full.onnx",
    "moss_audio_tokenizer_decode_step.onnx",
    "moss_audio_tokenizer_decode_shared.data",
)


def _snapshot(repo, revision, files, *, local_only=False):
    from huggingface_hub import snapshot_download

    path = Path(
        snapshot_download(
            repo, revision=revision, allow_patterns=list(files), local_files_only=local_only, max_workers=2
        )
    )
    if not all((path / name).is_file() for name in files):
        raise FileNotFoundError(f"Incomplete pinned checkpoint: {repo}@{revision}")
    return path


def _text_chunks(text, encode, budget=75):
    """Keep sentence boundaries where possible; cap every request by tokenizer size."""
    text = text.strip()
    if not text:
        raise ValueError("Enter text to generate speech")
    if len(text) > 10000:
        raise ValueError("MOSS-TTS accepts at most 10000 characters per generation")
    result = []
    for sentence in re.split(r"(?<=[.!?\u3002\uff01\uff1f])\s+", text):
        remaining = sentence
        while len(encode(remaining)) > budget:
            low, high = 1, len(remaining)
            while low < high:
                middle = (low + high + 1) // 2
                if len(encode(remaining[:middle])) <= budget:
                    low = middle
                else:
                    high = middle - 1
            split = remaining.rfind(" ", 0, low)
            end = split + 1 if split > 0 else low
            if len(encode(remaining[:end])) > budget:
                raise ValueError("Text contains a character exceeding the token budget")
            result.append(remaining[:end])
            remaining = remaining[end:]
        if remaining:
            result.append(remaining)
    return result


def _reference_audio(path):
    import soundfile as sf
    from scipy.signal import resample_poly

    with sf.SoundFile(path) as source:
        sr = source.samplerate
        if not 1 <= source.channels <= 2 or sr <= 0 or not source.frames:
            raise ValueError("MOSS-TTS requires nonempty mono or stereo reference audio")
        # Bound work and encoded state before reading potentially large files.
        audio = source.read(min(source.frames, sr * 10), dtype="float32", always_2d=True)
    if not np.isfinite(audio).all():
        raise ValueError("Reference audio contains nonfinite samples")
    if sr != 48000:
        divisor = math.gcd(sr, 48000)
        audio = resample_poly(audio, 48000 // divisor, sr // divisor, axis=0).astype(np.float32)
    if audio.shape[1] == 1:
        audio = np.repeat(audio, 2, axis=1)
    return np.ascontiguousarray(audio.T[None], dtype=np.float32)


def _load_runtime(tts, codec):
    # A nested subclass keeps optional imports lazy, including the native ORT library.
    import sentencepiece as spm
    from ort_cpu_runtime import OrtCpuRuntime

    class Runtime(OrtCpuRuntime):
        @staticmethod
        def _resolve_manifest_path(model_dir):
            # Resolving HF file symlinks loses adjacent graphs/external data.
            return model_dir / "browser_poc_manifest.json"

        def resolve_manifest_relative_path(self, relative):
            relative = Path(relative)
            if str(relative).replace("\\", "/").startswith("../MOSS-Audio-Tokenizer-Nano-ONNX/"):
                return codec / relative.name
            if relative.is_absolute() or ".." in relative.parts:
                raise ValueError("Unexpected path in pinned MOSS checkpoint manifest")
            return tts / relative

        def encode_reference(self, path):
            audio = _reference_audio(path)
            outputs = self.sessions["codec_encode"].run(
                None, {"waveform": audio, "input_lengths": np.array([audio.shape[-1]], dtype=np.int32)}
            )
            named = dict(zip([o.name for o in self.sessions["codec_encode"].get_outputs()], outputs, strict=True))
            count = int(np.asarray(named["audio_code_lengths"]).reshape(-1)[0])
            return np.asarray(named["audio_codes"][0, :count], dtype=np.int32).copy()

        def encode_text(self, text):
            return self.tokenizer.encode(text, out_type=int)

    runtime = Runtime(tts, thread_count=4, max_new_frames=375, sample_mode="fixed", execution_provider="cpu")
    runtime.tokenizer = spm.SentencePieceProcessor(model_file=str(tts / "tokenizer.model"))
    return runtime


class MossTTSBackend:
    """Bounded CPU prompt state; shared scheduler owns every physical operation."""

    PROMPT_CACHE_LIMIT = 8

    def __init__(self):
        self.model = None
        self.model_size = "default"
        self._state_lock = threading.Lock()
        self._unload_generation = 0
        self._prompt_cache = OrderedDict()

    @property
    def device(self):
        return "cpu"

    def _get_model_path(self, model_size):
        if model_size != "default":
            raise ValueError(f"Unknown MOSS-TTS model size: {model_size}")
        return TTS_REPO

    def _is_model_cached(self, model_size="default"):
        self._get_model_path(model_size)
        try:
            _snapshot(TTS_REPO, TTS_REVISION, TTS_FILES, local_only=True)
            _snapshot(CODEC_REPO, CODEC_REVISION, CODEC_FILES, local_only=True)
            return True
        except (OSError, ValueError):
            return False

    def _model_sync(self):
        with self._state_lock:
            if self.model is not None:
                return self.model
            generation = self._unload_generation
        with model_load_progress("moss-tts", self._is_model_cached()):
            tts = _snapshot(TTS_REPO, TTS_REVISION, TTS_FILES)
            codec = _snapshot(CODEC_REPO, CODEC_REVISION, CODEC_FILES)
            model = _load_runtime(tts, codec)
        with self._state_lock:
            if generation == self._unload_generation:
                self.model = model
        return model

    @serialized_inference
    async def load_model(self, model_size="default"):
        self._get_model_path(model_size)
        await asyncio.to_thread(self._model_sync)

    def is_loaded(self):
        return self.model is not None

    def unload_model(self):
        with self._state_lock:
            self._unload_generation += 1
            self.model = None
            self._prompt_cache.clear()

    def _validate_codes(self, codes):
        codes = np.asarray(codes)
        if (
            codes.ndim != 2
            or codes.shape[1] != 16
            or not 0 < codes.shape[0] <= 512
            or not np.issubdtype(codes.dtype, np.integer)
            or codes.min() < 0
            or codes.max() > 1023
        ):
            raise ValueError("MOSS-TTS requires valid encoded reference audio")
        return np.array(codes, dtype=np.int32, copy=True)

    def _prompt(self, codes):
        return {
            "engine": "moss_tts",
            "model_revision": TTS_REVISION,
            "codec_revision": CODEC_REVISION,
            "preprocess": PREPROCESS_VERSION,
            "audio_codes": self._validate_codes(codes),
        }

    @serialized_inference
    async def create_voice_prompt(self, audio_path, reference_text, use_cache=True):
        if not audio_path:
            raise ValueError("MOSS-TTS requires reference audio for voice cloning")

        def encode():
            digest = hashlib.sha256(
                json.dumps(
                    [TTS_REVISION, CODEC_REVISION, SOURCE_REVISION, PREPROCESS_VERSION, reference_text],
                    ensure_ascii=False,
                ).encode()
            )
            with open(audio_path, "rb") as source:
                payload = source.read(64 * 1024 * 1024 + 1)
            if len(payload) > 64 * 1024 * 1024:
                raise ValueError("MOSS-TTS reference audio must be at most 64 MiB")
            digest.update(payload)
            key = digest.hexdigest()
            with self._state_lock:
                generation = self._unload_generation
                codes = self._prompt_cache.get(key) if use_cache else None
                if codes is not None:
                    self._prompt_cache.move_to_end(key)
                    return self._prompt(codes), True
            model = self._model_sync()
            codes = self._validate_codes(model.encode_reference(io.BytesIO(payload)))
            if use_cache:
                with self._state_lock:
                    if generation == self._unload_generation:
                        self._prompt_cache[key] = codes.copy()
                        while len(self._prompt_cache) > self.PROMPT_CACHE_LIMIT:
                            self._prompt_cache.popitem(last=False)
            return self._prompt(codes), False

        return await asyncio.to_thread(encode)

    async def combine_voice_prompts(self, audio_paths, reference_texts):
        return await _combine_voice_prompts(audio_paths, reference_texts, sample_rate=24000)

    @serialized_inference
    async def generate(self, text, voice_prompt, language="en", seed=None, instruct=None):
        if language not in LANGUAGES:
            raise ValueError(f"MOSS-TTS does not support language: {language}")
        if instruct and instruct.strip():
            raise ValueError("MOSS-TTS does not support style instructions")
        if (
            voice_prompt.get("engine") != "moss_tts"
            or voice_prompt.get("model_revision") != TTS_REVISION
            or voice_prompt.get("codec_revision") != CODEC_REVISION
            or voice_prompt.get("preprocess") != PREPROCESS_VERSION
            or voice_prompt.get("voice_type") not in (None, "cloned")
            or voice_prompt.get("preset_voice_id")
            or voice_prompt.get("design_prompt")
        ):
            raise ValueError("MOSS-TTS requires its own encoded cloned voice prompt")
        codes = self._validate_codes(voice_prompt.get("audio_codes"))

        def synthesize():
            model = self._model_sync()
            model.rng = np.random.default_rng(seed)
            chunks = _text_chunks(text, model.encode_text)
            speech_chunks = []
            for chunk in chunks:
                rows = model.build_voice_clone_request_rows(codes.tolist(), model.encode_text(chunk))
                frames = model.generate_audio_frames(rows, on_frame=lambda *_: check_inference_cancelled())
                if not frames:
                    raise RuntimeError("MOSS-TTS returned no speech frames")
                if len(frames) >= 375:
                    raise ValueError("MOSS-TTS reached its audio limit; shorten the text")
                channels, length = model.decode_full_audio(frames)
                audio = np.asarray(channels, dtype=np.float32).mean(axis=0)
                if audio.ndim != 1 or not len(audio) or not np.isfinite(audio).all():
                    raise RuntimeError("MOSS-TTS returned invalid audio")
                speech_chunks.append(audio)
            matched = match_chunk_loudness(speech_chunks, 48000)
            waveforms = []
            for index, audio in enumerate(matched):
                waveforms.append(audio)
                if index < len(matched) - 1:
                    waveforms.append(np.zeros(11520, dtype=np.float32))
            return np.concatenate(waveforms), 48000

        return await asyncio.to_thread(synthesize)
