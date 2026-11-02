#!/usr/bin/env python3
"""Compare a baseline and a candidate Qwen configuration with
benchmark-local-tts.py, one fresh process per (round, config, text, reference)
cell, serially and never concurrently, alternating ABBA across rounds.

Every cell shares the fixed matched corpus, the same two references, the same
seed list and decoding settings. Only runs the child recorded as "warm" enter
the comparison; a child with no warm runs makes the comparison fail. The
idle-GPU state from nvidia-smi is recorded before each process. After every
process has finished, score-local-tts.py scores every WAV, and a blind
audition set is exported with its key kept apart from the listener manifest.
"""

import argparse
from dataclasses import asdict, dataclass
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import random
import re
import subprocess
import sys
import time


REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))
from scripts.portable_output import Output  # noqa: E402

_spec = importlib.util.spec_from_file_location("benchmark_local_tts", Path(__file__).with_name("benchmark-local-tts.py"))
bench = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = bench
_spec.loader.exec_module(bench)

BENCHMARK = Path(__file__).with_name("benchmark-local-tts.py")
SCORER = Path(__file__).with_name("score-local-tts.py")

CORPUS = {
    "short": "Hello from Voicebox. This speech was generated locally.",
    "medium": ("The library closes at eight tonight, so please return the borrowed telescope before the "
               "astronomy club meets on the roof."),
    "paragraph": ("Every spring the river rises past the old stone bridge, and the whole village turns out to "
                  "watch the water carry last year's leaves toward the sea. Children count the boats, elders "
                  "compare the flood to the ones they remember, and by evening someone has lit the lanterns "
                  "along the quay. Nobody plans it; the river simply calls, and the town answers."),
    "names_numbers": ("On March 3rd, 2026, Dr. Priya O'Neil paid $1,250.50 for 14 tickets; flight BA-287 "
                      "departs at 9:45 a.m. from gate B12, not B21."),
}
LABELS = ("baseline", "candidate")
METHOD = ("one fresh benchmark process per (round, config, text, reference) cell, run serially and never concurrently; "
          "config order alternates ABBA across rounds; each process runs one cold generation, warmup_repeats "
          "warmup generations and warm_repeats warm generations; only warm runs enter the summary")
SMALL_SAMPLE = "fewer than 10 warm samples: p95 is not a tail estimate and the ratio of medians is indicative only"
SMI_QUERY = ["nvidia-smi", "--query-gpu=index,memory.used,memory.total,utilization.gpu", "--format=csv,noheader,nounits"]


@dataclass(frozen=True)
class Settings:
    device: str
    cache_root: Path
    output_root: Path
    baseline_model: str
    candidate_model: str
    reference_a: Path
    reference_a_text: str
    reference_b: Path
    reference_b_text: str
    rounds: int = 2
    warm_repeats: int = 3
    warmup_repeats: int = 1
    seeds: tuple[int, ...] = (42, 7, 1234)
    texts: tuple[str, ...] = tuple(CORPUS)
    references: tuple[str, ...] = ("a", "b")
    language: str = "en"
    max_audio_seconds: float = 30.0
    process_timeout_s: float = 1800.0
    python: str = sys.executable
    skip_quality: bool = False
    dry_run: bool = False


@dataclass(frozen=True)
class Job:
    round: int
    position: int
    label: str
    model: str
    text_id: str
    reference_id: str

    @property
    def name(self):
        return f"r{self.round:02d}-{self.position:02d}-{self.label}-{self.text_id}-{self.reference_id}"


def reference(settings, reference_id):
    return {"a": (settings.reference_a, settings.reference_a_text),
            "b": (settings.reference_b, settings.reference_b_text)}[reference_id]


def model_of(settings, label):
    return settings.baseline_model if label == "baseline" else settings.candidate_model


def benchmark_settings(settings, label, text_id="short", reference_id="a"):
    path, text = reference(settings, reference_id)
    return bench.Settings("qwen", "pytorch", settings.device, model_of(settings, label), settings.language,
                          CORPUS[text_id], settings.cache_root, settings.output_root, path, text,
                          seeds=settings.seeds, warm_repeats=settings.warm_repeats,
                          warmup_repeats=settings.warmup_repeats, max_audio_seconds=settings.max_audio_seconds)


def validate(settings, *, admit=bench.admit_cached_model):
    if settings.warm_repeats < 1:
        raise ValueError("a comparison needs warm runs on both sides; warm repeats must be at least 1")
    if settings.baseline_model == settings.candidate_model:
        raise ValueError("baseline and candidate must differ")
    if not 1 <= settings.rounds <= 20:
        raise ValueError("rounds must be 1..20")
    if not settings.texts or any(text not in CORPUS for text in settings.texts):
        raise ValueError(f"texts must be a nonempty subset of {', '.join(CORPUS)}")
    if not settings.references or any(key not in ("a", "b") for key in settings.references):
        raise ValueError("references must be a nonempty subset of a, b")
    if not settings.seeds:
        raise ValueError("at least one seed is required")
    if not settings.process_timeout_s > 0:
        raise ValueError("process timeout must be positive")
    if settings.reference_b.resolve() == settings.reference_a.resolve():
        raise ValueError("references A and B must be distinct files")
    for label in LABELS:
        for reference_id in settings.references:
            bench.validate(benchmark_settings(settings, label, reference_id=reference_id))
        admit(benchmark_settings(settings, label))


def plan_jobs(settings):
    jobs = []
    for round_index in range(settings.rounds):
        order = LABELS if round_index % 2 == 0 else tuple(reversed(LABELS))
        position = 0
        for label in order:
            for text_id in settings.texts:
                for reference_id in settings.references:
                    jobs.append(Job(round_index, position, label, model_of(settings, label), text_id, reference_id))
                    position += 1
    return jobs


def child_argv(settings, job, root):
    path, text = reference(settings, job.reference_id)
    return [settings.python, "-B", str(BENCHMARK), "--engine", "qwen", "--backend", "pytorch",
            "--device", settings.device, "--model", job.model, "--language", settings.language,
            "--text", CORPUS[job.text_id], "--cache-root", str(settings.cache_root),
            "--output-root", str(root / "runs" / job.name), "--reference", str(path), "--reference-text", text,
            "--seeds", ",".join(str(seed) for seed in settings.seeds),
            "--warm-repeats", str(settings.warm_repeats), "--warmup-repeats", str(settings.warmup_repeats),
            "--max-audio-seconds", str(float(settings.max_audio_seconds))]


def scorer_argv(settings, root):
    return [settings.python, "-B", str(SCORER), "--manifest", str(root / "quality-manifest.json"),
            "--device", settings.device, "--cache-root", str(settings.cache_root), "--output-root", str(root / "quality")]


def gpu_index(device):
    return int(device.partition(":")[2] or 0)


def parse_gpu_snapshot(text, index):
    if text is None:
        return {"index": index, "error": "nvidia-smi unavailable or failed"}
    for line in text.splitlines():
        fields = [field.strip() for field in line.split(",")]
        if len(fields) != 4 or not all(re.fullmatch(r"\d+", field) for field in fields):
            return {"index": index, "error": f"unexpected nvidia-smi row: {line!r}"}
        if int(fields[0]) == index:
            return {"index": index, "memory_used_mib": int(fields[1]), "memory_total_mib": int(fields[2]),
                    "utilization_percent": int(fields[3])}
    return {"index": index, "error": "GPU index not reported by nvidia-smi"}


def nvidia_smi_snapshot(index):
    try:
        text = subprocess.check_output(SMI_QUERY, text=True, stderr=subprocess.DEVNULL, timeout=20)
    except (OSError, subprocess.SubprocessError):
        text = None
    return parse_gpu_snapshot(text, index)


def run_process(argv, timeout):
    return subprocess.run(argv, capture_output=True, text=True, timeout=timeout,
                          env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})


def provenance():
    return {**bench.provenance(), "runner_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "benchmark_module_sha256": hashlib.sha256(BENCHMARK.read_bytes()).hexdigest(),
            "scorer_sha256": hashlib.sha256(SCORER.read_bytes()).hexdigest()}


def warm_runs(result):
    return [run for run in result.get("runs", []) if run["kind"] == "warm"]


def summarize(results):
    """Per-config summary over the warm runs of every completed child result."""
    warm = [(result, run) for result in results for run in warm_runs(result)]

    def runs_dist(key):
        return bench.distribution([run[key] for _, run in warm if run.get(key) is not None])

    def stage_dist(key):
        return bench.distribution([result["stages"][f"generation_{run['index']}"][key] for result, run in warm
                                   if result["stages"][f"generation_{run['index']}"].get(key) is not None])

    eos = [run["hit_eos"] for _, run in warm if run.get("hit_eos") is not None]
    return {"processes": len(results), "warm_generation_s": runs_dist("generation_s"),
            "wall_audio_rtf": runs_dist("wall_audio_rtf"), "duration_s": runs_dist("duration_s"),
            "steps": runs_dist("steps"), "hit_eos_count": sum(eos) if eos else None,
            "bound_count": len(eos) - sum(eos) if eos else None,
            "cuda_allocated_peak_bytes": stage_dist("cuda_allocated_peak_bytes"),
            "cuda_reserved_peak_bytes": stage_dist("cuda_reserved_peak_bytes"), "rss_bytes": stage_dist("rss_bytes"),
            "cold_generation_s": bench.distribution([run["generation_s"] for result in results for run in result.get("runs", [])
                                                     if run["kind"] == "cold"]),
            "warmup_excluded": sum(run["kind"] == "warmup" for result in results for run in result.get("runs", [])),
            "load_s": bench.distribution([result["stages_s"]["load"] for result in results if "load" in result.get("stages_s", {})]),
            "graph_capture_s": bench.distribution([result["graph_capture"]["wall_s"] for result in results if result.get("graph_capture")]),
            "runtime_identity": next((result.get("runtime_identity") for result in results), None),
            "small_sample": len(warm) < 10}


def ratio_of_medians(baseline, candidate):
    left, right = baseline["warm_generation_s"], candidate["warm_generation_s"]
    if left is None or right is None or not right["p50"]:
        return None
    return left["p50"] / right["p50"]


def aggregate(jobs, results):
    """results: {job name: child results.json} for completed children."""
    by_label = {label: [results[job.name] for job in jobs if job.label == label and job.name in results] for label in LABELS}
    summary = {label: summarize(group) for label, group in by_label.items()}
    cells = {}
    for job in jobs:
        cells.setdefault(f"{job.text_id}/{job.reference_id}", {label: [] for label in LABELS})
        if job.name in results:
            cells[f"{job.text_id}/{job.reference_id}"][job.label].append(results[job.name])
    cell_summaries = {}
    for key, groups in cells.items():
        cell = {label: summarize(group) for label, group in groups.items()}
        cell["speedup_warm_generation_s_p50_ratio"] = ratio_of_medians(cell["baseline"], cell["candidate"])
        cell_summaries[key] = cell
    ratio = ratio_of_medians(summary["baseline"], summary["candidate"])
    speedup = None if ratio is None else {"warm_generation_s_p50_ratio": ratio,
                                          "method": "baseline p50 / candidate p50 of warm generation_s over every cell"}
    failures = [f"{label}: no warm runs to compare (a cold-only side is not a baseline)" for label in LABELS
                if by_label[label] and summary[label]["warm_generation_s"] is None]
    return summary, cell_summaries, speedup, failures


def quality_rows(settings, jobs, results, root):
    rows = []
    for job in jobs:
        for run in results.get(job.name, {}).get("runs", []):
            rows.append({"id": f"{job.name}/{run['wav']}", "wav": str(root / "runs" / job.name / run["wav"]),
                         "text": CORPUS[job.text_id], "group": job.label, "text_id": job.text_id,
                         "reference_id": job.reference_id, "seed": run["seed"], "kind": run["kind"]})
    return rows


def export_audition(rows, output, root):
    """Warm WAVs copied under blind ids in audition/; the key stays at the root."""
    warm = [row for row in rows if row["kind"] == "warm"]
    ids = [f"blind-{index:04d}" for index in range(len(warm))]
    random.SystemRandom().shuffle(ids)
    key = {}
    audition = Output(root / "audition")
    try:
        for blind_id, row in zip(ids, warm):
            with audition.open(f"{blind_id}.wav") as handle:
                handle.write(Path(row["wav"]).read_bytes())
            key[blind_id] = {"wav": row["wav"], "label": row["group"], "text_id": row["text_id"],
                             "reference_id": row["reference_id"], "seed": row["seed"], "kind": row["kind"]}
        listener_ids = sorted(ids)
        audition.write_text("manifest.json", json.dumps({"ids": listener_ids, "note": "listen blind; the key is held separately"}, indent=2))
    finally:
        audition.close()
    output.write_text("audition-key.json", json.dumps(key, indent=2))
    return {"count": len(warm), "listener_manifest": str(root / "audition" / "manifest.json"),
            "key": str(root / "audition-key.json")}


def compare(settings, output, *, runner=run_process, gpu_snapshot=nvidia_smi_snapshot, admit=bench.admit_cached_model,
            get_provenance=provenance):
    """Injectable test boundary. Caller owns validation."""
    jobs = plan_jobs(settings)
    root = output.path
    report = {"schema_version": 1, "status": "failed", "config": asdict(settings), "provenance": get_provenance(),
              "method": METHOD, "corpus": {text_id: CORPUS[text_id] for text_id in settings.texts},
              "plan": [{"name": job.name, **asdict(job)} for job in jobs], "jobs": [], "failures": [],
              "notes": {"small_sample": SMALL_SAMPLE}, "quality": None, "audition": None}
    results = {}
    try:
        report["models"] = {label: admit(benchmark_settings(settings, label)) for label in LABELS}
        report["references"] = {key: bench.reference_info(reference(settings, key)[0]) for key in settings.references}
        for job in jobs:
            record = {"name": job.name, "idle_gpu_before": gpu_snapshot(gpu_index(settings.device)), "status": "error",
                      "returncode": None, "error": None, "stderr_tail": None, "wall_s": None}
            argv = child_argv(settings, job, root)
            started = time.perf_counter()
            try:
                completed = runner(argv, timeout=settings.process_timeout_s)
                record["returncode"], record["stderr_tail"] = completed.returncode, (completed.stderr or "")[-2000:]
                result = bench.read_json(root / "runs" / job.name / "results.json")
                record["status"] = result.get("status", "failed")
                results[job.name] = result
                if record["status"] != "ok" or completed.returncode != 0:
                    report["failures"].append(f"job {job.name}: status {record['status']}, exit {completed.returncode}")
            except (Exception, KeyboardInterrupt) as exc:
                record["error"] = f"{type(exc).__name__}: {str(exc)[:500]}"
                report["failures"].append(f"job {job.name}: {record['error']}")
            record["wall_s"] = time.perf_counter() - started
            report["jobs"].append(record)
        completed_ok = {name: result for name, result in results.items() if result.get("status") == "ok"}
        summary, cells, speedup, failures = aggregate(jobs, completed_ok)
        report.update({"summary": summary, "cells": cells, "speedup": speedup})
        report["failures"].extend(failures)
        rows = quality_rows(settings, jobs, completed_ok, root)
        manifest = {"language": settings.language,
                    "references": {key: {"wav": str(reference(settings, key)[0]), "text": reference(settings, key)[1]}
                                   for key in settings.references},
                    "rows": rows}
        output.write_text("quality-manifest.json", json.dumps(manifest, indent=2))
        report["audition"] = export_audition(rows, output, root)
        if not settings.skip_quality:
            completed = runner(scorer_argv(settings, root), timeout=settings.process_timeout_s)
            path = root / "quality" / "quality.json"
            quality = bench.read_json(path) if path.is_file() else {"status": "missing", "groups": None}
            report["quality"] = {"status": quality.get("status"), "returncode": completed.returncode, "path": str(path),
                                 "groups": quality.get("groups")}
            if completed.returncode != 0:
                report["failures"].append(f"quality scoring exited {completed.returncode}")
        report["status"] = "ok" if not report["failures"] else "failed"
    except (Exception, KeyboardInterrupt) as exc:
        report["error"] = {"type": type(exc).__name__, "message": str(exc)[:2000]}
    finally:
        with output.open("comparison.json") as handle:
            handle.write(json.dumps(report, default=str, indent=2, allow_nan=False).encode() + b"\n")
    return report


def parse_args(argv):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    for name in ("device", "cache-root", "output-root", "baseline-model", "candidate-model",
                 "reference-a", "reference-a-text", "reference-b", "reference-b-text"):
        parser.add_argument("--" + name, required=True, type=Path if name.endswith(("root", "-a", "-b")) else str)
    parser.add_argument("--rounds", type=int, default=Settings.rounds)
    parser.add_argument("--warm-repeats", type=int, default=Settings.warm_repeats)
    parser.add_argument("--warmup-repeats", type=int, default=Settings.warmup_repeats)
    parser.add_argument("--seeds", type=bench.seed_list, default=Settings.seeds)
    parser.add_argument("--texts", type=lambda text: tuple(part.strip() for part in text.split(",")), default=Settings.texts,
                        help=f"comma-separated subset of {', '.join(CORPUS)}")
    parser.add_argument("--references", type=lambda text: tuple(part.strip() for part in text.split(",")), default=Settings.references)
    parser.add_argument("--language", default=Settings.language)
    parser.add_argument("--max-audio-seconds", type=float, default=Settings.max_audio_seconds)
    parser.add_argument("--process-timeout-s", type=float, default=Settings.process_timeout_s)
    parser.add_argument("--python", default=Settings.python)
    parser.add_argument("--skip-quality", action="store_true")
    parser.add_argument("--dry-run", action="store_true", help="print the process plan and exit")
    return Settings(**vars(parser.parse_args(argv)))


def main(argv=None):
    output = None
    try:
        settings = parse_args(argv)
        validate(settings)
        if settings.dry_run:
            jobs = plan_jobs(settings)
            print(f"{len(jobs)} processes, {settings.warm_repeats * settings.rounds} warm samples per cell and config")
            for job in jobs:
                print(job.name)
            return 0
        output = Output(settings.output_root)
        report = compare(settings, output)
        print(str(output.path / "comparison.json"))
        if report["status"] != "ok":
            print(json.dumps(report.get("error") or report["failures"]), file=sys.stderr)
            return 2
        return 0
    except (OSError, ValueError) as exc:
        print(f"comparison refused: {exc}", file=sys.stderr)
        return 2
    finally:
        if output is not None:
            output.close()


if __name__ == "__main__":
    raise SystemExit(main())
