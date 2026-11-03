"""Real CUDA-graph capture, replay and lifecycle on an NVIDIA device with cached Qwen Base weights.

Skips without CUDA, without the pinned snapshot, or without VOICEBOX_TEST_REFS, a
directory holding ref-a-af_heart.wav, ref-b-am_michael.wav and REFERENCES.txt
(path|provenance|transcript per line). VOICEBOX_CUDAGRAPH_REPORT names a JSON
file that receives the measured numbers; VOICEBOX_GATE0_DIR names a gate-0 run
whose graph_a_s42_1.wav the adapter's replay must reproduce bit for bit.
"""

import json
import os
import statistics
import time
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf
import torch

from backend import backends
from backend.backends.pytorch_backend import PyTorchTTSBackend
from backend.backends.qwen_cuda_variants import CudaGraphRuntimeError, cuda_graph_unavailable_reason
from backend.backends.qwen_cudagraph import CudaGraphSession

pytestmark = pytest.mark.skipif(not torch.cuda.is_available(), reason="CUDA device required")

REFS = os.environ.get("VOICEBOX_TEST_REFS")
SIZES = [size for size in os.environ.get("VOICEBOX_CUDAGRAPH_SIZES", "0.6B-cudagraph,1.7B-cudagraph").split(",") if size]
GATE0_TEXT = "Hello from Voicebox. This speech was generated locally."
PARAGRAPH = (
    "On the third of March, Dr. Amelia Okonkwo-Reyes boarded flight 2,718 to Reykjavik with 14 boxes of samples, "
    "two umbrellas and a question she had carried for 9 years: would the glacier still be there? The forecast said "
    "minus 3 degrees, light snow and a 40% chance of clear skies by Thursday. She did not believe it, but she packed "
    "the camera anyway, because hope, like luggage, weighs nothing until you have to carry it up a mountain."
)
REPORT = {"torch": torch.__version__, "gpu": torch.cuda.get_device_name(0), "sizes": {}}


def mib():
    free, total = torch.cuda.mem_get_info()
    return {
        "allocated_mib": torch.cuda.memory_allocated() // 2**20,
        "reserved_mib": torch.cuda.memory_reserved() // 2**20,
        "device_free_mib": free // 2**20,
        "device_total_mib": total // 2**20,
    }


def references():
    lines = (Path(REFS) / "REFERENCES.txt").read_text(encoding="utf-8").splitlines()
    return {line.split("|")[0]: (str(Path(REFS) / line.split("|")[0]), line.split("|")[2]) for line in lines if line.strip()}


@pytest.fixture(scope="module", autouse=True)
def report_file():
    yield
    path = os.environ.get("VOICEBOX_CUDAGRAPH_REPORT")
    if path:
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        Path(path).write_text(json.dumps(REPORT, indent=2))


@pytest.fixture(scope="module", params=SIZES)
async def loaded(request):
    size = request.param
    if REFS is None:
        pytest.skip("VOICEBOX_TEST_REFS not set")
    backend = PyTorchTTSBackend(size)
    if backend.device != "cuda":
        pytest.skip(f"torch device is {backend.device}")
    if not backend._is_model_cached(size):
        pytest.skip(f"{size} snapshot is not cached")
    torch.cuda.synchronize()
    baseline = mib()
    started = time.perf_counter()
    await backend.load_model(size)
    load_s = time.perf_counter() - started
    refs = references()
    prompt_a, _ = await backend.create_voice_prompt(*refs["ref-a-af_heart.wav"], use_cache=False)
    prompt_b, _ = await backend.create_voice_prompt(*refs["ref-b-am_michael.wav"], use_cache=False)
    REPORT["sizes"][size] = {
        "baseline": baseline, "load_s": load_s, "after_load": mib(),
        "graph_capture_s": backend.runtime_identity["graph_capture_s"], "runs": {},
    }
    yield size, backend, prompt_a, prompt_b, baseline
    backend.unload_model()


def record(size, label, backend, elapsed, audio, rate):
    REPORT["sizes"][size]["runs"][label] = {
        "wall_s": elapsed, "samples": int(audio.size), "duration_s": audio.size / rate,
        "finite": bool(np.isfinite(audio).all()), "peak_abs": float(np.abs(audio).max()),
        **backend.last_generation, **mib(),
    }


async def generate(backend, text, prompt, seed, size, label):
    torch.cuda.synchronize()
    started = time.perf_counter()
    audio, rate = await backend.generate(text, prompt, language="en", seed=seed)
    torch.cuda.synchronize()
    elapsed = time.perf_counter() - started
    assert rate == 24000 and audio.ndim == 1 and audio.dtype == np.float32 and np.isfinite(audio).all()
    assert backend.last_generation["hit_eos"] is True and backend.last_generation["steps"] > 0
    record(size, label, backend, elapsed, audio, rate)
    return audio


async def test_host_lists_the_variant_and_captured_at_load(loaded):
    size, backend, *_ = loaded
    assert cuda_graph_unavailable_reason() is None
    assert any(c.model_size == size for c in backends.get_tts_model_configs())
    identity = backend.runtime_identity
    assert identity["runtime"] == "cudagraph" and identity["graph_capture_s"] > 0
    assert backend._current_model_size == size


async def test_replay_is_seed_reproducible_and_matches_gate0(loaded):
    size, backend, prompt_a, _, _ = loaded
    first = await generate(backend, GATE0_TEXT, prompt_a, 42, size, "a_s42_first")
    warm = []
    for index in range(5):
        torch.cuda.synchronize()
        started = time.perf_counter()
        again = await generate(backend, GATE0_TEXT, prompt_a, 42, size, f"a_s42_warm{index}")
        warm.append(time.perf_counter() - started)
        assert np.array_equal(first, again), "same seed replay changed the audio"
    other = await generate(backend, GATE0_TEXT, prompt_a, 7, size, "a_s7")
    assert not (other.size == first.size and np.array_equal(first, other)), "a different seed replayed the same audio"
    REPORT["sizes"][size]["warm_same_seed_s"] = {"samples": warm, "p50": statistics.median(warm), "max": max(warm)}
    gate0 = os.environ.get("VOICEBOX_GATE0_DIR")
    if gate0 and size == "0.6B-cudagraph":
        reference, rate = sf.read(Path(gate0) / "graph_a_s42_1.wav", dtype="float32")
        # The gate-0 file is 16-bit PCM, so the comparison holds at that precision.
        assert rate == 24000 and first.size == reference.size, "adapter replay differs in length from the gate-0 run"
        assert np.abs(first - reference).max() <= 1 / 32768, "adapter replay differs from the gate-0 run"


async def test_two_speakers_do_not_leak(loaded):
    size, backend, prompt_a, prompt_b, _ = loaded
    a = await generate(backend, GATE0_TEXT, prompt_a, 42, size, "leak_a")
    b = await generate(backend, GATE0_TEXT, prompt_b, 42, size, "leak_b")
    a_again = await generate(backend, GATE0_TEXT, prompt_a, 42, size, "leak_a_after_b")
    assert not (a.size == b.size and np.array_equal(a, b)), "two references produced the same audio"
    assert np.array_equal(a, a_again), "speaker B's conditioning leaked into speaker A's replay"


async def test_variable_text_and_reference_lengths(loaded):
    size, backend, prompt_a, prompt_b, _ = loaded
    steps = {}
    for label, text, prompt in [("short_a", "Yes.", prompt_a), ("medium_b", GATE0_TEXT, prompt_b), ("paragraph_a", PARAGRAPH, prompt_a)]:
        audio = await generate(backend, text, prompt, 3, size, label)
        steps[label] = backend.last_generation["steps"]
        assert audio.size > 24000 * 0.2
    assert steps["short_a"] < steps["medium_b"] < steps["paragraph_a"]
    assert all(2048 - run["max_new_tokens"] > 0 for run in REPORT["sizes"][size]["runs"].values())


async def test_sequence_bound_raises_instead_of_truncating(loaded):
    size, backend, prompt_a, _, _ = loaded
    await generate(backend, "Yes.", prompt_a, 1, size, "bound_probe")
    prompt_len = 2048 - backend.last_generation["max_new_tokens"]
    tight = CudaGraphSession.capture(backend.model, "cuda", max_seq_len=prompt_len + 60, warmup_prefill_len=prompt_len)
    try:
        torch.manual_seed(1)
        torch.cuda.manual_seed(1)
        with pytest.raises(CudaGraphRuntimeError, match="bound"):
            tight.generate(PARAGRAPH, prompt_a, "english")
        assert tight.last_outcome == {"steps": 60, "hit_eos": False, "max_new_tokens": 60}
        too_small = CudaGraphSession.capture(backend.model, "cuda", max_seq_len=prompt_len - 1, warmup_prefill_len=8)
        try:
            with pytest.raises(CudaGraphRuntimeError, match="shorten"):
                too_small.generate("Yes.", prompt_a, "english")
        finally:
            too_small.close()
    finally:
        tight.close()
    audio = await generate(backend, "Yes.", prompt_a, 1, size, "bound_after")
    assert audio.size > 0


async def test_streaming_frames_are_continuous_at_window_seams(loaded):
    size, backend, prompt_a, _, _ = loaded
    buffered = await generate(backend, PARAGRAPH, prompt_a, 11, size, "stream_buffered")
    buffered_steps = backend.last_generation["steps"]
    frames = []
    torch.cuda.synchronize()
    started = time.perf_counter()
    first_frame_s = None
    async for audio, rate in backend.generate_stream(PARAGRAPH, prompt_a, "en", 11, None):
        if first_frame_s is None:
            first_frame_s = time.perf_counter() - started
        assert rate == 24000 and audio.ndim == 1 and audio.dtype == np.float32 and np.isfinite(audio).all()
        frames.append(audio)
    elapsed = time.perf_counter() - started
    assert backend.last_generation["steps"] == buffered_steps and backend.last_generation["hit_eos"] is True
    streamed = np.concatenate(frames)
    assert abs(streamed.size - buffered.size) <= 24000 // 12 * 2
    seams = np.cumsum([frame.size for frame in frames[:-1]])
    steps = np.abs(np.diff(streamed))
    interior = np.delete(steps, seams - 1)
    seam_steps = steps[seams - 1]
    length = min(streamed.size, buffered.size)
    correlation = float(np.corrcoef(streamed[:length], buffered[:length])[0, 1])
    REPORT["sizes"][size]["streaming"] = {
        "frames": len(frames), "frame_samples": [int(frame.size) for frame in frames], "wall_s": elapsed,
        "first_frame_s": first_frame_s, "streamed_samples": int(streamed.size), "buffered_samples": int(buffered.size),
        "max_seam_step": float(seam_steps.max()), "max_interior_step": float(interior.max()),
        "p99_interior_step": float(np.percentile(interior, 99)), "correlation_with_buffered": correlation,
    }
    assert seam_steps.max() <= interior.max(), "a window seam jumps further than any step inside a frame"


async def test_unload_releases_vram_and_reload_recaptures(loaded):
    size, backend, prompt_a, _, _ = loaded
    after_load = REPORT["sizes"][size]["after_load"]
    first_session = backend._graphs
    backend.unload_model()
    torch.cuda.synchronize()
    after_unload = mib()
    REPORT["sizes"][size]["after_unload"] = after_unload
    assert first_session.wrapper is None and backend._graphs is None and backend.model is None
    assert backend.runtime_identity == {"runtime": "stock"} and backend.generate_stream is None
    # Same 5% threshold as the C0 Turbo qualifier: the process keeps a small
    # floor (cuBLAS workspace, RNG state, the voice prompts) that is not the model.
    assert after_unload["allocated_mib"] <= 0.05 * after_load["allocated_mib"], "VRAM stayed allocated after unload"
    started = time.perf_counter()
    await backend.load_model(size)
    REPORT["sizes"][size]["reload_s"] = time.perf_counter() - started
    assert backend._graphs is not first_session and backend.runtime_identity["runtime"] == "cudagraph"
    await generate(backend, "Yes.", prompt_a, 1, size, "after_reload")


async def test_capture_failure_frees_vram_and_a_later_load_succeeds(loaded, monkeypatch):
    size, backend, prompt_a, _, _ = loaded
    after_load = REPORT["sizes"][size]["after_load"]
    from faster_qwen3_tts import talker_graph

    backend.unload_model()

    def explode(self, *args, **kwargs):
        raise RuntimeError("injected capture failure")

    monkeypatch.setattr(talker_graph.TalkerGraph, "capture", explode)
    with pytest.raises(CudaGraphRuntimeError, match="injected") as failure:
        await backend.load_model(size)
    torch.cuda.synchronize()
    after_failure = mib()
    REPORT["sizes"][size]["after_capture_failure"] = after_failure
    assert backend.model is None and backend._graphs is None and backend.runtime_identity == {"runtime": "stock"}
    # The held exception must not pin the model through its traceback.
    assert failure.value is not None and after_failure["allocated_mib"] <= 0.05 * after_load["allocated_mib"]
    monkeypatch.undo()
    await backend.load_model(size)
    assert backend.runtime_identity["runtime"] == "cudagraph"
    await generate(backend, "Yes.", prompt_a, 1, size, "after_capture_failure")
