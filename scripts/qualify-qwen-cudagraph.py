#!/usr/bin/env python3
"""Qualify the opt-in CUDA-graph Qwen Base runtime against the real backend
and model on an explicit CUDA device, offline, in a fresh process.

Each check drives PyTorchTTSBackend("<size>-cudagraph") through its public
async methods. Graph captures and replays are observed by a spy on the CUDA
graph class (torch.cuda.CUDAGraph), so "the graphs replayed" is a count of
replay calls, never an inference from timing. Spies only observe; the one
fault injected is a failing capture, through a separate CaptureFault.
results.json holds one entry per check plus device identity, stage telemetry
and the saved WAVs. Exit status is nonzero if any gating check fails.
"""

import argparse
import asyncio
from dataclasses import asdict, dataclass
import hashlib
import importlib.metadata
import importlib.util
import json
import math
from pathlib import Path
import shutil
import sys
import time
import traceback
from typing import Literal
import wave


REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))
from scripts.portable_output import Output  # noqa: E402
from scripts import device_telemetry as telemetry  # noqa: E402

_spec = importlib.util.spec_from_file_location("benchmark_local_tts", Path(__file__).with_name("benchmark-local-tts.py"))
bench = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = bench
_spec.loader.exec_module(bench)

SHORT_TEXT = "Hello from Voicebox. This speech was generated locally."
PARAGRAPH_TEXT = ("Every spring the river rises past the old stone bridge, and the whole village turns out to "
                  "watch the water carry last year's leaves toward the sea. Children count the boats, elders "
                  "compare the flood to the ones they remember, and by evening someone has lit the lanterns "
                  "along the quay.")
PACKAGE = "faster-qwen3-tts"
IDENTITY_KEYS = ("runtime", "package", "version", "commit", "dtype", "attn", "max_seq_len", "graph_capture_s")


@dataclass(frozen=True)
class Settings:
    device: str
    cache_root: Path
    output_root: Path
    reference_a: Path
    reference_a_text: str
    reference_b: Path
    reference_b_text: str
    model: str = "0.6B-cudagraph"
    second_model: str | None = None
    text: str = SHORT_TEXT
    seed: int = 42
    max_audio_seconds: float = 30.0
    lifecycle_cycles: int = 0


def benchmark_settings(settings, model=None):
    return bench.Settings("qwen", "pytorch", settings.device, model or settings.model, "en", settings.text,
                          settings.cache_root, settings.output_root, settings.reference_a,
                          settings.reference_a_text, seed=settings.seed, max_audio_seconds=settings.max_audio_seconds)


def validate(settings):
    for model in (settings.model, settings.second_model):
        if model is not None:
            if bench.expected_runtime(model) != "cudagraph":
                raise ValueError(f"{model} is not a cudagraph model; this runner qualifies the graph runtime only")
            bench.validate(benchmark_settings(settings, model))
    if settings.reference_b.resolve() == settings.reference_a.resolve():
        raise ValueError("references A and B must be distinct files")
    if not settings.reference_b_text.strip():
        raise ValueError("reference B requires a transcript")
    if not 0 <= settings.lifecycle_cycles <= 100:
        raise ValueError("lifecycle cycles must be 0..100")
    for path in (settings.reference_a, settings.reference_b):
        bench.reference_info(path)


@dataclass
class CheckResult:
    name: str
    kind: Literal["gating", "recorded"]
    passed: bool
    wall_s: float
    evidence: dict
    error: str | None = None


@dataclass(frozen=True)
class Recorded:
    """Returned by a gating check whose property this run could not exercise;
    the result is recorded, never counted as a pass."""
    evidence: dict


class GraphSpy:
    """Count capture_end and replay calls on a CUDA graph class, calling through.
    Instance methods resolve through the class, so every graph the runtime
    creates is observed without touching the runtime's objects."""

    def __init__(self, graph_class):
        self.graph_class = graph_class
        self.captures = self.replays = 0
        self.originals = {name: getattr(graph_class, name) for name in ("capture_end", "replay")}

        def counting(name):
            original = self.originals[name]

            def method(instance, *args, **kwargs):
                result = original(instance, *args, **kwargs)
                if name == "capture_end":
                    self.captures += 1
                else:
                    self.replays += 1
                return result
            return method

        for name in self.originals:
            setattr(graph_class, name, counting(name))

    def counts(self):
        return {"captures": self.captures, "replays": self.replays}

    def restore(self):
        for name, original in self.originals.items():
            setattr(self.graph_class, name, original)


class CaptureFault:
    """While entered, every capture_begin on the graph class raises."""

    def __init__(self, graph_class):
        self.graph_class = graph_class

    def __enter__(self):
        self.original = self.graph_class.capture_begin

        def failing(instance, *args, **kwargs):
            raise RuntimeError("injected capture fault")

        self.graph_class.capture_begin = failing
        return self

    def __exit__(self, *exc):
        self.graph_class.capture_begin = self.original


class VramFiller:
    """Hold almost all free VRAM so the next generation must fail to allocate."""

    def __init__(self, meter, headroom_bytes=128 * 1024 * 1024):
        self.meter, self.headroom, self.block = meter, headroom_bytes, None

    def fill(self):
        if self.meter.cuda is None:
            return {"provoked": False, "reason": "no CUDA allocator in this meter"}
        import torch
        free, _ = torch.cuda.mem_get_info(self.meter.device)
        size = free - self.headroom
        if size <= 0:
            return {"provoked": False, "reason": f"only {free} bytes free"}
        try:
            self.block = torch.empty(size, dtype=torch.uint8, device=self.meter.device)
        except RuntimeError as exc:
            return {"provoked": False, "reason": f"filler allocation failed: {str(exc)[:200]}"}
        return {"provoked": True, "held_bytes": size}

    def release(self):
        self.block = None
        if self.meter.cuda is not None:
            self.meter.cuda.empty_cache()


CODEC_HZ = 12.5


def long_text(max_seq_len):
    """Text whose speech needs more codec steps than the graphs hold. qwen_tts
    places only the reference's codec frames in the prefill and trails the text,
    so a long text reaches the generation bound rather than the prompt bound."""
    sentence = "The committee reviewed every numbered paragraph of the proposal before voting. "
    repeats = (max_seq_len * 8) // len(sentence) + 1
    return sentence * repeats


def long_reference(source, destination, seconds):
    """Loop a PCM WAV until it lasts at least `seconds`; returns (duration_s, repeats).
    The reference's codec frames fill the prefill, so this is what exceeds max_seq_len."""
    with wave.open(str(source), "rb") as audio:
        params, frames = audio.getparams(), audio.readframes(audio.getnframes())
    duration = params.nframes / params.framerate
    repeats = math.ceil(seconds / duration)
    with wave.open(str(destination), "wb") as target:
        target.setparams(params)
        target.writeframes(frames * repeats)
    return duration * repeats, repeats


def compare_audio(left, right):
    import numpy as np
    if left.shape != right.shape:
        return {"same_length": False, "bit_exact": False, "lengths": [int(left.size), int(right.size)]}
    difference = np.abs(left.astype(np.float64) - right.astype(np.float64))
    return {"same_length": True, "bit_exact": bool(difference.max() == 0.0), "max_abs_difference": float(difference.max())}


def is_cudagraph_error(exc):
    return isinstance(exc, RuntimeError) and type(exc).__name__ == "CudaGraphRuntimeError"


def is_oom(exc):
    return type(exc).__name__ == "OutOfMemoryError" or "out of memory" in str(exc).lower()


def vram_released(allocated_before, allocated_after):
    """None without CUDA; otherwise the unload must leave under 5% of the loaded allocation."""
    return None if allocated_before is None else allocated_after < allocated_before * 0.05


class Session:
    """Mutable state the ordered checks share: adapter, graph spy, audio and references."""

    def __init__(self, settings, output, meter, factory, admitted, verify_residency, spy, package_version):
        self.settings, self.output, self.meter = settings, output, meter
        self.factory, self.admitted, self.verify_residency = factory, admitted, verify_residency
        self.spy, self.filler, self.package_version = spy, None, package_version
        self.device = bench.torch_device(benchmark_settings(settings))
        self.adapter = None
        self.audio, self.samples, self.wavs = [], {}, []
        self.stage_counter = 0
        self.loaded_allocation = None
        work = output.path / "runtime" / "refs"
        work.mkdir(parents=True)
        self.work_a, self.work_b = work / "a.wav", work / "b.wav"
        shutil.copyfile(settings.reference_a, self.work_a)
        shutil.copyfile(settings.reference_b, self.work_b)
        self.prompt_a = self.prompt_b = None

    def stage(self, name):
        self.stage_counter += 1
        return self.meter.stage(f"{self.stage_counter:02d}_{name}")

    def last_stage_wall(self):
        return next(reversed(self.meter.stages.values())).wall_s

    async def load(self, model=None, label="load"):
        before = self.spy.counts()
        with self.stage(label):
            await self.adapter.load_model(model or self.settings.model)
        residency = self.verify_residency(bench.qwen_inference_roots(self.adapter), self.device)
        identity = bench.verify_runtime(self.adapter, benchmark_settings(self.settings, model))
        self.loaded_allocation = self.meter.cuda_allocated_bytes()
        return {"residency": residency, "runtime_identity": identity, "load_s": self.last_stage_wall(),
                "captures": self.spy.captures - before["captures"],
                "graph_capture_s": (bench.graph_capture_figure(identity) or {}).get("wall_s")}

    async def prepare(self, path, text, label):
        with self.stage(label):
            prompt, hit = await self.adapter.create_voice_prompt(str(path), text, use_cache=False)
        return prompt

    async def prepare_both(self):
        self.prompt_a = await self.prepare(self.work_a, self.settings.reference_a_text, "prepare_a")
        self.prompt_b = await self.prepare(self.work_b, self.settings.reference_b_text, "prepare_b")

    async def generate(self, label, prompt, *, seed, text=None):
        before = self.spy.counts()
        with self.stage(f"generate_{label}"):
            audio, rate = await self.adapter.generate(text or self.settings.text, prompt, language="en", seed=seed)
        wall = self.last_stage_wall()
        samples, metrics = bench.audio_metrics(audio, rate, wall, self.settings.max_audio_seconds)
        after = self.spy.counts()
        name = f"{label}.wav"
        bench.save_wav(self.output, name, samples, rate)
        self.wavs.append(name)
        entry = {"label": label, "seed": seed, **metrics, **bench.generation_facts(self.adapter),
                 "replays": after["replays"] - before["replays"], "captures": after["captures"] - before["captures"]}
        self.audio.append(entry)
        self.samples[label] = samples
        return samples, entry


def expect(condition, message):
    if not condition:
        raise AssertionError(message)


async def check_capture_then_warmup_then_replay(s):
    expect(s.load_evidence["captures"] >= 1, f"no graph capture observed during load (captures={s.load_evidence['captures']})")
    await s.prepare_both()
    _, first = await s.generate("first_after_capture", s.prompt_a, seed=s.settings.seed)
    _, second = await s.generate("second_after_capture", s.prompt_a, seed=s.settings.seed)
    expect(first["replays"] > 0 and second["replays"] > 0,
           f"generations did not replay the graph: replays {first['replays']}, {second['replays']}")
    expect(second["captures"] == 0, f"a warm generation recaptured: captures={second['captures']}")
    return {"captures_during_load": s.load_evidence["captures"], "graph_capture_s": s.load_evidence["graph_capture_s"],
            "first_generation": first, "second_generation": second}


async def check_first_generation_after_capture_timing(s):
    first = next(e for e in s.audio if e["label"] == "first_after_capture")["generation_s"]
    second = next(e for e in s.audio if e["label"] == "second_after_capture")["generation_s"]
    return {"first_s": first, "second_s": second, "ratio": first / second if second else None}


async def check_runtime_identity_truthful(s):
    identity = s.load_evidence["runtime_identity"]
    missing = [key for key in IDENTITY_KEYS if key not in identity]
    expect(not missing, f"runtime identity lacks {missing}")
    try:
        installed = s.package_version(PACKAGE)
    except importlib.metadata.PackageNotFoundError:
        installed = None
    expect(identity["package"] == PACKAGE, f"package {identity['package']!r} is not {PACKAGE}")
    expect(installed is not None and identity["version"] == installed,
           f"identity version {identity['version']!r} vs installed {installed!r}")
    expect(identity["dtype"] == "bfloat16" and identity["attn"] == "sdpa", f"dtype/attn {identity['dtype']}/{identity['attn']}")
    expect(isinstance(identity["max_seq_len"], int) and identity["max_seq_len"] > 0, "max_seq_len is not a positive int")
    expect(isinstance(identity["graph_capture_s"], (int, float)) and identity["graph_capture_s"] > 0, "graph_capture_s is not positive")
    model_class = type(s.adapter.model).__name__
    expect(model_class == "Qwen3TTSModel", f"backend.model is {model_class}, residency roots changed")
    return {**identity, "package_version_installed": installed, "model_class": model_class}


async def check_seed_behavior(s):
    one, _ = await s.generate("a_seed42_1", s.prompt_a, seed=42)
    other, _ = await s.generate("a_seed7", s.prompt_a, seed=7)
    again, _ = await s.generate("a_seed42_2", s.prompt_a, seed=42)
    different, same = compare_audio(one, other), compare_audio(one, again)
    expect(not different["bit_exact"], "different seeds produced identical audio: RNG frozen by the graph")
    expect(same["bit_exact"], f"same seed not reproducible across replays: {same}")
    return {"different_seed": different, "same_seed": same}


async def check_variable_text_and_reference_lengths(s):
    _, short_a = await s.generate("short_a", s.prompt_a, seed=s.settings.seed)
    _, paragraph_a = await s.generate("paragraph_a", s.prompt_a, seed=s.settings.seed, text=PARAGRAPH_TEXT)
    _, short_b = await s.generate("short_b", s.prompt_b, seed=s.settings.seed)
    entries = {"short_a": short_a, "paragraph_a": paragraph_a, "short_b": short_b}
    expect(paragraph_a["duration_s"] > short_a["duration_s"], "paragraph audio is not longer than the short text's")
    bound = [key for key, entry in entries.items() if entry["hit_eos"] is not True]
    expect(not bound, f"generations that did not end by EOS: {bound}")
    if short_a["steps"] is not None and paragraph_a["steps"] is not None:
        expect(paragraph_a["steps"] > short_a["steps"], "paragraph used no more codec steps than the short text")
    return {**entries, "reference_durations_s": {"a": bench.reference_info(s.work_a)["duration_s"],
                                                 "b": bench.reference_info(s.work_b)["duration_s"]}}


async def check_two_speakers_no_leak(s):
    a_first, _ = await s.generate("speaker_a_1", s.prompt_a, seed=s.settings.seed)
    b, _ = await s.generate("speaker_b", s.prompt_b, seed=s.settings.seed)
    a_again, _ = await s.generate("speaker_a_2", s.prompt_a, seed=s.settings.seed)
    a_vs_b, a_vs_a = compare_audio(a_first, b), compare_audio(a_first, a_again)
    expect(not a_vs_b["bit_exact"], "speakers A and B produced identical audio")
    expect(a_vs_a["bit_exact"], f"speaker leak: A after B differs from the first A: {a_vs_a}")
    return {"a_vs_b": a_vs_b, "a_vs_a_after_b": a_vs_a}


async def graph_refusal(s, label, text, prompt):
    """Run one generation that must raise CudaGraphRuntimeError; returns (raised name, replays during it)."""
    replays_before = s.spy.replays
    try:
        with s.stage(label):
            await s.adapter.generate(text, prompt, language="en", seed=s.settings.seed)
    except Exception as exc:
        expect(is_cudagraph_error(exc), f"{label} raised {type(exc).__name__}, not CudaGraphRuntimeError: {exc}")
        return type(exc).__name__, s.spy.replays - replays_before
    raise AssertionError(f"{label} did not raise; the bound was silently truncated or ignored")


async def state_after_error(s, label):
    expect(s.adapter.is_loaded(), f"adapter unloaded itself after {label}")
    intact, _ = await s.generate(label, s.prompt_a, seed=s.settings.seed)
    state = compare_audio(s.samples["speaker_a_1"], intact)
    expect(state["bit_exact"], f"state corrupted after {label}: {state}")
    return state


async def check_generation_bound_raises(s):
    """A text too long for the remaining positions decodes up to max_new_tokens and then raises."""
    max_seq_len = s.load_evidence["runtime_identity"]["max_seq_len"]
    text = long_text(max_seq_len)
    raised, replays = await graph_refusal(s, "generate_long_text", text, s.prompt_a)
    last = dict(s.adapter.last_generation or {})
    expect(last.get("steps") is not None and last["steps"] == last.get("max_new_tokens"),
           f"the generation bound was not reached: last_generation {last}")
    expect(last.get("hit_eos") is False, f"a bound error reported hit_eos {last.get('hit_eos')!r}, not False")
    expect(replays > 0, "no replay happened before the generation bound")
    state = await state_after_error(s, "a_after_bound_error")
    return {"probe": "long_text", "generation_bound_probed": True, "chars": len(text), "max_seq_len": max_seq_len,
            "raised": raised, "replays_during_error": replays, "last_generation": last, "state_intact_after_error": state}


async def check_prompt_too_long_is_refused_before_replay(s):
    """A reference whose codec frames exceed the graphs' positions is refused before any replay."""
    max_seq_len = s.load_evidence["runtime_identity"]["max_seq_len"]
    path = s.work_a.with_name("a_long.wav")
    duration, repeats = long_reference(s.work_a, path, max_seq_len / CODEC_HZ * 1.25)
    prompt = await s.prepare(path, " ".join([s.settings.reference_a_text] * repeats), "prepare_a_long")
    raised, replays = await graph_refusal(s, "generate_long_reference", s.settings.text, prompt)
    expect(replays == 0, f"{replays} replays ran before the prompt was refused")
    last = dict(s.adapter.last_generation or {})
    expect(all(value is None for value in last.values()), f"a refused prompt reported a generation: {last}")
    state = await state_after_error(s, "a_after_prompt_refusal")
    return {"probe": "long_reference_prompt", "reference_duration_s": duration, "reference_repeats": repeats,
            "reference_frames_at_12_5hz": int(duration * CODEC_HZ), "max_seq_len": max_seq_len, "raised": raised,
            "replays_during_error": replays, "last_generation": last, "state_intact_after_error": state}


async def check_capture_failure_recovery(s):
    problems = []
    with s.stage("unload_before_capture_fault"):
        s.adapter.unload_model()
    captures_before = s.spy.captures
    raised = None
    with CaptureFault(s.spy.graph_class):
        try:
            with s.stage("load_with_capture_fault"):
                await s.adapter.load_model(s.settings.model)
        except Exception as exc:
            raised = type(exc).__name__
            if not is_cudagraph_error(exc):
                problems.append(f"capture fault raised {raised}, not CudaGraphRuntimeError")
    if raised is None:
        problems.append("load succeeded although capture failed")
    loaded_after = s.adapter.is_loaded()
    if loaded_after:
        problems.append("adapter still loaded after a failed capture")
    allocated_after = s.meter.cuda_allocated_bytes()
    released = vram_released(s.loaded_allocation, allocated_after)
    if released is False:
        problems.append(f"VRAM not released after failed capture: {s.loaded_allocation} -> {allocated_after}")
    if s.spy.captures != captures_before:
        problems.append("a capture completed despite the fault")
    if loaded_after:
        s.adapter.unload_model()
    recovered = await s.load(label="load_after_capture_fault")
    await s.prepare_both()
    _, entry = await s.generate("b_after_capture_recovery", s.prompt_b, seed=s.settings.seed)
    expect(not problems, "; ".join(problems))
    return {"raised": raised, "loaded_after_failure": loaded_after, "vram_released_after_failure": released,
            "cuda_allocated_after_failure_bytes": allocated_after, "captures_after_recovery": recovered["captures"],
            "different_call_after_recovery": "create_voice_prompt", "generated_after_recovery": entry["replays"] > 0}


async def check_oom_recovery(s):
    outcome = s.filler.fill()
    if not outcome["provoked"]:
        return Recorded(outcome)
    raised = None
    try:
        try:
            with s.stage("generate_under_vram_pressure"):
                await s.adapter.generate(s.settings.text, s.prompt_a, language="en", seed=s.settings.seed)
        except Exception as exc:
            expect(is_oom(exc), f"generation under VRAM pressure raised {type(exc).__name__}, not an OOM: {exc}")
            raised = type(exc).__name__
    finally:
        s.filler.release()
    if raised is None:
        return Recorded({**outcome, "provoked": False, "reason": "generation completed under VRAM pressure; no OOM occurred"})
    if not s.adapter.is_loaded():
        await s.load(label="load_after_oom")
        await s.prepare_both()
    recovered, _ = await s.generate("a_after_oom", s.prompt_a, seed=s.settings.seed)
    state = compare_audio(s.samples["speaker_a_1"], recovered)
    expect(state["bit_exact"], f"generation after OOM differs from the pre-OOM output: {state}")
    return {**outcome, "raised": raised, "recovered": state}


async def check_model_size_change(s):
    if s.settings.second_model is None:
        return Recorded({"skipped": "no --second-model"})
    first = s.settings.model
    second = await s.load(s.settings.second_model, label="load_second_model")
    await s.prepare_both()
    _, second_entry = await s.generate("second_model", s.prompt_a, seed=s.settings.seed)
    back = await s.load(first, label="load_first_model_again")
    await s.prepare_both()
    again, _ = await s.generate("first_model_again", s.prompt_a, seed=s.settings.seed)
    state = compare_audio(s.samples["speaker_a_1"], again)
    expect(state["bit_exact"], f"first model after size change differs from its earlier output: {state}")
    return {"sequence": [first, s.settings.second_model, first], "second": second_entry,
            "second_identity": second["runtime_identity"], "back_identity": back["runtime_identity"], "back_to_first": state}


async def check_no_silent_fallback(s):
    expect(s.audio, "no generation ran, so nothing shows the graphs replayed")
    without = [entry["label"] for entry in s.audio if entry["replays"] <= 0]
    expect(not without, f"generations without replay calls: {without}")
    expect(s.spy.captures >= 1, "no capture was ever observed")
    return {"generations": len(s.audio), "generations_without_replay": without, "total_replays": s.spy.replays,
            "total_captures": s.spy.captures}


async def check_all_audio_finite_mono(s):
    expect(s.audio, "no audio generated")
    durations = [entry["duration_s"] for entry in s.audio]
    short = [entry["label"] for entry in s.audio if entry["duration_s"] < 0.25]
    expect(not short, f"implausibly short audio: {short}")
    rates = sorted({entry["sample_rate"] for entry in s.audio})
    expect(len(rates) == 1, f"inconsistent sample rates: {rates}")
    return {"count": len(s.audio), "sample_rate": rates[0], "min_duration_s": min(durations),
            "max_duration_s": max(durations), "clipped_samples_total": sum(e["clipped_samples_pcm16"] for e in s.audio)}


async def check_lifecycle_cycles(s):
    """--lifecycle-cycles N: load/prepare/generate/unload cycles after the checks;
    each reload must recapture and each unload must release VRAM."""
    problems, rows = [], []
    with s.stage("unload_before_cycles"):
        s.adapter.unload_model()
    for cycle in range(1, s.settings.lifecycle_cycles + 1):
        loaded = await s.load(label=f"load_cycle_{cycle:02d}")
        if loaded["captures"] < 1:
            problems.append(f"cycle {cycle}: reload did not recapture")
        prompt = await s.prepare(s.work_a, s.settings.reference_a_text, f"prepare_cycle_{cycle:02d}")
        _, entry = await s.generate(f"cycle_{cycle:02d}", prompt, seed=s.settings.seed)
        allocated_before = s.meter.cuda_allocated_bytes()
        with s.stage(f"unload_cycle_{cycle:02d}"):
            s.adapter.unload_model()
        allocated_after = s.meter.cuda_allocated_bytes()
        if vram_released(allocated_before, allocated_after) is False:
            problems.append(f"cycle {cycle}: VRAM not released: {allocated_before} -> {allocated_after}")
        rss, peak_rss = telemetry.process_memory(s.meter.process)
        rows.append({"cycle": cycle, "load_s": loaded["load_s"], "captures": loaded["captures"],
                     "graph_capture_s": loaded["graph_capture_s"], "generate_s": entry["generation_s"],
                     "replays": entry["replays"], "cuda_allocated_before_unload_bytes": allocated_before,
                     "cuda_allocated_after_unload_bytes": allocated_after,
                     "cuda_reserved_after_unload_bytes": s.meter.cuda_reserved_bytes(),
                     "rss_after_unload_bytes": rss, "peak_rss_after_unload_bytes": peak_rss})
    expect(not problems, "; ".join(problems))
    return {"cycle_count": s.settings.lifecycle_cycles, "cycles": rows}


CHECKS = [
    check_capture_then_warmup_then_replay,
    check_first_generation_after_capture_timing,
    check_runtime_identity_truthful,
    check_seed_behavior,
    check_variable_text_and_reference_lengths,
    check_two_speakers_no_leak,
    check_generation_bound_raises,
    check_prompt_too_long_is_refused_before_replay,
    check_capture_failure_recovery,
    check_oom_recovery,
    check_model_size_change,
    check_no_silent_fallback,
    check_all_audio_finite_mono,
]
# The first generation after capture is slower (gate 0: 10 s vs 1.8 s); its
# ratio is evidence, not a verdict.
RECORDED_CHECKS = frozenset({check_first_generation_after_capture_timing})


def check_kind(check):
    return "recorded" if check in RECORDED_CHECKS else "gating"


def cuda_graph_class():
    import torch
    return torch.cuda.CUDAGraph


def provenance():
    return {**bench.provenance(), "runner_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "benchmark_module_sha256": hashlib.sha256(Path(bench.__file__).read_bytes()).hexdigest()}


async def qualify(settings, output, *, factory=bench.create_adapter, admit=bench.admit_cached_model,
                  identify=bench.device_identity, meter_factory=telemetry.StageMeter.for_device,
                  verify_residency=telemetry.check_residency, get_provenance=provenance, checks=CHECKS,
                  graph_class=None, filler_factory=None, package_version=importlib.metadata.version):
    """Injectable test boundary. Caller owns offline setup and validation."""
    report = {"schema_version": 1, "status": "failed", "config": asdict(settings), "provenance": get_provenance(),
              "checks": [], "stages": {}, "audio": [], "wavs": []}
    if settings.lifecycle_cycles:
        checks = [*checks, check_lifecycle_cycles]
    session = spy = None
    try:
        report["model"] = admitted = admit(benchmark_settings(settings))
        if settings.second_model is not None:
            report["second_model"] = admit(benchmark_settings(settings, settings.second_model))
        report["references"] = {"a": bench.reference_info(settings.reference_a), "b": bench.reference_info(settings.reference_b)}
        report["device"] = identify(benchmark_settings(settings))
        meter = meter_factory(bench.torch_device(benchmark_settings(settings)))
        spy = GraphSpy(graph_class or cuda_graph_class())
        filler = (filler_factory or (lambda _adapter: VramFiller(meter)))
        session = Session(settings, output, meter, factory, admitted, verify_residency, spy, package_version)
        with session.stage("adapter_init"):
            session.adapter = factory(benchmark_settings(settings), admitted, output)
        session.filler = filler(session.adapter)
        if session.adapter.is_loaded():
            raise ValueError("qualification requires a fresh unloaded adapter")
        report["load"] = session.load_evidence = await session.load()
        for check in checks:
            name, kind = check.__name__.removeprefix("check_"), check_kind(check)
            start = time.perf_counter()
            try:
                evidence = await check(session)
                if isinstance(evidence, Recorded):
                    kind, evidence = "recorded", evidence.evidence
                result = CheckResult(name, kind, True, time.perf_counter() - start, evidence)
            except (Exception, asyncio.CancelledError) as exc:
                result = CheckResult(name, kind, False, time.perf_counter() - start, {},
                                     f"{type(exc).__name__}: {exc}\n{traceback.format_exc()[-1500:]}")
            report["checks"].append(asdict(result))
        report["status"] = "ok" if all(c["passed"] for c in report["checks"] if c["kind"] == "gating") else "failed"
    except (Exception, KeyboardInterrupt) as exc:
        report["error"] = {"type": type(exc).__name__, "message": str(exc)[:2000]}
    finally:
        if session is not None:
            report["audio"], report["wavs"] = session.audio, session.wavs
            report["stages"] = {name: asdict(m) for name, m in session.meter.stages.items()}
            if session.adapter is not None:
                try:
                    session.adapter.unload_model()
                except Exception as exc:
                    report["status"] = "failed"
                    report["cleanup_error"] = {"type": type(exc).__name__, "message": str(exc)[:2000]}
            report["graph_calls"] = spy.counts()
        if spy is not None:
            spy.restore()
        gating = [c for c in report["checks"] if c["kind"] == "gating"]
        recorded = {c["name"]: recorded_outcome(c) for c in report["checks"] if c["kind"] == "recorded"}
        report["summary"] = {"passed": sum(c["passed"] for c in gating), "failed": sum(not c["passed"] for c in gating),
                             "expected": sum(check_kind(check) == "gating" and check.__name__.removeprefix("check_") not in recorded
                                             for check in checks),
                             "recorded": recorded}
        with output.open("results.json") as handle:
            handle.write(json.dumps(report, default=str, indent=2, allow_nan=False).encode() + b"\n")
    return report


def recorded_outcome(check):
    """What a recorded check observed; `passed` only means it ran to completion."""
    return check["evidence"] if check["passed"] else "error"


def parse_args(argv):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    for name in ("device", "cache-root", "output-root", "reference-a", "reference-a-text", "reference-b", "reference-b-text"):
        parser.add_argument("--" + name, required=True, type=Path if name.endswith(("root", "-a", "-b")) else str)
    parser.add_argument("--model", default=Settings.model)
    parser.add_argument("--second-model", default=None, help="a second cudagraph size for the 0.6B->1.7B->0.6B check")
    parser.add_argument("--text", default=Settings.text)
    parser.add_argument("--seed", type=int, default=Settings.seed)
    parser.add_argument("--max-audio-seconds", type=float, default=Settings.max_audio_seconds)
    parser.add_argument("--lifecycle-cycles", type=int, default=Settings.lifecycle_cycles,
                        help="load/prepare/generate/unload cycles to run after the checks (default 0)")
    return Settings(**vars(parser.parse_args(argv)))


def main(argv=None):
    output = None
    try:
        settings = parse_args(argv)
        validate(settings)
        output = Output(settings.output_root)
        bench.configure_offline(benchmark_settings(settings), output)
        report = asyncio.run(qualify(settings, output))
        print(str(output.path / "results.json"))
        for check in report["checks"]:
            if check["kind"] == "recorded":
                verdict = f"RECORDED {json.dumps(recorded_outcome(check))}"
            else:
                verdict = "PASS" if check["passed"] else "FAIL"
            print(f"{verdict} {check['name']}", file=sys.stderr)
        if report["status"] != "ok":
            print(json.dumps(report.get("error") or report.get("cleanup_error") or report["summary"]), file=sys.stderr)
            return 2
        return 0
    except (OSError, ValueError) as exc:
        print(f"qualification refused: {exc}", file=sys.stderr)
        return 2
    finally:
        if output is not None:
            output.close()


if __name__ == "__main__":
    raise SystemExit(main())
