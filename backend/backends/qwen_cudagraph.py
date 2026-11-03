"""CUDA-graph replay for the Qwen Base PyTorch adapter, built on faster-qwen3-tts 0.3.2.

The stock Qwen3TTSModel stays the loaded model. This module wraps it in the pinned
runtime's predictor and talker graphs, captures them once at load, and replays them
for every generation on one dedicated thread. Nothing here falls back to the stock
decode loop: a capture failure frees the graphs and raises.
"""

import asyncio
import contextlib
import gc
import logging
import sys
import time
import traceback
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import torch

from .qwen_cuda_variants import CUDA_GRAPH_RUNTIME, CudaGraphRuntimeError

logger = logging.getLogger(__name__)

# One thread captures and replays; CUDA graph state is shared mutable state.
_graph_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="cudagraph-worker")

MIN_NEW_TOKENS = 2
STREAM_CHUNK_STEPS = 12
TALKER_SAMPLING_KEYS = ("do_sample", "top_k", "top_p", "temperature", "repetition_penalty")
PREDICTOR_SAMPLING_KEYS = {
    "subtalker_dosample": "do_sample",
    "subtalker_top_k": "top_k",
    "subtalker_top_p": "top_p",
    "subtalker_temperature": "temperature",
}


def run_on_graph_thread(func, *args):
    return asyncio.get_running_loop().run_in_executor(_graph_executor, func, *args)


def require_cuda_device(device: str) -> None:
    if not str(device).startswith("cuda"):
        raise CudaGraphRuntimeError(f"CUDA-graph model variants require a CUDA device, not {device!r}")


def _checkpoint_sampling(model) -> dict:
    """Stock sampling values, read from the checkpoint's generation config."""
    defaults = getattr(model, "generate_defaults", None) or {}
    missing = [key for key in (*TALKER_SAMPLING_KEYS, *PREDICTOR_SAMPLING_KEYS) if key not in defaults]
    if missing:
        raise CudaGraphRuntimeError(f"The checkpoint generation config lacks sampling values {missing}")
    return {key: defaults[key] for key in (*TALKER_SAMPLING_KEYS, *PREDICTOR_SAMPLING_KEYS)}


_capture_streams: dict = {}


class _CudaOneStream:
    def Stream(self, *args, **kwargs):
        if args or kwargs:
            return torch.cuda.Stream(*args, **kwargs)
        device = torch.cuda.current_device()
        if device not in _capture_streams:
            _capture_streams[device] = torch.cuda.Stream(device=device)
        return _capture_streams[device]

    def __getattr__(self, name):
        return getattr(torch.cuda, name)


class _TorchOneStream:
    cuda = _CudaOneStream()

    def __getattr__(self, name):
        return getattr(torch, name)


@contextlib.contextmanager
def _capture_on_one_stream(*graphs):
    """Upstream warms each graph up on a new side stream before capturing it, and
    PyTorch keeps a cuBLAS workspace per stream for the life of the process: about
    16 MiB per load. Give the upstream graph modules one reused stream per device."""
    modules = {sys.modules[type(graph).__module__] for graph in graphs}
    modules = [module for module in modules if getattr(module, "torch", None) is torch]
    if len(modules) < len({type(graph).__module__ for graph in graphs}):
        logger.warning("faster-qwen3-tts graph modules no longer expose `torch`; each load may keep a cuBLAS workspace")
    for module in modules:
        module.torch = _TorchOneStream()
    try:
        yield
    finally:
        for module in modules:
            module.torch = torch


def _release_cuda_memory() -> None:
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


def _synchronize() -> None:
    if torch.cuda.is_available():
        torch.cuda.synchronize()


class CudaGraphSession:
    """Captured graphs around one resident stock model, replayed one request at a time."""

    def __init__(self, wrapper, sampling: dict, graph_capture_s: float):
        self.wrapper = wrapper
        self.sampling = sampling
        self.graph_capture_s = graph_capture_s
        self.last_outcome = None

    @classmethod
    def capture(cls, model, device: str, *, max_seq_len: int = CUDA_GRAPH_RUNTIME.max_seq_len, warmup_prefill_len: int = 100):
        """Build and capture graphs around a loaded stock model; free everything on failure."""
        require_cuda_device(device)
        sampling = _checkpoint_sampling(model)
        from faster_qwen3_tts import FasterQwen3TTS
        from faster_qwen3_tts.predictor_graph import PredictorGraph
        from faster_qwen3_tts.talker_graph import TalkerGraph

        talker = model.model.talker
        talker_config = model.model.config.talker_config
        dtype = torch.bfloat16
        wrapper = predictor_graph = talker_graph = None
        try:
            predictor_graph = PredictorGraph(
                talker.code_predictor, talker.code_predictor.model.config, talker_config.hidden_size,
                device=device, dtype=dtype,
                do_sample=sampling["subtalker_dosample"], top_k=sampling["subtalker_top_k"],
                top_p=sampling["subtalker_top_p"], temperature=sampling["subtalker_temperature"],
            )
            captured = {name: getattr(predictor_graph, name) for name in PREDICTOR_SAMPLING_KEYS.values()}
            expected = {name: sampling[key] for key, name in PREDICTOR_SAMPLING_KEYS.items()}
            if captured != expected:
                raise CudaGraphRuntimeError(f"Predictor graph sampling {captured} differs from the checkpoint {expected}")
            talker_graph = TalkerGraph(talker.model, talker_config, device=device, dtype=dtype, max_seq_len=max_seq_len)
            wrapper = FasterQwen3TTS(model, predictor_graph, talker_graph, device=device, dtype=dtype, max_seq_len=max_seq_len)
            _synchronize()
            started = time.perf_counter()
            with torch.inference_mode(), _capture_on_one_stream(predictor_graph, talker_graph):
                wrapper.warmup(prefill_len=warmup_prefill_len)
                # The first request would otherwise rebuild the per-position mask table.
                unpadded = torch.ones(1, warmup_prefill_len, dtype=torch.long, device=talker_graph.cache_position.device)
                talker_graph.set_generation_state(unpadded, None)
            _synchronize()
            graph_capture_s = time.perf_counter() - started
        except BaseException as error:
            if wrapper is not None:
                cls._free(wrapper)
            # The traceback's frames would otherwise keep the graphs and the
            # model's modules resident for as long as the exception lives.
            traceback.clear_frames(error.__traceback__)
            wrapper = predictor_graph = talker_graph = talker = model = None
            _release_cuda_memory()
            if isinstance(error, CudaGraphRuntimeError):
                raise
            raise CudaGraphRuntimeError(f"CUDA graph capture failed: {error}") from error
        logger.info("CUDA graphs captured in %.2fs (max_seq_len=%d)", graph_capture_s, max_seq_len)
        return cls(wrapper, sampling, graph_capture_s)

    @property
    def identity(self) -> dict:
        return {**CUDA_GRAPH_RUNTIME.identity(), "max_seq_len": self.wrapper.max_seq_len, "graph_capture_s": self.graph_capture_s}

    def _talker_sampling(self) -> dict:
        return {key: self.sampling[key] for key in TALKER_SAMPLING_KEYS}

    def _token_budget(self, prompt_len: int) -> int:
        budget = self.wrapper.max_seq_len - prompt_len
        if budget < MIN_NEW_TOKENS:
            raise CudaGraphRuntimeError(
                f"The prompt occupies {prompt_len} of the {self.wrapper.max_seq_len} talker positions the CUDA graphs hold; "
                "shorten the text or the reference, or use the stock Qwen model"
            )
        return budget

    def _record(self, steps: int, max_new_tokens: int) -> None:
        hit_eos = steps < max_new_tokens
        self.last_outcome = {"steps": int(steps), "hit_eos": hit_eos, "max_new_tokens": int(max_new_tokens)}
        if not hit_eos:
            raise CudaGraphRuntimeError(
                f"Generation reached the CUDA-graph bound of {max_new_tokens} codec steps without an end of speech; "
                "the stock Qwen model allows longer output"
            )

    def _prepare(self, text: str, items: list, language: str):
        prepared = self.wrapper._prepare_generation(text=text, language=language, voice_clone_prompt=items, instruct=None)
        return prepared, prepared[3].shape[1]

    def generate(self, text: str, items: list, language: str):
        """Return (mono float32 audio, sample rate); raises at the sequence bound."""
        from faster_qwen3_tts.generate import fast_generate

        with torch.inference_mode():
            (m, talker, config, tie, tam, tth, tpe, ref_codes), prompt_len = self._prepare(text, items, language)
            budget = self._token_budget(prompt_len)
            codec_ids, timing = fast_generate(
                talker=talker, talker_input_embeds=tie, attention_mask=tam, trailing_text_hiddens=tth,
                tts_pad_embed=tpe, config=config, predictor_graph=self.wrapper.predictor_graph,
                talker_graph=self.wrapper.talker_graph, max_new_tokens=budget, min_new_tokens=MIN_NEW_TOKENS,
                **self._talker_sampling(),
            )
            self._record(timing["steps"], budget)
            if codec_ids is None:
                raise CudaGraphRuntimeError("Generation produced no codec tokens")
            return self._decode(m.speech_tokenizer, codec_ids, ref_codes)

    @staticmethod
    def _decode(speech_tokenizer, codec_ids, ref_codes):
        """Decode with the reference as acoustic context and cut it back out, as upstream does."""
        codes = codec_ids if ref_codes is None else torch.cat([ref_codes.to(codec_ids.device), codec_ids], dim=0)
        audio_list, sample_rate = speech_tokenizer.decode({"audio_codes": codes.unsqueeze(0)})
        audio = audio_list[0]
        audio = audio.flatten().cpu().numpy() if hasattr(audio, "cpu") else np.asarray(audio).flatten()
        if ref_codes is not None:
            audio = audio[int(ref_codes.shape[0] / max(codes.shape[0], 1) * len(audio)):]
        return np.asarray(audio, dtype=np.float32), int(sample_rate)

    def stream(self, text: str, items: list, language: str, chunk_steps: int = STREAM_CHUNK_STEPS):
        """Yield (audio, sample rate) per decoded window; raises after the frames at the bound."""
        with torch.inference_mode():
            _, prompt_len = self._prepare(text, items, language)
            budget = self._token_budget(prompt_len)
            steps = 0
            for audio, sample_rate, timing in self.wrapper.generate_voice_clone_streaming(
                text=text, language=language, voice_clone_prompt=items, instruct=None,
                max_new_tokens=budget, min_new_tokens=MIN_NEW_TOKENS, chunk_size=chunk_steps,
                **self._talker_sampling(),
            ):
                steps = timing["total_steps_so_far"]
                yield np.asarray(audio, dtype=np.float32), int(sample_rate)
            self._record(steps, budget)

    @staticmethod
    def _free(wrapper) -> None:
        for graph in (wrapper.predictor_graph, wrapper.talker_graph):
            graph.graph = None
            graph.captured = False
            graph.static_cache = None
        wrapper.talker_graph.attn_mask_table = None
        wrapper.talker_graph.attn_mask = None
        wrapper.predictor_graph = None
        wrapper.talker_graph = None
        wrapper.model = None

    def close(self) -> None:
        """Drop graphs, static caches and mask tables; the owner drops the model."""
        wrapper, self.wrapper = self.wrapper, None
        if wrapper is not None:
            self._free(wrapper)
        del wrapper
        _release_cuda_memory()
