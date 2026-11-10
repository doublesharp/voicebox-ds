"""Qwen CUDA-graph qualification runner against a labelled fake backend that
implements the C1 runtime contract (no weights, no GPU)."""

import asyncio
import dataclasses
import hashlib
import importlib.util
import json
from pathlib import Path
import random
import subprocess
import sys
from types import SimpleNamespace
import wave

import numpy as np
import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "qualify-qwen-cudagraph.py"
SPEC = importlib.util.spec_from_file_location("qualify_qwen_cudagraph", SCRIPT)
qualify = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = qualify
SPEC.loader.exec_module(qualify)

MAX_SEQ_LEN = 2048


def make_reference(path, fill, frames=800, rate=800):
    with wave.open(str(path), "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(rate)
        audio.writeframes(bytes([fill, 0]) * frames)
    return path


class CudaGraphRuntimeError(RuntimeError):
    """Stands in for backend.backends.pytorch_backend.CudaGraphRuntimeError."""


class FakeCUDAGraph:
    """Stands in for torch.cuda.CUDAGraph; the fake backend captures and replays through it."""

    def capture_begin(self):
        pass

    def capture_end(self):
        pass

    def replay(self):
        pass


class Qwen3TTSModel:
    """Stock model stand-in: the residency root the contract keeps unchanged."""


class FakeGraphBackend:
    """Fake PyTorchTTSBackend for a cudagraph model size. Audio is a deterministic
    function of (speaker, text, seed); each generation replays the graph once per
    codec step. Behaviour switches reproduce the defects the checks must catch."""

    def __init__(self, model_size, *, graph_class=FakeCUDAGraph, defect=None, vram=None):
        self.model_size, self.graph_class, self.defect, self.vram = model_size, graph_class, defect, vram or SimpleNamespace(allocated=0)
        self.model = self.runtime_identity = self.last_generation = None
        self._current_model_size = None
        self.graph = None
        self.loads, self.unloads, self.generations = [], 0, []
        self.oom_next = False

    def is_loaded(self):
        return self.model is not None

    async def load_model(self, model_size=None):
        model_size = model_size or self.model_size
        if self.model is not None and self._current_model_size == model_size:
            return
        if self.model is not None:
            self.unload_model()
        self.loads.append(model_size)
        self.vram.allocated = 2_400_000_000 if model_size.startswith("0.6B") else 4_600_000_000
        try:
            self.graph = self.graph_class()
            if self.defect != "no_recapture" or len(self.loads) == 1:
                self.graph.capture_begin()
                self.graph.capture_end()
        except RuntimeError as exc:
            if self.defect == "ignores_capture_fault":
                self.graph.capture_end()
            elif self.defect == "wrong_capture_error":
                raise ValueError("capture failed") from exc
            else:
                if self.defect != "leaky_capture_failure":
                    self.vram.allocated = 0
                    self.graph = None
                else:
                    self.model = Qwen3TTSModel()
                raise CudaGraphRuntimeError(f"graph capture failed: {exc}") from exc
        self.model = Qwen3TTSModel()
        self._current_model_size = model_size
        self.runtime_identity = {"runtime": "stock"} if self.defect == "stock_identity" else {
            "runtime": "cudagraph", "package": "faster-qwen3-tts", "version": "0.3.2", "commit": "a" * 40,
            "dtype": "bfloat16", "attn": "sdpa", "max_seq_len": MAX_SEQ_LEN, "graph_capture_s": 4.5}

    def unload_model(self):
        if self.model is not None:
            self.model = self.graph = None
            self._current_model_size = None
            self.unloads += 1
            if self.defect != "vram_leak":
                self.vram.allocated = 0

    async def create_voice_prompt(self, audio_path, reference_text, use_cache=True):
        assert use_cache is False, "qualification must bypass the shared prompt cache"
        speaker = int.from_bytes(hashlib.sha256(Path(audio_path).read_bytes()).digest()[:2], "big") / 65535
        with wave.open(str(audio_path), "rb") as audio:
            frames = round(audio.getnframes() / audio.getframerate() * 12)
        return {"speaker": speaker, "ref_text": reference_text, "frames": frames}, False

    async def generate(self, text, voice_prompt, language="en", seed=None, instruct=None):
        self.last_generation = {"steps": None, "hit_eos": None, "max_new_tokens": None}
        if self.oom_next:
            self.oom_next = False
            if self.defect == "oom_unloads":
                self.unload_model()
            if self.defect == "wrong_oom_error":
                raise ValueError("boom")
            raise RuntimeError("CUDA out of memory. Tried to allocate 20.00 MiB")
        # The reference's codec frames fill the prefill; the text trails and drives the step count.
        prompt_len = voice_prompt["frames"] + 16
        max_new_tokens = MAX_SEQ_LEN - prompt_len
        if max_new_tokens < 2:
            if self.defect == "no_prompt_bound":
                max_new_tokens = MAX_SEQ_LEN
            else:
                if self.defect == "refuses_after_replay":
                    self.graph.replay()
                raise CudaGraphRuntimeError(f"The prompt occupies {prompt_len} of the {MAX_SEQ_LEN} talker positions; shorten the reference")
        speaker = voice_prompt["speaker"]
        if self.defect == "speaker_leak" and self.generations:
            speaker = self.generations[-1]["speaker"]
        effective_seed = 0 if self.defect == "frozen_rng" else seed
        steps = min(max_new_tokens, 12 + len(text) // 8)
        if self.defect != "stock_path":
            for _ in range(steps):
                self.graph.replay()
        rng = random.Random(f"{speaker:.5f}|{text}|{effective_seed}")
        samples = np.array([rng.uniform(-0.5, 0.5) for _ in range(steps * 20)], dtype=np.float32)
        hit_eos = steps < max_new_tokens
        self.last_generation = {"steps": steps, "hit_eos": hit_eos or self.defect == "misreported_bound", "max_new_tokens": max_new_tokens}
        self.generations.append({"speaker": speaker, "text": text, "seed": seed})
        if not hit_eos and self.defect != "no_bound":
            raise CudaGraphRuntimeError(f"Generation reached the CUDA-graph bound of {max_new_tokens} codec steps")
        return samples, 240


class FakeCuda:
    """torch.cuda stand-in whose allocation follows the fake backend's VRAM."""

    def __init__(self, vram):
        self.vram = vram

    def synchronize(self, device):
        pass

    def reset_peak_memory_stats(self, device):
        pass

    def memory_allocated(self, device):
        return self.vram.allocated

    max_memory_allocated = memory_reserved = max_memory_reserved = memory_allocated


class FakeFiller:
    """Stands in for the VRAM filler: makes the backend's next generation raise OOM."""

    def __init__(self, backend, provoke=True, harmless=False):
        self.backend, self.provoke, self.harmless, self.held = backend, provoke, harmless, 0

    def fill(self):
        if not self.provoke:
            return {"provoked": False, "reason": "fixture declined"}
        self.backend.oom_next = not self.harmless
        self.held = 7_000_000_000
        return {"provoked": True, "held_bytes": self.held}

    def release(self):
        self.backend.oom_next = False
        self.held = 0


@pytest.fixture
def settings(tmp_path):
    cache_root = tmp_path / "hub"
    cache_root.mkdir()
    return qualify.Settings("cuda", cache_root, tmp_path / "run",
                            make_reference(tmp_path / "a.wav", 10), "Reference A.",
                            make_reference(tmp_path / "b.wav", 200), "Reference B.", seed=42)


def harness(defect=None, provoke_oom=True, graph_class=FakeCUDAGraph, harmless_oom=False):
    vram = SimpleNamespace(allocated=0)
    backends = []

    def factory(settings, admitted, output):
        backend = FakeGraphBackend(settings.model, graph_class=graph_class, defect=defect, vram=vram)
        backends.append(backend)
        return backend

    return SimpleNamespace(
        factory=factory, backends=backends, vram=vram,
        meter_factory=lambda device: qualify.telemetry.StageMeter(device, cuda=FakeCuda(vram), process=None),
        filler_factory=lambda backend: FakeFiller(backend, provoke=provoke_oom, harmless=harmless_oom))


def run(settings, fixture, **kwargs):
    output = qualify.Output(settings.output_root)
    admitted = {"repo_id": "Qwen/Qwen3-TTS-12Hz-0.6B-Base", "revision": "a" * 40, "snapshot": "fake"}
    try:
        defaults = {"factory": fixture.factory, "admit": lambda _: admitted, "identify": lambda _: {"fixture": True},
                    "get_provenance": lambda: {"fixture": True}, "meter_factory": fixture.meter_factory,
                    "filler_factory": fixture.filler_factory, "graph_class": FakeCUDAGraph,
                    "package_version": lambda name: "0.3.2",
                    "verify_residency": lambda roots, device: {"roots": sorted(roots), "device": device}}
        report = asyncio.run(qualify.qualify(settings, output, **{**defaults, **kwargs}))
    finally:
        output.close()
    saved = json.loads((settings.output_root / "results.json").read_text())
    assert saved["status"] == report["status"] and len(saved["checks"]) == len(report["checks"])
    return report


def by_name(report):
    return {check["name"]: check for check in report["checks"]}


def test_every_check_passes_against_the_contract_fake(settings):
    fixture = harness()
    report = run(dataclasses.replace(settings, second_model="1.7B-cudagraph", lifecycle_cycles=2), fixture)
    failures = {c["name"]: c["error"] for c in report["checks"] if not c["passed"]}
    assert failures == {}
    assert report["status"] == "ok"
    names = [c["name"] for c in report["checks"]]
    assert names == [c.__name__.removeprefix("check_") for c in qualify.CHECKS] + ["lifecycle_cycles"]
    checks = by_name(report)
    capture = checks["capture_then_warmup_then_replay"]["evidence"]
    assert capture["captures_during_load"] == 1 and capture["graph_capture_s"] == 4.5
    assert capture["first_generation"]["replays"] > 0 and capture["second_generation"]["captures"] == 0
    seeds = checks["seed_behavior"]["evidence"]
    assert seeds["same_seed"]["bit_exact"] is True and seeds["different_seed"]["bit_exact"] is False
    lengths = checks["variable_text_and_reference_lengths"]["evidence"]
    assert lengths["paragraph_a"]["duration_s"] > lengths["short_a"]["duration_s"]
    assert all(entry["hit_eos"] is True for key, entry in lengths.items() if isinstance(entry, dict) and "hit_eos" in entry)
    speakers = checks["two_speakers_no_leak"]["evidence"]
    assert speakers["a_vs_a_after_b"]["bit_exact"] is True and speakers["a_vs_b"]["bit_exact"] is False
    bound = checks["generation_bound_raises"]["evidence"]
    assert bound["probe"] == "long_text" and bound["generation_bound_probed"] is True and bound["raised"] == "CudaGraphRuntimeError"
    assert bound["chars"] > MAX_SEQ_LEN * 4 and bound["state_intact_after_error"]["bit_exact"] is True
    assert bound["last_generation"]["hit_eos"] is False and bound["last_generation"]["steps"] == bound["last_generation"]["max_new_tokens"]
    assert bound["replays_during_error"] == bound["last_generation"]["steps"]
    refusal = checks["prompt_too_long_is_refused_before_replay"]["evidence"]
    assert refusal["probe"] == "long_reference_prompt" and refusal["raised"] == "CudaGraphRuntimeError"
    assert refusal["reference_duration_s"] > MAX_SEQ_LEN / 12 and refusal["replays_during_error"] == 0
    assert refusal["last_generation"] == {"steps": None, "hit_eos": None, "max_new_tokens": None}
    assert refusal["state_intact_after_error"]["bit_exact"] is True
    recovery = checks["capture_failure_recovery"]["evidence"]
    assert recovery["raised"] == "CudaGraphRuntimeError" and recovery["loaded_after_failure"] is False
    assert recovery["vram_released_after_failure"] is True and recovery["captures_after_recovery"] >= 1
    assert recovery["different_call_after_recovery"] == "create_voice_prompt" and recovery["generated_after_recovery"] is True
    oom = checks["oom_recovery"]["evidence"]
    assert oom["provoked"] is True and oom["raised"] == "RuntimeError" and oom["recovered"]["bit_exact"] is True
    sizes = checks["model_size_change"]["evidence"]
    assert sizes["sequence"] == ["0.6B-cudagraph", "1.7B-cudagraph", "0.6B-cudagraph"]
    assert sizes["back_to_first"]["bit_exact"] is True and sizes["second"]["duration_s"] > 0
    identity = checks["runtime_identity_truthful"]["evidence"]
    assert identity["package_version_installed"] == "0.3.2" and identity["model_class"] == "Qwen3TTSModel"
    fallback = checks["no_silent_fallback"]["evidence"]
    assert fallback["generations"] > 5 and fallback["generations_without_replay"] == [] and fallback["total_replays"] > 0
    timing = checks["first_generation_after_capture_timing"]
    assert timing["kind"] == "recorded" and set(timing["evidence"]) == {"first_s", "second_s", "ratio"}
    lifecycle = checks["lifecycle_cycles"]["evidence"]
    assert [row["cycle"] for row in lifecycle["cycles"]] == [1, 2]
    assert all(row["captures"] >= 1 and row["cuda_allocated_after_unload_bytes"] == 0 for row in lifecycle["cycles"])
    assert report["summary"]["recorded"] == {"first_generation_after_capture_timing": timing["evidence"]}
    assert report["summary"]["expected"] == report["summary"]["passed"] == len(qualify.CHECKS)
    assert report["load"]["runtime_identity"]["runtime"] == "cudagraph" and report["load"]["captures"] == 1
    assert fixture.backends[0].unloads >= 3 and fixture.vram.allocated == 0
    for name in report["wavs"]:
        with wave.open(str(settings.output_root / name), "rb") as audio:
            assert audio.getnchannels() == 1 and audio.getnframes() > 0


def test_stock_path_without_replays_fails_fallback_and_capture_checks(settings):
    report = run(settings, harness(defect="stock_path"))
    checks = by_name(report)
    assert report["status"] == "failed"
    assert checks["no_silent_fallback"]["passed"] is False and "without replay" in checks["no_silent_fallback"]["error"]
    assert checks["capture_then_warmup_then_replay"]["passed"] is False and "replay" in checks["capture_then_warmup_then_replay"]["error"]


def test_frozen_rng_fails_seed_behavior(settings):
    checks = by_name(run(settings, harness(defect="frozen_rng")))
    assert checks["seed_behavior"]["passed"] is False and "different seeds" in checks["seed_behavior"]["error"]
    assert checks["two_speakers_no_leak"]["passed"] is True


def test_speaker_leak_fails_two_speakers(settings):
    checks = by_name(run(settings, harness(defect="speaker_leak")))
    assert checks["two_speakers_no_leak"]["passed"] is False and "leak" in checks["two_speakers_no_leak"]["error"]


def test_silent_bound_truncation_fails_bound_check(settings):
    checks = by_name(run(settings, harness(defect="no_bound")))
    assert checks["generation_bound_raises"]["passed"] is False and "did not raise" in checks["generation_bound_raises"]["error"]


def test_a_bound_error_whose_last_generation_claims_eos_fails_bound_check(settings):
    checks = by_name(run(settings, harness(defect="misreported_bound")))
    assert checks["generation_bound_raises"]["passed"] is False and "hit_eos" in checks["generation_bound_raises"]["error"]


@pytest.mark.parametrize("defect, message", [("no_prompt_bound", "did not raise"), ("refuses_after_replay", "replay")])
def test_a_prompt_that_is_not_refused_before_replay_fails_the_prompt_check(settings, defect, message):
    checks = by_name(run(settings, harness(defect=defect)))
    check = checks["prompt_too_long_is_refused_before_replay"]
    assert check["passed"] is False and message in check["error"]


def test_capture_failure_that_leaves_state_fails_recovery(settings):
    checks = by_name(run(settings, harness(defect="leaky_capture_failure")))
    error = checks["capture_failure_recovery"]["error"]
    assert checks["capture_failure_recovery"]["passed"] is False and "still loaded" in error and "VRAM" in error


def test_stock_identity_stops_before_checks(settings):
    report = run(settings, harness(defect="stock_identity"))
    assert report["status"] == "failed" and report["checks"] == [] and "silent runtime substitution" in report["error"]["message"]


def test_oom_not_provoked_is_recorded_not_gated(settings):
    report = run(settings, harness(provoke_oom=False))
    oom = by_name(report)["oom_recovery"]
    assert oom["kind"] == "recorded" and oom["evidence"] == {"provoked": False, "reason": "fixture declined"}
    assert report["summary"]["recorded"]["oom_recovery"] == oom["evidence"]
    assert report["summary"]["expected"] == report["summary"]["passed"] + report["summary"]["failed"]


def test_model_size_change_is_recorded_as_skipped_without_a_second_model(settings):
    report = run(settings, harness())
    sizes = by_name(report)["model_size_change"]
    assert sizes["kind"] == "recorded" and sizes["evidence"] == {"skipped": "no --second-model"}
    assert report["summary"]["recorded"]["model_size_change"] == {"skipped": "no --second-model"}


def test_an_error_that_is_not_an_oom_fails_oom_recovery(settings):
    checks = by_name(run(settings, harness(defect="wrong_oom_error")))
    assert checks["oom_recovery"]["kind"] == "gating" and checks["oom_recovery"]["passed"] is False
    assert "not an OOM" in checks["oom_recovery"]["error"]


def test_no_silent_fallback_fails_without_any_generation(settings):
    checks = by_name(run(settings, harness(), checks=[qualify.check_no_silent_fallback]))
    assert checks["no_silent_fallback"]["passed"] is False and "no generation" in checks["no_silent_fallback"]["error"]


def test_vram_leak_fails_lifecycle_and_recovery(settings):
    checks = by_name(run(dataclasses.replace(settings, lifecycle_cycles=1), harness(defect="vram_leak")))
    assert checks["lifecycle_cycles"]["passed"] is False and "VRAM not released" in checks["lifecycle_cycles"]["error"]


def test_graph_spy_counts_and_calls_through():
    class Graph:
        def __init__(self):
            self.events = []

        def capture_begin(self):
            self.events.append("begin")

        def capture_end(self):
            self.events.append("end")

        def replay(self):
            self.events.append("replay")

    spy = qualify.GraphSpy(Graph)
    graph = Graph()
    graph.capture_begin()
    graph.capture_end()
    graph.replay()
    graph.replay()
    assert spy.counts() == {"captures": 1, "replays": 2} and graph.events == ["begin", "end", "replay", "replay"]
    with qualify.CaptureFault(Graph):
        with pytest.raises(RuntimeError, match="injected"):
            graph.capture_begin()
    graph.capture_begin()
    spy.restore()
    graph.replay()
    assert spy.counts() == {"captures": 1, "replays": 2} and graph.events[-2:] == ["begin", "replay"]


def test_long_text_needs_more_codec_steps_than_the_graphs_hold():
    text = qualify.long_text(MAX_SEQ_LEN)
    assert len(text) > MAX_SEQ_LEN * 4 and text.count(".") > 10


def test_long_reference_loops_the_source_past_the_requested_seconds(tmp_path):
    source = make_reference(tmp_path / "src.wav", 10, frames=1600, rate=800)
    duration, repeats = qualify.long_reference(source, tmp_path / "long.wav", 7.0)
    with wave.open(str(tmp_path / "long.wav"), "rb") as audio:
        assert audio.getnframes() == 1600 * 4 and audio.getframerate() == 800 and audio.getnchannels() == 1
    assert duration == 8.0 and repeats == 4


def test_vram_filler_declines_without_cuda():
    filler = qualify.VramFiller(SimpleNamespace(cuda=None))
    assert filler.fill() == {"provoked": False, "reason": "no CUDA allocator in this meter"}
    filler.release()


@pytest.mark.parametrize("change", [
    {"device": "cpu"}, {"device": "mlx"}, {"model": "0.6B"}, {"second_model": "1.7B"}, {"lifecycle_cycles": -1},
    {"lifecycle_cycles": 101}, {"reference_b_text": " "}, {"text": ""},
])
def test_invalid_settings_are_refused(settings, change):
    with pytest.raises(ValueError):
        qualify.validate(dataclasses.replace(settings, **change))


def test_identical_references_are_refused(settings):
    with pytest.raises(ValueError, match="distinct"):
        qualify.validate(dataclasses.replace(settings, reference_b=settings.reference_a))


def test_main_reports_checks_and_exit_status(settings, monkeypatch, capsys):
    import functools
    fixture = harness(defect="frozen_rng")
    monkeypatch.setattr(qualify.bench, "configure_offline", lambda *args: None)
    admitted = {"repo_id": "Qwen/Qwen3-TTS-12Hz-0.6B-Base", "revision": "a" * 40, "snapshot": "fake"}
    monkeypatch.setattr(qualify, "qualify", functools.partial(
        qualify.qualify, factory=fixture.factory, admit=lambda _: admitted, identify=lambda _: {"fixture": True},
        verify_residency=lambda roots, device: {"fixture": True}, meter_factory=fixture.meter_factory,
        filler_factory=fixture.filler_factory, graph_class=FakeCUDAGraph, package_version=lambda name: "0.3.2"))
    argv = ["--device", "cuda", "--cache-root", str(settings.cache_root), "--output-root", str(settings.output_root),
            "--reference-a", str(settings.reference_a), "--reference-a-text", "A.",
            "--reference-b", str(settings.reference_b), "--reference-b-text", "B."]
    assert qualify.main(argv) == 2
    printed = capsys.readouterr().err.splitlines()
    assert "FAIL seed_behavior" in printed and "PASS two_speakers_no_leak" in printed
    assert any(line.startswith("RECORDED ") and line.endswith("first_generation_after_capture_timing") for line in printed)
    report = json.loads((settings.output_root / "results.json").read_text())
    assert report["provenance"]["runner_sha256"] == hashlib.sha256(SCRIPT.read_bytes()).hexdigest()
    assert qualify.main(["--device", "gpu"] + argv[2:]) == 2


def test_cli_refuses_missing_cache_before_importing_models(tmp_path, settings):
    result = subprocess.run(
        [sys.executable, "-B", str(SCRIPT), "--device", "cuda", "--cache-root", str(settings.cache_root),
         "--output-root", str(tmp_path / "cli-run"), "--reference-a", str(settings.reference_a),
         "--reference-a-text", "A.", "--reference-b", str(settings.reference_b), "--reference-b-text", "B."],
        capture_output=True, text=True, timeout=60)
    assert result.returncode == 2, result.stdout + result.stderr
    assert "not locally ready" in result.stderr
    assert json.loads((tmp_path / "cli-run" / "results.json").read_text())["checks"] == []


def test_qualifier_entry_point_installs_the_same_offline_guard(settings):
    result = subprocess.run([sys.executable, "-B", str(SCRIPT.with_name("tests") / "offline_guard_probe.py"), str(SCRIPT),
                             str(settings.cache_root), str(settings.output_root)], capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr


def test_loaded_adapter_and_cleanup_failure_are_refused(settings):
    fixture = harness()

    def loaded(*args):
        backend = fixture.factory(*args)
        backend.model = Qwen3TTSModel()
        return backend

    report = run(settings, fixture, factory=loaded)
    assert report["status"] == "failed" and "fresh unloaded" in report["error"]["message"]

    def failing_unload(*args):
        backend = fixture.factory(*args)

        def unload():
            raise RuntimeError("unload failed")

        backend.unload_model = unload
        return backend

    report = run(dataclasses.replace(settings, output_root=settings.output_root.with_name("run-cleanup")), fixture,
                 factory=failing_unload, checks=[])
    assert report["status"] == "failed" and report["cleanup_error"]["message"] == "unload failed"


def test_capture_fault_swallowed_or_misreported_fails_recovery(settings):
    checks = by_name(run(settings, harness(defect="ignores_capture_fault")))
    error = checks["capture_failure_recovery"]["error"]
    assert "load succeeded although capture failed" in error and "capture completed despite the fault" in error
    checks = by_name(run(dataclasses.replace(settings, output_root=settings.output_root.with_name("run-wrong")),
                         harness(defect="wrong_capture_error")))
    assert "raised ValueError, not CudaGraphRuntimeError" in checks["capture_failure_recovery"]["error"]


def test_oom_that_never_happens_or_that_unloads_is_handled(settings):
    checks = by_name(run(settings, harness(harmless_oom=True)))
    evidence = checks["oom_recovery"]["evidence"]
    assert checks["oom_recovery"]["kind"] == "recorded" and evidence["provoked"] is False and "no OOM" in evidence["reason"]
    checks = by_name(run(dataclasses.replace(settings, output_root=settings.output_root.with_name("run-unloads")),
                         harness(defect="oom_unloads")))
    assert checks["oom_recovery"]["passed"] is True and checks["oom_recovery"]["evidence"]["recovered"]["bit_exact"] is True


def test_reload_without_recapture_fails_lifecycle(settings):
    checks = by_name(run(dataclasses.replace(settings, lifecycle_cycles=1), harness(defect="no_recapture")))
    assert checks["lifecycle_cycles"]["passed"] is False and "did not recapture" in checks["lifecycle_cycles"]["error"]


def test_missing_runtime_package_fails_identity(settings):
    import importlib.metadata

    def missing(name):
        raise importlib.metadata.PackageNotFoundError(name)

    checks = by_name(run(settings, harness(), package_version=missing))
    assert checks["runtime_identity_truthful"]["passed"] is False and "installed None" in checks["runtime_identity_truthful"]["error"]


def test_vram_filler_uses_torch_allocator_when_present(monkeypatch):
    allocations = []
    fake_torch = SimpleNamespace(
        uint8="u8",
        cuda=SimpleNamespace(mem_get_info=lambda device: (10**9, 2 * 10**9)),
        empty=lambda size, dtype, device: allocations.append((size, dtype, device)) or "block")
    monkeypatch.setitem(sys.modules, "torch", fake_torch)
    meter = SimpleNamespace(cuda=SimpleNamespace(empty_cache=lambda: allocations.append("emptied")), device="cuda:0")
    filler = qualify.VramFiller(meter, headroom_bytes=1000)
    assert filler.fill() == {"provoked": True, "held_bytes": 10**9 - 1000} and filler.block == "block"
    filler.release()
    assert filler.block is None and allocations == [(10**9 - 1000, "u8", "cuda:0"), "emptied"]
    fake_torch.cuda.mem_get_info = lambda device: (500, 2 * 10**9)
    assert filler.fill() == {"provoked": False, "reason": "only 500 bytes free"}

    def refuse(size, dtype, device):
        raise RuntimeError("CUDA out of memory")

    fake_torch.cuda.mem_get_info = lambda device: (10**9, 2 * 10**9)
    fake_torch.empty = refuse
    assert filler.fill()["reason"].startswith("filler allocation failed")
    monkeypatch.setitem(sys.modules, "torch", SimpleNamespace(cuda=SimpleNamespace(CUDAGraph=FakeCUDAGraph)))
    assert qualify.cuda_graph_class() is FakeCUDAGraph


def test_main_success_exit_status(settings, monkeypatch):
    import functools
    fixture = harness()
    monkeypatch.setattr(qualify.bench, "configure_offline", lambda *args: None)
    admitted = {"repo_id": "Qwen/Qwen3-TTS-12Hz-0.6B-Base", "revision": "a" * 40, "snapshot": "fake"}
    monkeypatch.setattr(qualify, "qualify", functools.partial(
        qualify.qualify, factory=fixture.factory, admit=lambda _: admitted, identify=lambda _: {"fixture": True},
        verify_residency=lambda roots, device: {"fixture": True}, meter_factory=fixture.meter_factory,
        filler_factory=fixture.filler_factory, graph_class=FakeCUDAGraph, package_version=lambda name: "0.3.2"))
    assert qualify.main(["--device", "cuda", "--cache-root", str(settings.cache_root), "--output-root", str(settings.output_root),
                         "--reference-a", str(settings.reference_a), "--reference-a-text", "A.",
                         "--reference-b", str(settings.reference_b), "--reference-b-text", "B.", "--lifecycle-cycles", "1"]) == 0
