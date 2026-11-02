"""
PyTorch backend implementation for TTS and STT.
"""

from typing import Optional, List, Tuple
import asyncio
import logging
import torch
import numpy as np

logger = logging.getLogger(__name__)

WHISPER_SAMPLE_RATE = 16000
# Whisper encodes one 30s window per pass; longer audio needs sequential long-form decoding.
WHISPER_WINDOW_SAMPLES = 30 * WHISPER_SAMPLE_RATE

from . import TTSBackend, STTBackend, LANGUAGE_CODE_TO_NAME, WHISPER_HF_REPOS
from .base import (
    is_model_cached,
    get_torch_device,
    empty_device_cache,
    manual_seed,
    combine_voice_prompts as _combine_voice_prompts,
    model_load_progress,
)
from .qwen_cuda_variants import QWEN_CUDA_GRAPH_REQUIRED_FILES, QWEN_CUDA_GRAPH_VARIANTS, CudaGraphRuntimeError
from ..utils.cache import get_cache_key, get_cached_voice_prompt, cache_voice_prompt
from ..utils.audio import load_audio
from ..utils.async_work import run_blocking

STOCK_RUNTIME_IDENTITY = {"runtime": "stock"}
NO_GENERATION = {"steps": None, "hit_eos": None, "max_new_tokens": None}


def _serialize_qwen_voice_prompt(items: list) -> dict:
    """Keep the disk cache compatible with torch.load(weights_only=True).

    Qwen returns dataclass instances rather than a dict. CPU tensors avoid
    retaining device buffers in the process-lifetime prompt cache.
    """
    return {
        "format": "qwen-voice-clone-v2",
        "items": [
            {
                "ref_code": item.ref_code.detach().cpu() if item.ref_code is not None else None,
                "ref_spk_embedding": item.ref_spk_embedding.detach().cpu(),
                "x_vector_only_mode": item.x_vector_only_mode,
                "icl_mode": item.icl_mode,
                "ref_text": item.ref_text,
            }
            for item in items
        ],
    }


def _restore_qwen_voice_prompt(payload, device):
    if not isinstance(payload, dict) or payload.get("format") != "qwen-voice-clone-v2":
        return None
    items = payload.get("items")
    if not isinstance(items, list) or not items:
        return None
    for item in items:
        if not isinstance(item, dict):
            return None
        if not {"ref_code", "ref_spk_embedding", "x_vector_only_mode", "icl_mode", "ref_text"}.issubset(item):
            return None
        if not isinstance(item.get("ref_spk_embedding"), torch.Tensor):
            return None
        if item.get("ref_code") is not None and not isinstance(item["ref_code"], torch.Tensor):
            return None
        if not isinstance(item.get("x_vector_only_mode"), bool) or not isinstance(item.get("icl_mode"), bool):
            return None
        if item.get("ref_text") is not None and not isinstance(item["ref_text"], str):
            return None

    from qwen_tts.inference.qwen3_tts_model import VoiceClonePromptItem

    return [
        VoiceClonePromptItem(
            ref_code=item["ref_code"].to(device) if item["ref_code"] is not None else None,
            ref_spk_embedding=item["ref_spk_embedding"].to(device),
            x_vector_only_mode=item["x_vector_only_mode"],
            icl_mode=item["icl_mode"],
            ref_text=item["ref_text"],
        )
        for item in items
    ]


class PyTorchTTSBackend:
    """PyTorch-based TTS backend using Qwen3-TTS."""

    def __init__(self, model_size: str = "1.7B"):
        self.model = None
        self.model_size = model_size
        self.device = self._get_device()
        self._current_model_size = None
        self._graphs = None
        self.last_generation = dict(NO_GENERATION)

    def _get_device(self) -> str:
        """Get the best available device."""
        return get_torch_device(allow_xpu=True, allow_directml=True)

    def is_loaded(self) -> bool:
        """Check if model is loaded."""
        return self.model is not None

    @property
    def runtime_identity(self) -> dict:
        """The runtime that actually renders: captured graphs or the stock decode loop."""
        return self._graphs.identity if self._graphs is not None else dict(STOCK_RUNTIME_IDENTITY)

    def _get_model_path(self, model_size: str) -> str:
        """
        Get the HuggingFace Hub model ID.

        Args:
            model_size: Model size (1.7B or 0.6B)

        Returns:
            HuggingFace Hub model ID
        """
        hf_model_map = {
            "1.7B": "Qwen/Qwen3-TTS-12Hz-1.7B-Base",
            "0.6B": "Qwen/Qwen3-TTS-12Hz-0.6B-Base",
        }
        variant = QWEN_CUDA_GRAPH_VARIANTS.get(model_size)
        if variant is not None:
            return variant.hf_repo_id

        if model_size not in hf_model_map:
            raise ValueError(f"Unknown model size: {model_size}")

        return hf_model_map[model_size]

    def _is_model_cached(self, model_size: str) -> bool:
        variant = QWEN_CUDA_GRAPH_VARIANTS.get(model_size)
        if variant is not None:
            return is_model_cached(
                variant.hf_repo_id, revision=variant.revision, required_files=list(QWEN_CUDA_GRAPH_REQUIRED_FILES)
            )
        return is_model_cached(self._get_model_path(model_size))

    async def load_model_async(self, model_size: Optional[str] = None):
        """
        Lazy load the TTS model with automatic downloading from HuggingFace Hub.

        Args:
            model_size: Model size to load (1.7B or 0.6B)
        """
        if model_size is None:
            model_size = self.model_size

        # If already loaded with correct size, return
        if self.model is not None and self._current_model_size == model_size:
            return

        # Unload existing model if different size requested
        if self.model is not None and self._current_model_size != model_size:
            self.unload_model()

        if model_size in QWEN_CUDA_GRAPH_VARIANTS:
            # Graph capture and every later replay share one thread.
            from .qwen_cudagraph import run_on_graph_thread

            await run_on_graph_thread(self._load_model_sync, model_size)
            return

        # Run blocking load in thread pool
        await asyncio.to_thread(self._load_model_sync, model_size)

    # Alias for compatibility
    load_model = load_model_async

    def _load_model_sync(self, model_size: str):
        """Synchronous model loading."""
        model_name = f"qwen-tts-{model_size}"
        is_cached = self._is_model_cached(model_size)
        variant = QWEN_CUDA_GRAPH_VARIANTS.get(model_size)
        if variant is not None:
            from .qwen_cudagraph import CudaGraphSession, require_cuda_device

            require_cuda_device(self.device)

        with model_load_progress(model_name, is_cached):
            from qwen_tts import Qwen3TTSModel

            model_path = self._get_model_path(model_size)
            logger.info("Loading TTS model %s on %s...", model_size, self.device)

            # Route both HF Hub and Transformers through a single cache root.
            # On Windows local setups, model assets can otherwise split between
            # .hf-cache/hub and .hf-cache/transformers, causing speech_tokenizer
            # and preprocessor_config.json to fail to resolve during load.
            from huggingface_hub import constants as hf_constants
            tts_cache_dir = hf_constants.HF_HUB_CACHE

            if self.device == "cpu":
                self.model = Qwen3TTSModel.from_pretrained(
                    model_path,
                    cache_dir=tts_cache_dir,
                    torch_dtype=torch.float32,
                    low_cpu_mem_usage=False,
                )
            elif variant is not None:
                self.model = Qwen3TTSModel.from_pretrained(
                    model_path,
                    cache_dir=tts_cache_dir,
                    revision=variant.revision,
                    device_map=self.device,
                    torch_dtype=torch.bfloat16,
                    attn_implementation="sdpa",
                )
            else:
                self.model = Qwen3TTSModel.from_pretrained(
                    model_path,
                    cache_dir=tts_cache_dir,
                    device_map=self.device,
                    torch_dtype=torch.bfloat16,
                )

        if variant is not None:
            try:
                self._graphs = CudaGraphSession.capture(self.model, self.device)
            except BaseException:
                self.model = None
                empty_device_cache(self.device)
                raise

        self._current_model_size = model_size
        self.model_size = model_size
        logger.info("TTS model %s loaded successfully", model_size)

    def unload_model(self):
        """Unload the model to free memory."""
        if self.model is not None:
            if self._graphs is not None:
                self._graphs.close()
                self._graphs = None
            del self.model
            self.model = None
            self._current_model_size = None

            empty_device_cache(self.device)

            logger.info("TTS model unloaded")

    async def create_voice_prompt(
        self,
        audio_path: str,
        reference_text: str,
        use_cache: bool = True,
    ) -> tuple[list, bool]:
        """
        Create voice prompt from reference audio.

        Args:
            audio_path: Path to reference audio file
            reference_text: Transcript of reference audio
            use_cache: Whether to use cached prompt if available

        Returns:
            Tuple of (VoiceClonePromptItem list, was_cached)
        """
        await self.load_model_async(None)

        namespace = f"qwen:pytorch:{self._current_model_size or self.model_size}:voice-clone-v2"

        def _create_prompt_sync():
            """Run synchronous voice prompt creation in thread pool."""
            cache_key = get_cache_key(audio_path, reference_text, namespace=namespace) if use_cache else None
            if cache_key is not None:
                cached = _restore_qwen_voice_prompt(get_cached_voice_prompt(cache_key), self.device)
                if cached is not None:
                    return cached, True
            # Inference runs with the process's default HF_HUB_OFFLINE
            # state. Forcing offline here (issue #462) regressed online
            # users whose libraries issue legitimate metadata lookups
            # during voice-prompt creation.
            items = self.model.create_voice_clone_prompt(
                ref_audio=str(audio_path),
                ref_text=reference_text,
                x_vector_only_mode=False,
            )
            if cache_key is not None:
                cache_voice_prompt(cache_key, _serialize_qwen_voice_prompt(items))
            return items, False

        # Hashing, serialization, device transfers and encoding all stay off
        # the API event loop, including the warm disk-cache path.
        return await asyncio.to_thread(_create_prompt_sync)

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
        """
        Generate audio from text using voice prompt.

        Args:
            text: Text to synthesize
            voice_prompt: Voice prompt dictionary from create_voice_prompt
            language: Language code (en or zh)
            seed: Random seed for reproducibility
            instruct: Natural language instruction for speech delivery control

        Returns:
            Tuple of (audio_array, sample_rate)
        """
        # Load model
        await self.load_model_async(None)
        language_name = LANGUAGE_CODE_TO_NAME.get(language, "auto")

        if self._graphs is not None:
            from .qwen_cudagraph import run_on_graph_thread

            # Stock Base ignores instruct, so the graphs never receive it.
            return await run_on_graph_thread(self._generate_graphs_sync, text, voice_prompt, language_name, seed)

        def _generate_sync():
            """Run synchronous generation in thread pool."""
            # Set seed if provided
            if seed is not None:
                manual_seed(seed, self.device)

            # See _create_prompt_sync comment — inference runs with the
            # process's default HF_HUB_OFFLINE state (issue #462).
            with torch.inference_mode():
                wavs, sample_rate = self.model.generate_voice_clone(
                    text=text,
                    voice_clone_prompt=voice_prompt,
                    language=language_name,
                    instruct=instruct,
                )
            defaults = getattr(self.model, "generate_defaults", None)
            self.last_generation = {
                **NO_GENERATION,
                "max_new_tokens": defaults.get("max_new_tokens") if isinstance(defaults, dict) else None,
            }
            return wavs[0], sample_rate

        # Run blocking inference in thread pool to avoid blocking event loop
        audio, sample_rate = await asyncio.to_thread(_generate_sync)

        return audio, sample_rate

    def _generate_graphs_sync(self, text, voice_prompt, language_name, seed):
        graphs = self._graphs
        if seed is not None:
            manual_seed(seed, self.device)
        try:
            return graphs.generate(text, voice_prompt, language_name)
        finally:
            self.last_generation = dict(graphs.last_outcome or NO_GENERATION)


class PyTorchSTTBackend:
    """PyTorch-based STT backend using Whisper."""

    def __init__(self, model_size: str = "base"):
        self.model = None
        self.processor = None
        self.model_size = model_size
        self.device = self._get_device()
        self._op_lock = asyncio.Lock()

    def _get_device(self) -> str:
        """Get the best available device."""
        return get_torch_device(allow_xpu=True, allow_directml=True)

    def is_loaded(self) -> bool:
        """Check if model is loaded."""
        return self.model is not None

    def _is_model_cached(self, model_size: str) -> bool:
        hf_repo = WHISPER_HF_REPOS.get(model_size, f"openai/whisper-{model_size}")
        return is_model_cached(hf_repo)

    async def load_model_async(self, model_size: Optional[str] = None):
        """
        Lazy load the Whisper model.

        Args:
            model_size: Model size (tiny, base, small, medium, large)
        """
        async with self._op_lock:
            await self._load_model_owned(model_size)

    async def _load_model_owned(self, model_size: Optional[str]):
        if model_size is None:
            model_size = self.model_size
        if self.model is not None and self.model_size == model_size:
            return
        await run_blocking(self._load_model_sync, model_size)

    # Alias for compatibility
    load_model = load_model_async

    def _load_model_sync(self, model_size: str):
        """Synchronous model loading."""
        progress_model_name = f"whisper-{model_size}"
        is_cached = self._is_model_cached(model_size)

        with model_load_progress(progress_model_name, is_cached):
            from transformers import WhisperProcessor, WhisperForConditionalGeneration

            model_name = WHISPER_HF_REPOS.get(model_size, f"openai/whisper-{model_size}")
            logger.info("Loading Whisper model %s on %s...", model_size, self.device)

            processor = None
            model = None
            try:
                processor = WhisperProcessor.from_pretrained(model_name)
                model = WhisperForConditionalGeneration.from_pretrained(model_name)
                model.to(self.device)
            except BaseException:
                processor = None
                model = None
                empty_device_cache(self.device)
                raise

        self.processor = processor
        self.model = model
        self.model_size = model_size
        logger.info("Whisper model %s loaded successfully", model_size)

    def unload_model(self):
        """Unload the model to free memory."""
        if self.model is not None:
            del self.model
            del self.processor
            self.model = None
            self.processor = None

            empty_device_cache(self.device)

            logger.info("Whisper model unloaded")

    async def transcribe(
        self,
        audio_path: str,
        language: Optional[str] = None,
        model_size: Optional[str] = None,
    ) -> str:
        async with self._op_lock:
            return await self._transcribe_owned(audio_path, language, model_size)

    async def _transcribe_owned(
        self,
        audio_path: str,
        language: Optional[str],
        model_size: Optional[str],
    ) -> str:
        """
        Transcribe audio to text.

        Args:
            audio_path: Path to audio file
            language: Optional language hint
            model_size: Optional model size override

        Returns:
            Transcribed text
        """
        await self._load_model_owned(model_size)

        def _transcribe_sync():
            """Run synchronous transcription in thread pool."""
            # Load audio
            audio, _sr = load_audio(audio_path, sample_rate=WHISPER_SAMPLE_RATE)

            # Inference runs with the process's default HF_HUB_OFFLINE
            # state — forcing offline here (issue #462) broke online users
            # whose `get_decoder_prompt_ids` / tokenizer calls issue
            # legitimate metadata lookups.
            # Process audio.
            # truncation=False + padding="longest" + return_attention_mask=True
            # are required for long-form transcription. Without them the
            # feature extractor silently truncates to 30s (Whisper's native
            # window) and audio past that point is dropped.
            #
            # Only use them for audio longer than one 30s window. For shorter
            # clips the default pad-to-30s path is needed: with
            # padding="longest" the encoder rejects the shorter mel input
            # ("expects the mel input features to be of length 3000") when
            # generate() runs language detection, i.e. whenever no language
            # is forced.
            is_long_form = len(audio) > WHISPER_WINDOW_SAMPLES
            processor_kwargs = (
                {"truncation": False, "padding": "longest", "return_attention_mask": True}
                if is_long_form
                else {}
            )
            inputs = self.processor(
                audio,
                sampling_rate=WHISPER_SAMPLE_RATE,
                return_tensors="pt",
                **processor_kwargs,
            )
            inputs = inputs.to(self.device)

            # Generate transcription.
            # If language is provided, force it; otherwise let Whisper
            # auto-detect. Pass language/task directly to generate() instead
            # of building forced_decoder_ids — get_decoder_prompt_ids defaults
            # to no_timestamps=True, which injects <|notimestamps|> and
            # disables the timestamp tokens that return_timestamps=True (and
            # therefore long-form decoding) depend on.
            generate_kwargs = {}
            if language:
                generate_kwargs["language"] = language
                generate_kwargs["task"] = "transcribe"
            if is_long_form:
                generate_kwargs["attention_mask"] = inputs["attention_mask"]
                generate_kwargs["return_timestamps"] = True

            with torch.no_grad():
                predicted_ids = self.model.generate(
                    inputs["input_features"],
                    **generate_kwargs,
                )

            # Decode
            transcription = self.processor.batch_decode(
                predicted_ids,
                skip_special_tokens=True,
            )[0]

            return transcription.strip()

        # Run blocking transcription in thread pool
        return await run_blocking(_transcribe_sync)
