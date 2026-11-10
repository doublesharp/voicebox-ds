"""Repeated CUDA-graph load/generate/unload cycles must not leave memory behind.

Upstream warms each graph up on a new side stream, and PyTorch keeps a cuBLAS
workspace per stream for the life of the process, so a per-load leak shows only
across cycles.
Skips like test_qwen_cudagraph_cuda.py; runs in its own module so no fixture
holds a model while it measures.
"""
import os
from pathlib import Path

import pytest
import torch

from backend.backends.pytorch_backend import PyTorchTTSBackend

pytestmark = pytest.mark.skipif(not torch.cuda.is_available(), reason="CUDA device required")
REFS = os.environ.get("VOICEBOX_TEST_REFS")
SIZE = "0.6B-cudagraph"


async def test_repeated_cycles_do_not_accumulate_allocated_vram():
    if REFS is None:
        pytest.skip("VOICEBOX_TEST_REFS not set")
    backend = PyTorchTTSBackend(SIZE)
    if not backend._is_model_cached(SIZE):
        pytest.skip(f"{SIZE} snapshot is not cached")
    line = (Path(REFS) / "REFERENCES.txt").read_text(encoding="utf-8").splitlines()[0].split("|")
    after_unload = []
    for _ in range(3):
        await backend.load_model(SIZE)
        prompt, _ = await backend.create_voice_prompt(str(Path(REFS) / line[0]), line[2], use_cache=False)
        await backend.generate("Cycle check.", prompt, seed=42)
        backend.unload_model()
        torch.cuda.synchronize()
        after_unload.append(torch.cuda.memory_allocated())
    growth = after_unload[-1] - after_unload[0]
    assert growth < 2**20, f"allocated VRAM after unload grew by {growth} bytes over cycles: {after_unload}"
