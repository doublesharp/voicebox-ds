"""Offline contract tests for Qwen CustomVoice/VoiceDesign MLX routing."""

import asyncio
import subprocess
import sys
import threading
from contextlib import nullcontext
from types import ModuleType, SimpleNamespace

import numpy as np
import pytest

from backend import backends
from backend.studio import capabilities


@pytest.mark.parametrize("backend_type", ["mlx", "pytorch"])
@pytest.mark.parametrize(
    ("engine", "variant", "sizes"),
    [
        ("qwen_custom_voice", "CustomVoice", ["1.7B", "0.6B"]),
        ("qwen_voice_design", "VoiceDesign", ["1.7B"]),
    ],
)
def test_registry_and_runtime_identity_follow_platform(monkeypatch, backend_type, engine, variant, sizes):
    from backend.utils import platform_detect

    monkeypatch.setattr(backends, "get_backend_type", lambda: backend_type)
    monkeypatch.setattr(platform_detect, "get_backend_type", lambda: backend_type)
    configs = [cfg for cfg in backends.get_tts_model_configs() if cfg.engine == engine]
    assert [cfg.model_size for cfg in configs] == sizes
    for cfg in configs:
        prefix = "mlx-community" if backend_type == "mlx" else "Qwen"
        suffix = "-bf16" if backend_type == "mlx" else ""
        assert cfg.hf_repo_id == f"{prefix}/Qwen3-TTS-12Hz-{cfg.model_size}-{variant}{suffix}"
        caps = capabilities.capability_for_config(cfg)
        identity = caps["registry_identity"]
        assert identity["backend"] == backend_type
        assert identity["hf_repo_id"] == cfg.hf_repo_id
        assert ("mlx-audio" in identity["packages"]) == (backend_type == "mlx")
        assert ("qwen_mlx_styles_backend" in identity["adapter"]) == (backend_type == "mlx")
        assert caps["supports_seed"]
        assert caps["supports_instruct"]
        assert caps["streaming"]["qualified"] is False


@pytest.mark.parametrize("backend_type", ["mlx", "pytorch"])
@pytest.mark.parametrize("engine", ["qwen_custom_voice", "qwen_voice_design"])
def test_factory_selects_platform_adapter_without_loading(monkeypatch, backend_type, engine):
    monkeypatch.setattr(backends, "get_backend_type", lambda: backend_type)
    monkeypatch.setattr(backends, "_tts_backends", {})
    selected = object()
    other = object()
    names = {
        "qwen_custom_voice": ("QwenCustomVoiceBackend", "QwenMLXCustomVoiceBackend"),
        "qwen_voice_design": ("QwenVoiceDesignBackend", "QwenMLXVoiceDesignBackend"),
    }
    torch_class, mlx_class = names[engine]
    torch_module = ModuleType(f"backend.backends.{engine}_backend")
    setattr(torch_module, torch_class, lambda: selected if backend_type == "pytorch" else other)
    mlx_module = ModuleType("backend.backends.qwen_mlx_styles_backend")
    setattr(mlx_module, mlx_class, lambda: selected if backend_type == "mlx" else other)
    monkeypatch.setitem(sys.modules, torch_module.__name__, torch_module)
    monkeypatch.setitem(sys.modules, mlx_module.__name__, mlx_module)
    assert backends.get_tts_backend_for_engine(engine) is selected
    assert backends.get_tts_backend_for_engine(engine) is selected


@pytest.fixture
def runtime(monkeypatch):
    from backend.backends import qwen_mlx_styles_backend as styles

    state = SimpleNamespace(models=[], calls=[], loads=[], clears=[], seeds=[], load_hook=None, generate_hook=None)

    class Model:
        def __init__(self, repo):
            self.config = SimpleNamespace(tts_model_type="custom_voice" if "CustomVoice" in repo else "voice_design")
            self.tokenizer = object()
            self.speech_tokenizer = object()

        def results(self, method, kwargs):
            state.calls.append((method, kwargs, threading.get_ident()))
            if state.generate_hook:
                state.generate_hook()
            yield SimpleNamespace(audio=np.array([0.25, -0.25]), sample_rate=24000)
            yield SimpleNamespace(audio=np.array([0.5]), sample_rate=24000)

        # Match the installed dependency's explicit keyword names; **kwargs
        # would hide adapter/API mismatches from these CPU-only tests.
        def generate_custom_voice(self, text, speaker, language="auto", instruct=None):
            yield from self.results(
                "custom_voice", dict(text=text, speaker=speaker, language=language, instruct=instruct)
            )

        def generate_voice_design(self, text, instruct, language="auto"):
            yield from self.results("voice_design", dict(text=text, instruct=instruct, language=language))

    def load(repo):
        state.loads.append((repo, threading.get_ident()))
        model = Model(repo)
        state.models.append(model)
        if state.load_hook:
            state.load_hook(model)
        return model

    tts = ModuleType("mlx_audio.tts")
    tts.load = load
    mlx_audio = ModuleType("mlx_audio")
    mlx_audio.tts = tts
    mlx = ModuleType("mlx")
    core = ModuleType("mlx.core")
    core.random = SimpleNamespace(seed=lambda seed: state.seeds.append((seed, threading.get_ident())))
    mlx.core = core
    for module in (tts, mlx_audio, mlx, core):
        monkeypatch.setitem(sys.modules, module.__name__, module)
    monkeypatch.setattr(styles, "empty_mlx_cache", lambda: state.clears.append(threading.get_ident()))
    monkeypatch.setattr(styles, "model_load_progress", lambda *args: nullcontext())
    monkeypatch.setattr(styles, "is_model_cached", lambda repo, **_kwargs: True)
    state.styles = styles
    return state


def test_import_and_construction_do_not_initialize_mlx():
    code = """
import builtins
original = builtins.__import__
def guarded(name, *args, **kwargs):
    if name.split('.')[0] in ('mlx', 'mlx_audio', 'qwen_tts'):
        raise AssertionError('Native model runtime imported: ' + name)
    return original(name, *args, **kwargs)
builtins.__import__ = guarded
from backend.backends.qwen_mlx_styles_backend import QwenMLXCustomVoiceBackend, QwenMLXVoiceDesignBackend
assert not QwenMLXCustomVoiceBackend().is_loaded()
assert not QwenMLXVoiceDesignBackend().is_loaded()
"""
    result = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr


@pytest.mark.asyncio
@pytest.mark.parametrize("size", ["1.7B", "0.6B"])
async def test_custom_voice_preserves_preset_instruct_language_and_sampling_seed(runtime, size):
    backend = runtime.styles.QwenMLXCustomVoiceBackend(size)
    audio, rate = await backend.generate(
        "こんにちは", {"preset_voice_id": "Ono_Anna"}, "ja", seed=0, instruct="Very happy"
    )
    assert audio.dtype == np.float32
    np.testing.assert_array_equal(audio, [0.25, -0.25, 0.5])
    assert rate == 24000
    method, kwargs, thread = runtime.calls[0]
    assert method == "custom_voice"
    assert kwargs == dict(text="こんにちは", speaker="Ono_Anna", language="japanese", instruct="Very happy")
    assert runtime.seeds == [(0, thread)]
    assert runtime.loads == [(backend._get_model_path(size), thread)]
    assert thread != threading.get_ident()
    await backend.generate("Hello", {}, "unknown")
    assert runtime.calls[-1][1] == dict(text="Hello", speaker="Ryan", language="auto", instruct=None)
    assert len(runtime.loads) == 1
    assert len(runtime.seeds) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("instruct", [None, "Speak gently"])
async def test_design_identity_leads_request_direction(runtime, instruct):
    backend = runtime.styles.QwenMLXVoiceDesignBackend()
    await backend.generate("Hello", {"design_prompt": "A low, warm voice. "}, "en", seed=42, instruct=instruct)
    expected = "A low, warm voice. Speak gently" if instruct else "A low, warm voice. "
    assert runtime.calls[0][1] == dict(text="Hello", language="english", instruct=expected)
    await backend.generate("Default", {}, "zh")
    assert runtime.calls[-1][1]["instruct"] == "A clear, neutral voice with natural pacing."
    assert runtime.calls[-1][1]["language"] == "chinese"


@pytest.mark.asyncio
@pytest.mark.parametrize(("language", "expected"), list(backends.LANGUAGE_CODE_TO_NAME.items()))
async def test_registered_languages_reach_style_api(runtime, language, expected):
    backend = runtime.styles.QwenMLXCustomVoiceBackend()
    await backend.generate("Text", {}, language)
    assert runtime.calls[-1][1]["language"] == expected


@pytest.mark.asyncio
async def test_audio_materialization_uses_load_thread(runtime):
    backend = runtime.styles.QwenMLXVoiceDesignBackend()
    await backend.load_model()
    loader_thread = runtime.loads[0][1]

    class WorkerAudio:
        def __array__(self, dtype=None):
            assert threading.get_ident() == loader_thread
            return np.array([0.1, 0.2], dtype=dtype)

    backend.model.generate_voice_design = lambda **kwargs: iter(
        [SimpleNamespace(audio=WorkerAudio(), sample_rate=24000)]
    )
    audio, rate = await backend.generate("Text", {})
    np.testing.assert_allclose(audio, [0.1, 0.2])
    assert rate == 24000


@pytest.mark.asyncio
async def test_combine_reference_protocol_keeps_audio_and_transcripts(runtime, tmp_path):
    import soundfile as sf

    paths = [tmp_path / "a.wav", tmp_path / "b.wav"]
    for path in paths:
        sf.write(path, np.full(240, 0.1, dtype=np.float32), 24000)
    backend = runtime.styles.QwenMLXCustomVoiceBackend()
    audio, text = await backend.combine_voice_prompts([str(path) for path in paths], ["First", "Second"])
    assert audio.size == 480
    assert np.isfinite(audio).all()
    assert text == "First Second"


@pytest.mark.asyncio
async def test_shared_worker_affinity_and_size_switching(runtime):
    from backend.backends.mlx_backend import _run_on_mlx_thread

    backend = runtime.styles.QwenMLXCustomVoiceBackend()
    await asyncio.gather(*[backend.load_model("1.7B") for _ in range(5)])
    assert len(runtime.loads) == 1
    await backend.load_model("0.6B")
    await backend.generate("small", {})
    assert backend._current_model_size == backend.model_size == "0.6B"
    other = runtime.styles.QwenMLXVoiceDesignBackend()
    await other.generate("designed", {})
    shared_thread = await _run_on_mlx_thread(threading.get_ident)
    assert {thread for _, thread in runtime.loads} == {shared_thread}
    assert {thread for _, _, thread in runtime.calls} == {shared_thread}
    assert runtime.clears == [shared_thread]
    for invalid in ("4B", "default", ""):
        with pytest.raises(ValueError, match="Unknown model size"):
            await backend.load_model(invalid)
    with pytest.raises(ValueError, match="Unknown model size"):
        runtime.styles.QwenMLXVoiceDesignBackend("0.6B")


@pytest.mark.asyncio
@pytest.mark.parametrize("cls", ["QwenMLXCustomVoiceBackend", "QwenMLXVoiceDesignBackend"])
async def test_references_and_other_voice_types_fail_closed(runtime, cls):
    backend = getattr(runtime.styles, cls)()
    bad_prompts = [
        {"ref_audio": "missing.wav"},
        {"ref_audio_path": "existing.wav"},
        {"audio_path": "reference.wav"},
        {"voice_type": "cloned"},
        {"preset_engine": "kokoro"},
        {"design_prompt": "wrong"} if backend.voice_type == "preset" else {"preset_voice_id": "Ryan"},
    ]
    for prompt in bad_prompts:
        with pytest.raises(ValueError, match="Qwen|voice prompt"):
            await backend.generate("Must not render a replacement", prompt)
    with pytest.raises(ValueError, match="cannot clone"):
        await backend.create_voice_prompt("sample.wav", "reference")
    prompt, cached = await backend.create_voice_prompt("", "")
    assert prompt == backend.default_prompt
    assert cached is False
    prompt.clear()
    assert backend.default_prompt
    assert not runtime.loads
    assert not runtime.calls


@pytest.mark.asyncio
@pytest.mark.parametrize("fault", ["type", "method", "text_tokenizer", "speech_tokenizer", "loader"])
async def test_load_failure_never_publishes_ready_model(runtime, fault):
    backend = runtime.styles.QwenMLXCustomVoiceBackend()

    def fail(model):
        if fault == "type":
            model.config.tts_model_type = "base"
        elif fault == "method":
            model.generate_custom_voice = None
        elif fault == "text_tokenizer":
            model.tokenizer = None
        elif fault == "speech_tokenizer":
            model.speech_tokenizer = None
        else:
            raise RuntimeError("load failed")

    runtime.load_hook = fail
    with pytest.raises(RuntimeError, match="checkpoint|mlx-audio|tokenizer|load failed"):
        await backend.load_model()
    assert not backend.is_loaded()
    assert backend._current_model_size is None
    assert len(runtime.clears) == 1
    runtime.load_hook = None
    await backend.load_model()
    assert backend.is_loaded()


@pytest.mark.asyncio
@pytest.mark.parametrize("fails", [False, True])
async def test_unload_during_inference_drains_after_physical_completion(runtime, fails):
    backend = runtime.styles.QwenMLXCustomVoiceBackend()

    def unload():
        backend.unload_model()
        if fails:
            raise RuntimeError("inference failed")

    runtime.generate_hook = unload
    if fails:
        with pytest.raises(RuntimeError, match="inference failed"):
            await backend.generate("hello", {})
    else:
        audio, _ = await backend.generate("hello", {})
        assert len(audio) == 3
    assert not backend.is_loaded()
    assert backend._current_model_size is None
    assert len(runtime.clears) == 2
    backend.unload_model()
    assert len(runtime.clears) == 2
    runtime.generate_hook = None
    await backend.generate("reload", {})
    assert backend.is_loaded()
    assert len(runtime.loads) == 2


@pytest.mark.asyncio
async def test_unload_during_load_prevents_late_ready_publication(runtime):
    backend = runtime.styles.QwenMLXVoiceDesignBackend()
    runtime.load_hook = lambda model: backend.unload_model()
    await backend.load_model()
    assert not backend.is_loaded()
    assert backend._current_model_size is None
    assert len(runtime.clears) == 1
    runtime.load_hook = None
    await backend.generate("reload", {})
    assert backend.is_loaded()
    assert len(runtime.loads) == 2


@pytest.mark.asyncio
async def test_unload_during_lazy_load_allows_only_current_generation(runtime):
    backend = runtime.styles.QwenMLXCustomVoiceBackend()
    runtime.load_hook = lambda model: backend.unload_model()
    audio, _ = await backend.generate("in flight", {})
    assert len(audio) == 3
    assert not backend.is_loaded()
    assert len(runtime.clears) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("fails", [False, True])
async def test_cancel_keeps_lock_until_worker_exits_even_after_second_cancel(runtime, fails):
    backend = runtime.styles.QwenMLXCustomVoiceBackend()
    started, release = threading.Event(), threading.Event()

    def block():
        started.set()
        assert release.wait(5), "test did not release worker"
        if fails:
            raise RuntimeError("worker failed after cancellation")

    runtime.generate_hook = block
    task = asyncio.create_task(backend.generate("cancelled", {}))
    try:
        assert await asyncio.to_thread(started.wait, 5)
        task.cancel()
        await asyncio.sleep(0)
        task.cancel()
        await asyncio.sleep(0)
        assert backend._op_lock.locked()
        assert not task.done()
        waiter = asyncio.create_task(backend.load_model("0.6B"))
        await asyncio.sleep(0)
        assert len(runtime.loads) == 1
    finally:
        release.set()
    with pytest.raises(asyncio.CancelledError):
        await task
    await waiter
    assert not backend._op_lock.locked()
    assert backend._current_model_size == "0.6B"


@pytest.mark.asyncio
async def test_empty_or_mismatched_audio_fails_without_hiding_error(runtime):
    backend = runtime.styles.QwenMLXVoiceDesignBackend()
    await backend.load_model()
    backend.model.generate_voice_design = lambda **kwargs: iter(())
    with pytest.raises(RuntimeError, match="no audio"):
        await backend.generate("hello", {})
    backend.model.generate_voice_design = lambda **kwargs: iter(
        [
            SimpleNamespace(audio=[0.1], sample_rate=24000),
            SimpleNamespace(audio=[0.2], sample_rate=16000),
        ]
    )
    with pytest.raises(RuntimeError, match="inconsistent"):
        await backend.generate("hello", {})


@pytest.mark.asyncio
async def test_registry_load_readiness_cache_inventory_and_unload_use_same_variant(runtime, monkeypatch, tmp_path):
    from huggingface_hub import constants

    from backend.backends import base
    from backend.routes.models import get_model_status

    monkeypatch.setattr(backends, "get_backend_type", lambda: "mlx")
    monkeypatch.setattr(backends, "_tts_backends", {})
    monkeypatch.setattr(constants, "HF_HUB_CACHE", str(tmp_path))
    # Use the real local cache reader for backend readiness and inventory.
    monkeypatch.setattr(runtime.styles, "is_model_cached", base.is_model_cached)

    async def downloaded(cfg):
        from backend.utils.model_inventory import model_inventory

        model_inventory.invalidate()
        status = await get_model_status()
        return next(item.downloaded for item in status.models if item.model_name == cfg.model_name)

    configs = [c for c in backends.get_tts_model_configs() if c.engine in ("qwen_custom_voice", "qwen_voice_design")]
    for cfg in configs:
        backend = backends.get_tts_backend_for_engine(cfg.engine)
        root = tmp_path / ("models--" + cfg.hf_repo_id.replace("/", "--"))
        revision = "a" * 40
        snapshot = root / "snapshots" / revision
        (root / "refs").mkdir(parents=True)
        (root / "refs" / "main").write_text(revision)
        for asset in cfg.required_files:
            file = snapshot / asset
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(b"inventory fixture")
        assert backend._get_model_path(cfg.model_size) == cfg.hf_repo_id
        assert backend._is_model_cached(cfg.model_size)
        assert await downloaded(cfg) is True
        await backends.ensure_model_cached_or_raise(cfg.engine, cfg.model_size)
        await backends.get_model_load_func(cfg)()
        assert backends.check_model_loaded(cfg)
        assert runtime.loads[-1][0] == cfg.hf_repo_id
        if cfg.engine == "qwen_custom_voice" and cfg.model_size == "0.6B":
            big = next(c for c in configs if c.engine == cfg.engine and c.model_size == "1.7B")
            assert not backends.check_model_loaded(big)
            assert not backends.unload_model_by_config(big)
        assert backends.unload_model_by_config(cfg)
        assert not backends.check_model_loaded(cfg)
        assert not backends.unload_model_by_config(cfg)
        (snapshot / "model.safetensors").unlink()
        assert not backend._is_model_cached(cfg.model_size)
        assert await downloaded(cfg) is False
        from fastapi import HTTPException

        with pytest.raises(HTTPException):
            await backends.ensure_model_cached_or_raise(cfg.engine, cfg.model_size)
