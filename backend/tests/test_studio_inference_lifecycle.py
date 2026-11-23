"""The legacy and studio entry points must share physical model ownership."""

import asyncio
from types import SimpleNamespace

import numpy as np
import pytest
import soundfile as sf

from backend import backends
from backend.routes import models as model_routes
from backend.services import generation, profiles, tts
from backend.studio.jobs import synthesize


@pytest.mark.asyncio
@pytest.mark.parametrize("stage", ["load", "prompt"])
async def test_legacy_preparation_waits_for_studio_lifecycle(monkeypatch, tmp_path, stage):
    entered = asyncio.Event()
    release = asyncio.Event()
    calls = []

    async def load(engine, size):
        calls.append(("load", engine))
        if engine == "studio" and stage == "load":
            entered.set()
            await release.wait()

    class Model:
        async def create_voice_prompt(self, *args, **kwargs):
            if stage == "prompt":
                entered.set()
                await release.wait()
            return {}, None

        async def generate(self, *args, **kwargs):
            return np.zeros(100, dtype="float32"), 1000

    async def noop(*args, **kwargs):
        return {}

    monkeypatch.setattr(backends, "ensure_model_cached_or_raise", noop)
    monkeypatch.setattr(backends, "load_engine_model", load)
    monkeypatch.setattr(backends, "get_tts_backend_for_engine", lambda engine: Model())
    monkeypatch.setattr(profiles, "create_voice_prompt_for_profile", noop)
    monkeypatch.setattr(generation, "get_db", lambda: iter([SimpleNamespace(close=lambda: None)]))
    monkeypatch.setattr(generation, "release_generation_memory", lambda model: None)
    monkeypatch.setattr(tts, "audio_to_wav_bytes", lambda *args: b"wav")
    request = {
        "passage": {
            "text": "Studio",
            "language": "en",
            "direction": {
                "seed": None,
                "instruct": "",
                "max_chunk_chars": 800,
                "crossfade_ms": 50,
            },
            "voice_snapshot": {
                "engine": "studio",
                "voice_type": "cloned",
                "samples": [
                    {"asset_id": "reference", "reference_text": "Reference"},
                ],
            },
        }
    }
    reference = tmp_path / "reference"
    sf.write(reference, np.zeros(100, dtype=np.float32), 24000, format="WAV")
    first = asyncio.create_task(synthesize(request, SimpleNamespace(root=tmp_path, asset_path=lambda _: reference)))
    await entered.wait()
    second = asyncio.create_task(
        generation.generate_audio_sync(
            profile_id="voice", text="Legacy", language="en", engine="legacy", model_size="default",
            normalize=False, effects_chain=[]
        )
    )
    await asyncio.sleep(0.01)
    overlapped = ("load", "legacy") in calls
    release.set()
    await asyncio.gather(first, second)
    assert not overlapped, "Legacy loaded a model while Studio still owned model preparation"


@pytest.mark.asyncio
async def test_manual_unload_waits_for_cancelled_physical_generation(monkeypatch):
    from backend.utils.chunked_tts import generate_chunked

    entered = asyncio.Event()
    release = asyncio.Event()
    unloaded = []

    class Model:
        async def generate(self, *args):
            entered.set()
            await release.wait()
            return np.zeros(100, dtype="float32"), 1000

    monkeypatch.setattr(tts, "unload_tts_model", lambda: unloaded.append(True))
    first = asyncio.create_task(generate_chunked(Model(), "Hello", {}))
    await entered.wait()
    first.cancel()
    second = asyncio.create_task(model_routes.unload_model())
    await asyncio.sleep(0.01)
    overlapped = bool(unloaded)
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await first
    await second
    assert not overlapped, "Manual unload ran before cancelled inference actually returned"


@pytest.mark.asyncio
async def test_shutdown_drains_physical_owner_and_refuses_new_work():
    from backend.utils.inference import run_inference, shutdown_inference, start_inference

    entered = asyncio.Event()
    release = asyncio.Event()
    unloaded = []

    async def inference():
        entered.set()
        await release.wait()

    async def unload():
        unloaded.append(True)

    first = asyncio.create_task(run_inference(inference))
    await entered.wait()
    shutdown = asyncio.create_task(shutdown_inference(unload))
    await asyncio.sleep(0.01)
    assert unloaded == []
    with pytest.raises(RuntimeError, match="shutting down"):
        await run_inference(inference)
    release.set()
    await first
    await shutdown
    assert unloaded == [True]
    start_inference()
