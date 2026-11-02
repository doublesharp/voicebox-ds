"""Comparison driver logic with a fake subprocess runner (no models, no GPU)."""

from dataclasses import replace
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
import wave

import numpy as np
import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "compare-local-tts.py"
SPEC = importlib.util.spec_from_file_location("compare_local_tts", SCRIPT)
compare = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = compare
SPEC.loader.exec_module(compare)


def make_reference(path, fill=0, frames=800, rate=800):
    with wave.open(str(path), "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(rate)
        audio.writeframes(bytes([fill, 0]) * frames)
    return path


@pytest.fixture
def settings(tmp_path):
    cache = tmp_path / "hub"
    cache.mkdir()
    return compare.Settings("cuda", cache, tmp_path / "cmp", "0.6B", "0.6B-cudagraph",
                            make_reference(tmp_path / "a.wav", 10), "Reference A.",
                            make_reference(tmp_path / "b.wav", 200), "Reference B.",
                            rounds=2, warm_repeats=2, warmup_repeats=1, seeds=(3, 5), texts=("short", "medium"))


def argv_value(argv, flag):
    return argv[argv.index(flag) + 1]


class FakeRunner:
    """Fake subprocess runner: writes the results.json a benchmark child would,
    or the quality.json the scorer would, into the --output-root it was given.
    Candidate generations are 10x faster than baseline; the stock model never
    reports steps."""

    def __init__(self, fail_jobs=(), cold_only=False, quality_rc=0):
        self.calls, self.fail_jobs, self.cold_only, self.quality_rc = [], set(fail_jobs), cold_only, quality_rc

    def __call__(self, argv, **kwargs):
        self.calls.append(argv)
        root = Path(argv_value(argv, "--output-root"))
        root.mkdir(parents=True)
        if argv[2].endswith("score-local-tts.py"):
            (root / "quality.json").write_text(json.dumps({"status": "ok", "groups": {"baseline": {"count": 1}}}))
            return SimpleNamespace(returncode=self.quality_rc, stdout=str(root / "quality.json"), stderr="")
        model = argv_value(argv, "--model")
        if root.name in self.fail_jobs:
            (root / "results.json").write_text(json.dumps({"status": "failed", "error": {"stage": "load", "message": "boom"}, "runs": []}))
            return SimpleNamespace(returncode=2, stdout="", stderr="load failed")
        seeds = [int(s) for s in argv_value(argv, "--seeds").split(",")]
        warm, warmup = int(argv_value(argv, "--warm-repeats")), int(argv_value(argv, "--warmup-repeats"))
        graph = model.endswith("cudagraph")
        base = 1.0 if graph else 10.0
        runs, stages = [], {"load": {"wall_s": 20.0, "cuda_allocated_peak_bytes": 2 * 10**9, "rss_bytes": 10**9}}
        total = 1 if self.cold_only else warmup + warm + 1
        for index in range(total):
            kind = "cold" if index == 0 else ("warmup" if index <= warmup else "warm")
            elapsed = base * (3 if index == 0 else 1) + index * 0.1
            wav = root / f"{kind}-{index:02d}.wav"
            make_reference(wav, frames=4, rate=4)
            runs.append({"kind": kind, "index": index, "seed": seeds[index % len(seeds)], "wav": wav.name,
                         "duration_s": 4.0, "generation_s": elapsed, "wall_audio_rtf": elapsed / 4,
                         "steps": 48 + index if graph else None, "hit_eos": (index != 1) if graph else None,
                         "max_new_tokens": 2048 if graph else None})
            stages[f"generation_{index}"] = {"wall_s": elapsed, "cuda_allocated_peak_bytes": 3 * 10**9 + index,
                                             "cuda_reserved_peak_bytes": 4 * 10**9, "rss_bytes": 10**9 + index}
        identity = {"runtime": "cudagraph", "graph_capture_s": 4.5} if graph else {"runtime": "stock"}
        (root / "results.json").write_text(json.dumps({
            "status": "ok", "config": {"model": model, "text": argv_value(argv, "--text")}, "runtime_identity": identity,
            "graph_capture": {"wall_s": 4.5} if graph else None, "runs": runs, "stages": stages,
            "stages_s": {name: stage["wall_s"] for name, stage in stages.items()},
            "device": {"selected_gpu": {"name": "fake"}}}))
        return SimpleNamespace(returncode=0, stdout=str(root / "results.json"), stderr="")


def snapshots():
    counter = iter(range(100))
    return lambda index: {"memory_used_mib": 1600 + next(counter), "memory_total_mib": 8151, "utilization_percent": 5, "index": index}


def run(settings, runner, **kwargs):
    output = compare.Output(settings.output_root)
    try:
        report = compare.compare(settings, output, runner=runner, gpu_snapshot=snapshots(),
                                 admit=lambda s: {"snapshot": "fake", "repo_id": "fake", "revision": "a" * 40},
                                 get_provenance=lambda: {"fixture": True}, **kwargs)
    finally:
        output.close()
    saved = json.loads((settings.output_root / "comparison.json").read_text())
    assert saved["status"] == report["status"]
    return report


def test_plan_alternates_abba_over_rounds_with_fresh_process_per_cell(settings):
    jobs = compare.plan_jobs(settings)
    assert len(jobs) == 2 * 2 * 2 * 2
    assert [job.label for job in jobs[:8]] == ["baseline"] * 4 + ["candidate"] * 4
    assert [job.label for job in jobs[8:]] == ["candidate"] * 4 + ["baseline"] * 4
    assert jobs[0].name == "r00-00-baseline-short-a" and jobs[15].name == "r01-07-baseline-medium-b"
    assert {(job.text_id, job.reference_id) for job in jobs} == {("short", "a"), ("short", "b"), ("medium", "a"), ("medium", "b")}
    assert jobs[8].model == "0.6B-cudagraph" and jobs[0].model == "0.6B"
    assert len({job.name for job in jobs}) == 16


def test_child_argv_pins_assets_seeds_and_decoding_for_both_configs(settings):
    job = compare.plan_jobs(settings)[9]
    argv = compare.child_argv(settings, job, Path("/out"))
    assert argv[:2] == [settings.python, "-B"] and argv[2].endswith("benchmark-local-tts.py")
    assert argv_value(argv, "--model") == "0.6B-cudagraph" and argv_value(argv, "--engine") == "qwen"
    assert argv_value(argv, "--device") == "cuda" and argv_value(argv, "--seeds") == "3,5"
    assert argv_value(argv, "--warm-repeats") == "2" and argv_value(argv, "--warmup-repeats") == "1"
    assert argv_value(argv, "--text") == compare.CORPUS[job.text_id]
    assert argv_value(argv, "--reference") == str(settings.reference_b) and argv_value(argv, "--reference-text") == "Reference B."
    assert argv_value(argv, "--output-root") == str(Path("/out") / "runs" / job.name)
    assert argv_value(argv, "--max-audio-seconds") == "30.0" and argv_value(argv, "--language") == "en"


def test_corpus_is_fixed_and_matched():
    assert set(compare.CORPUS) == {"short", "medium", "paragraph", "names_numbers"}
    assert all(1 <= len(text) <= 2000 for text in compare.CORPUS.values())
    assert len(compare.CORPUS["short"]) < len(compare.CORPUS["medium"]) < len(compare.CORPUS["paragraph"])
    assert any(ch.isdigit() for ch in compare.CORPUS["names_numbers"]) and "$" in compare.CORPUS["names_numbers"]


def test_comparison_runs_serially_aggregates_warm_runs_and_exports_audition(settings):
    runner = FakeRunner()
    report = run(settings, runner)
    assert report["status"] == "ok", report.get("failures")
    assert len(runner.calls) == 17 and runner.calls[-1][2].endswith("score-local-tts.py")
    assert [Path(argv_value(argv, "--output-root")).name for argv in runner.calls[:16]] == [job["name"] for job in report["plan"]]
    assert [job["idle_gpu_before"]["memory_used_mib"] for job in report["jobs"]] == list(range(1600, 1616))
    assert all(job["status"] == "ok" and job["returncode"] == 0 for job in report["jobs"])
    baseline, candidate = report["summary"]["baseline"], report["summary"]["candidate"]
    assert baseline["processes"] == 8 and candidate["processes"] == 8
    assert baseline["warm_generation_s"]["count"] == 16 and candidate["warm_generation_s"]["count"] == 16
    assert baseline["warm_generation_s"]["p50"] == pytest.approx(10.25) and candidate["warm_generation_s"]["p50"] == pytest.approx(1.25)
    assert baseline["cold_generation_s"]["count"] == 8 and baseline["cold_generation_s"]["p50"] == 30
    assert baseline["warmup_excluded"] == 8
    assert candidate["steps"] == {"count": 16, "p50": 50.5, "p95": 51} and baseline["steps"] is None
    assert candidate["hit_eos_count"] == 16 and candidate["bound_count"] == 0 and baseline["hit_eos_count"] is None
    assert candidate["duration_s"]["p50"] == 4 and candidate["wall_audio_rtf"]["p50"] == pytest.approx(1.25 / 4)
    assert candidate["cuda_allocated_peak_bytes"]["p50"] == pytest.approx(3 * 10**9 + 2.5)
    assert candidate["rss_bytes"]["count"] == 16 and candidate["load_s"] == {"count": 8, "p50": 20, "p95": 20}
    assert candidate["graph_capture_s"] == {"count": 8, "p50": 4.5, "p95": 4.5} and baseline["graph_capture_s"] is None
    assert candidate["runtime_identity"] == {"runtime": "cudagraph", "graph_capture_s": 4.5}
    assert baseline["small_sample"] is False
    assert report["speedup"]["warm_generation_s_p50_ratio"] == pytest.approx(10.25 / 1.25)
    assert "baseline p50 / candidate p50" in report["speedup"]["method"]
    cell = report["cells"]["short/a"]
    assert cell["baseline"]["warm_generation_s"]["count"] == 4 and cell["candidate"]["small_sample"] is True
    assert cell["speedup_warm_generation_s_p50_ratio"] == pytest.approx(10.25 / 1.25)
    assert report["notes"]["small_sample"].startswith("fewer than 10")
    assert "never concurrently" in report["method"]
    manifest = json.loads((settings.output_root / "quality-manifest.json").read_text())
    assert manifest["language"] == "en" and set(manifest["references"]) == {"a", "b"}
    assert manifest["references"]["a"] == {"wav": str(settings.reference_a), "text": "Reference A."}
    assert len(manifest["rows"]) == 16 * 4
    row = manifest["rows"][0]
    assert row == {"id": "r00-00-baseline-short-a/cold-00.wav", "wav": str(settings.output_root / "runs" / "r00-00-baseline-short-a" / "cold-00.wav"),
                   "text": compare.CORPUS["short"], "group": "baseline", "text_id": "short", "reference_id": "a", "seed": 3, "kind": "cold"}
    quality_argv = runner.calls[-1]
    assert argv_value(quality_argv, "--manifest") == str(settings.output_root / "quality-manifest.json")
    assert argv_value(quality_argv, "--output-root") == str(settings.output_root / "quality") and argv_value(quality_argv, "--device") == "cuda"
    assert report["quality"] == {"status": "ok", "returncode": 0, "path": str(settings.output_root / "quality" / "quality.json"),
                                 "groups": {"baseline": {"count": 1}}}
    listener = json.loads((settings.output_root / "audition" / "manifest.json").read_text())
    key = json.loads((settings.output_root / "audition-key.json").read_text())
    assert len(listener["ids"]) == 32 and len(key) == 32 and set(listener["ids"]) == set(key)
    assert "label" not in json.dumps(listener) and "baseline" not in json.dumps(listener)
    assert {entry["label"] for entry in key.values()} == {"baseline", "candidate"}
    assert all(entry["kind"] == "warm" for entry in key.values())
    for blind_id in listener["ids"]:
        assert (settings.output_root / "audition" / f"{blind_id}.wav").stat().st_size > 44
        assert Path(key[blind_id]["wav"]).is_file()
    assert listener["ids"] != sorted(key, key=lambda i: key[i]["wav"]), "listener order must not follow generation order"
    assert report["audition"] == {"count": 32, "listener_manifest": str(settings.output_root / "audition" / "manifest.json"),
                                  "key": str(settings.output_root / "audition-key.json")}


def test_failed_child_is_recorded_and_the_rest_still_run(settings):
    runner = FakeRunner(fail_jobs={"r00-01-baseline-short-b"})
    report = run(settings, runner)
    assert report["status"] == "failed" and len(runner.calls) == 17
    failed = [job for job in report["jobs"] if job["status"] != "ok"]
    assert len(failed) == 1 and failed[0]["name"] == "r00-01-baseline-short-b" and failed[0]["returncode"] == 2
    assert "load failed" in failed[0]["stderr_tail"]
    assert report["summary"]["baseline"]["processes"] == 7 and report["cells"]["short/b"]["baseline"]["warm_generation_s"]["count"] == 2
    assert report["failures"] == ["job r00-01-baseline-short-b: status failed, exit 2"]


def test_cold_only_results_are_refused_as_a_comparison(settings):
    report = run(settings, FakeRunner(cold_only=True))
    assert report["status"] == "failed"
    assert report["summary"]["baseline"]["warm_generation_s"] is None
    assert any("no warm runs" in failure for failure in report["failures"])
    assert report["speedup"] is None


def test_quality_failure_fails_the_comparison_but_keeps_timing(settings):
    report = run(settings, FakeRunner(quality_rc=2))
    assert report["status"] == "failed" and report["quality"]["status"] == "ok" and report["quality"]["returncode"] == 2
    assert report["summary"]["candidate"]["warm_generation_s"]["count"] == 16
    assert report["failures"] == ["quality scoring exited 2"]


def test_skip_quality_runs_no_scorer(settings):
    runner = FakeRunner()
    report = run(replace(settings, skip_quality=True), runner)
    assert report["status"] == "ok" and len(runner.calls) == 16 and report["quality"] is None


def test_runner_exception_fails_the_job_and_continues(settings):
    class Flaky(FakeRunner):
        def __call__(self, argv, **kwargs):
            if len(self.calls) == 0:
                self.calls.append(argv)
                raise subprocess.TimeoutExpired(argv, 1)
            return super().__call__(argv, **kwargs)

    report = run(settings, Flaky())
    assert report["jobs"][0]["status"] == "error" and "TimeoutExpired" in report["jobs"][0]["error"]
    assert report["jobs"][1]["status"] == "ok" and report["status"] == "failed"


@pytest.mark.parametrize("change", [
    {"warm_repeats": 0}, {"candidate_model": "0.6B"}, {"device": "cpu"}, {"rounds": 0}, {"rounds": 21},
    {"texts": ("short", "unknown")}, {"texts": ()}, {"seeds": ()}, {"references": ("a", "c")}, {"references": ()},
    {"process_timeout_s": 0}, {"warmup_repeats": -1},
])
def test_invalid_settings_are_refused(settings, change):
    with pytest.raises(ValueError):
        compare.validate(replace(settings, **change), admit=lambda s: {})


def test_identical_references_are_refused(settings):
    with pytest.raises(ValueError, match="distinct"):
        compare.validate(replace(settings, reference_b=settings.reference_a), admit=lambda s: {})


def test_validate_admits_both_models_through_the_benchmark(settings):
    admitted = []
    compare.validate(settings, admit=lambda s: admitted.append(s.model))
    assert admitted == ["0.6B", "0.6B-cudagraph"]


def test_gpu_snapshot_parsing_selects_the_requested_index():
    text = "0, 1694, 8151, 9\n1, 20, 16000, 0\n"
    assert compare.parse_gpu_snapshot(text, 1) == {"index": 1, "memory_used_mib": 20, "memory_total_mib": 16000, "utilization_percent": 0}
    assert compare.parse_gpu_snapshot(text, 2) == {"index": 2, "error": "GPU index not reported by nvidia-smi"}
    assert compare.parse_gpu_snapshot(None, 0) == {"index": 0, "error": "nvidia-smi unavailable or failed"}
    assert compare.parse_gpu_snapshot("garbage", 0)["error"].startswith("unexpected")
    assert compare.gpu_index("cuda") == 0 and compare.gpu_index("cuda:3") == 3


def test_cli_dry_run_prints_the_plan_without_creating_output(settings, capsys, monkeypatch):
    monkeypatch.setattr(compare, "validate", lambda s, admit=None: None)
    argv = ["--device", "cuda", "--cache-root", str(settings.cache_root), "--output-root", str(settings.output_root),
            "--baseline-model", "0.6B", "--candidate-model", "0.6B-cudagraph",
            "--reference-a", str(settings.reference_a), "--reference-a-text", "A.",
            "--reference-b", str(settings.reference_b), "--reference-b-text", "B.", "--rounds", "1", "--texts", "short",
            "--seeds", "1,2", "--dry-run"]
    assert compare.main(argv) == 0
    lines = capsys.readouterr().out.strip().splitlines()
    assert lines[0].startswith("4 processes") and "r00-00-baseline-short-a" in lines[1]
    assert not settings.output_root.exists()


def test_cli_refuses_before_creating_output_and_reports_failures(settings, tmp_path, monkeypatch):
    result = subprocess.run([sys.executable, "-B", str(SCRIPT), "--device", "cuda", "--cache-root", str(settings.cache_root),
                             "--output-root", str(tmp_path / "cli"), "--baseline-model", "0.6B", "--candidate-model", "0.6B-cudagraph",
                             "--reference-a", str(settings.reference_a), "--reference-a-text", "A.",
                             "--reference-b", str(settings.reference_b), "--reference-b-text", "B."],
                            capture_output=True, text=True, timeout=60)
    assert result.returncode == 2 and "not locally ready" in result.stderr and not (tmp_path / "cli").exists()
    assert subprocess.run([sys.executable, "-B", str(SCRIPT), "--help"], capture_output=True, text=True, timeout=30).returncode == 0
    import functools
    monkeypatch.setattr(compare, "validate", lambda s, admit=None: None)
    monkeypatch.setattr(compare, "compare", functools.partial(
        compare.compare, runner=FakeRunner(cold_only=True), gpu_snapshot=snapshots(), admit=lambda s: {},
        get_provenance=lambda: {}))
    argv = ["--device", "cuda", "--cache-root", str(settings.cache_root), "--output-root", str(settings.output_root),
            "--baseline-model", "0.6B", "--candidate-model", "0.6B-cudagraph",
            "--reference-a", str(settings.reference_a), "--reference-a-text", "A.",
            "--reference-b", str(settings.reference_b), "--reference-b-text", "B.", "--rounds", "1", "--texts", "short", "--skip-quality"]
    assert compare.main(argv) == 2
    assert json.loads((settings.output_root / "comparison.json").read_text())["status"] == "failed"


def test_real_gpu_snapshot_tolerates_a_missing_tool(monkeypatch):
    monkeypatch.setattr(compare.subprocess, "check_output", lambda *a, **k: (_ for _ in ()).throw(OSError("no smi")))
    assert compare.nvidia_smi_snapshot(0) == {"index": 0, "error": "nvidia-smi unavailable or failed"}


def test_provenance_hashes_driver_benchmark_and_scorer():
    result = compare.provenance()
    assert len({result["runner_sha256"], result["benchmark_module_sha256"], result["scorer_sha256"]}) == 3


def test_run_process_captures_a_real_child():
    completed = compare.run_process([sys.executable, "-c", "import sys; print('out'); print('err', file=sys.stderr)"], 30)
    assert completed.returncode == 0 and completed.stdout.strip() == "out" and completed.stderr.strip() == "err"


def test_admission_failure_inside_compare_is_recorded(settings):
    def refuse(_):
        raise ValueError("model not locally ready: fake")

    output = compare.Output(settings.output_root)
    try:
        report = compare.compare(settings, output, runner=FakeRunner(), gpu_snapshot=snapshots(), admit=refuse,
                                 get_provenance=lambda: {})
    finally:
        output.close()
    assert report["status"] == "failed" and report["error"]["type"] == "ValueError" and report["jobs"] == []


def test_main_success_and_in_process_refusal(settings, monkeypatch, capsys):
    import functools
    monkeypatch.setattr(compare, "validate", lambda s, admit=None: None)
    monkeypatch.setattr(compare, "compare", functools.partial(
        compare.compare, runner=FakeRunner(), gpu_snapshot=snapshots(), admit=lambda s: {}, get_provenance=lambda: {}))
    argv = ["--device", "cuda", "--cache-root", str(settings.cache_root), "--output-root", str(settings.output_root),
            "--baseline-model", "0.6B", "--candidate-model", "0.6B-cudagraph",
            "--reference-a", str(settings.reference_a), "--reference-a-text", "A.",
            "--reference-b", str(settings.reference_b), "--reference-b-text", "B.", "--rounds", "1", "--texts", "short"]
    assert compare.main(argv) == 0
    assert json.loads((settings.output_root / "comparison.json").read_text())["status"] == "ok"

    def refuse(s, admit=None):
        raise ValueError("rounds must be 1..20")

    monkeypatch.setattr(compare, "validate", refuse)
    assert compare.main(argv[:5] + [str(settings.output_root.with_name("cmp2"))] + argv[6:]) == 2
    assert "comparison refused: rounds" in capsys.readouterr().err
