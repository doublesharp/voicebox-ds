"""Deterministic offline benchmark behavior with caller-selected output paths."""

import os
import asyncio
from dataclasses import asdict, replace
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
import wave

import numpy as np
import pytest


def symlink_or_skip(target, link, **kwargs):
    try:
        link.symlink_to(target, **kwargs)
    except OSError as exc:
        pytest.skip(f"this account cannot create symlinks (winerror {getattr(exc, 'winerror', None)})")


SCRIPT = Path(__file__).resolve().parents[1] / "benchmark-local-tts.py"
SPEC = importlib.util.spec_from_file_location("benchmark_local_tts", SCRIPT)
bench = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = bench
SPEC.loader.exec_module(bench)


@pytest.fixture
def settings(tmp_path):
    cache = tmp_path / "cache"
    cache.mkdir()
    return bench.Settings("qwen_custom_voice", "pytorch", "cpu", "1.7B", "en", "Test speech.",
                          cache, tmp_path / "output", preset_voice="Ryan", warm_repeats=2)


@pytest.fixture
def cached(settings):
    repo = settings.cache_root / "models--Qwen--Qwen3-TTS-12Hz-1.7B-CustomVoice"
    snapshot = repo / "snapshots" / ("a" * 40)
    snapshot.mkdir(parents=True)
    (repo / "refs").mkdir()
    (repo / "refs" / "main").write_text("a" * 40)
    for name in ("config.json", "generation_config.json", "tokenizer_config.json",
                 "vocab.json", "merges.txt", "preprocessor_config.json", "model.safetensors",
                 "speech_tokenizer/config.json", "speech_tokenizer/preprocessor_config.json",
                 "speech_tokenizer/model.safetensors"):
        path = snapshot / name
        path.parent.mkdir(exist_ok=True)
        path.write_text('{"tts_model_type": "custom_voice"}' if name == "config.json" else "{}")
    return repo, snapshot


class FakeAdapter:
    def __init__(self, fail=None, outputs=None):
        self.fail, self.outputs = fail, outputs
        self.loads, self.unloads, self.calls, self.references = [], 0, [], []

    def is_loaded(self):
        return self.fail == "already_loaded"

    async def load_model(self, model):
        self.loads.append(model)
        if self.fail == "load":
            raise RuntimeError("load failed")

    async def create_voice_prompt(self, path, text, use_cache):
        self.references.append((path, text, use_cache))
        if self.fail == "reference":
            raise RuntimeError("reference failed")
        return {"ref_audio": path, "ref_text": text}, False

    async def generate(self, text, prompt, **kwargs):
        self.calls.append((text, prompt, kwargs))
        if self.fail == "generate" or (self.fail == "second" and len(self.calls) == 2):
            raise RuntimeError("generation failed")
        if self.fail == "interrupt":
            raise KeyboardInterrupt()
        return self.outputs if self.outputs is not None else (np.array([0., .25, -.25, 1.5]), 4)

    def unload_model(self):
        self.unloads += 1
        if self.fail == "unload":
            raise RuntimeError("unload failed")


def run_fake(settings, adapter, **kwargs):
    output = bench.Output(settings.output_root)
    ticks = iter(range(0, 100 * 10**9, 10**9))
    spec = bench.ENGINES[settings.engine]
    fake_spec = replace(spec, admit=lambda _: {"snapshot": "fake-cached-snapshot", "repo_id": "fake", "revision": "a" * 40},
                        inference_roots=lambda adapter: {"fake": adapter})
    try:
        with pytest.MonkeyPatch.context() as patch:
            patch.setitem(bench.ENGINES, settings.engine, fake_spec)
            result = asyncio.run(bench.benchmark(
                settings, output, clock=lambda: next(ticks),
                get_provenance=lambda: {"fixture": True},
                **{"factory": lambda *args: adapter, "identify": lambda _: {"fixture": True},
                   "verify_residency": lambda roots, device: {"fixture": True},
                   "meter_factory": lambda device, clock: bench.telemetry.StageMeter.for_device("cpu", clock),
                   **kwargs},
            ))
        saved = json.loads((settings.output_root / "results.json").read_text())
        assert saved["status"] == result["status"]
        return result
    finally:
        output.close()


def test_cli_refuses_missing_cache_before_loading_or_writing_audio(tmp_path):
    cache = tmp_path / "empty-cache"
    cache.mkdir()
    output = tmp_path / "run"
    result = subprocess.run(
        [sys.executable, "-B", str(SCRIPT), "--engine", "qwen_custom_voice",
         "--backend", "pytorch", "--device", "cpu", "--model", "1.7B", "--language", "en",
         "--preset-voice", "Ryan", "--text", "A short offline test.",
         "--cache-root", str(cache), "--output-root", str(output)],
        env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
        capture_output=True, text=True, timeout=30,
    )
    assert result.returncode == 2, result.stdout + result.stderr
    assert "not locally ready" in result.stderr
    assert not list(output.rglob("*.wav"))
    report = json.loads((output / "results.json").read_text())
    assert report["status"] == "failed" and report["error"]["stage"] == "admission"


def test_cold_warm_metrics_prompt_and_real_wav(settings):
    adapter = FakeAdapter()
    result = run_fake(settings, adapter)
    assert result["status"] == "ok"
    assert adapter.loads == ["1.7B"] and adapter.unloads == 1
    assert len(adapter.calls) == 3
    assert adapter.calls[0] == ("Test speech.", {"voice_type": "preset", "preset_engine": "qwen_custom_voice",
                                               "preset_voice_id": "Ryan"},
                                {"language": "en", "seed": 0, "instruct": None})
    assert {k: v for k, v in result["stages_s"].items() if not k.startswith("generation")} == {
        "adapter_init": 1, "load": 1, "reference_preparation": 1}
    assert set(result["stages"]) == {"adapter_init", "load", "reference_preparation", "generation_0", "generation_1", "generation_2"}
    assert result["stages"]["load"]["rss_bytes"] > 0 and result["stages"]["load"]["cuda_allocated_bytes"] is None
    assert result["schema_version"] == 2 and result["device"] == {"fixture": True}
    assert result["reference_preparation"] == {"use_cache": False, "cache_hit": None}
    assert result["cold_load_reference_generation_rtf"] == 3
    assert result["warm"]["wall_audio_rtf"] == {"count": 2, "p50": 1, "p95": 1}
    assert [run["kind"] for run in result["runs"]] == ["cold", "warm", "warm"]
    for run in result["runs"]:
        assert run["duration_s"] == 1 and run["generation_s"] == 1 and run["wall_audio_rtf"] == 1
        assert run["first_model_audio_s"] is None
        assert run["clipped_samples_pcm16"] == 1
        with wave.open(str(settings.output_root / run["wav"]), "rb") as audio:
            assert (audio.getnframes(), audio.getframerate(), audio.getsampwidth()) == (4, 4, 2)
            assert np.frombuffer(audio.readframes(4), dtype="<i2").tolist() == [0, 8191, -8191, 32767]


def test_distribution_uses_linear_interpolation_and_empty_is_unavailable():
    assert bench.distribution([]) is None
    assert bench.distribution([9]) == {"count": 1, "p50": 9, "p95": 9}
    assert bench.distribution([9, 1, 3, 7])["p50"] == 5
    assert bench.distribution([9, 1, 3, 7])["p95"] == pytest.approx(8.7)


def test_no_warm_repeats_is_not_a_fake_distribution(settings):
    result = run_fake(replace(settings, warm_repeats=0), FakeAdapter())
    assert result["warm"]["generation_s"] is None
    assert len(result["runs"]) == 1


def make_reference(path, frames=8, rate=8):
    with wave.open(str(path), "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(rate)
        audio.writeframes(b"\0\0" * frames)
    return path


def test_reference_prompt_is_prepared_once_without_shared_cache(settings, tmp_path):
    ref = make_reference(tmp_path / "ref.wav")
    settings = replace(settings, engine="qwen", preset_voice=None, reference=ref, reference_text="Reference speech.")
    adapter = FakeAdapter()
    result = run_fake(settings, adapter)
    assert adapter.references == [(str(ref), "Reference speech.", False)]
    assert result["reference"]["duration_s"] == 1
    assert len(result["reference"]["sha256"]) == 64


def test_voice_design_and_instruction_are_explicit(settings):
    settings = replace(settings, engine="qwen_voice_design", preset_voice=None,
                       design_prompt="A clear voice.", instruct="Speak slowly.")
    bench.validate(settings)
    adapter = FakeAdapter()
    result = run_fake(settings, adapter)
    assert result["status"] == "ok"
    assert adapter.calls[0][1] == {"voice_type": "designed", "design_prompt": "A clear voice."}
    assert adapter.calls[0][2]["instruct"] == "Speak slowly."


@pytest.mark.parametrize("failure,stage", [("load", "load"), ("generate", "generation_0"),
                                          ("second", "generation_1"), ("already_loaded", "adapter_init"),
                                          ("interrupt", "generation_0")])
def test_failures_keep_partial_results_and_always_unload(settings, failure, stage):
    adapter = FakeAdapter(fail=failure)
    result = run_fake(settings, adapter)
    assert result["status"] == "failed" and result["error"]["stage"] == stage
    assert adapter.unloads == 1
    assert result["warm"] is None
    assert len(result["runs"]) == (1 if failure == "second" else 0)


def test_reference_failure_unloads(settings, tmp_path):
    settings = replace(settings, reference=make_reference(tmp_path / "ref.wav"), reference_text="Ref")
    adapter = FakeAdapter(fail="reference")
    result = run_fake(settings, adapter)
    assert result["status"] == "failed" and result["error"]["stage"] == "reference_preparation"
    assert adapter.unloads == 1


def test_unload_failure_cannot_be_success(settings):
    result = run_fake(settings, FakeAdapter(fail="unload"))
    assert result["status"] == "failed" and result["cleanup_error"]["message"] == "unload failed"


@pytest.mark.parametrize("audio,rate", [([], 24000), ([float("nan")], 24000), ([float("inf")], 24000),
                                       ([[0., 1.]], 24000), ([1+2j], 24000), ([0.], 0), ([0.], -1),
                                       ([0.], float("nan")), ([0.], 2.5), ([0.], True), ([0.], 192001)])
def test_bad_model_audio_is_failed_and_not_written(settings, audio, rate):
    adapter = FakeAdapter(outputs=(audio, rate))
    result = run_fake(settings, adapter)
    assert result["status"] == "failed" and result["error"]["stage"] == "generation_0"
    assert not list(settings.output_root.glob("*.wav")) and adapter.unloads == 1


def test_duration_and_total_artifact_budget(settings, monkeypatch):
    result = run_fake(replace(settings, max_audio_seconds=.5), FakeAdapter())
    assert result["status"] == "failed" and "duration limit" in result["error"]["message"]
    monkeypatch.setattr(bench, "MAX_ARTIFACT_BYTES", 1)
    result = run_fake(replace(settings, output_root=settings.output_root.parent / "budget"), FakeAdapter())
    assert result["status"] == "failed" and "budget" in result["error"]["message"]


@pytest.mark.parametrize("change", [
    {"engine": "remote"}, {"backend": "auto"}, {"model": "2B"},
    {"engine": "qwen_voice_design", "model": "0.6B"}, {"language": "auto"},
    {"text": " "}, {"text": "a" * 2001}, {"warm_repeats": -1}, {"warm_repeats": 21},
    {"seed": -1}, {"seed": 2**32}, {"max_audio_seconds": float("nan")}, {"max_audio_seconds": 121},
    {"max_audio_seconds": 0}, {"instruct": " "}, {"preset_voice": "unknown"}, {"preset_voice": None},
    {"reference_text": "Unexpected reference"}, {"design_prompt": "Unexpected design"},
    {"engine": "qwen"}, {"engine": "qwen_voice_design"}, {"cache_root": Path("relative")},
    {"device": "auto"}, {"device": "mlx"}, {"device": "cuda0"}, {"device": "CUDA"}, {"device": "gpu"},
    {"backend": "mlx"}, {"backend": "mlx", "device": "cpu"},
])
def test_invalid_configuration_is_rejected(settings, change):
    with pytest.raises(ValueError):
        bench.validate(replace(settings, **change))


def test_base_rejects_silently_ignored_instruction(settings, tmp_path):
    settings = replace(settings, engine="qwen", reference=make_reference(tmp_path / "ref.wav"),
                       reference_text="Ref", preset_voice=None, instruct="Ignored style")
    with pytest.raises(ValueError, match="does not support"):
        bench.validate(settings)
    bench.validate(replace(settings, instruct=None))
    bench.validate(replace(settings, backend="mlx", device="mlx", instruct=None))


def test_readiness_is_local_and_checks_selected_revision(settings, cached, monkeypatch):
    repo, snapshot = cached
    # No network libraries are imported for admission.
    before = set(sys.modules)
    result = bench.admit_cached_model(settings)
    assert result["revision"] == "a" * 40 and result["snapshot"] == str(snapshot)
    assert not any(name.startswith("huggingface_hub") for name in set(sys.modules) - before)
    (snapshot / "model.safetensors").unlink()
    stale = repo / "snapshots" / ("b" * 40)
    stale.mkdir()
    (stale / "model.safetensors").write_text("stale")
    with pytest.raises(ValueError, match="not locally ready"):
        bench.admit_cached_model(settings)


@pytest.mark.parametrize("corruption", ["revision", "oversized_revision", "incomplete", "missing_codec", "shard", "escape", "mode", "json", "alias"])
def test_cache_admission_refuses_partial_or_unsafe_snapshots(settings, cached, corruption, tmp_path):
    repo, snapshot = cached
    if corruption == "revision":
        (repo / "refs" / "main").write_text("../../elsewhere")
    elif corruption == "oversized_revision":
        (repo / "refs" / "main").write_text("a" * 129)
    elif corruption == "incomplete":
        (repo / "blobs").mkdir()
        (repo / "blobs" / "abc.incomplete").write_text("partial")
    elif corruption == "missing_codec":
        (snapshot / "speech_tokenizer" / "model.safetensors").unlink()
    elif corruption in ("shard", "escape"):
        name = "missing.safetensors" if corruption == "shard" else "../../escape.safetensors"
        (snapshot / "model.safetensors.index.json").write_text(json.dumps({"weight_map": {"weight": name}}))
    elif corruption == "mode":
        (snapshot / "config.json").write_text('{"tts_model_type": "base"}')
    elif corruption == "json":
        (snapshot / "config.json").write_text("broken json")
    elif corruption == "alias":
        renamed = repo.with_name("foreign-repo")
        repo.rename(renamed)
        symlink_or_skip(renamed, repo, target_is_directory=True)
    with pytest.raises(ValueError, match="not locally ready"):
        bench.admit_cached_model(settings)


def test_shards_and_hf_blob_symlinks_are_supported(settings, cached):
    repo, snapshot = cached
    blobs = repo / "blobs"
    blobs.mkdir()
    blob = blobs / "complete"
    blob.write_bytes(b"pretend weights")
    (blobs / "complete.incomplete").write_text("stale incomplete")
    symlink_or_skip(blob, snapshot / "shard.safetensors")
    (snapshot / "model.safetensors.index.json").write_text(json.dumps({"weight_map": {"weight": "shard.safetensors"}}))
    assert bench.admit_cached_model(settings)["revision"] == "a" * 40


def test_cache_file_symlink_escape_is_refused(settings, cached, tmp_path):
    _, snapshot = cached
    outside = tmp_path / "outside"
    outside.write_text("weights")
    (snapshot / "model.safetensors").unlink()
    symlink_or_skip(outside, snapshot / "model.safetensors")
    with pytest.raises(ValueError, match="escapes"):
        bench.admit_cached_model(settings)


def test_outputs_require_fresh_absolute_directory_and_no_symlinks(tmp_path):
    with pytest.raises(ValueError, match="absolute"):
        bench.Output(Path("relative"))
    with pytest.raises(ValueError, match="fresh subdirectory"):
        bench.Output(Path(tmp_path.anchor))
    with pytest.raises(ValueError, match="absolute"):
        bench.Output(tmp_path / ".." / "unsafe")
    output = bench.Output(tmp_path / "safe")
    try:
        with output.open("owned.json") as handle:
            handle.write(b"first")
        with pytest.raises(FileExistsError):
            output.open("owned.json")
        with pytest.raises(ValueError, match="single filename"):
            output.open("../escape")
    finally:
        output.close()
    with pytest.raises(ValueError, match="already exists"):
        bench.Output(tmp_path / "safe")
    symlink_or_skip(tmp_path / "safe", tmp_path / "link", target_is_directory=True)
    with pytest.raises(OSError):
        bench.Output(tmp_path / "link" / "escape")
    assert not (tmp_path / "safe" / "escape").exists()


def test_output_root_is_selected_by_caller_without_a_mount_requirement(settings, monkeypatch):
    monkeypatch.setattr(Path, "is_mount", lambda _: False)
    output = bench.Output(settings.output_root)
    output.close()
    assert settings.output_root.is_dir()


def test_reference_bounds_and_empty_audio(settings, tmp_path):
    with pytest.raises(ValueError, match="absolute local WAV"):
        bench.reference_info(Path("relative.wav"))
    with pytest.raises(ValueError, match="nonempty"):
        bench.reference_info(make_reference(tmp_path / "empty.wav", frames=0))
    with pytest.raises(ValueError, match="30 seconds"):
        bench.reference_info(make_reference(tmp_path / "long.wav", frames=31, rate=1))


def test_read_json_size_is_bounded(tmp_path):
    oversized = tmp_path / "oversized.json"
    oversized.write_bytes(b" " * (1024 * 1024 + 1))
    with pytest.raises(ValueError, match="oversized"):
        bench.read_json(oversized)


@pytest.mark.parametrize("engine,backend,module,class_name", [
    ("qwen", "mlx", "mlx_backend", "MLXTTSBackend"),
    ("qwen", "pytorch", "pytorch_backend", "PyTorchTTSBackend"),
    ("qwen_custom_voice", "mlx", "qwen_mlx_styles_backend", "QwenMLXCustomVoiceBackend"),
    ("qwen_voice_design", "mlx", "qwen_mlx_styles_backend", "QwenMLXVoiceDesignBackend"),
    ("qwen_custom_voice", "pytorch", "qwen_custom_voice_backend", "QwenCustomVoiceBackend"),
    ("qwen_voice_design", "pytorch", "qwen_voice_design_backend", "QwenVoiceDesignBackend"),
    ("chatterbox_turbo", "pytorch", "chatterbox_turbo_backend", "ChatterboxTurboTTSBackend"),
])
def test_factory_uses_only_selected_adapter_and_pins_local_snapshot(settings, monkeypatch, engine, backend, module, class_name):
    config_dirs, requested = [], []
    patch = SimpleNamespace(ensure_original_qwen_config_cached=lambda: pytest.fail("shared cache mutation"))
    monkeypatch.setitem(sys.modules, "backend", SimpleNamespace(config=SimpleNamespace(set_data_dir=config_dirs.append)))
    monkeypatch.setitem(sys.modules, "backend.utils", SimpleNamespace(hf_offline_patch=patch))

    class Constructed:
        def __init__(self, size="constructed-without-size"):
            self.size = size

    def import_module(name):
        requested.append(name)
        return SimpleNamespace(**{class_name: Constructed}, __file__=str(SCRIPT))

    monkeypatch.setattr(bench.importlib, "import_module", import_module)
    device = "mlx" if backend == "mlx" else "cpu"
    adapter = bench.create_adapter(replace(settings, engine=engine, backend=backend, device=device),
                                   {"snapshot": "/explicit/cached/snapshot"}, SimpleNamespace(path=settings.output_root))
    expected_size = "constructed-without-size" if engine == "chatterbox_turbo" else "1.7B"
    assert adapter.size == expected_size and requested == ["backend.backends." + module]
    assert adapter._get_model_path("1.7B") == "/explicit/cached/snapshot"
    assert adapter._is_model_cached() is True
    assert len(adapter._benchmark_source_sha256) == 64
    assert config_dirs == [settings.output_root / "runtime" / "data"]
    patch.ensure_original_qwen_config_cached()  # now a no-op


def test_provenance_records_versions_commit_and_source_hash():
    result = bench.provenance()
    assert len(result["git_commit"]) == 40 and isinstance(result["git_dirty"], bool)
    assert result["versions"]["numpy"] and len(result["runner_sha256"]) == 64
    assert result["recorded_at_utc"].endswith("+00:00")


def test_provenance_preserves_unknowns_instead_of_inventing_versions(monkeypatch):
    def missing(*args, **kwargs):
        raise bench.importlib.metadata.PackageNotFoundError()

    def no_git(*args, **kwargs):
        raise OSError("git unavailable")

    monkeypatch.setattr(bench.importlib.metadata, "version", missing)
    monkeypatch.setattr(bench.subprocess, "check_output", no_git)
    result = bench.provenance()
    assert result["git_commit"] is None and result["git_dirty"] is None
    assert all(value is None for value in result["versions"].values())


def test_cli_help_and_unsafe_output_refusal(tmp_path):
    help_result = subprocess.run([sys.executable, "-B", str(SCRIPT), "--help"], capture_output=True, text=True, timeout=10)
    assert help_result.returncode == 0 and "--warm-repeats" in help_result.stdout
    result = subprocess.run([sys.executable, "-B", str(SCRIPT), "--engine", "qwen_custom_voice",
                             "--backend", "pytorch", "--device", "cpu", "--model", "1.7B", "--language", "en",
                             "--preset-voice", "Ryan", "--text", "Offline test.",
                             "--cache-root", str(tmp_path), "--output-root", "relative-benchmark"],
                            capture_output=True, text=True, timeout=10)
    assert result.returncode == 2 and "absolute" in result.stderr


def test_main_entry_point_failure_is_nonzero_and_closes_output(settings, monkeypatch):
    # Keep the irreversible network audit hook out of the pytest process.
    monkeypatch.setattr(bench, "configure_offline", lambda *args: None)
    code = bench.main(["--engine", settings.engine, "--backend", settings.backend, "--device", "cpu",
                       "--model", settings.model, "--language", settings.language,
                       "--text", settings.text, "--preset-voice", "Ryan",
                       "--cache-root", str(settings.cache_root), "--output-root", str(settings.output_root)])
    assert code == 2
    assert json.loads((settings.output_root / "results.json").read_text())["status"] == "failed"
    assert bench.main(["--engine", "invalid", "--backend", "pytorch", "--device", "cpu", "--model", "1.7B",
                       "--language", "en", "--text", "Test", "--cache-root", str(settings.cache_root),
                       "--output-root", str(settings.output_root)]) == 2


def test_offline_guard_blocks_sync_and_asyncio_network_in_subprocess(settings):
    result = subprocess.run([sys.executable, "-B", str(SCRIPT.with_name("tests") / "offline_guard_probe.py"), str(SCRIPT),
                             str(settings.cache_root), str(settings.output_root)], capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr
    assert result.stdout.strip() == "offline guard passed"


def test_offline_configuration_and_guard_without_process_side_effects(settings, monkeypatch):
    output = bench.Output(settings.output_root)
    hooks = []
    monkeypatch.setattr(os, "environ", {})
    monkeypatch.setattr(sys, "addaudithook", hooks.append)
    monkeypatch.setattr(sys, "dont_write_bytecode", True)
    monkeypatch.setattr(bench.tempfile, "tempdir", None)
    try:
        bench.configure_offline(settings, output)
        assert os.environ["VOICEBOX_OFFLINE_PATCH"] == "0"
        assert Path(os.environ["TORCH_HOME"]).is_relative_to(settings.output_root)
        assert bench.tempfile.tempdir == str(settings.output_root / "runtime" / "tmp")
        guard = hooks[0]
        with pytest.raises(OSError, match="network lookup"):
            guard("socket.getaddrinfo", ())
        with pytest.raises(OSError, match="network connections"):
            guard("socket.connect", (SimpleNamespace(family=bench.socket.AF_INET), ("192.0.2.1", 443)))
        guard("socket.connect", (SimpleNamespace(family=getattr(bench.socket, "AF_UNIX", bench.socket.AF_UNSPEC)), "local"))
        with pytest.raises(OSError, match="network connections"):
            guard("socket.connect", (SimpleNamespace(family=bench.socket.AF_INET), ("127.0.0.1", 80)))
        for family in (bench.socket.AF_INET, bench.socket.AF_INET6):
            with pytest.raises(OSError, match="network sockets"):
                guard("socket.__new__", (None, family, bench.socket.SOCK_STREAM, 0))
        guard("socket.__new__", (None, getattr(bench.socket, "AF_UNIX", bench.socket.AF_UNSPEC), bench.socket.SOCK_STREAM, 0))
        guard("unrelated.event", ())
    finally:
        output.close()


def test_main_success_and_output_close(settings, monkeypatch):
    opened = []
    original_output = bench.Output

    def open_output(path):
        result = original_output(path)
        opened.append(result)
        return result

    async def fake_benchmark(*args):
        return {"status": "ok"}

    monkeypatch.setattr(bench, "Output", open_output)
    monkeypatch.setattr(bench, "configure_offline", lambda *args: None)
    monkeypatch.setattr(bench, "benchmark", fake_benchmark)
    assert bench.main(["--engine", settings.engine, "--backend", settings.backend, "--device", "cpu",
                       "--model", settings.model, "--language", settings.language,
                       "--text", settings.text, "--preset-voice", "Ryan",
                       "--cache-root", str(settings.cache_root), "--output-root", str(settings.output_root)]) == 0
    with pytest.raises(OSError):
        os.fstat(opened[0].fd)


@pytest.mark.parametrize("elapsed", [-1, float("nan"), float("inf")])
def test_invalid_clock_metrics_are_refused(elapsed):
    with pytest.raises(ValueError, match="monotonic elapsed"):
        bench.audio_metrics(np.zeros(4), 4, elapsed, 30)


def test_mlx_cache_mapping_and_empty_index_fail_closed(settings, cached):
    repo, snapshot = cached
    mlx_repo = repo.with_name("models--mlx-community--Qwen3-TTS-12Hz-1.7B-Base-bf16")
    repo.rename(mlx_repo)
    snapshot = mlx_repo / "snapshots" / snapshot.name
    (snapshot / "config.json").write_text('{"tts_model_type": "base"}')
    mlx_settings = replace(settings, backend="mlx", engine="qwen")
    assert bench.admit_cached_model(mlx_settings)["repo_id"].startswith("mlx-community/")
    (snapshot / "model.safetensors.index.json").write_text('{"weight_map": {}}')
    with pytest.raises(ValueError, match="empty weight index"):
        bench.admit_cached_model(mlx_settings)


def test_reference_truncated_payload_is_refused(tmp_path):
    path = make_reference(tmp_path / "truncated.wav")
    path.write_bytes(path.read_bytes()[:-2])
    with pytest.raises(ValueError, match="truncated"):
        bench.reference_info(path)


def test_nonfinite_json_is_refused_before_model_loading(settings, cached):
    _, snapshot = cached
    (snapshot / "generation_config.json").write_text('{"temperature": NaN}')
    with pytest.raises(ValueError, match="nonfinite JSON"):
        bench.admit_cached_model(settings)


@pytest.mark.parametrize("engine,variant,mode", [
    ("qwen_custom_voice", "CustomVoice", "custom_voice"),
    ("qwen_voice_design", "VoiceDesign", "voice_design"),
])
def test_mlx_style_admission_matches_integrated_backend(settings, cached, engine, variant, mode):
    repo, snapshot = cached
    mlx_repo = repo.with_name(f"models--mlx-community--Qwen3-TTS-12Hz-1.7B-{variant}-bf16")
    repo.rename(mlx_repo)
    snapshot = mlx_repo / "snapshots" / snapshot.name
    (snapshot / "config.json").write_text(json.dumps({"tts_model_type": mode}))
    selected = replace(settings, backend="mlx", device="mlx", engine=engine,
                       preset_voice="Ryan" if mode == "custom_voice" else None,
                       design_prompt="A clear natural voice." if mode == "voice_design" else None)
    bench.validate(selected)
    admitted = bench.admit_cached_model(selected)
    assert admitted["repo_id"] == f"mlx-community/Qwen3-TTS-12Hz-1.7B-{variant}-bf16"
    assert admitted["snapshot"] == str(snapshot)


def turbo_settings(settings, tmp_path):
    ref = make_reference(tmp_path / "turbo-ref.wav")
    return replace(settings, engine="chatterbox_turbo", model="default", preset_voice=None,
                   reference=ref, reference_text="Turbo reference.")


@pytest.fixture
def turbo_cached(settings):
    repo = settings.cache_root / "models--ResembleAI--chatterbox-turbo"
    snapshot = repo / "snapshots" / ("c" * 40)
    snapshot.mkdir(parents=True)
    (repo / "refs").mkdir()
    (repo / "refs" / "main").write_text("c" * 40)
    for name in bench.TURBO_WEIGHT_FILES:
        (snapshot / name).write_bytes(b"x" * 8)
    return repo, snapshot


def test_turbo_asset_policy_matches_backend_weight_files():
    pytest.importorskip("torch")
    from backend.backends import chatterbox_turbo_backend as turbo
    assert list(bench.TURBO_WEIGHT_FILES) == turbo._TURBO_WEIGHT_FILES
    assert bench.TURBO_REPO == turbo.CHATTERBOX_TURBO_HF_REPO


def test_turbo_admission_pins_local_revision_and_sizes(settings, turbo_cached, tmp_path):
    _, snapshot = turbo_cached
    selected = turbo_settings(settings, tmp_path)
    bench.validate(selected)
    admitted = bench.admit_cached_turbo(selected)
    assert admitted["repo_id"] == "ResembleAI/chatterbox-turbo" and admitted["revision"] == "c" * 40
    assert admitted["snapshot"] == str(snapshot)
    assert admitted["files"] == {name: 8 for name in bench.TURBO_WEIGHT_FILES}


@pytest.mark.parametrize("corruption", ["missing_weight", "empty_weight", "incomplete", "revision", "alias", "escape"])
def test_turbo_admission_refuses_partial_or_unsafe_snapshots(settings, turbo_cached, corruption, tmp_path):
    repo, snapshot = turbo_cached
    if corruption == "missing_weight":
        (snapshot / "conds.pt").unlink()
    elif corruption == "empty_weight":
        (snapshot / "ve.safetensors").write_bytes(b"")
    elif corruption == "incomplete":
        (repo / "blobs").mkdir()
        (repo / "blobs" / "abc.incomplete").write_text("partial")
    elif corruption == "revision":
        (repo / "refs" / "main").write_text("main")
    elif corruption == "alias":
        renamed = repo.with_name("foreign-turbo")
        repo.rename(renamed)
        symlink_or_skip(renamed, repo, target_is_directory=True)
    elif corruption == "escape":
        outside = tmp_path / "outside.safetensors"
        outside.write_bytes(b"weights")
        (snapshot / "ve.safetensors").unlink()
        symlink_or_skip(outside, snapshot / "ve.safetensors")
    with pytest.raises(ValueError, match="not locally ready"):
        bench.admit_cached_turbo(turbo_settings(settings, tmp_path))


@pytest.mark.parametrize("change", [
    {"language": "de"}, {"model": "1.7B"}, {"backend": "mlx", "device": "mlx"}, {"instruct": "Whisper."},
    {"preset_voice": "Ryan"}, {"design_prompt": "A voice."}, {"reference": None}, {"reference_text": None},
])
def test_turbo_is_english_cloning_only(settings, tmp_path, change):
    with pytest.raises(ValueError):
        bench.validate(replace(turbo_settings(settings, tmp_path), **change))


class FakeTurboAdapter(FakeAdapter):
    """Fake Turbo adapter: records the loaded revision the way the backend does."""

    def __init__(self, revision="c" * 40, hit=False, **kwargs):
        super().__init__(**kwargs)
        self._conditioning_model_id = "ResembleAI/chatterbox-turbo"
        self.revision, self.hit = revision, hit
        self.model = SimpleNamespace(t3=None, s3gen=None, ve=None)

    async def load_model(self, model):
        await super().load_model(model)
        self._conditioning_model_id = f"ResembleAI/chatterbox-turbo@{self.revision}"

    async def create_voice_prompt(self, path, text, use_cache):
        prompt, _ = await super().create_voice_prompt(path, text, use_cache)
        return prompt, self.hit


def run_turbo(settings, adapter, tmp_path, **kwargs):
    selected = turbo_settings(settings, tmp_path)
    admitted = {"snapshot": "fake", "repo_id": "ResembleAI/chatterbox-turbo", "revision": "c" * 40}
    spec = replace(bench.ENGINES["chatterbox_turbo"], admit=lambda _: admitted)
    output = bench.Output(selected.output_root)
    ticks = iter(range(0, 100 * 10**9, 10**9))
    try:
        with pytest.MonkeyPatch.context() as patch:
            patch.setitem(bench.ENGINES, "chatterbox_turbo", spec)
            return asyncio.run(bench.benchmark(
                selected, output, factory=lambda *args: adapter, clock=lambda: next(ticks),
                get_provenance=lambda: {"fixture": True}, identify=lambda _: {"fixture": True},
                **{"verify_residency": lambda roots, device: {"roots": sorted(roots)}, **kwargs}))
    finally:
        output.close()


def test_turbo_run_prepares_through_isolated_cache_and_verifies_revision(settings, tmp_path):
    adapter = FakeTurboAdapter()
    result = run_turbo(settings, adapter, tmp_path)
    assert result["status"] == "ok", result.get("error")
    assert adapter.references[0][2] is True
    assert result["reference_preparation"] == {"use_cache": True, "cache_hit": False}
    assert result["adapter"]["loaded_revision"] == "ResembleAI/chatterbox-turbo@" + "c" * 40
    assert result["residency"] == {"roots": ["s3gen", "t3", "ve"]}
    assert adapter.loads == ["default"] and adapter.unloads == 1


def test_turbo_run_fails_on_revision_mismatch_before_generating(settings, tmp_path):
    adapter = FakeTurboAdapter(revision="d" * 40)
    result = run_turbo(settings, adapter, tmp_path)
    assert result["status"] == "failed" and result["error"]["stage"] == "residency"
    assert "expected ResembleAI/chatterbox-turbo@" + "c" * 40 in result["error"]["message"]
    assert adapter.calls == [] and adapter.unloads == 1


def test_turbo_run_fails_when_first_preparation_hits(settings, tmp_path):
    adapter = FakeTurboAdapter(hit=True)
    result = run_turbo(settings, adapter, tmp_path)
    assert result["status"] == "failed" and result["error"]["stage"] == "reference_preparation"
    assert "cache hit" in result["error"]["message"] and adapter.calls == []


def test_residency_mismatch_fails_the_run_after_load(settings, tmp_path):
    def mismatch(roots, device):
        raise bench.telemetry.ResidencyError("fake: tensors on ['cpu'], expected cuda:0")

    adapter = FakeAdapter()
    result = run_fake(settings, adapter, verify_residency=mismatch)
    assert result["status"] == "failed" and result["error"]["stage"] == "residency"
    assert adapter.loads == ["1.7B"] and adapter.calls == [] and adapter.unloads == 1


def test_real_residency_check_runs_on_adapter_roots(settings):
    torch = pytest.importorskip("torch")
    adapter = FakeAdapter()
    adapter.model = SimpleNamespace(inner=torch.nn.Linear(1, 1))
    result = run_fake(settings, adapter, verify_residency=bench.telemetry.check_residency)
    assert result["status"] == "ok", result.get("error")
    assert result["residency"] == {"fake": {"devices": ["cpu"], "dtypes": ["torch.float32"], "tensors": 2}}


def test_device_refusal_happens_before_adapter_construction(settings):
    def refuse(_):
        raise bench.telemetry.DeviceRefused("torch reports CUDA not available")

    constructed = []
    result = run_fake(replace(settings, device="cuda"), FakeAdapter(), identify=refuse,
                      factory=lambda *args: constructed.append(args))
    assert result["status"] == "failed" and result["error"] == {
        "stage": "device", "type": "DeviceRefused", "message": "torch reports CUDA not available"}
    assert constructed == [] and result["stages"] == {}


def test_device_identity_requires_nvidia_for_cuda_and_skips_torch_for_mlx(settings, monkeypatch):
    calls = []

    rocm = bench.telemetry.DeviceIdentity("os", "x", "2.9", None, "6.2", False, 0, (), "no smi", None, "cuda:0", None, None)

    def identity(device, **kwargs):
        calls.append(device)
        return replace(rocm, selected_device=device)

    monkeypatch.setattr(bench.telemetry, "collect_identity", identity)
    monkeypatch.delenv("CUDA_VISIBLE_DEVICES", raising=False)
    assert bench.device_identity(replace(settings, backend="mlx", device="mlx"))["selected_device"] == "mlx"
    assert calls == []
    assert bench.device_identity(settings) == {**asdict(rocm), "selected_device": "cpu", "requested_device": "cpu",
                                               "cuda_visible_devices": None, "selected_gpu": None}
    with pytest.raises(bench.telemetry.DeviceRefused, match="ROCm"):
        bench.device_identity(replace(settings, device="cuda:1"))
    assert calls == ["cpu", "cuda:0"]


@pytest.mark.parametrize("device,expected", [
    ("cpu", {"VOICEBOX_FORCE_CPU": "1", "CUDA_VISIBLE_DEVICES": "-1"}),
    ("cuda", {"CUDA_VISIBLE_DEVICES": "0", "CUDA_DEVICE_ORDER": "PCI_BUS_ID"}),
    ("cuda:1", {"CUDA_VISIBLE_DEVICES": "1", "CUDA_DEVICE_ORDER": "PCI_BUS_ID"}), ("mlx", {}),
])
def test_device_selection_is_forced_through_environment_before_imports(settings, device, expected):
    assert bench.device_environment(replace(settings, device=device)) == expected
    assert bench.torch_device(replace(settings, device=device)) == {"cpu": "cpu", "mlx": "mlx"}.get(device, "cuda:0")


def test_offline_configuration_forces_cpu_and_windows_temp(settings, monkeypatch):
    output = bench.Output(settings.output_root)
    monkeypatch.setattr(os, "environ", {"CUDA_VISIBLE_DEVICES": "0"})
    monkeypatch.setattr(sys, "addaudithook", lambda hook: None)
    monkeypatch.setattr(bench.tempfile, "tempdir", None)
    try:
        bench.configure_offline(settings, output)
        temporary = str(settings.output_root / "runtime" / "tmp")
        assert os.environ["VOICEBOX_FORCE_CPU"] == "1" and os.environ["CUDA_VISIBLE_DEVICES"] == "-1"
        assert os.environ["TMPDIR"] == os.environ["TEMP"] == os.environ["TMP"] == temporary
    finally:
        output.close()


def test_offline_configuration_for_cuda_drops_an_inherited_cpu_override(settings, monkeypatch):
    output = bench.Output(settings.output_root)
    monkeypatch.setattr(os, "environ", {"VOICEBOX_FORCE_CPU": "1"})
    monkeypatch.setattr(sys, "addaudithook", lambda hook: None)
    monkeypatch.setattr(bench.tempfile, "tempdir", None)
    try:
        bench.configure_offline(replace(settings, device="cuda:1"), output)
        assert "VOICEBOX_FORCE_CPU" not in os.environ
        assert os.environ["CUDA_VISIBLE_DEVICES"] == "1" and os.environ["CUDA_DEVICE_ORDER"] == "PCI_BUS_ID"
    finally:
        output.close()


def test_device_identity_records_the_selected_nvidia_smi_gpu(settings, monkeypatch):
    gpus = (bench.telemetry.Gpu(0, "GPU zero", 8000, "8.9", "610"), bench.telemetry.Gpu(1, "GPU one", 16000, "12.0", "610"))
    identity = bench.telemetry.DeviceIdentity("os", "x", "2.9", "12.8", None, True, 1, gpus, None, True, "cuda:0", "GPU one", "12.0")
    monkeypatch.setattr(bench.telemetry, "collect_identity", lambda device, **kwargs: identity)
    monkeypatch.setenv("CUDA_VISIBLE_DEVICES", "1")
    record = bench.device_identity(replace(settings, device="cuda:1"))
    assert record["selected_gpu"] == asdict(gpus[1]) and record["cuda_visible_devices"] == "1"
    monkeypatch.setenv("CUDA_VISIBLE_DEVICES", "2")
    with pytest.raises(bench.telemetry.DeviceRefused, match="nvidia-smi"):
        bench.device_identity(replace(settings, device="cuda:2"))


def test_cli_requires_explicit_device(tmp_path):
    result = subprocess.run([sys.executable, "-B", str(SCRIPT), "--engine", "qwen_custom_voice",
                             "--backend", "pytorch", "--model", "1.7B", "--language", "en",
                             "--preset-voice", "Ryan", "--text", "Offline test.",
                             "--cache-root", str(tmp_path), "--output-root", str(tmp_path / "run")],
                            capture_output=True, text=True, timeout=10)
    assert result.returncode == 2 and "--device" in result.stderr
    assert not (tmp_path / "run").exists()


def test_qwen_inference_roots_are_the_loaded_model():
    adapter = SimpleNamespace(model="loaded")
    assert bench.qwen_inference_roots(adapter) == {"model": "loaded"}


def test_socketpair_emulation_gate_admits_only_loopback_connects_from_cpython_emulation(monkeypatch):
    connect = (SimpleNamespace(family=bench.socket.AF_INET), ("127.0.0.1", 50000))

    def emulated():
        bench.deny_network("socket.__new__", (None, bench.socket.AF_INET, bench.socket.SOCK_STREAM, 0))
        bench.deny_network("socket.connect", connect)
        return bench.inside_socketpair_emulation()

    monkeypatch.setattr(bench.socket, "_fallback_socketpair", emulated, raising=False)
    assert emulated() is True
    with pytest.raises(OSError, match="network sockets"):
        bench.deny_network("socket.__new__", (None, bench.socket.AF_INET, bench.socket.SOCK_STREAM, 0))
    with pytest.raises(OSError, match="network connections"):
        bench.deny_network("socket.connect", (SimpleNamespace(family=bench.socket.AF_INET), ("10.0.0.1", 50000)))
    assert bench.inside_socketpair_emulation() is False
    monkeypatch.delattr(bench.socket, "_fallback_socketpair")
    assert bench.inside_socketpair_emulation() is False
    with pytest.raises(OSError, match="network connections"):
        bench.deny_network("socket.connect", connect)


class FakeGraphAdapter(FakeAdapter):
    """Fake Qwen adapter honoring the C1 runtime contract: runtime_identity
    after load, last_generation after every generate."""

    def __init__(self, runtime="cudagraph", **kwargs):
        super().__init__(**kwargs)
        self.runtime = runtime
        self.model = SimpleNamespace()
        self.runtime_identity = None
        self.last_generation = None

    async def load_model(self, model):
        await super().load_model(model)
        if self.runtime == "cudagraph":
            self.runtime_identity = {"runtime": "cudagraph", "package": "faster-qwen3-tts", "version": "0.3.2",
                                     "commit": "a" * 40, "dtype": "bfloat16", "attn": "sdpa", "max_seq_len": 2048,
                                     "graph_capture_s": 4.5}
        else:
            self.runtime_identity = {"runtime": "stock"}

    async def generate(self, text, prompt, **kwargs):
        audio = await super().generate(text, prompt, **kwargs)
        self.last_generation = {"steps": 40 + len(self.calls), "hit_eos": len(self.calls) % 2 == 1, "max_new_tokens": 2048}
        return audio


def graph_settings(settings, tmp_path, model="0.6B-cudagraph", **changes):
    ref = make_reference(tmp_path / "ref.wav")
    return replace(settings, engine="qwen", device="cuda", model=model, preset_voice=None,
                   reference=ref, reference_text="Reference speech.", **changes)


@pytest.mark.parametrize("model", ["0.6B-cudagraph", "1.7B-cudagraph"])
def test_cudagraph_models_are_admitted_on_cuda_pytorch_qwen_only(settings, tmp_path, model):
    selected = graph_settings(settings, tmp_path, model=model)
    bench.validate(selected)
    bench.validate(replace(selected, device="cuda:1"))
    for change in ({"device": "cpu"}, {"backend": "mlx", "device": "mlx"}, {"engine": "qwen_custom_voice", "reference": None,
                   "reference_text": None, "preset_voice": "Ryan"}):
        with pytest.raises(ValueError):
            bench.validate(replace(selected, **change))
    assert bench.stock_model(model) == model.removesuffix("-cudagraph")
    assert bench.expected_runtime(model) == "cudagraph" and bench.expected_runtime("0.6B") == "stock"


def test_cudagraph_admission_uses_the_stock_repository(settings, cached, tmp_path):
    repo, snapshot = cached
    base_repo = repo.with_name("models--Qwen--Qwen3-TTS-12Hz-1.7B-Base")
    repo.rename(base_repo)
    (base_repo / "snapshots" / snapshot.name / "config.json").write_text('{"tts_model_type": "base"}')
    admitted = bench.admit_cached_model(graph_settings(settings, tmp_path, model="1.7B-cudagraph"))
    assert admitted["repo_id"] == "Qwen/Qwen3-TTS-12Hz-1.7B-Base"


def test_cudagraph_run_records_runtime_identity_capture_and_generation_facts(settings, tmp_path):
    selected = graph_settings(settings, tmp_path, seeds=(3, 5), warm_repeats=3)
    adapter = FakeGraphAdapter()
    result = run_fake(selected, adapter)
    assert result["status"] == "ok", result.get("error")
    assert adapter.loads == ["0.6B-cudagraph"]
    assert result["runtime_identity"]["runtime"] == "cudagraph"
    assert result["graph_capture"] == {"wall_s": 4.5, "included_in_stage": "load", "source": "runtime_identity.graph_capture_s"}
    assert "graph_capture" not in result["stages_s"] and "graph_capture" not in result["stages"]
    assert sum(result["stages_s"].values()) == sum(stage["wall_s"] for stage in result["stages"].values())
    assert [run["seed"] for run in result["runs"]] == [3, 5, 3, 5]
    assert [call[2]["seed"] for call in adapter.calls] == [3, 5, 3, 5]
    assert [run["steps"] for run in result["runs"]] == [41, 42, 43, 44]
    assert [run["hit_eos"] for run in result["runs"]] == [True, False, True, False]
    assert all(run["max_new_tokens"] == 2048 for run in result["runs"])
    assert result["warm"]["steps"] == {"count": 3, "p50": 43, "p95": 43.9}
    assert result["warm"]["hit_eos_count"] == 1 and result["warm"]["bound_count"] == 2
    assert result["streaming"] == {"generate_stream": False, "first_frame_measured": False}


def test_streaming_is_reported_only_for_a_callable_generate_stream(settings, tmp_path):
    """PyTorchTTSBackend exposes generate_stream as None while the stock model is resident."""
    stock = FakeGraphAdapter(runtime="stock")
    stock.generate_stream = None
    assert run_fake(graph_settings(settings, tmp_path, model="0.6B"), stock)["streaming"]["generate_stream"] is False
    native = FakeGraphAdapter()
    native.generate_stream = lambda *args, **kwargs: iter(())
    result = run_fake(graph_settings(settings, tmp_path, output_root=settings.output_root.with_name("run-native")), native)
    assert result["streaming"] == {"generate_stream": True, "first_frame_measured": False}


def test_stock_run_keeps_old_shape_with_null_generation_facts(settings):
    result = run_fake(settings, FakeAdapter())
    assert result["runtime_identity"] is None and result["graph_capture"] is None
    assert "graph_capture" not in result["stages_s"]
    assert [run["seed"] for run in result["runs"]] == [0, 0, 0]
    assert result["runs"][0]["steps"] is None and result["runs"][0]["hit_eos"] is None
    assert result["warm"]["steps"] is None and result["warm"]["hit_eos_count"] is None


def test_stock_adapter_reporting_cudagraph_or_cudagraph_reporting_stock_fails_before_generation(settings, tmp_path):
    adapter = FakeGraphAdapter(runtime="stock")
    result = run_fake(graph_settings(settings, tmp_path), adapter)
    assert result["status"] == "failed" and result["error"]["stage"] == "runtime"
    assert "silent" in result["error"]["message"] and adapter.calls == [] and adapter.unloads == 1
    adapter = FakeGraphAdapter(runtime="cudagraph")
    result = run_fake(graph_settings(settings, tmp_path, model="0.6B", output_root=settings.output_root.with_name("stock")), adapter)
    assert result["status"] == "failed" and result["error"]["stage"] == "runtime" and adapter.calls == []


def test_warmup_repeats_are_recorded_but_excluded_from_warm(settings):
    result = run_fake(replace(settings, warmup_repeats=2, warm_repeats=2), FakeAdapter())
    assert [run["kind"] for run in result["runs"]] == ["cold", "warmup", "warmup", "warm", "warm"]
    assert result["warm"]["generation_s"]["count"] == 2
    assert [run["wav"] for run in result["runs"]][:3] == ["cold-00.wav", "warmup-01.wav", "warmup-02.wav"]


@pytest.mark.parametrize("change", [{"seeds": (2**32,)}, {"seeds": (-1,)}, {"seeds": tuple(range(21))},
                                    {"warmup_repeats": -1}, {"warmup_repeats": 21}])
def test_seed_list_and_warmup_bounds_are_validated(settings, change):
    with pytest.raises(ValueError):
        bench.validate(replace(settings, **change))


def test_cli_parses_seed_list_and_warmup(settings):
    parsed = bench.parse_args(["--engine", "qwen", "--backend", "pytorch", "--device", "cuda", "--model", "0.6B-cudagraph",
                               "--language", "en", "--text", "Hi", "--cache-root", str(settings.cache_root),
                               "--output-root", str(settings.output_root), "--seeds", "1, 2,3", "--warmup-repeats", "1"])
    assert parsed.seeds == (1, 2, 3) and parsed.warmup_repeats == 1 and parsed.seed == 0
    assert bench.parse_args(["--engine", "qwen", "--backend", "pytorch", "--device", "cpu", "--model", "0.6B",
                             "--language", "en", "--text", "Hi", "--cache-root", "c", "--output-root", "o"]).seeds == ()
    with pytest.raises(SystemExit):
        bench.parse_args(["--engine", "qwen", "--backend", "pytorch", "--device", "cpu", "--model", "0.6B",
                          "--language", "en", "--text", "Hi", "--cache-root", "c", "--output-root", "o", "--seeds", "1,x"])


def test_run_seed_cycles_seed_list_or_falls_back_to_seed():
    assert bench.run_seed(replace(bench.Settings("qwen", "pytorch", "cpu", "0.6B", "en", "t", Path("c"), Path("o")), seed=9), 4) == 9
    cycled = replace(bench.Settings("qwen", "pytorch", "cpu", "0.6B", "en", "t", Path("c"), Path("o")), seeds=(4, 8))
    assert [bench.run_seed(cycled, index) for index in range(3)] == [4, 8, 4]
