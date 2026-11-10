"""Capabilities derived from the selected local registry entry and adapter contracts.

Registry identity records repository names, not a verified weights commit. Runtime
qualification and model licence suitability remain unknown unless explicitly evidenced.
"""

import hashlib
import importlib.metadata
import json
import platform
import re
from pathlib import Path

# Tokens recognised by the existing paralinguistic editor, not all bracketed prose.
RECOGNIZED_TAGS = frozenset(
    (
        "laugh",
        "chuckle",
        "gasp",
        "cough",
        "sigh",
        "groan",
        "sniff",
        "shush",
        "clear throat",
        "angry",
        "crying",
        "dramatic",
        "fear",
        "happy",
        "narration",
        "sarcastic",
        "surprised",
        "whispering",
        "whisper",
        "advertisement",
    )
)
# Adapter documents these three tokens explicitly; other editor tokens are not qualified.
TURBO_TAGS = ("[laugh]", "[cough]", "[chuckle]")
SEED_ENGINES = frozenset(
    (
        "qwen",
        "qwen_custom_voice",
        "qwen_voice_design",
        "luxtts",
        "chatterbox",
        "chatterbox_turbo",
        "tada",
        "kokoro",
        "omnivoice",
        "moss_tts",
    )
)


def _adapter_runtime(engine):
    """Match get_tts_backend_for_engine without importing or constructing models."""
    from ..utils.platform_detect import get_backend_type

    backend = get_backend_type() if engine in ("qwen", "chatterbox", "qwen_custom_voice", "qwen_voice_design") else "pytorch"
    if engine == "moss_tts":
        backend = "onnx-cpu"
    adapters = {
        "qwen": ("mlx_backend", "MLXTTSBackend", ())
        if backend == "mlx"
        else ("pytorch_backend", "PyTorchTTSBackend", ("qwen-tts",)),
        "chatterbox": ("chatterbox_mlx_backend", "ChatterboxMLXTTSBackend", ())
        if backend == "mlx"
        else ("chatterbox_backend", "ChatterboxTTSBackend", ("chatterbox-tts",)),
        "chatterbox_turbo": ("chatterbox_turbo_backend", "ChatterboxTurboTTSBackend", ("chatterbox-tts",)),
        "qwen_custom_voice": ("qwen_mlx_styles_backend", "QwenMLXCustomVoiceBackend", ())
        if backend == "mlx"
        else ("qwen_custom_voice_backend", "QwenCustomVoiceBackend", ("qwen-tts",)),
        "qwen_voice_design": ("qwen_mlx_styles_backend", "QwenMLXVoiceDesignBackend", ())
        if backend == "mlx"
        else ("qwen_voice_design_backend", "QwenVoiceDesignBackend", ("qwen-tts",)),
        "moss_tts": ("moss_tts_backend", "MossTTSBackend", ("onnxruntime", "sentencepiece", "moss-tts-nano")),
        "luxtts": ("luxtts_backend", "LuxTTSBackend", ("Zipvoice",)),
        "tada": ("hume_backend", "HumeTadaBackend", ("hume-tada",)),
        "kokoro": ("kokoro_backend", "KokoroTTSBackend", ("kokoro", "misaki")),
        "omnivoice": ("omnivoice_backend", "OmniVoiceBackend", ("omnivoice",)),
    }
    if engine not in adapters:
        raise ValueError(f"No Studio runtime identity is registered for engine {engine!r}")
    module, adapter, engine_packages = adapters[engine]
    runtime_packages = ("onnxruntime",) if backend == "onnx-cpu" else ("mlx", "mlx-audio") if backend == "mlx" else ("torch", "torchaudio")
    versions = {}
    for package in (*runtime_packages, *engine_packages, "numpy", "transformers", "huggingface-hub", "safetensors"):
        try:
            versions[package] = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            versions[package] = None
    return {
        "backend": backend,
        "adapter": f"backend.backends.{module}.{adapter}",
        "adapter_sha256": _sources_sha256(module),
        "packages": versions,
    }


def _sources_sha256(*modules):
    """One digest over the named backend modules, in order; None when any source is absent."""
    digest = hashlib.sha256()
    for module in modules:
        source = Path(__file__).resolve().parent.parent / "backends" / f"{module}.py"
        try:
            digest.update(source.read_bytes())
        except OSError:
            # Frozen builds may omit Python source. Do not fabricate its identity.
            return None
    return digest.hexdigest()


def capability_for_config(cfg):
    from ..backends.qwen_cuda_variants import CUDA_GRAPH_RUNTIME, is_cuda_graph_variant

    runtime = _adapter_runtime(cfg.engine)
    if cfg.engine == "qwen" and is_cuda_graph_variant(cfg.model_size):
        try:
            runtime["packages"][CUDA_GRAPH_RUNTIME.package] = importlib.metadata.version(CUDA_GRAPH_RUNTIME.package)
        except importlib.metadata.PackageNotFoundError:
            runtime["packages"][CUDA_GRAPH_RUNTIME.package] = None
        runtime["runtime"] = CUDA_GRAPH_RUNTIME.identity()
        runtime["adapter_sources"] = ["pytorch_backend", "qwen_cudagraph", "qwen_cuda_variants"]
        runtime["adapter_sha256"] = _sources_sha256(*runtime["adapter_sources"])
    identity = {
        "engine": cfg.engine,
        "model_size": cfg.model_size,
        "model_name": cfg.model_name,
        "hf_repo_id": cfg.hf_repo_id,
        "aux_hf_repo_ids": list(cfg.aux_hf_repo_ids),
        "weights_revision": getattr(cfg, "revision", None),
        "aux_weights_revisions": dict(getattr(cfg, "aux_revisions", {})),
        "license": getattr(cfg, "license", None),
        **runtime,
        "platform": platform.system(),
        "machine": platform.machine(),
        "python": platform.python_version(),
    }
    semantics = {
        "supports_instruct": bool(cfg.supports_instruct and cfg.engine != "omnivoice"),
        "supports_voice_design": cfg.engine == "qwen_voice_design",
        "supports_seed": cfg.engine in SEED_ENGINES,
        "languages": list(cfg.languages),
        "expressive_tags": list(TURBO_TAGS if cfg.engine == "chatterbox_turbo" else ()),
        "recognized_tags": sorted(f"[{tag}]" for tag in RECOGNIZED_TAGS),
        "supported_attributes": [],
        "attribute_vocabulary": "closed_unqualified" if cfg.engine == "omnivoice" else "none",
        "limits": {"max_chunk_chars": 100000, "max_crossfade_ms": 10000},
        "streaming": {"qualified": False},
        "performance_conversion": {"qualified": False},
        "commercial_use": "restricted" if cfg.engine == "omnivoice" else "unknown",
    }
    revision = hashlib.sha256(
        json.dumps([identity, semantics], sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    return {**semantics, "registry_identity": identity, "registry_revision": revision}


def resolve_voice(voice):
    from ..backends import get_tts_model_configs

    if not voice:
        raise ValueError("Assign a voice before generation")
    cfg = next(
        (
            c
            for c in get_tts_model_configs()
            if c.engine == voice.get("engine") and c.model_size == (voice.get("model_size") or "default")
        ),
        None,
    )
    if cfg is None:
        raise ValueError("The selected voice model variant is no longer registered; reassign the voice")
    return capability_for_config(cfg)


def freeze_passage(passage, resolver=resolve_voice):
    voice = passage.get("voice_snapshot")
    from .archive_scope import unavailable_references

    if voice and unavailable_references(voice):
        raise ValueError(
            f"Passage {passage['id']}: regeneration references are unavailable. "
            "Existing audio can still play; reassign a voice with reference audio before generating."
        )
    current = resolver(voice)
    snapshot = (voice or {}).get("capabilities")
    if snapshot is not None and snapshot != current:
        raise ValueError("The frozen voice capability identity differs from the current registry; reassign the voice")
    caps = snapshot or current
    language = passage.get("language")
    if language not in caps["languages"]:
        raise ValueError(f"Passage {passage['id']}: language {language!r} is not supported by the selected model")
    supported = {t.lower() for t in caps["expressive_tags"]}
    for match in re.finditer(r"\[([^\[\]]+)\]", passage["text"]):
        tag = match.group(0).lower()
        if match.group(1).strip().lower() in RECOGNIZED_TAGS and tag not in supported:
            raise ValueError(
                f"Passage {passage['id']}: {match.group(0)} is unsupported by this model; remove or replace it before generating"
            )
    direction = passage["direction"]
    effective = dict(direction)
    effective["instruct"] = direction["instruct"] or None if caps["supports_instruct"] else None
    effective["seed"] = direction["seed"] if caps["supports_seed"] else None
    return caps, effective
