"""
MLX backend implementation for TTS and STT using mlx-audio.
"""

from typing import Optional, Tuple
import asyncio
import logging
import numpy as np
from pathlib import Path
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor

logger = logging.getLogger(__name__)

# MLX's Metal backend keeps a per-thread stream registry. Loading a model on
# one worker thread (via asyncio.to_thread, which round-robins across the
# default executor's pool) and then generating on a different worker thread
# raises "There is no Stream(gpu, N) in current thread." All MLX calls in
# this module must therefore run on the SAME OS thread for the process
# lifetime — route them through this single-worker executor instead of
# asyncio.to_thread's shared multi-worker pool.
_mlx_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="mlx-worker")


def _run_on_mlx_thread(func, *args):
    loop = asyncio.get_running_loop()
    return loop.run_in_executor(_mlx_executor, func, *args)

# PATCH: Import and apply offline patch BEFORE any huggingface_hub usage
# This prevents mlx_audio from making network requests when models are cached
from ..utils.hf_offline_patch import patch_huggingface_hub_offline, ensure_original_qwen_config_cached  # noqa: E402

patch_huggingface_hub_offline()
ensure_original_qwen_config_cached()

from . import LANGUAGE_CODE_TO_NAME, WHISPER_HF_REPOS  # noqa: E402
from .base import (  # noqa: E402
    is_model_cached,
    combine_voice_prompts as _combine_voice_prompts,
    model_load_progress,
    empty_mlx_cache,
)
from ..utils.cache import get_cache_key, get_cached_voice_prompt, cache_voice_prompt  # noqa: E402
from ..utils.mlx_reference_cache import MLXReferenceCache  # noqa: E402
from ..utils.async_work import run_owned  # noqa: E402


class VoiceCloningError(RuntimeError):
    """The selected voice could not be used; no replacement voice was rendered."""


class MLXTTSBackend:
    """MLX-based TTS backend using mlx-audio."""

    def __init__(self, model_size: str = "1.7B"):
        self.model = None
        self.model_size = model_size
        self._current_model_size = None
        self._reference_cache = MLXReferenceCache()
        # Guards the whole load-then-use sequence in generate()/create_voice_prompt()
        # so a concurrent request for a different model_size can't swap self.model
        # out from under an in-flight request between its load and its inference.
        self._op_lock = asyncio.Lock()
        # Bounded in-memory cache of decoded reference waveforms / encoded voice
        # prompts keyed by (model_size, path, mtime_ns, size, ref_text) so long
        # scripts and multi-take batches don't re-read & resample ref_audio on
        # every chunk. Cleared on unload_model().
        self._ref_audio_cache: OrderedDict[tuple, object] = OrderedDict()
        self._max_ref_cache_entries = 16

    def is_loaded(self) -> bool:
        """Check if model is loaded."""
        return self.model is not None

    def _get_model_path(self, model_size: str) -> str:
        """
        Get the MLX model path.

        Args:
            model_size: Model size (1.7B or 0.6B)

        Returns:
            HuggingFace Hub model ID for MLX
        """
        mlx_model_map = {
            "1.7B": "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16",
            "0.6B": "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16",
        }

        from .qwen_mlx_variants import QWEN_MLX_QUANTIZED_VARIANTS

        mlx_model_map.update(QWEN_MLX_QUANTIZED_VARIANTS)
        if model_size not in mlx_model_map:
            raise ValueError(f"Unknown model size: {model_size}")

        hf_model_id = mlx_model_map[model_size]
        logger.info("Will download MLX model from HuggingFace Hub: %s", hf_model_id)

        return hf_model_id

    def _is_model_cached(self, model_size: str) -> bool:
        from .qwen_mlx_variants import QWEN_MLX_QUANTIZED_REVISIONS, QWEN_MLX_REQUIRED_FILES

        if model_size in QWEN_MLX_QUANTIZED_REVISIONS:
            return is_model_cached(self._get_model_path(model_size), revision=QWEN_MLX_QUANTIZED_REVISIONS[model_size], required_files=list(QWEN_MLX_REQUIRED_FILES))
        return is_model_cached(
            self._get_model_path(model_size),
            weight_extensions=(".safetensors", ".bin", ".npz"),
        )

    async def load_model_async(self, model_size: Optional[str] = None):
        """
        Lazy load the MLX TTS model.

        Args:
            model_size: Model size to load (1.7B or 0.6B)
        """
        if model_size is None:
            model_size = self.model_size

        # If already loaded with correct size, return
        if self.model is not None and self._current_model_size == model_size:
            return

        # Unload (if needed) and load as ONE callable on the MLX worker thread.
        # Doing this as two separate _run_on_mlx_thread calls would run the
        # unload on whichever thread issues the second call — usually still
        # correct, but a caller-side await gap between them would let another
        # coroutine slip a conflicting load in between. One callable removes
        # the gap.
        await _run_on_mlx_thread(self._reload_sync, model_size)

    # Alias for compatibility
    load_model = load_model_async

    def _reload_sync(self, model_size: str):
        """Unload a mismatched model and load the requested one, in one MLX-thread op."""
        if self.model is not None and self._current_model_size != model_size:
            self._unload_model_sync()
        self._load_model_sync(model_size)

    def _load_model_sync(self, model_size: str):
        """Synchronous model loading."""
        self._reference_cache.clear()
        model_path = self._get_model_path(model_size)
        model_name = f"qwen-tts-{model_size}"
        is_cached = self._is_model_cached(model_size)

        with model_load_progress(model_name, is_cached):
            from mlx_audio.tts import load

            logger.info("Loading MLX TTS model %s...", model_size)
            from .qwen_mlx_variants import QWEN_MLX_QUANTIZED_REVISIONS, QWEN_MLX_REQUIRED_FILES
            if model_size in QWEN_MLX_QUANTIZED_REVISIONS:
                from huggingface_hub import snapshot_download

                model_path = snapshot_download(model_path, revision=QWEN_MLX_QUANTIZED_REVISIONS[model_size], allow_patterns=list(QWEN_MLX_REQUIRED_FILES), max_workers=2)
            self.model = load(model_path)

        self._reference_cache.bind(self.model)

        self._current_model_size = model_size
        self.model_size = model_size
        logger.info("MLX TTS model %s loaded successfully", model_size)

    def unload_model(self):
        """Unload the model to free memory.

        Runs inline on the calling thread rather than on the MLX worker:
        dropping the Python reference is thread-safe (MLX frees buffers
        through its global allocator, no stream needed), and routing it
        through the single worker would block the caller — usually the
        FastAPI event loop, via /models/unload — until any in-flight
        generation on that worker finishes. A generation still running bound
        the model to a local before it started, so it completes normally and
        the next generate() reloads via _reload_and_generate_sync.
        """
        self._unload_model_sync()

    def _unload_model_sync(self):
        # Invalidate even if an in-flight worker still holds the old model.
        # Its epoch cannot publish encoded reference state after this point.
        self._reference_cache.clear()
        if hasattr(self, "_ref_audio_cache"):
            self._ref_audio_cache.clear()
        if self.model is not None:
            del self.model
            self.model = None
            self._current_model_size = None
            empty_mlx_cache()
            logger.info("MLX TTS model unloaded")

    def _resolve_cached_ref_audio(self, model, ref_audio: str, ref_text: str):
        """Return a cached decoded mx.array reference waveform when supported.

        Avoids re-reading and resampling the reference WAV from disk on every
        chunk/take of a long narration script. Falls back to the file path if
        the loaded model or runtime cannot consume an array directly.
        """
        path = Path(ref_audio)
        try:
            stat = path.stat()
        except OSError:
            return ref_audio
        target_sr = int(getattr(model, "sample_rate", 24000) or 24000)
        cache_key = (self._current_model_size or self.model_size, str(path), stat.st_mtime_ns, stat.st_size, target_sr)
        if cache_key in self._ref_audio_cache:
            self._ref_audio_cache.move_to_end(cache_key)
            return self._ref_audio_cache[cache_key]
        try:
            import mlx.core as mx
            from ..utils.audio import load_audio

            samples, _ = load_audio(str(path), sample_rate=target_sr, mono=True)
            cached = mx.array(np.asarray(samples, dtype=np.float32))
        except Exception:
            return ref_audio
        self._ref_audio_cache[cache_key] = cached
        while len(self._ref_audio_cache) > self._max_ref_cache_entries:
            self._ref_audio_cache.popitem(last=False)
        return cached

    async def create_voice_prompt(
        self,
        audio_path: str,
        reference_text: str,
        use_cache: bool = True,
    ) -> Tuple[dict, bool]:
        """
        Create voice prompt from reference audio.

        Metadata is cached here; bounded codec reuse happens on the MLX worker
        during generation, keyed by the actual normalized encoder input.

        Args:
            audio_path: Path to reference audio file
            reference_text: Transcript of reference audio
            use_cache: Whether to use cached prompt if available

        Returns:
            Tuple of (voice_prompt_dict, was_cached)
        """
        async with self._op_lock:
            await self.load_model_async(None)

        namespace = f"qwen:mlx:{self._current_model_size or self.model_size}:reference-v2"

        def _reference_prompt():
            if not Path(audio_path).is_file():
                raise VoiceCloningError("Voice reference audio is missing. Re-add the sample before generating speech.")
            # This metadata cache must always use the caller's current
            # path even when identical content was cached from another path.
            prompt = {"ref_audio": str(audio_path), "ref_text": reference_text}
            if not use_cache:
                prompt["_mlx_reference_cache"] = False
            cache_key = get_cache_key(audio_path, reference_text, namespace=namespace) if use_cache else None
            cached = get_cached_voice_prompt(cache_key) if cache_key is not None else None
            was_cached = isinstance(cached, dict) and cached.get("ref_text") == reference_text
            if cache_key is not None and (not was_cached or cached.get("ref_audio") != str(audio_path)):
                cache_voice_prompt(cache_key, prompt)
            return prompt, was_cached

        return await asyncio.to_thread(_reference_prompt)

    async def combine_voice_prompts(self, audio_paths, reference_texts):
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
            voice_prompt: Voice prompt dictionary with ref_audio and ref_text
            language: Language code (en or zh) - may not be fully supported by MLX
            seed: Random seed for reproducibility
            instruct: Natural language instruction (may not be supported by MLX)

        Returns:
            Tuple of (audio_array, sample_rate)
        """
        logger.info("Generating audio for text: %s", text)

        def _generate_sync():
            """Run synchronous generation in thread pool."""
            # Bind the model once so an inline unload_model() from another
            # thread mid-generation cannot turn a later self.model read into
            # None (the fallback path below runs seconds into a request).
            model = self.model
            try:
                # MLX generate() returns a generator yielding GenerationResult objects
                audio_chunks = []
                sample_rate = 24000
                lang = LANGUAGE_CODE_TO_NAME.get(language, "auto")

                # Set seed if provided (MLX uses numpy random)
                if seed is not None:
                    import mlx.core as mx

                    np.random.seed(seed)
                    mx.random.seed(seed)

                # Extract voice prompt info
                ref_audio = voice_prompt.get("ref_audio") or voice_prompt.get("ref_audio_path")
                ref_text = voice_prompt.get("ref_text", "")

                # Validate that the audio file exists
                if ref_audio and not Path(ref_audio).is_file():
                    raise VoiceCloningError(
                        "Voice reference audio is missing. Re-add the sample before generating speech."
                    )

                # Inference runs with the process's default HF_HUB_OFFLINE
                # state. Forcing offline here (previously used to avoid lazy
                # mlx_audio lookups hanging when the network drops mid-inference,
                # issue #462) regressed online users because libraries make
                # legitimate metadata calls during generation.
                try:
                    if ref_audio:
                        # Check if generate accepts ref_audio parameter
                        import inspect

                        sig = inspect.signature(model.generate)
                        accepts_reference = "ref_audio" in sig.parameters or any(
                            parameter.kind == inspect.Parameter.VAR_KEYWORD for parameter in sig.parameters.values()
                        )
                        if accepts_reference:
                            # Generate with voice cloning
                            with self._reference_cache.encoding(
                                model, enabled=voice_prompt.get("_mlx_reference_cache", True)
                            ):
                                for result in model.generate(text, ref_audio=ref_audio, ref_text=ref_text, lang_code=lang):
                                    audio_chunks.append(np.array(result.audio))
                                    sample_rate = result.sample_rate
                        else:
                            raise VoiceCloningError(
                                "This model does not support voice references. Select a voice-cloning model."
                            )
                    else:
                        # No voice prompt, generate normally
                        for result in model.generate(text, lang_code=lang):
                            audio_chunks.append(np.array(result.audio))
                            sample_rate = result.sample_rate
                except Exception as e:
                    if ref_audio and not isinstance(e, VoiceCloningError):
                        raise VoiceCloningError(
                            f"Voice cloning failed; no replacement voice was generated: {e}"
                        ) from e
                    raise

                # Concatenate all chunks
                if audio_chunks:
                    audio = np.concatenate([np.asarray(chunk, dtype=np.float32) for chunk in audio_chunks])
                else:
                    # Fallback: empty audio
                    audio = np.array([], dtype=np.float32)

                return audio, sample_rate
            finally:
                # Drop the local binding here, inside the frame a propagating
                # traceback would keep alive, so the caller's drain can
                # actually return the model's buffers to MLX.
                del model

        def _reload_and_generate_sync():
            """Ensure the configured model is loaded, then generate — as ONE
            MLX-worker submission. Two separate submissions (load, then
            generate) leave a gap after the load future resolves and before
            the generate future is submitted; an unload_model() call from
            another thread could land in that gap and tear down the model
            this call is about to use. Folding both into one callable closes
            the gap: the executor's own FIFO ordering is the only guarantee
            this needs, and the reload check here is self-healing even if an
            unload happened to run just before this callable started.
            """
            if self.model is None or self._current_model_size != self.model_size:
                self._reload_sync(self.model_size)
            try:
                return _generate_sync()
            finally:
                # An unload_model() that landed while we were generating only
                # dropped the backend's reference; the model's buffers were
                # kept alive by _generate_sync's local, which that function
                # drops in its own finally (so a propagating traceback cannot
                # pin it), and have just been returned to MLX's pool. Drain it
                # now, or they stay resident until the next load/unload cycle.
                if self.model is None:
                    empty_mlx_cache()

        async with self._op_lock:
            try:
                audio, sample_rate = await _run_on_mlx_thread(_reload_and_generate_sync)
            except asyncio.CancelledError:
                # The executor cannot interrupt MLX. Invalidate its pending
                # publication while it finishes on the dedicated worker.
                self._reference_cache.clear(keep_model=True)
                raise

        return audio, sample_rate


    async def generate_stream(self, text, voice_prompt, language="en", seed=None, instruct=None):
        """Yield model-native audio; callers needing full-output checks use generate()."""
        from contextlib import aclosing

        from ..utils.native_stream import audio_frame, iter_native_worker

        def frames():
            if self.model is None or self._current_model_size != self.model_size:
                self._reload_sync(self.model_size)
            model = self.model
            reference = voice_prompt.get("ref_audio") or voice_prompt.get("ref_audio_path")
            try:
                if reference and not Path(reference).is_file():
                    raise VoiceCloningError("Voice reference audio is missing. Re-add the sample before generating speech.")
                if seed is not None:
                    import mlx.core as mx

                    np.random.seed(seed)
                    mx.random.seed(seed)
                kwargs = dict(lang_code=LANGUAGE_CODE_TO_NAME.get(language, "auto"), stream=True, streaming_interval=0.32)
                if reference:
                    kwargs.update(ref_audio=reference, ref_text=voice_prompt.get("ref_text", ""))
                rate = None
                try:
                    with self._reference_cache.encoding(
                        model, enabled=bool(reference) and voice_prompt.get("_mlx_reference_cache", True)
                    ):
                        for result in model.generate(text, **kwargs):
                            frame = audio_frame(result.audio, result.sample_rate)
                            if rate is not None and frame[1] != rate:
                                raise ValueError("Qwen returned inconsistent audio sample rates")
                            rate = frame[1]
                            yield frame
                except Exception as error:
                    if reference and not isinstance(error, VoiceCloningError):
                        raise VoiceCloningError(f"Voice cloning failed; no replacement voice was generated: {error}") from error
                    raise
            finally:
                del model
                if self.model is None:
                    empty_mlx_cache()

        async with self._op_lock, aclosing(iter_native_worker(frames, _run_on_mlx_thread)) as stream:
            async for frame in stream:
                yield frame


class MLXSTTBackend:
    """MLX-based STT backend using mlx-audio Whisper."""

    def __init__(self, model_size: str = "base"):
        self.model = None
        self.model_size = model_size
        self._recognition_revision = None
        self._load_epoch = 0
        # See MLXTTSBackend._op_lock — same reason.
        self._op_lock = asyncio.Lock()

    def is_loaded(self) -> bool:
        """Check if model is loaded."""
        return self.model is not None

    def _is_model_cached(self, model_size: str) -> bool:
        hf_repo = WHISPER_HF_REPOS.get(model_size, f"openai/whisper-{model_size}")
        return is_model_cached(hf_repo, weight_extensions=(".safetensors", ".bin", ".npz"))

    async def load_model_async(self, model_size: Optional[str] = None):
        """
        Lazy load the MLX Whisper model.

        Args:
            model_size: Model size (tiny, base, small, medium, large)
        """
        if model_size is None:
            model_size = self.model_size

        async with self._op_lock:
            if self.model is not None and self.model_size == model_size:
                return
            await run_owned(_run_on_mlx_thread(self._load_model_sync, model_size))

    # Alias for compatibility
    load_model = load_model_async

    def _load_model_sync(self, model_size: str):
        """Synchronous model loading."""
        progress_model_name = f"whisper-{model_size}"
        is_cached = self._is_model_cached(model_size)

        with model_load_progress(progress_model_name, is_cached):
            from mlx_audio.stt import load

            model_name = WHISPER_HF_REPOS.get(model_size, f"openai/whisper-{model_size}")
            logger.info("Loading MLX Whisper model %s...", model_size)

            self.model = load(model_name)
            self._recognition_revision = None

        self.model_size = model_size
        logger.info("MLX Whisper model %s loaded successfully", model_size)

    def unload_model(self):
        """Unload the model to free memory (inline; see MLXTTSBackend.unload_model)."""
        self._unload_model_sync()

    def _unload_model_sync(self):
        self._load_epoch += 1
        self._recognition_revision = None
        if self.model is not None:
            del self.model
            self.model = None
            empty_mlx_cache()
            logger.info("MLX Whisper model unloaded")

    async def transcribe(
        self,
        audio_path: str,
        language: Optional[str] = None,
        model_size: Optional[str] = None,
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
        resolved_size = model_size if model_size is not None else self.model_size

        def _transcribe_sync():
            """Run synchronous transcription in thread pool."""
            # MLX Whisper transcription using generate method
            # The generate method accepts audio path directly
            model = self.model
            try:
                decode_options = {}
                if language:
                    decode_options["language"] = language

                # Inference runs with the process's default HF_HUB_OFFLINE
                # state — see the comment in MLXTTSBackend.generate for the
                # regression this revert fixes (issue #462).
                result = model.generate(str(audio_path), **decode_options)

                # Extract text from result
                if isinstance(result, str):
                    return result.strip()
                elif isinstance(result, dict):
                    return result.get("text", "").strip()
                elif hasattr(result, "text"):
                    return result.text.strip()
                else:
                    return str(result).strip()
            finally:
                # Drop the local binding here, inside the frame a propagating
                # traceback would keep alive, so the caller's drain can
                # actually return the model's buffers to MLX.
                del model

        def _reload_and_transcribe_sync():
            """Ensure the requested model is loaded, then transcribe — as ONE
            MLX-worker submission. See MLXTTSBackend._reload_and_generate_sync
            for why this needs to be a single callable rather than a separate
            load-then-transcribe pair.
            """
            if self.model is None or self.model_size != resolved_size:
                self._load_model_sync(resolved_size)
            try:
                return _transcribe_sync()
            finally:
                # See MLXTTSBackend._reload_and_generate_sync: drain the pool
                # if an unload landed mid-transcription.
                if self.model is None:
                    empty_mlx_cache()

        async with self._op_lock:
            return await run_owned(_run_on_mlx_thread(_reload_and_transcribe_sync))


    async def transcribe_detailed(self, audio_path, language=None, model_size=None):
        """Cached-only recognition with words, pinned to one local snapshot.

        Keep loading, decoding and result materialization on the MLX worker.
        Cancellation drains that worker before releasing the operation lock.
        """
        from ..utils.async_work import run_owned
        from ..utils.whisper_timing import recognized_word_timing

        resolved_size = model_size or self.model_size
        epoch = self._load_epoch

        def recognize():
            model = None
            try:
                if self.model is None or self.model_size != resolved_size:
                    from huggingface_hub import snapshot_download
                    from mlx_audio.stt import load
                    from huggingface_hub import constants as hf_constants

                    repo = WHISPER_HF_REPOS.get(resolved_size, f"openai/whisper-{resolved_size}")
                    snapshot = snapshot_download(repo_id=repo, local_files_only=True,
                                                 cache_dir=hf_constants.HF_HUB_CACHE)
                    loaded = load(snapshot)
                    if epoch != self._load_epoch:
                        del loaded
                        raise RuntimeError("Whisper was unloaded during recognition loading")
                    self.model = loaded
                    self.model_size = resolved_size
                    self._recognition_revision = Path(snapshot).name
                model = self.model
                options = {"word_timestamps": True}
                if language:
                    options["language"] = language
                # Studio assets have opaque, extensionless names. Decode by
                # audio content before handing 16 kHz mono samples to Whisper.
                from ..utils.audio import load_audio

                audio, _ = load_audio(str(audio_path), sample_rate=16000, mono=True)
                with recognized_word_timing(model):
                    result = model.generate(audio, **options)
                # Return plain CPU metadata, never lazy arrays/native model state.
                return {"text": result.get("text", "") if isinstance(result, dict) else result.text,
                        "segments": result.get("segments", []) if isinstance(result, dict) else result.segments}
            finally:
                del model
                if self.model is None:
                    empty_mlx_cache()

        async with self._op_lock:
            return await run_owned(_run_on_mlx_thread(recognize))
