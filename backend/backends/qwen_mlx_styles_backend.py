"""Qwen preset/designed voices on MLX, using mlx-audio 0.4.1's style API.

GPU imports, model loading, sampling and materialization stay on the shared
MLX worker. No weights or GPU runtime are initialized by importing this module.
"""

import asyncio
import threading
from typing import ClassVar

import numpy as np

from ..utils.audio_leveling import match_chunk_loudness
from . import LANGUAGE_CODE_TO_NAME
from .base import combine_voice_prompts as _combine_voice_prompts, empty_mlx_cache, is_model_cached, model_load_progress
from .mlx_backend import _run_on_mlx_thread
from .qwen_assets import QWEN_MLX_REQUIRED_FILES


class _QwenMLXStylesBackend:
    def __init__(self, model_size: str = "1.7B"):
        self._get_model_path(model_size)  # Reject unsupported variants before loading.
        self.model = None
        self.model_size = model_size
        self._current_model_size = None
        self._op_lock = asyncio.Lock()
        self._state_lock = threading.Lock()
        self._unload_generation = 0

    def _get_model_path(self, model_size: str) -> str:
        if model_size not in self.sizes:
            raise ValueError(f"Unknown model size: {model_size}")
        return f"mlx-community/Qwen3-TTS-12Hz-{model_size}-{self.variant}-bf16"

    def _is_model_cached(self, model_size: str | None = None) -> bool:
        return is_model_cached(
            self._get_model_path(model_size or self.model_size),
            required_files=list(QWEN_MLX_REQUIRED_FILES),
        )

    def is_loaded(self) -> bool:
        return self.model is not None

    async def _run_owned(self, operation):
        async with self._op_lock:
            future = _run_on_mlx_thread(operation)
            try:
                return await asyncio.shield(future)
            except asyncio.CancelledError:
                # Cancelling an asyncio Future cannot stop native inference.
                # Keep ownership until the physical worker exits, even if the
                # caller cancels again, and retrieve any worker exception.
                while not future.done():
                    try:
                        await asyncio.shield(future)
                    except asyncio.CancelledError:
                        continue
                    except Exception:
                        break
                if not future.cancelled():
                    future.exception()
                raise

    def _model_for_size_sync(self, size):
        repo = self._get_model_path(size)
        with self._state_lock:
            if self.model is not None and self._current_model_size == size:
                return self.model
        self.unload_model()
        with self._state_lock:
            generation = self._unload_generation
        model = None
        try:
            with model_load_progress(f"{self.progress_prefix}-{size}", self._is_model_cached(size)):
                from mlx_audio.tts import load

                model = load(repo)
                if getattr(getattr(model, "config", None), "tts_model_type", None) != self.model_type:
                    raise RuntimeError(f"The selected checkpoint is not a Qwen {self.variant} model")
                if not callable(getattr(model, self.generation_method, None)):
                    raise RuntimeError(f"Installed mlx-audio does not support {self.generation_method}")
                if getattr(model, "tokenizer", None) is None or getattr(model, "speech_tokenizer", None) is None:
                    raise RuntimeError("The Qwen text/speech tokenizer did not load")
            with self._state_lock:
                # An explicit unload during loading must not be undone by a
                # late load completion. The in-flight caller can still use its
                # local binding; it will drain the pool when that binding dies.
                if generation == self._unload_generation:
                    self.model = model
                    self._current_model_size = size
                    self.model_size = size
            return model
        except Exception:
            del model
            empty_mlx_cache()
            raise

    async def load_model_async(self, model_size: str | None = None) -> None:
        size = self.model_size if model_size is None else model_size
        self._get_model_path(size)

        def load_sync():
            model = self._model_for_size_sync(size)
            del model
            if self.model is None:
                empty_mlx_cache()

        await self._run_owned(load_sync)

    load_model = load_model_async

    def unload_model(self) -> None:
        # Dropping a reference and draining MLX's global allocator are safe
        # inline, matching MLXTTSBackend; never block the API on the worker.
        with self._state_lock:
            self._unload_generation += 1
            loaded = self.model is not None
            self.model = None
            self._current_model_size = None
        if loaded:
            empty_mlx_cache()

    def _validate_prompt(self, prompt):
        if any(prompt.get(key) for key in ("ref_audio", "ref_audio_path", "audio_path")):
            raise ValueError(f"Qwen {self.variant} cannot clone reference audio; select the Qwen Base engine")
        if prompt.get("voice_type") not in (None, self.voice_type):
            raise ValueError(f"Qwen {self.variant} requires a {self.voice_type} voice")
        if prompt.get("preset_engine") not in (None, self.engine):
            raise ValueError("The voice prompt belongs to a different engine")
        incompatible = "design_prompt" if self.voice_type == "preset" else "preset_voice_id"
        if prompt.get(incompatible):
            raise ValueError("The voice prompt belongs to a different voice type")

    async def create_voice_prompt(self, audio_path, reference_text, use_cache=True):
        if audio_path:
            self._validate_prompt({"ref_audio": audio_path})
        return dict(self.default_prompt), False

    async def combine_voice_prompts(self, audio_paths, reference_texts):
        return await _combine_voice_prompts(audio_paths, reference_texts)

    async def generate(self, text, voice_prompt, language="en", seed=None, instruct=None):
        self._validate_prompt(voice_prompt)
        kwargs = self._generation_kwargs(voice_prompt, instruct)
        kwargs.update(text=text, language=LANGUAGE_CODE_TO_NAME.get(language, "auto"))

        def generate_sync():
            model = self._model_for_size_sync(self.model_size)
            try:
                if seed is not None:
                    import mlx.core as mx

                    mx.random.seed(seed)
                chunks = []
                sample_rate = None
                for result in getattr(model, self.generation_method)(**kwargs):
                    rate = int(result.sample_rate)
                    if sample_rate is not None and sample_rate != rate:
                        raise RuntimeError("Qwen returned inconsistent audio sample rates")
                    sample_rate = rate
                    chunks.append(np.asarray(result.audio, dtype=np.float32).reshape(-1))
                if not chunks:
                    raise RuntimeError("Qwen returned no audio")
                return np.concatenate(match_chunk_loudness(chunks, sample_rate)), sample_rate
            finally:
                del model
                if self.model is None:
                    empty_mlx_cache()

        return await self._run_owned(generate_sync)

    async def generate_stream(self, text, voice_prompt, language="en", seed=None, instruct=None):
        """Yield incremental codec audio while holding this adapter's physical owner."""
        from contextlib import aclosing

        from ..utils.native_stream import audio_frame, iter_native_worker

        self._validate_prompt(voice_prompt)
        kwargs = self._generation_kwargs(voice_prompt, instruct)
        kwargs.update(
            text=text,
            language=LANGUAGE_CODE_TO_NAME.get(language, "auto"),
            stream=True,
            streaming_interval=0.32,
        )

        def frames():
            model = self._model_for_size_sync(self.model_size)
            try:
                if seed is not None:
                    import mlx.core as mx

                    mx.random.seed(seed)
                rate = None
                for result in getattr(model, self.generation_method)(**kwargs):
                    frame = audio_frame(result.audio, result.sample_rate)
                    if rate is not None and frame[1] != rate:
                        raise ValueError("Qwen returned inconsistent audio sample rates")
                    rate = frame[1]
                    yield frame
            finally:
                del model
                if self.model is None:
                    empty_mlx_cache()

        async with self._op_lock, aclosing(iter_native_worker(frames, _run_on_mlx_thread)) as stream:
            async for frame in stream:
                yield frame


class QwenMLXCustomVoiceBackend(_QwenMLXStylesBackend):
    engine = "qwen_custom_voice"
    variant = "CustomVoice"
    model_type = "custom_voice"
    voice_type = "preset"
    sizes = ("1.7B", "0.6B")
    progress_prefix = "qwen-custom-voice"
    generation_method = "generate_custom_voice"
    default_prompt: ClassVar[dict] = {"voice_type": "preset", "preset_engine": engine, "preset_voice_id": "Ryan"}

    def _generation_kwargs(self, prompt, instruct):
        kwargs = {"speaker": prompt.get("preset_voice_id") or self.default_prompt["preset_voice_id"]}
        if instruct:
            kwargs["instruct"] = instruct
        return kwargs


class QwenMLXVoiceDesignBackend(_QwenMLXStylesBackend):
    engine = "qwen_voice_design"
    variant = "VoiceDesign"
    model_type = "voice_design"
    voice_type = "designed"
    sizes = ("1.7B",)
    progress_prefix = "qwen-voice-design"
    generation_method = "generate_voice_design"
    default_prompt: ClassVar[dict] = {
        "voice_type": "designed",
        "design_prompt": "A clear, neutral voice with natural pacing.",
    }

    def _generation_kwargs(self, prompt, instruct):
        design = prompt.get("design_prompt") or self.default_prompt["design_prompt"]
        return {"instruct": f"{design.rstrip('. ')}. {instruct}" if instruct else design}
