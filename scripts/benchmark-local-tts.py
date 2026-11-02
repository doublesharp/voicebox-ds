#!/usr/bin/env python3
"""Benchmark existing TTS adapters using cached weights and explicit output paths.

Importing is inert. main() is a standalone entry point: it installs a permanent
network audit guard before importing adapters. See the developer benchmark guide.
"""

import argparse
import asyncio
from collections.abc import Callable
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
import hashlib
import importlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import platform
import re
import socket
import subprocess
import sys
import tempfile
import time
from typing import Literal
import wave


REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))
from scripts.portable_output import Output  # noqa: E402
from scripts import device_telemetry as telemetry  # noqa: E402
LANGUAGES = ("zh", "en", "ja", "ko", "de", "fr", "ru", "pt", "es", "it")
PRESETS = ("Vivian", "Serena", "Uncle_Fu", "Dylan", "Eric", "Ryan", "Aiden", "Ono_Anna", "Sohee")
MAX_ARTIFACT_BYTES = 128 * 1024 * 1024
TURBO_REPO = "ResembleAI/chatterbox-turbo"
# Pinned to backend.backends.chatterbox_turbo_backend._TURBO_WEIGHT_FILES by test;
# admission must not import the backend (and torch) before the offline guard.
TURBO_WEIGHT_FILES = ("t3_turbo_v1.safetensors", "s3gen_meanflow.safetensors", "ve.safetensors",
                      "tokenizer_config.json", "vocab.json", "merges.txt", "conds.pt")
# Opt-in CUDA-graph runtime variants of Qwen Base: same repository and
# revision as the stock size, a different in-process runtime (C1 contract).
CUDAGRAPH_MODELS = {"0.6B-cudagraph": "0.6B", "1.7B-cudagraph": "1.7B"}


def stock_model(model):
    return CUDAGRAPH_MODELS.get(model, model)


def expected_runtime(model):
    return "cudagraph" if model in CUDAGRAPH_MODELS else "stock"


@dataclass(frozen=True)
class Settings:
    engine: str
    backend: str
    device: str
    model: str
    language: str
    text: str
    cache_root: Path
    output_root: Path
    reference: Path | None = None
    reference_text: str | None = None
    preset_voice: str | None = None
    design_prompt: str | None = None
    instruct: str | None = None
    seed: int = 0
    warm_repeats: int = 3
    max_audio_seconds: float = 30.0
    seeds: tuple[int, ...] = ()
    warmup_repeats: int = 0


def torch_device(settings):
    """In-process torch device. cuda:N is selected through CUDA_VISIBLE_DEVICES
    before torch is imported, so the process always sees it as cuda:0."""
    if settings.device == "mlx":
        return "mlx"
    return "cuda:0" if settings.device.startswith("cuda") else "cpu"


def validate(settings):
    if settings.engine not in ENGINES:
        raise ValueError("unsupported engine; only audited Qwen and Chatterbox Turbo adapters are admitted")
    spec = ENGINES[settings.engine]
    if settings.backend not in spec.backends:
        raise ValueError(f"backend must be explicit: one of {', '.join(spec.backends)}")
    if settings.backend == "mlx" and settings.device != "mlx":
        raise ValueError("mlx backend requires --device mlx")
    if settings.backend == "pytorch" and not re.fullmatch(r"cpu|cuda(:\d+)?", settings.device):
        raise ValueError("pytorch backend requires --device cpu, cuda or cuda:N; nothing is auto-selected")
    if settings.model not in spec.models:
        raise ValueError("unsupported model size for this engine")
    if settings.model in CUDAGRAPH_MODELS and (settings.backend != "pytorch" or not settings.device.startswith("cuda")):
        raise ValueError("cudagraph models run only with --backend pytorch on --device cuda")
    if settings.language not in spec.languages:
        raise ValueError("unsupported language; automatic language fallback is disabled")
    if not settings.text.strip() or len(settings.text) > 2000:
        raise ValueError("text must contain 1..2000 characters")
    if not 0 <= settings.warm_repeats <= 20 or not 0 <= settings.warmup_repeats <= 20:
        raise ValueError("warm and warmup repeats must be 0..20")
    if len(settings.seeds) > 20 or any(not 0 <= seed < 2**32 for seed in (settings.seed, *settings.seeds)):
        raise ValueError("seeds must be at most 20 values in 0..2**32-1")
    if not math.isfinite(settings.max_audio_seconds) or not 0 < settings.max_audio_seconds <= 120:
        raise ValueError("max audio seconds must be finite and in (0, 120]")
    for value in (settings.instruct, settings.reference_text, settings.design_prompt):
        if value is not None and (not value.strip() or len(value) > 2000):
            raise ValueError("instructions, design and reference text must contain 1..2000 characters")
    if spec.voice == "reference":
        if settings.reference is None or not settings.reference_text:
            raise ValueError(f"{settings.engine} requires explicit --reference and --reference-text")
        if settings.instruct or settings.preset_voice or settings.design_prompt:
            raise ValueError(f"{settings.engine} does not support instruct, presets or voice design")
    elif settings.reference is not None or settings.reference_text:
        raise ValueError("reference audio is only supported by cloning engines")
    elif spec.voice == "preset":
        if settings.preset_voice not in PRESETS or settings.design_prompt:
            raise ValueError("CustomVoice requires a known explicit --preset-voice")
    elif not settings.design_prompt or settings.preset_voice:
        raise ValueError("VoiceDesign requires --design-prompt and no preset")
    if not settings.cache_root.is_absolute() or not settings.cache_root.is_dir():
        raise ValueError("cache root must be an existing absolute Hugging Face hub directory")


def read_json(path):
    if path.stat().st_size > 1024 * 1024:
        raise ValueError(f"oversized configuration: {path.name}")
    def reject_nonfinite(value):
        raise ValueError(f"nonfinite JSON configuration value: {value}")

    return json.loads(path.read_text(), parse_constant=reject_nonfinite)


def admit_local_snapshot(cache_root, repo_id, check):
    """Resolve refs/main locally; never call a Hub API, even for admission.
    check(snapshot, required) audits the files and returns extra evidence."""
    cache = cache_root.resolve()
    repo = cache / ("models--" + repo_id.replace("/", "--"))
    try:
        # Converted MLX weights masquerading as a PyTorch repo are not ready.
        if repo.is_symlink():
            raise ValueError("repository cache aliases are not admitted")
        ref = repo / "refs" / "main"
        if ref.stat().st_size > 128:
            raise ValueError("oversized local main revision")
        revision = ref.read_text().strip()
        if not re.fullmatch(r"[a-fA-F0-9]{40,64}", revision):
            raise ValueError("invalid local main revision")
        snapshot = repo / "snapshots" / revision
        for incomplete in (repo / "blobs").glob("*.incomplete"):
            if not incomplete.with_suffix("").is_file():
                raise ValueError("incomplete download in repository")

        def required(name):
            candidate = snapshot / name
            if not candidate.resolve().is_relative_to(repo.resolve()):
                raise ValueError("cached file escapes its repository")
            if not candidate.is_file() or candidate.stat().st_size == 0:
                raise ValueError(f"missing/empty cached file: {name}")
            return candidate

        return {"repo_id": repo_id, "revision": revision, "snapshot": str(snapshot), **check(snapshot, required)}
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
        raise ValueError(f"model not locally ready: {repo_id}: {exc}") from exc


def admit_cached_model(settings):
    variant = {"qwen": "Base", "qwen_custom_voice": "CustomVoice",
               "qwen_voice_design": "VoiceDesign"}[settings.engine]
    size = stock_model(settings.model)
    repo_id = f"Qwen/Qwen3-TTS-12Hz-{size}-{variant}"
    if settings.backend == "mlx":
        repo_id = f"mlx-community/Qwen3-TTS-12Hz-{size}-{variant}-bf16"

    def check(snapshot, required):
        for name in ("config.json", "generation_config.json", "tokenizer_config.json",
                     "vocab.json", "merges.txt", "preprocessor_config.json",
                     "speech_tokenizer/config.json", "speech_tokenizer/preprocessor_config.json"):
            required(name)
        for prefix in ("", "speech_tokenizer/"):
            index_path = snapshot / (prefix + "model.safetensors.index.json")
            if index_path.exists():
                index = read_json(required(prefix + "model.safetensors.index.json"))
                weights = set(index["weight_map"].values())
                if not weights:
                    raise ValueError("empty weight index")
                for name in weights:
                    if Path(name).is_absolute() or ".." in Path(name).parts:
                        raise ValueError("unsafe shard path")
                    required(prefix + name)
            else:
                required(prefix + "model.safetensors")
        config = read_json(required("config.json"))
        expected = {"Base": "base", "CustomVoice": "custom_voice", "VoiceDesign": "voice_design"}
        if config.get("tts_model_type") != expected[variant]:
            raise ValueError("checkpoint voice mode does not match selected engine")
        return {"config_sha256": hashlib.sha256((snapshot / "config.json").read_bytes()).hexdigest(),
                "generation_config": read_json(required("generation_config.json"))}

    return admit_local_snapshot(settings.cache_root, repo_id, check)


def admit_cached_turbo(settings):
    def check(snapshot, required):
        return {"files": {name: required(name).stat().st_size for name in TURBO_WEIGHT_FILES},
                "tokenizer_config_sha256": hashlib.sha256(required("tokenizer_config.json").read_bytes()).hexdigest()}

    return admit_local_snapshot(settings.cache_root, TURBO_REPO, check)


def qwen_inference_roots(adapter):
    return {"model": adapter.model}


def turbo_inference_roots(adapter):
    # The perth watermarker holds a CPU post-processing network and is not inference.
    return {"t3": adapter.model.t3, "s3gen": adapter.model.s3gen, "ve": adapter.model.ve}


def turbo_loaded_revision(adapter, admitted):
    expected = f"{admitted['repo_id']}@{admitted['revision']}"
    loaded = adapter._conditioning_model_id
    if loaded != expected:
        raise ValueError(f"adapter loaded {loaded}, admission expected {expected}")
    return loaded


@dataclass(frozen=True)
class EngineSpec:
    backends: tuple[str, ...]
    models: tuple[str, ...]
    languages: tuple[str, ...]
    voice: Literal["reference", "preset", "design"]
    admit: Callable[[Settings], dict]
    adapters: dict[str, tuple[str, str]]  # backend -> (module, class)
    constructor_takes_model: bool
    reference_use_cache: bool
    inference_roots: Callable[[object], dict]
    loaded_revision: Callable[[object, dict], str] | None = None


ENGINES = {
    "qwen": EngineSpec(("mlx", "pytorch"), ("1.7B", "0.6B", *CUDAGRAPH_MODELS), LANGUAGES, "reference", admit_cached_model,
                       {"mlx": ("mlx_backend", "MLXTTSBackend"), "pytorch": ("pytorch_backend", "PyTorchTTSBackend")},
                       True, False, qwen_inference_roots),
    "qwen_custom_voice": EngineSpec(("mlx", "pytorch"), ("1.7B", "0.6B"), LANGUAGES, "preset", admit_cached_model,
                                    {"mlx": ("qwen_mlx_styles_backend", "QwenMLXCustomVoiceBackend"),
                                     "pytorch": ("qwen_custom_voice_backend", "QwenCustomVoiceBackend")},
                                    True, False, qwen_inference_roots),
    "qwen_voice_design": EngineSpec(("mlx", "pytorch"), ("1.7B",), LANGUAGES, "design", admit_cached_model,
                                    {"mlx": ("qwen_mlx_styles_backend", "QwenMLXVoiceDesignBackend"),
                                     "pytorch": ("qwen_voice_design_backend", "QwenVoiceDesignBackend")},
                                    True, False, qwen_inference_roots),
    # Turbo defers encoding when use_cache=False, so its reference stage must
    # encode through the run-isolated cache and the first preparation must miss.
    "chatterbox_turbo": EngineSpec(("pytorch",), ("default",), ("en",), "reference", admit_cached_turbo,
                                   {"pytorch": ("chatterbox_turbo_backend", "ChatterboxTurboTTSBackend")},
                                   False, True, turbo_inference_roots, turbo_loaded_revision),
}


def reference_info(path):
    if path is None:
        return None
    if not path.is_absolute() or not path.is_file() or path.stat().st_size > 16 * 1024 * 1024:
        raise ValueError("reference must be an explicit absolute local WAV of at most 16 MiB")
    with wave.open(str(path), "rb") as source:
        rate, frames = source.getframerate(), source.getnframes()
        if not rate or not frames or frames / rate > 30 or source.getcomptype() != "NONE":
            raise ValueError("reference must be nonempty uncompressed PCM WAV, at most 30 seconds")
        if len(source.readframes(frames)) != frames * source.getnchannels() * source.getsampwidth():
            raise ValueError("reference PCM WAV is truncated")
        duration = frames / rate
    return {"path": str(path.resolve()), "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "duration_s": duration, "sample_rate": rate}


def device_environment(settings):
    """Device selection that must precede every torch import. The backend
    honors VOICEBOX_FORCE_CPU; CUDA_VISIBLE_DEVICES pins one physical GPU,
    numbered as nvidia-smi numbers them. The invalid index -1 hides every GPU
    for cpu: an empty value is dropped from the Windows environment block, so
    the CUDA runtime would still see the devices."""
    if settings.device == "cpu":
        return {"VOICEBOX_FORCE_CPU": "1", "CUDA_VISIBLE_DEVICES": "-1"}
    if settings.device.startswith("cuda"):
        return {"CUDA_VISIBLE_DEVICES": settings.device.partition(":")[2] or "0", "CUDA_DEVICE_ORDER": "PCI_BUS_ID"}
    return {}


def configure_offline(settings, output):
    """Standalone-process guard, applied before model libraries are imported."""
    runtime = output.path / "runtime"
    runtime.mkdir()
    temporary = runtime / "tmp"
    temporary.mkdir()
    os.environ.pop("VOICEBOX_FORCE_CPU", None)
    os.environ.update({
        "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "HF_DATASETS_OFFLINE": "1",
        "HF_HUB_DISABLE_TELEMETRY": "1", "DO_NOT_TRACK": "1",
        "HF_HUB_CACHE": str(settings.cache_root.resolve()),
        "VOICEBOX_MODELS_DIR": str(settings.cache_root.resolve()),
        "HF_HOME": str(runtime / "huggingface"), "XDG_CACHE_HOME": str(runtime / "cache"),
        "TORCH_HOME": str(runtime / "torch"),
        "TMPDIR": str(temporary), "TEMP": str(temporary), "TMP": str(temporary),
        "PYTHONPYCACHEPREFIX": str(runtime / "bytecode"), "PYTHONDONTWRITEBYTECODE": "1",
        "VOICEBOX_OFFLINE_PATCH": "0",
        **device_environment(settings),
    })
    sys.dont_write_bytecode = True
    tempfile.tempdir = str(temporary)

    sys.addaudithook(deny_network)


def inside_socketpair_emulation():
    """Windows has no socketpair(2); CPython emulates it by connecting a client
    socket to its own listening loopback socket, and every asyncio loop builds
    its self-pipe that way. Only that exact code object is let through."""
    emulation = getattr(socket, "_fallback_socketpair", None)
    if emulation is None:
        return False
    frame = sys._getframe(1)
    while frame is not None:
        if frame.f_code is emulation.__code__:
            return True
        frame = frame.f_back
    return False


INTERNET_FAMILIES = (socket.AF_INET, socket.AF_INET6)


def deny_network(event, args):
    """Internet sockets may not even be created: asyncio's Proactor loop
    connects and sends through overlapped Win32 calls that raise no
    socket.connect or socket.sendto audit event, so creation is the one
    choke point every path shares."""
    if event in ("socket.getaddrinfo", "socket.gethostbyname", "socket.gethostbyaddr"):
        raise OSError("benchmark forbids network lookup")
    # _socket.socket() without a family audits -1 but creates an AF_INET socket.
    if event == "socket.__new__" and args[1] in (*INTERNET_FAMILIES, -1) and not inside_socketpair_emulation():
        raise OSError("benchmark forbids network sockets")
    if event in ("socket.connect", "socket.sendto") and args[0].family in INTERNET_FAMILIES:
        if event == "socket.connect" and args[1][0] == "127.0.0.1" and inside_socketpair_emulation():
            return
        raise OSError("benchmark forbids network connections")


def device_identity(settings):
    """Identity from real tools; refuses non-NVIDIA CUDA. MLX never imports torch."""
    if settings.device == "mlx":
        return {"selected_device": "mlx", "os": platform.platform(), "machine": platform.machine()}
    identity = telemetry.collect_identity(torch_device(settings))
    visible = os.environ.get("CUDA_VISIBLE_DEVICES")
    selected_gpu = None
    if settings.device.startswith("cuda"):
        telemetry.require_cuda(identity)
        selected_gpu = next((asdict(gpu) for gpu in identity.gpus if str(gpu.index) == visible), None)
        if selected_gpu is None:
            raise telemetry.DeviceRefused(f"CUDA_VISIBLE_DEVICES={visible!r} is not an nvidia-smi GPU index")
    return {**asdict(identity), "requested_device": settings.device,
            "cuda_visible_devices": visible, "selected_gpu": selected_gpu}


def create_adapter(settings, admitted, output):
    # No server/services, global backend singleton, model discovery or ASR.
    sys.path.insert(0, str(REPO))
    from backend import config
    config.set_data_dir(output.path / "runtime" / "data")
    from backend.utils import hf_offline_patch
    # mlx_backend explicitly calls this too; never modify shared caches.
    hf_offline_patch.ensure_original_qwen_config_cached = lambda: None
    spec = ENGINES[settings.engine]
    module, name = spec.adapters[settings.backend]
    imported = importlib.import_module("backend.backends." + module)
    cls = getattr(imported, name)
    adapter = cls(settings.model) if spec.constructor_takes_model else cls()
    adapter._benchmark_source_sha256 = hashlib.sha256(Path(imported.__file__).read_bytes()).hexdigest()
    # Bind precisely the admitted snapshot; refs/main cannot switch this run.
    adapter._get_model_path = lambda size=None: admitted["snapshot"]
    adapter._is_model_cached = lambda size=None: True
    return adapter


def provenance():
    def git(*args):
        return subprocess.check_output(["git", "--no-optional-locks", "-C", str(REPO), *args], text=True,
                                       stderr=subprocess.DEVNULL, timeout=5).strip()
    try:
        commit, dirty = git("rev-parse", "HEAD"), bool(git("status", "--porcelain"))
    except (OSError, subprocess.SubprocessError):
        commit, dirty = None, None
    versions = {}
    for package in ("numpy", "torch", "mlx", "mlx-audio", "qwen-tts", "chatterbox-tts", "transformers", "huggingface-hub"):
        try:
            versions[package] = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            versions[package] = None
    return {"git_commit": commit, "git_dirty": dirty, "python": sys.version,
            "platform": platform.platform(), "machine": platform.machine(), "versions": versions,
            "recorded_at_utc": datetime.now(timezone.utc).isoformat(),
            "runner_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}


def verify_runtime(adapter, settings):
    """The loaded runtime must be the requested one: a cudagraph model that
    runs stock, or a stock model that runs graphs, would be a silent fallback
    or a silent upgrade, and either misattributes every later number."""
    identity = getattr(adapter, "runtime_identity", None)
    expected = expected_runtime(settings.model)
    actual = "stock" if identity is None else identity.get("runtime")
    if actual != expected:
        raise ValueError(f"silent runtime substitution: {settings.model} expects runtime {expected!r}, "
                         f"adapter reports {identity!r}")
    return identity


def graph_capture_figure(identity):
    """Capture happens inside load_model, so its time is reported beside the
    load stage rather than as a measured stage of its own."""
    if identity is None or "graph_capture_s" not in identity:
        return None
    return {"wall_s": identity["graph_capture_s"], "included_in_stage": "load",
            "source": "runtime_identity.graph_capture_s"}


def run_seed(settings, index):
    return settings.seeds[index % len(settings.seeds)] if settings.seeds else settings.seed


def generation_facts(adapter):
    """steps/hit_eos/max_new_tokens from the adapter's last_generation; None
    each when the adapter does not report them."""
    last = getattr(adapter, "last_generation", None) or {}
    return {key: last.get(key) for key in ("steps", "hit_eos", "max_new_tokens")}


def run_kind(index, warmup_repeats):
    if index == 0:
        return "cold"
    return "warmup" if index <= warmup_repeats else "warm"


def distribution(values):
    if not values:
        return None
    ordered = sorted(values)

    def percentile(q):
        index = (len(ordered) - 1) * q
        low = math.floor(index)
        return ordered[low] + (ordered[math.ceil(index)] - ordered[low]) * (index - low)

    return {"count": len(values), "p50": percentile(.5), "p95": percentile(.95)}


def audio_metrics(audio, sample_rate, elapsed, limit):
    import numpy as np
    if isinstance(sample_rate, bool) or not isinstance(sample_rate, (int, np.integer)) or not 0 < sample_rate <= 192000:
        raise ValueError("invalid sample rate; expected integer in 1..192000")
    samples = np.asarray(audio)
    if samples.ndim != 1 or not samples.size or samples.dtype.kind not in "fi":
        raise ValueError("expected nonempty mono real audio array")
    duration = samples.size / sample_rate
    if not math.isfinite(elapsed) or elapsed < 0:
        raise ValueError("invalid monotonic elapsed time")
    if duration > limit or not np.isfinite(samples).all():
        raise ValueError("audio exceeds duration limit or contains nonfinite samples")
    return samples, {"sample_rate": int(sample_rate), "samples": int(samples.size),
                     "duration_s": duration, "generation_s": elapsed,
                     "wall_audio_rtf": elapsed / duration,
                     "first_model_audio_s": None,
                     "first_model_audio_unavailable": "adapter returns a complete array; no streaming boundary",
                     "clipped_samples_pcm16": int(np.count_nonzero(np.abs(samples) > 1))}


def save_wav(output, name, samples, sample_rate):
    import numpy as np
    pcm = (np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes()
    with output.open(name) as handle, wave.open(handle, "wb") as target:
        target.setnchannels(1)
        target.setsampwidth(2)
        target.setframerate(sample_rate)
        target.writeframes(pcm)


async def benchmark(settings, output, *, factory=create_adapter, clock=time.perf_counter_ns,
                    get_provenance=provenance, identify=device_identity,
                    meter_factory=telemetry.StageMeter.for_device, verify_residency=telemetry.check_residency):
    """Injectable test boundary. Caller owns offline setup and validation."""
    spec = ENGINES[settings.engine]
    report = {"schema_version": 2, "status": "failed", "config": asdict(settings),
              "provenance": get_provenance(), "stages_s": {}, "stages": {}, "runs": [], "warm": None,
              "timing_scope": "adapter calls; WAV IO/validation excluded; first load in fresh process, not cold disk cache; "
                              "CUDA synchronized at stage boundaries only"}
    adapter = meter = None
    stage = "admission"
    try:
        report["model"] = spec.admit(settings)
        report["reference"] = reference_info(settings.reference)
        stage = "device"
        report["device"] = identify(settings)
        meter = meter_factory(torch_device(settings), clock)
        stage = "adapter_init"
        with meter.stage(stage):
            adapter = factory(settings, report["model"], output)
        report["adapter"] = {"class": type(adapter).__name__,
                             "source_sha256": getattr(adapter, "_benchmark_source_sha256", None)}
        if adapter.is_loaded():
            raise ValueError("cold load requires a fresh unloaded adapter")
        stage = "load"
        with meter.stage(stage):
            await adapter.load_model(settings.model)
        stage = "residency"
        # Turbo records its device only once loaded, as _device.
        report["adapter"]["device"] = str(getattr(adapter, "device", None) or getattr(adapter, "_device", None) or settings.backend)
        if settings.backend == "pytorch":
            report["residency"] = verify_residency(spec.inference_roots(adapter), torch_device(settings))
        if spec.loaded_revision is not None:
            report["adapter"]["loaded_revision"] = spec.loaded_revision(adapter, report["model"])
        stage = "runtime"
        report["runtime_identity"] = verify_runtime(adapter, settings)
        report["graph_capture"] = graph_capture_figure(report["runtime_identity"])
        report["streaming"] = {"generate_stream": callable(getattr(adapter, "generate_stream", None)),
                               "first_frame_measured": False}
        stage = "reference_preparation"
        hit = None
        with meter.stage(stage):
            if settings.reference is not None:
                prompt, hit = await adapter.create_voice_prompt(str(settings.reference), settings.reference_text,
                                                                use_cache=spec.reference_use_cache)
            elif settings.preset_voice:
                prompt = {"voice_type": "preset", "preset_engine": settings.engine,
                          "preset_voice_id": settings.preset_voice}
            else:
                prompt = {"voice_type": "designed", "design_prompt": settings.design_prompt}
        report["reference_preparation"] = {"use_cache": spec.reference_use_cache, "cache_hit": hit}
        if hit:
            raise ValueError("first reference preparation reported a cache hit in a fresh run-isolated cache")
        artifact_bytes = 0
        for index in range(settings.warmup_repeats + settings.warm_repeats + 1):
            stage = f"generation_{index}"
            seed = run_seed(settings, index)
            with meter.stage(stage):
                audio, rate = await adapter.generate(settings.text, prompt, language=settings.language,
                                                      seed=seed, instruct=settings.instruct)
            samples, metrics = audio_metrics(audio, rate, meter.stages[stage].wall_s, settings.max_audio_seconds)
            artifact_bytes += samples.size * 2 + 44
            if artifact_bytes > MAX_ARTIFACT_BYTES:
                raise ValueError("WAV artifacts exceed 128 MiB run budget")
            kind = run_kind(index, settings.warmup_repeats)
            name = f"{kind}-{index:02d}.wav"
            save_wav(output, name, samples, rate)
            report["runs"].append({"kind": kind, "index": index, "seed": seed, "wav": name, **metrics,
                                   **generation_facts(adapter)})
        cold = report["runs"][0]
        report["cold_load_reference_generation_rtf"] = (
            meter.stages["load"].wall_s + meter.stages["reference_preparation"].wall_s + cold["generation_s"]
        ) / cold["duration_s"]
        warm = [r for r in report["runs"] if r["kind"] == "warm"]
        reported_eos = [r["hit_eos"] for r in warm if r["hit_eos"] is not None]
        report["warm"] = {"generation_s": distribution([r["generation_s"] for r in warm]),
                          "wall_audio_rtf": distribution([r["wall_audio_rtf"] for r in warm]),
                          "steps": distribution([r["steps"] for r in warm if r["steps"] is not None]),
                          "hit_eos_count": sum(reported_eos) if reported_eos else None,
                          "bound_count": len(reported_eos) - sum(reported_eos) if reported_eos else None,
                          "percentile_method": "linear interpolation at (n-1)*q"}
        report["status"] = "ok"
    except (Exception, KeyboardInterrupt) as exc:
        report["error"] = {"stage": stage, "type": type(exc).__name__, "message": str(exc)[:2000]}
    finally:
        if adapter is not None:
            try:
                adapter.unload_model()
            except Exception as exc:
                report["status"] = "failed"
                report["cleanup_error"] = {"type": type(exc).__name__, "message": str(exc)[:2000]}
        if meter is not None:
            report["stages"] = {name: asdict(m) for name, m in meter.stages.items()}
            report["stages_s"] = {name: m.wall_s for name, m in meter.stages.items()}
        with output.open("results.json") as handle:
            handle.write(json.dumps(report, default=str, indent=2, allow_nan=False).encode() + b"\n")
    return report


def parse_args(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("engine", "backend", "device", "model", "language", "text", "cache-root", "output-root"):
        parser.add_argument("--" + name, required=True, type=Path if name.endswith("root") else str)
    parser.add_argument("--reference", type=Path)
    for name in ("reference-text", "preset-voice", "design-prompt", "instruct"):
        parser.add_argument("--" + name)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--seeds", type=seed_list, default=(),
                        help="comma-separated seeds cycled across generations; overrides --seed")
    parser.add_argument("--warm-repeats", type=int, default=3)
    parser.add_argument("--warmup-repeats", type=int, default=0,
                        help="generations after the cold one that are recorded but excluded from warm statistics")
    parser.add_argument("--max-audio-seconds", type=float, default=30)
    return Settings(**vars(parser.parse_args(argv)))


def seed_list(text):
    try:
        return tuple(int(part) for part in text.split(","))
    except ValueError:
        raise argparse.ArgumentTypeError("seeds must be comma-separated integers") from None


def main(argv=None):
    output = None
    try:
        settings = parse_args(argv)
        validate(settings)
        output = Output(settings.output_root)
        configure_offline(settings, output)
        report = asyncio.run(benchmark(settings, output))
        print(str(output.path / "results.json"))
        if report["status"] != "ok":
            print(json.dumps(report.get("error") or report["cleanup_error"]), file=sys.stderr)
            return 2
        return 0
    except (OSError, ValueError) as exc:
        print(f"benchmark refused: {exc}", file=sys.stderr)
        return 2
    finally:
        if output is not None:
            output.close()


if __name__ == "__main__":
    raise SystemExit(main())
