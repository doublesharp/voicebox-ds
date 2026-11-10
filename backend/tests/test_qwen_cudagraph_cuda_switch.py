"""A size switch never holds two graph sets; a separate module so the lifecycle fixtures of
test_qwen_cudagraph_cuda.py are torn down first and no other model shares the device."""

import json
import os
from pathlib import Path

import pytest
import torch

from backend.backends.pytorch_backend import PyTorchTTSBackend

from .test_qwen_cudagraph_cuda import REFS, SIZES, mib

pytestmark = pytest.mark.skipif(not torch.cuda.is_available(), reason="CUDA device required")


@pytest.mark.skipif(len(SIZES) < 2, reason="two variant sizes are required")
async def test_size_switch_never_holds_two_graph_sets(monkeypatch):
    if REFS is None:
        pytest.skip("VOICEBOX_TEST_REFS not set")
    small, large = SIZES[0], SIZES[1]
    backend = PyTorchTTSBackend(small)
    if backend.device != "cuda" or not all(backend._is_model_cached(size) for size in (small, large)):
        pytest.skip("both snapshots and a CUDA device are required")
    torch.cuda.synchronize()
    idle = mib()
    assert idle["allocated_mib"] < 256, "another model is resident on the device before the switch test"
    fresh = {}
    for size in (large, small):
        await backend.load_model(size)
        torch.cuda.synchronize()
        fresh[size] = mib()["allocated_mib"]
        backend.unload_model()
    await backend.load_model(small)
    small_session = backend._graphs
    await backend.load_model(large)
    torch.cuda.synchronize()
    switched = mib()["allocated_mib"]
    path = os.environ.get("VOICEBOX_CUDAGRAPH_REPORT")
    if path:
        Path(path).with_name("size_switch.json").write_text(json.dumps(
            {"fresh_allocated_mib": fresh, "after_switch_allocated_mib": switched, "idle_before": idle}, indent=2))
    assert small_session.wrapper is None and backend._current_model_size == large
    assert switched <= fresh[large] + 64, "the previous size's graphs stayed resident across the switch"
    backend.unload_model()
