"""Explicit optional CUDA-graph Base variants on NVIDIA; the stock path remains the default."""

import importlib.metadata
import os
from dataclasses import asdict, dataclass


class CudaGraphRuntimeError(RuntimeError):
    """Capture failed, the sequence bound was reached, or the selection is unsupported."""


@dataclass(frozen=True)
class CudaGraphRuntime:
    package: str = "faster-qwen3-tts"
    version: str = "0.3.2"
    commit: str = "a70afc0f81f7f5f8801c3227968f1102f43f211c"
    license: str = "MIT"
    dtype: str = "bfloat16"
    attn_implementation: str = "sdpa"
    max_seq_len: int = 2048

    def identity(self) -> dict:
        record = asdict(self)
        del record["license"]
        record["attn"] = record.pop("attn_implementation")
        return {"runtime": "cudagraph", **record}


CUDA_GRAPH_RUNTIME = CudaGraphRuntime()


@dataclass(frozen=True)
class CudaGraphVariant:
    base_size: str
    hf_repo_id: str
    revision: str
    size_mb: int


QWEN_CUDA_GRAPH_VARIANTS = {
    "0.6B-cudagraph": CudaGraphVariant(
        "0.6B", "Qwen/Qwen3-TTS-12Hz-0.6B-Base", "5d83992436eae1d760afd27aff78a71d676296fc", 1200
    ),
    "1.7B-cudagraph": CudaGraphVariant(
        "1.7B", "Qwen/Qwen3-TTS-12Hz-1.7B-Base", "fd4b254389122332181a7c3db7f27e918eec64e3", 3500
    ),
}

QWEN_CUDA_GRAPH_REQUIRED_FILES = (
    "config.json",
    "generation_config.json",
    "merges.txt",
    "vocab.json",
    "tokenizer_config.json",
    "preprocessor_config.json",
    "model.safetensors",
    "speech_tokenizer/config.json",
    "speech_tokenizer/configuration.json",
    "speech_tokenizer/model.safetensors",
    "speech_tokenizer/preprocessor_config.json",
)


def is_cuda_graph_variant(model_size) -> bool:
    return model_size in QWEN_CUDA_GRAPH_VARIANTS


def cuda_graph_unavailable_reason() -> str | None:
    """None when the pinned runtime can run on this host, otherwise why it cannot."""
    from .base import FORCE_CPU_ENABLED_VALUE, FORCE_CPU_ENV_VAR

    runtime = CUDA_GRAPH_RUNTIME
    try:
        installed = importlib.metadata.version(runtime.package)
    except importlib.metadata.PackageNotFoundError:
        return f"{runtime.package} is not installed"
    if installed != runtime.version:
        return f"{runtime.package} {installed} is installed; only {runtime.version} is qualified"
    if os.environ.get(FORCE_CPU_ENV_VAR, "").strip() == FORCE_CPU_ENABLED_VALUE:
        return f"{FORCE_CPU_ENV_VAR}={FORCE_CPU_ENABLED_VALUE} forces the CPU device"
    import torch

    if getattr(torch.version, "hip", None):
        return "CUDA graphs are qualified on NVIDIA CUDA only, not ROCm/HIP"
    if torch.version.cuda is None:
        return "The installed torch build has no CUDA support"
    if not torch.cuda.is_available():
        return "No CUDA device is available"
    return None


def require_cuda_graph_variant(engine: str) -> None:
    """Refuse a CUDA-graph selection before any model access."""
    if engine != "qwen":
        raise ValueError("CUDA-graph model variants require the Qwen Base engine")
    reason = cuda_graph_unavailable_reason()
    if reason is not None:
        raise CudaGraphRuntimeError(f"CUDA-graph model variants are unavailable: {reason}")
