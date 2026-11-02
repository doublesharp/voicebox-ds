"""CUDA-graph variants are listed only where they can run and refused elsewhere before any load."""

import importlib.metadata

import pytest
from pydantic import ValidationError

from backend import backends
from backend.backends import qwen_cuda_variants as variants
from backend.backends.qwen_cuda_variants import CudaGraphRuntimeError
from backend.models import GenerationRequest
from backend.studio import capabilities


def listed(monkeypatch, backend_type="pytorch", reason=None):
    monkeypatch.setattr(backends, "get_backend_type", lambda: backend_type)
    monkeypatch.setattr(variants, "cuda_graph_unavailable_reason", lambda: reason)
    return {c.model_size: c for c in backends.get_tts_model_configs() if c.engine == "qwen"}


def test_pytorch_cuda_host_lists_pinned_variants_without_instruct(monkeypatch):
    configs = listed(monkeypatch)
    assert set(configs) == {"1.7B", "0.6B", "0.6B-cudagraph", "1.7B-cudagraph"}
    small, large = configs["0.6B-cudagraph"], configs["1.7B-cudagraph"]
    assert small.model_name == "qwen-tts-0.6B-cudagraph" and large.model_name == "qwen-tts-1.7B-cudagraph"
    assert "CUDA graphs" in small.display_name and "Experimental" in small.display_name
    assert small.hf_repo_id == "Qwen/Qwen3-TTS-12Hz-0.6B-Base" and small.revision == "5d83992436eae1d760afd27aff78a71d676296fc"
    assert large.hf_repo_id == "Qwen/Qwen3-TTS-12Hz-1.7B-Base" and large.revision == "fd4b254389122332181a7c3db7f27e918eec64e3"
    assert small.supports_instruct is False and small.retries_runaway is False and small.needs_trim is False
    assert small.license == "apache-2.0" and "speech_tokenizer/model.safetensors" in small.required_files
    assert small.languages == configs["0.6B"].languages
    assert configs["0.6B"].revision is None, "stock entries stay unpinned"


@pytest.mark.parametrize("backend_type,reason", [("mlx", None), ("pytorch", "No CUDA device is available")])
def test_variants_are_hidden_where_they_cannot_run(monkeypatch, backend_type, reason):
    assert not any(size.endswith("cudagraph") for size in listed(monkeypatch, backend_type, reason))


@pytest.mark.asyncio
@pytest.mark.parametrize("loader", ["load_engine_model", "_load_engine_model_unmanaged"])
async def test_other_engines_refuse_the_variant_before_backend_access(monkeypatch, loader):
    def unexpected(_engine):
        pytest.fail("A CUDA-graph selection reached another engine's backend")

    monkeypatch.setattr(backends, "get_tts_backend_for_engine", unexpected)
    with pytest.raises(ValueError, match="Qwen Base"):
        await getattr(backends, loader)("kokoro", "0.6B-cudagraph")


@pytest.mark.asyncio
@pytest.mark.parametrize("loader", ["load_engine_model", "_load_engine_model_unmanaged"])
async def test_unavailable_runtime_is_refused_before_backend_access(monkeypatch, loader):
    listed(monkeypatch, "pytorch", "faster-qwen3-tts is not installed")
    monkeypatch.setattr(backends, "get_tts_backend_for_engine", lambda _engine: pytest.fail("backend reached"))
    with pytest.raises(CudaGraphRuntimeError, match="not installed"):
        await getattr(backends, loader)("qwen", "1.7B-cudagraph")


class FakeTorch:
    def __init__(self, cuda="12.8", hip=None, available=True):
        self.version = type("version", (), {"cuda": cuda, "hip": hip})()
        self.cuda = type("cuda", (), {"is_available": staticmethod(lambda: available)})()


@pytest.mark.parametrize("installed,torch,env,expected", [
    (None, FakeTorch(), {}, "not installed"),
    ("0.5.4", FakeTorch(), {}, "0.5.4"),
    ("0.3.2", FakeTorch(hip="6.2"), {}, "ROCm"),
    ("0.3.2", FakeTorch(cuda=None), {}, "no CUDA"),
    ("0.3.2", FakeTorch(available=False), {}, "No CUDA device"),
    ("0.3.2", FakeTorch(), {"VOICEBOX_FORCE_CPU": "1"}, "VOICEBOX_FORCE_CPU"),
    ("0.3.2", FakeTorch(), {}, None),
])
def test_runtime_availability_names_each_blocker(monkeypatch, installed, torch, env, expected):
    import sys

    def version(package):
        if installed is None:
            raise importlib.metadata.PackageNotFoundError(package)
        return installed

    monkeypatch.setattr(importlib.metadata, "version", version)
    monkeypatch.setitem(sys.modules, "torch", torch)
    monkeypatch.delenv("VOICEBOX_FORCE_CPU", raising=False)
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    reason = variants.cuda_graph_unavailable_reason()
    if expected is None:
        assert reason is None
    else:
        assert expected in reason


def test_generation_requests_accept_the_variant_only_for_qwen_base():
    request = GenerationRequest(profile_id="voice", text="A sample.", engine="qwen", model_size="0.6B-cudagraph")
    assert request.model_size == "0.6B-cudagraph"
    assert GenerationRequest(profile_id="voice", text="A sample.", model_size="1.7B-cudagraph").model_size == "1.7B-cudagraph"
    with pytest.raises(ValidationError, match="Qwen Base"):
        GenerationRequest(profile_id="voice", text="A sample.", engine="kokoro", model_size="1.7B-cudagraph")
    with pytest.raises(ValidationError):
        GenerationRequest(profile_id="voice", text="A sample.", engine="qwen", model_size="4B-cudagraph")


def test_studio_identity_records_the_pinned_runtime(monkeypatch):
    from backend.utils import platform_detect

    monkeypatch.setattr(platform_detect, "get_backend_type", lambda: "pytorch")
    configs = listed(monkeypatch)
    stock = capabilities.capability_for_config(configs["0.6B"])
    variant = capabilities.capability_for_config(configs["0.6B-cudagraph"])
    identity = variant["registry_identity"]
    assert identity["adapter"].endswith("pytorch_backend.PyTorchTTSBackend")
    assert identity["weights_revision"] == "5d83992436eae1d760afd27aff78a71d676296fc"
    assert identity["runtime"] == {
        "runtime": "cudagraph", "package": "faster-qwen3-tts", "version": "0.3.2",
        "commit": "a70afc0f81f7f5f8801c3227968f1102f43f211c", "dtype": "bfloat16", "attn": "sdpa", "max_seq_len": 2048,
    }
    assert "faster-qwen3-tts" in identity["packages"]
    assert "runtime" not in stock["registry_identity"]
    assert stock["registry_revision"] != variant["registry_revision"]
    assert variant["supports_instruct"] is False and variant["supports_seed"] is True
