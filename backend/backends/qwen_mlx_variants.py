"""
Explicit optional MLX Base variants (BF16 remains the default) plus Apple Silicon
MLX backends for Qwen CustomVoice, Qwen VoiceDesign, Chatterbox Turbo, and Kokoro.

Every MLX model load and generation routes through the single dedicated worker
thread in ``mlx_backend._run_on_mlx_thread`` so Metal streams stay pinned to one
OS thread for the lifetime of the process (issues #675, #699).
"""

from __future__ import annotations

QWEN_MLX_QUANTIZED_VARIANTS = {
    "1.7B-8bit": "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-8bit",
    "1.7B-4bit": "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-4bit",
}

QWEN_MLX_QUANTIZED_REVISIONS = {
    "1.7B-8bit": "e7dd0585652209fa0d7783659aad4e8a324de11c",
    "1.7B-4bit": "37e955a1deb861c088ae5f3a67043185f3d1a60c",
}
QWEN_MLX_REQUIRED_FILES = (
    "config.json",
    "generation_config.json",
    "merges.txt",
    "vocab.json",
    "tokenizer_config.json",
    "preprocessor_config.json",
    "model.safetensors",
    "model.safetensors.index.json",
    "speech_tokenizer/config.json",
    "speech_tokenizer/configuration.json",
    "speech_tokenizer/model.safetensors",
    "speech_tokenizer/preprocessor_config.json",
)

import asyncio
import inspect
import logging
from pathlib import Path
from typing import ClassVar, List, Optional, Tuple

import numpy as np

from . import CHATTERBOX_MLX_S3_TOKENIZER_REPO, LANGUAGE_CODE_TO_NAME
from .base import (
    combine_voice_prompts as _combine_voice_prompts,
    empty_mlx_cache,
    is_model_cached,
    model_load_progress,
)
from .kokoro_backend import KOKORO_DEFAULT_VOICE, KOKORO_SAMPLE_RATE, LANG_CODE_MAP
from .mlx_backend import _run_on_mlx_thread
from .qwen_custom_voice_backend import QWEN_CV_DEFAULT_SPEAKER
from .qwen_voice_design_backend import QWEN_VD_DEFAULT_DESIGN

logger = logging.getLogger(__name__)

# ── HuggingFace MLX repositories ─────────────────────────────────────────

QWEN_CV_MLX_REPOS: dict[str, str] = {
    "1.7B": "mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-bf16",
    "0.6B": "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-bf16",
}

QWEN_VD_MLX_REPOS: dict[str, str] = {
    "1.7B": "mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-bf16",
}

CHATTERBOX_TURBO_MLX_HF_REPO = "mlx-community/chatterbox-turbo-fp16"
KOKORO_MLX_HF_REPO = "mlx-community/Kokoro-82M-bf16"

_MLX_WEIGHT_EXTS = (".safetensors", ".bin", ".npz")
_S3_TOKENIZER_FILES = ["model.safetensors", "config.json"]


def _collect_mlx_audio(results, default_sr: int = 24000) -> Tuple[np.ndarray, int]:
    """Consume an mlx-audio generator (or single result) into a float32 waveform."""
    chunks: list[np.ndarray] = []
    sample_rate = default_sr
    if hasattr(results, "audio"):
        results = [results]
    for result in results:
        audio = getattr(result, "audio", result)
        if audio is None:
            continue
        arr = np.asarray(audio, dtype=np.float32).squeeze()
        if arr.size:
            chunks.append(arr)
        sr = getattr(result, "sample_rate", None)
        if sr:
            sample_rate = int(sr)
    if not chunks:
        return np.zeros(0, dtype=np.float32), int(sample_rate)
    return np.concatenate(chunks).astype(np.float32), int(sample_rate)


def _filtered_kwargs(fn, candidates: dict) -> dict:
    """Keep only keyword arguments accepted by ``fn`` (unless it takes **kwargs)."""
    try:
        sig = inspect.signature(fn)
    except (TypeError, ValueError):
        return {k: v for k, v in candidates.items() if v is not None}
    accepts_var_kw = any(p.kind == inspect.Parameter.VAR_KEYWORD for p in sig.parameters.values())
    if accepts_var_kw:
        return {k: v for k, v in candidates.items() if v is not None}
    return {k: v for k, v in candidates.items() if v is not None and k in sig.parameters}


class QwenCustomVoiceMLXBackend:
    """Qwen3-TTS CustomVoice on Apple Silicon via MLX/Metal."""

    def __init__(self, model_size: str = "1.7B"):
        self.model = None
        self.model_size = model_size
        self._current_model_size: Optional[str] = None
        self._op_lock = asyncio.Lock()

    def is_loaded(self) -> bool:
        return self.model is not None

    def _get_model_path(self, model_size: str) -> str:
        if model_size not in QWEN_CV_MLX_REPOS:
            raise ValueError(f"Unknown model size: {model_size}")
        return QWEN_CV_MLX_REPOS[model_size]

    def _is_model_cached(self, model_size: Optional[str] = None) -> bool:
        size = model_size or self.model_size
        return is_model_cached(self._get_model_path(size), weight_extensions=_MLX_WEIGHT_EXTS)

    async def load_model_async(self, model_size: Optional[str] = None) -> None:
        if model_size is None:
            model_size = self.model_size
        if self.model is not None and self._current_model_size == model_size:
            return
        async with self._op_lock:
            if self.model is not None and self._current_model_size == model_size:
                return
            await _run_on_mlx_thread(self._reload_sync, model_size)

    load_model = load_model_async

    def _reload_sync(self, model_size: str) -> None:
        if self.model is not None and self._current_model_size != model_size:
            self._unload_model_sync()
        self._load_model_sync(model_size)

    def _load_model_sync(self, model_size: str) -> None:
        model_path = self._get_model_path(model_size)
        model_name = f"qwen-custom-voice-{model_size}"
        is_cached = self._is_model_cached(model_size)
        with model_load_progress(model_name, is_cached):
            from mlx_audio.tts import load

            logger.info("Loading Qwen CustomVoice %s on MLX (Metal)...", model_size)
            self.model = load(model_path)
        self._current_model_size = model_size
        self.model_size = model_size
        logger.info("Qwen CustomVoice %s (MLX) loaded successfully", model_size)

    def unload_model(self) -> None:
        self._unload_model_sync()

    def _unload_model_sync(self) -> None:
        if self.model is not None:
            del self.model
            self.model = None
            self._current_model_size = None
            empty_mlx_cache()
            logger.info("Qwen CustomVoice (MLX) unloaded")

    async def create_voice_prompt(
        self,
        audio_path: str,
        reference_text: str,
        use_cache: bool = True,
    ) -> Tuple[dict, bool]:
        return {
            "voice_type": "preset",
            "preset_engine": "qwen_custom_voice",
            "preset_voice_id": QWEN_CV_DEFAULT_SPEAKER,
        }, False

    async def combine_voice_prompts(
        self,
        audio_paths: List[str],
        reference_texts: List[str],
    ) -> Tuple[np.ndarray, str]:
        return await _combine_voice_prompts(audio_paths, reference_texts)

    async def generate(
        self,
        text: str,
        voice_prompt: dict,
        language: str = "en",
        seed: Optional[int] = None,
        instruct: Optional[str] = None,
    ) -> Tuple[np.ndarray, int]:
        speaker = voice_prompt.get("preset_voice_id") or QWEN_CV_DEFAULT_SPEAKER

        def _reload_and_generate_sync() -> Tuple[np.ndarray, int]:
            if self.model is None or self._current_model_size != self.model_size:
                self._reload_sync(self.model_size)
            model = self.model
            try:
                if seed is not None:
                    import mlx.core as mx

                    np.random.seed(seed)
                    mx.random.seed(seed)

                lang_name = LANGUAGE_CODE_TO_NAME.get(language, "auto")
                lang_arg = lang_name.capitalize() if lang_name != "auto" else "Auto"
                if hasattr(model, "generate_custom_voice"):
                    fn = model.generate_custom_voice
                    kwargs = _filtered_kwargs(
                        fn,
                        {
                            "text": text,
                            "speaker": speaker,
                            "voice": speaker,
                            "language": lang_arg,
                            "lang_code": lang_name,
                            "instruct": instruct or None,
                            "verbose": False,
                        },
                    )
                    return _collect_mlx_audio(fn(**kwargs), default_sr=getattr(model, "sample_rate", 24000))

                fn = model.generate
                kwargs = _filtered_kwargs(
                    fn,
                    {
                        "voice": speaker,
                        "speaker": speaker,
                        "instruct": instruct or None,
                        "lang_code": lang_name,
                        "language": lang_arg,
                        "verbose": False,
                    },
                )
                return _collect_mlx_audio(fn(text, **kwargs), default_sr=getattr(model, "sample_rate", 24000))
            finally:
                del model
                if self.model is None:
                    empty_mlx_cache()

        async with self._op_lock:
            return await _run_on_mlx_thread(_reload_and_generate_sync)


class QwenVoiceDesignMLXBackend:
    """Qwen3-TTS VoiceDesign on Apple Silicon via MLX/Metal."""

    def __init__(self, model_size: str = "1.7B"):
        self.model = None
        self.model_size = model_size
        self._current_model_size: Optional[str] = None
        self._op_lock = asyncio.Lock()

    def is_loaded(self) -> bool:
        return self.model is not None

    def _get_model_path(self, model_size: str = "1.7B") -> str:
        if model_size not in QWEN_VD_MLX_REPOS:
            raise ValueError(f"Unknown model size: {model_size}")
        return QWEN_VD_MLX_REPOS[model_size]

    def _is_model_cached(self, model_size: Optional[str] = None) -> bool:
        size = model_size or self.model_size
        return is_model_cached(self._get_model_path(size), weight_extensions=_MLX_WEIGHT_EXTS)

    async def load_model_async(self, model_size: Optional[str] = None) -> None:
        if model_size is None:
            model_size = self.model_size
        if self.model is not None and self._current_model_size == model_size:
            return
        async with self._op_lock:
            if self.model is not None and self._current_model_size == model_size:
                return
            await _run_on_mlx_thread(self._reload_sync, model_size)

    load_model = load_model_async

    def _reload_sync(self, model_size: str) -> None:
        if self.model is not None and self._current_model_size != model_size:
            self._unload_model_sync()
        self._load_model_sync(model_size)

    def _load_model_sync(self, model_size: str) -> None:
        model_path = self._get_model_path(model_size)
        model_name = f"qwen-voice-design-{model_size}"
        is_cached = self._is_model_cached(model_size)
        with model_load_progress(model_name, is_cached):
            from mlx_audio.tts import load

            logger.info("Loading Qwen VoiceDesign %s on MLX (Metal)...", model_size)
            self.model = load(model_path)
        self._current_model_size = model_size
        self.model_size = model_size
        logger.info("Qwen VoiceDesign %s (MLX) loaded successfully", model_size)

    def unload_model(self) -> None:
        self._unload_model_sync()

    def _unload_model_sync(self) -> None:
        if self.model is not None:
            del self.model
            self.model = None
            self._current_model_size = None
            empty_mlx_cache()
            logger.info("Qwen VoiceDesign (MLX) unloaded")

    async def create_voice_prompt(
        self,
        audio_path: str,
        reference_text: str,
        use_cache: bool = True,
    ) -> Tuple[dict, bool]:
        return {
            "voice_type": "designed",
            "design_prompt": QWEN_VD_DEFAULT_DESIGN,
        }, False

    async def combine_voice_prompts(
        self,
        audio_paths: List[str],
        reference_texts: List[str],
    ) -> Tuple[np.ndarray, str]:
        return await _combine_voice_prompts(audio_paths, reference_texts)

    async def generate(
        self,
        text: str,
        voice_prompt: dict,
        language: str = "en",
        seed: Optional[int] = None,
        instruct: Optional[str] = None,
    ) -> Tuple[np.ndarray, int]:
        design_prompt = voice_prompt.get("design_prompt") or QWEN_VD_DEFAULT_DESIGN
        combined_instruct = (
            f"{design_prompt.rstrip('. ')}. {instruct}" if instruct else design_prompt
        )

        def _reload_and_generate_sync() -> Tuple[np.ndarray, int]:
            if self.model is None or self._current_model_size != self.model_size:
                self._reload_sync(self.model_size)
            model = self.model
            try:
                if seed is not None:
                    import mlx.core as mx

                    np.random.seed(seed)
                    mx.random.seed(seed)

                lang_name = LANGUAGE_CODE_TO_NAME.get(language, "auto")
                lang_arg = lang_name.capitalize() if lang_name != "auto" else "Auto"
                if hasattr(model, "generate_voice_design"):
                    fn = model.generate_voice_design
                    kwargs = _filtered_kwargs(
                        fn,
                        {
                            "text": text,
                            "instruct": combined_instruct,
                            "language": lang_arg,
                            "lang_code": lang_name,
                            "verbose": False,
                        },
                    )
                    return _collect_mlx_audio(fn(**kwargs), default_sr=getattr(model, "sample_rate", 24000))

                fn = model.generate
                kwargs = _filtered_kwargs(
                    fn,
                    {
                        "instruct": combined_instruct,
                        "lang_code": lang_name,
                        "language": lang_arg,
                        "verbose": False,
                    },
                )
                return _collect_mlx_audio(fn(text, **kwargs), default_sr=getattr(model, "sample_rate", 24000))
            finally:
                del model
                if self.model is None:
                    empty_mlx_cache()

        async with self._op_lock:
            return await _run_on_mlx_thread(_reload_and_generate_sync)


class ChatterboxTurboMLXTTSBackend:
    """Chatterbox Turbo TTS on Apple Silicon via MLX/Metal."""

    _DEFAULTS: ClassVar[dict] = {
        "temperature": 0.8,
        "top_k": 1000,
        "top_p": 0.95,
        "repetition_penalty": 1.2,
    }

    def __init__(self):
        self.model = None
        self.model_size = "default"
        self._op_lock = asyncio.Lock()

    def is_loaded(self) -> bool:
        return self.model is not None

    def _get_model_path(self, model_size: str = "default") -> str:
        return CHATTERBOX_TURBO_MLX_HF_REPO

    def _is_model_cached(self, model_size: str = "default") -> bool:
        model_cached = is_model_cached(CHATTERBOX_TURBO_MLX_HF_REPO, weight_extensions=_MLX_WEIGHT_EXTS)
        tokenizer_cached = is_model_cached(CHATTERBOX_MLX_S3_TOKENIZER_REPO, required_files=_S3_TOKENIZER_FILES)
        return model_cached and tokenizer_cached

    async def load_model(self, model_size: str = "default") -> None:
        if self.model is not None:
            return
        async with self._op_lock:
            if self.model is not None:
                return
            await _run_on_mlx_thread(self._load_model_sync)

    def _load_model_sync(self) -> None:
        is_cached = self._is_model_cached()
        with model_load_progress("chatterbox-turbo", is_cached):
            from mlx_audio.tts import load

            logger.info("Loading Chatterbox Turbo TTS on MLX (Metal)...")
            self.model = load(CHATTERBOX_TURBO_MLX_HF_REPO)
        logger.info("Chatterbox Turbo TTS (MLX) loaded successfully")

    def unload_model(self) -> None:
        if self.model is not None:
            del self.model
            self.model = None
            empty_mlx_cache()
            logger.info("Chatterbox Turbo (MLX) unloaded")

    async def create_voice_prompt(
        self,
        audio_path: str,
        reference_text: str,
        use_cache: bool = True,
    ) -> Tuple[dict, bool]:
        return {"ref_audio": str(audio_path), "ref_text": reference_text}, False

    async def combine_voice_prompts(
        self,
        audio_paths: List[str],
        reference_texts: List[str],
    ) -> Tuple[np.ndarray, str]:
        return await _combine_voice_prompts(audio_paths, reference_texts)

    async def generate(
        self,
        text: str,
        voice_prompt: dict,
        language: str = "en",
        seed: Optional[int] = None,
        instruct: Optional[str] = None,
        *,
        generation_options: dict[str, float] | None = None,
    ) -> Tuple[np.ndarray, int]:
        ref_audio = voice_prompt.get("ref_audio")
        if ref_audio and not Path(ref_audio).exists():
            logger.warning("Reference audio not found: %s", ref_audio)
            ref_audio = None
        sampling = {**self._DEFAULTS, **(generation_options or {})}

        def _generate_sync() -> Tuple[np.ndarray, int]:
            if self.model is None:
                self._load_model_sync()
            model = self.model
            try:
                if seed is not None:
                    import mlx.core as mx

                    np.random.seed(seed)
                    mx.random.seed(seed)

                kwargs = _filtered_kwargs(
                    model.generate,
                    {
                        "ref_audio": ref_audio,
                        "verbose": False,
                        **sampling,
                    },
                )
                default_sr = getattr(model, "sr", None) or getattr(model, "sample_rate", 24000)
                return _collect_mlx_audio(model.generate(text, **kwargs), default_sr=int(default_sr))
            finally:
                del model
                if self.model is None:
                    empty_mlx_cache()

        async with self._op_lock:
            return await _run_on_mlx_thread(_generate_sync)


class KokoroMLXTTSBackend:
    """Kokoro-82M on Apple Silicon via MLX/Metal."""

    def __init__(self):
        self.model = None
        self.model_size = "default"
        self._op_lock = asyncio.Lock()

    def is_loaded(self) -> bool:
        return self.model is not None

    def _get_model_path(self, model_size: str = "default") -> str:
        return KOKORO_MLX_HF_REPO

    def _is_model_cached(self, model_size: str = "default") -> bool:
        return is_model_cached(KOKORO_MLX_HF_REPO, weight_extensions=_MLX_WEIGHT_EXTS)

    async def load_model(self, model_size: str = "default") -> None:
        if self.model is not None:
            return
        async with self._op_lock:
            if self.model is not None:
                return
            await _run_on_mlx_thread(self._load_model_sync)

    def _load_model_sync(self) -> None:
        is_cached = self._is_model_cached()
        with model_load_progress("kokoro", is_cached):
            from mlx_audio.tts import load

            logger.info("Loading Kokoro-82M on MLX (Metal)...")
            self.model = load(KOKORO_MLX_HF_REPO)
        logger.info("Kokoro-82M (MLX) loaded successfully")

    def unload_model(self) -> None:
        if self.model is not None:
            del self.model
            self.model = None
            empty_mlx_cache()
            logger.info("Kokoro (MLX) unloaded")

    async def create_voice_prompt(
        self,
        audio_path: str,
        reference_text: str,
        use_cache: bool = True,
    ) -> Tuple[dict, bool]:
        return {
            "voice_type": "preset",
            "preset_engine": "kokoro",
            "preset_voice_id": KOKORO_DEFAULT_VOICE,
        }, False

    async def combine_voice_prompts(
        self,
        audio_paths: List[str],
        reference_texts: List[str],
    ) -> Tuple[np.ndarray, str]:
        return await _combine_voice_prompts(audio_paths, reference_texts, sample_rate=KOKORO_SAMPLE_RATE)

    async def generate(
        self,
        text: str,
        voice_prompt: dict,
        language: str = "en",
        seed: Optional[int] = None,
        instruct: Optional[str] = None,
    ) -> Tuple[np.ndarray, int]:
        voice_name = (
            voice_prompt.get("preset_voice_id")
            or voice_prompt.get("kokoro_voice")
            or KOKORO_DEFAULT_VOICE
        )
        pipeline_language = "en-gb" if language == "en" and voice_name.startswith(("bf_", "bm_")) else language
        kokoro_lang = "b" if pipeline_language == "en-gb" else LANG_CODE_MAP.get(pipeline_language, "a")

        def _generate_sync() -> Tuple[np.ndarray, int]:
            if self.model is None:
                self._load_model_sync()
            model = self.model
            try:
                if seed is not None:
                    import mlx.core as mx

                    np.random.seed(seed)
                    mx.random.seed(seed)

                kwargs = _filtered_kwargs(
                    model.generate,
                    {
                        "voice": voice_name,
                        "lang_code": kokoro_lang,
                        "speed": 1.0,
                        "verbose": False,
                    },
                )
                audio, sr = _collect_mlx_audio(model.generate(text, **kwargs), default_sr=KOKORO_SAMPLE_RATE)
                if audio.size == 0:
                    return np.zeros(KOKORO_SAMPLE_RATE, dtype=np.float32), KOKORO_SAMPLE_RATE
                from ..utils.audio import trim_tts_output

                audio = trim_tts_output(audio, sample_rate=sr, max_internal_silence_ms=None)
                return audio, sr
            finally:
                del model
                if self.model is None:
                    empty_mlx_cache()

        async with self._op_lock:
            return await _run_on_mlx_thread(_generate_sync)
