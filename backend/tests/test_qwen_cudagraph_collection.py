"""The real-CUDA modules must collect (and skip) on a host without an NVIDIA device,
or `pytest backend/tests` aborts for every Mac and CPU-only contributor."""

import os
import subprocess
import sys
from pathlib import Path

TESTS = Path(__file__).resolve().parent
REPO = TESTS.parent.parent
CUDA_MODULES = [
    "test_qwen_cudagraph_cuda.py",
    "test_qwen_cudagraph_cuda_switch.py",
    "test_qwen_cudagraph_cuda_cycles.py",
]


def test_real_cuda_modules_collect_without_a_visible_gpu():
    result = subprocess.run(
        [sys.executable, "-m", "pytest", "-p", "no:cacheprovider", "-q", "--collect-only",
         *(str(TESTS / name) for name in CUDA_MODULES)],
        cwd=str(REPO), capture_output=True, text=True, timeout=300,
        env={**os.environ, "CUDA_VISIBLE_DEVICES": "-1"},
    )
    assert result.returncode == 0, result.stdout[-3000:] + result.stderr[-3000:]
    assert "error" not in result.stdout.lower(), result.stdout[-3000:]
