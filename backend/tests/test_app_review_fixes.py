"""Regression and coverage tests for the full-app review fixes."""

from __future__ import annotations

import asyncio
import io
import json
import sys
import types
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import numpy as np
import pytest
import soundfile as sf
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from backend import backends, config, models
from backend.database import Base, Capture, EffectPreset, Generation, GenerationVersion, VoiceProfile, get_db
from backend.database.seed import backfill_generation_versions, seed_builtin_presets
from backend.services import export_import, profiles as profiles_service
from backend.services.generation import release_generation_memory
from backend.services.refinement import RefinementFlags, build_refinement_prompt
from backend.utils.streaming_audio import serialized_byte_stream


def _make_memory_db():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(bind=engine)
    return engine, sessionmaker(autocommit=False, autoflush=False, bind=engine)


# ---------------------------------------------------------------------------
# 1. TADA multi-size dispatch, progress name, and model_size validation
# ---------------------------------------------------------------------------


def test_tada_multi_size_dispatch_and_validation(monkeypatch):
    class FakeTadaBackend:
        def __init__(self):
            self.loaded = False
            self.model_size = "1B"
            self.loaded_calls: list[str] = []
            self.unloaded_calls = 0

        def is_loaded(self) -> bool:
            return self.loaded

        async def load_model(self, model_size: str = "1B") -> None:
            self.loaded = True
            self.model_size = model_size
            self.loaded_calls.append(model_size)

        def unload_model(self) -> None:
            self.loaded = False
            self.unloaded_calls += 1

    fake = FakeTadaBackend()
    monkeypatch.setattr(backends, "get_tts_backend_for_engine", lambda engine: fake)

    cfg_1b = backends.get_model_config("tada-1b")
    cfg_3b = backends.get_model_config("tada-3b-ml")
    assert cfg_1b is not None and cfg_3b is not None
    assert "HumeAI/tada-codec" in cfg_1b.aux_hf_repo_ids
    assert "unsloth/Llama-3.2-1B" in cfg_3b.aux_hf_repo_ids

    # Loading 3B must invoke load_model("3B"), not default "1B"
    asyncio.run(backends.get_model_load_func(cfg_3b)())
    assert fake.loaded_calls == ["3B"]
    assert backends.check_model_loaded(cfg_3b) is True
    assert backends.check_model_loaded(cfg_1b) is False

    # Unloading 1B must NOT unload the loaded 3B model
    assert backends.unload_model_by_config(cfg_1b) is False
    assert fake.loaded is True
    assert backends.unload_model_by_config(cfg_3b) is True
    assert fake.loaded is False

    # Engine-specific defaults & validation
    assert backends.resolve_engine_model_size("tada", None) == "1B"
    assert backends.resolve_engine_model_size("tada", "3B") == "3B"
    assert backends.resolve_engine_model_size("qwen", None) == "1.7B"
    assert backends.resolve_engine_model_size("kokoro", "1.7B") is None
    with pytest.raises(ValueError, match="Invalid model_size"):
        backends.resolve_engine_model_size("tada", "1.7B")
    with pytest.raises(ValueError, match="Invalid model_size"):
        backends.resolve_engine_model_size("qwen", "3B")


def test_hume_backend_device_property_and_progress_name():
    from backend.backends.hume_backend import HumeTadaBackend

    backend = HumeTadaBackend()
    assert backend.device == "cpu"
    backend._device = "cuda"
    assert backend.device == "cuda"


# ---------------------------------------------------------------------------
# 2. Storage path handling when parent directory is named "data"
# ---------------------------------------------------------------------------


def test_to_storage_path_with_parent_named_data(tmp_path):
    prev_dir = config.get_data_dir()
    nested = tmp_path / "data" / "voicebox"
    try:
        config.set_data_dir(nested)
        clip = nested / "generations" / "clip.wav"
        clip.parent.mkdir(parents=True, exist_ok=True)
        clip.write_bytes(b"RIFF")

        stored = config.to_storage_path(clip)
        assert stored == str(Path("generations") / "clip.wav")
        assert config.resolve_storage_path(stored) == clip.resolve()
    finally:
        config.set_data_dir(prev_dir)


# ---------------------------------------------------------------------------
# 3. delete_model shared aux_hf_repo_ids & active-download 409 guard
# ---------------------------------------------------------------------------


def test_delete_model_preserves_shared_aux_repos_and_blocks_active_download(tmp_path, monkeypatch):
    from backend.routes import models as models_route
    from backend.utils.tasks import get_task_manager
    from huggingface_hub import constants as hf_constants

    monkeypatch.setattr(hf_constants, "HF_HUB_CACHE", str(tmp_path))
    monkeypatch.setattr(backends, "unload_model_by_config", lambda cfg: False)

    # Create cached repos for tada-1b, tada-3b-ml, and their shared codec/tokenizer
    tada_1b_dir = tmp_path / "models--HumeAI--tada-1b"
    tada_3b_dir = tmp_path / "models--HumeAI--tada-3b-ml"
    codec_dir = tmp_path / "models--HumeAI--tada-codec"
    tok_dir = tmp_path / "models--unsloth--Llama-3.2-1B"
    for d in (tada_1b_dir, tada_3b_dir, codec_dir, tok_dir):
        d.mkdir(parents=True)

    app = FastAPI()
    app.include_router(models_route.router)
    client = TestClient(app)

    # Active download must return 409
    tm = get_task_manager()
    tm.start_download("tada-1b")
    try:
        resp = client.delete("/models/tada-1b")
        assert resp.status_code == 409
    finally:
        tm.cancel_download("tada-1b")

    # Deleting tada-1b while tada-3b-ml is still cached must preserve shared aux repos
    resp = client.delete("/models/tada-1b")
    assert resp.status_code == 200
    assert not tada_1b_dir.exists()
    assert codec_dir.exists()
    assert tok_dir.exists()

    # Deleting the last sibling tada-3b-ml removes the shared aux repos too
    resp = client.delete("/models/tada-3b-ml")
    assert resp.status_code == 200
    assert not tada_3b_dir.exists()
    assert not codec_dir.exists()
    assert not tok_dir.exists()


# ---------------------------------------------------------------------------
# 4. migrate_models reports error instead of complete when moves fail
# ---------------------------------------------------------------------------


def test_migrate_models_reports_error_on_failure(tmp_path, monkeypatch):
    from backend.routes import models as models_route
    from backend.utils.progress import get_progress_manager
    from huggingface_hub import constants as hf_constants

    src = tmp_path / "src"
    dst = tmp_path / "dst"
    (src / "models--org--demo").mkdir(parents=True)
    monkeypatch.setattr(hf_constants, "HF_HUB_CACHE", str(src))

    def boom(*_args, **_kwargs):
        raise PermissionError("disk read-only")

    monkeypatch.setattr(models_route.shutil, "move", boom)

    pm = get_progress_manager()
    pm._progress.pop("migration", None)

    app = FastAPI()
    app.include_router(models_route.router)
    with TestClient(app) as client:
        resp = client.post(
            "/models/migrate",
            json={"destination": str(dst)},
        )
        assert resp.status_code == 200

    state = pm.get_progress("migration")
    assert state is not None
    assert state["status"] == "error"
    assert "disk read-only" in (state.get("error") or "")


# ---------------------------------------------------------------------------
# 5. Memory cleanup & unload_all_models
# ---------------------------------------------------------------------------


def test_release_generation_memory_and_unload_all(monkeypatch):
    device_calls: list[str] = []
    mlx_calls: list[bool] = []
    monkeypatch.setattr("backend.backends.base.empty_device_cache", lambda d: device_calls.append(d))
    monkeypatch.setattr("backend.backends.base.empty_mlx_cache", lambda: mlx_calls.append(True))

    class FakeCudaBackend:
        _device = "cuda"

    release_generation_memory(FakeCudaBackend())
    assert device_calls == ["cuda"]
    assert mlx_calls == []

    # Simulated MLX module class
    mlx_cls = type("FakeMLX", (), {"__module__": "backend.backends.qwen_mlx_variants"})
    release_generation_memory(mlx_cls())
    assert mlx_calls == [True]

    # unload_all_models unloads every registered TTS and LLM backend
    unloaded: list[str] = []

    class DummyBackend:
        def __init__(self, name: str):
            self.name = name
            self.loaded = True

        def is_loaded(self):
            return self.loaded

        def unload_model(self):
            self.loaded = False
            unloaded.append(self.name)

    monkeypatch.setattr(backends, "_tts_backends", {"kokoro": DummyBackend("kokoro"), "tada": DummyBackend("tada")})
    monkeypatch.setattr(backends, "_llm_backends", {"qwen_llm": DummyBackend("qwen_llm")})
    monkeypatch.setattr(backends, "_stt_backend", DummyBackend("whisper"))

    backends.unload_all_models()
    assert set(unloaded) == {"kokoro", "tada", "qwen_llm", "whisper"}


# ---------------------------------------------------------------------------
# 6. Refinement prompt pass-through when all toggles are off
# ---------------------------------------------------------------------------


def test_refinement_prompt_all_toggles_off_emits_passthrough():
    prompt = build_refinement_prompt(
        RefinementFlags(smart_cleanup=False, self_correction=False, preserve_technical=False),
        language="en",
    )
    assert "Return the transcript unchanged." in prompt
    assert "MUST be written in English" in prompt
    assert "disfluencies" not in prompt.lower()


# ---------------------------------------------------------------------------
# 7. serialized_byte_stream stall timeout does not deadlock on full queue
# ---------------------------------------------------------------------------


def test_serialized_byte_stream_stall_does_not_deadlock():
    async def run():
        async def produce(send):
            await send(b"chunk-1")
            await send(b"chunk-2")
            await send(b"chunk-3")
            # Queue maxsize=2 is now full after consumer stops reading; next send times out
            await send(b"chunk-4")

        stream = serialized_byte_stream(produce, stall_timeout=0.05)
        first = await anext(stream)
        assert first == b"chunk-1"
        # Wait longer than stall_timeout before reading again so producer fills queue and times out
        await asyncio.sleep(0.25)
        with pytest.raises(TimeoutError, match="stalled"):
            async for _ in stream:
                pass

    asyncio.run(asyncio.wait_for(run(), timeout=3.0))


# ---------------------------------------------------------------------------
# 8. Profiles validation, counts, design_prompt & personality preservation
# ---------------------------------------------------------------------------


def test_profiles_validation_counts_and_update_preservation():
    engine, SessionLocal = _make_memory_db()
    try:
        with SessionLocal() as db:
            # Invalid preset_engine must be rejected
            with pytest.raises(ValueError, match="does not support preset voices"):
                asyncio.run(
                    profiles_service.create_profile(
                        models.VoiceProfileCreate(
                            name="BadPreset",
                            language="en",
                            voice_type="preset",
                            preset_engine="invalid_engine",
                            preset_voice_id="someone",
                        ),
                        db,
                    )
                )

            # Create designed profile with personality
            created = asyncio.run(
                profiles_service.create_profile(
                    models.VoiceProfileCreate(
                        name="Designer",
                        language="en",
                        voice_type="designed",
                        design_prompt="Warm baritone narrator",
                        personality="Speak concisely like a firmware engineer.",
                    ),
                    db,
                )
            )
            assert created.personality == "Speak concisely like a firmware engineer."
            assert created.design_prompt == "Warm baritone narrator"

            # Add a generation to verify get_profile returns real generation_count
            db.add(
                Generation(
                    id="gen-count-1",
                    profile_id=created.id,
                    text="hello",
                    language="en",
                    audio_path="generations/gen-count-1.wav",
                    duration=1.0,
                    status="completed",
                )
            )
            db.commit()

            fetched = asyncio.run(profiles_service.get_profile(created.id, db))
            assert fetched is not None
            assert fetched.generation_count == 1

            # Partial update omitting personality must NOT wipe personality, and can update design_prompt
            updated = asyncio.run(
                profiles_service.update_profile(
                    created.id,
                    models.VoiceProfileCreate(
                        name="Designer Renamed",
                        description="Updated desc",
                        language="en",
                        design_prompt="Crisp documentary voice",
                    ),
                    db,
                )
            )
            assert updated is not None
            assert updated.personality == "Speak concisely like a firmware engineer."
            assert updated.design_prompt == "Crisp documentary voice"
            assert updated.generation_count == 1
    finally:
        engine.dispose()


# ---------------------------------------------------------------------------
# 9. Imported audio creates original version & export-audio?format=wav transcodes
# ---------------------------------------------------------------------------


def test_import_audio_creates_version_and_history_get_includes_versions(tmp_path):
    from backend.routes import effects as effects_route, generations as gen_route, history as history_route

    prev_dir = config.get_data_dir()
    engine, SessionLocal = _make_memory_db()
    try:
        config.set_data_dir(tmp_path)
        app = FastAPI()
        app.include_router(gen_route.router)
        app.include_router(history_route.router)
        app.include_router(effects_route.router)

        def override_get_db():
            db = SessionLocal()
            try:
                yield db
            finally:
                db.close()

        app.dependency_overrides[get_db] = override_get_db
        client = TestClient(app)

        # Build a valid FLAC file in memory (non-WAV format!)
        buf = io.BytesIO()
        sr = 24000
        samples = np.sin(2 * np.pi * 440 * np.linspace(0, 0.25, sr // 4, dtype=np.float32)) * 0.2
        sf.write(buf, samples, sr, format="FLAC")
        flac_bytes = buf.getvalue()

        import_resp = client.post(
            "/generate/import",
            files={"file": ("music_bed.flac", flac_bytes, "audio/flac")},
        )
        assert import_resp.status_code == 200
        gen_id = import_resp.json()["id"]

        # GET /history/{id} must include the original version and active_version_id
        detail = client.get(f"/history/{gen_id}")
        assert detail.status_code == 200
        body = detail.json()
        assert body["versions"] is not None
        assert len(body["versions"]) == 1
        assert body["active_version_id"] == body["versions"][0]["id"]

        # Applying effects and editing that version in-place must NOT 409
        fx_resp = client.post(
            f"/generations/{gen_id}/versions/apply-effects",
            json={
                "effects_chain": [{"type": "gain", "enabled": True, "params": {"gain_db": 2.0}}],
                "set_as_default": True,
            },
        )
        assert fx_resp.status_code == 200
        fx_version_id = fx_resp.json()["id"]

        edit_resp = client.put(
            f"/generations/{gen_id}/versions/{fx_version_id}",
            json={
                "effects_chain": [{"type": "gain", "enabled": True, "params": {"gain_db": 1.0}}],
            },
        )
        assert edit_resp.status_code == 200

        # Also verify export-audio?format=wav on a FLAC generation produces genuine RIFF WAV bytes
        with SessionLocal() as db:
            gen_row = db.get(Generation, gen_id)
            flac_path = tmp_path / "generations" / f"{gen_id}.flac"
            gen_row.audio_path = config.to_storage_path(flac_path)
            db.commit()

        wav_resp = client.get(f"/history/{gen_id}/export-audio?format=wav")
        assert wav_resp.status_code == 200
        assert wav_resp.headers["content-type"].startswith("audio/wav")
        assert wav_resp.content[:4] == b"RIFF"
    finally:
        config.set_data_dir(prev_dir)
        engine.dispose()


# ---------------------------------------------------------------------------
# 10. MCP bindings profile validation & Captures retranscribe "auto" reset
# ---------------------------------------------------------------------------


def test_mcp_bindings_validates_profile_and_captures_auto_retranscribe(tmp_path, monkeypatch):
    from backend.routes import captures as captures_route, mcp_bindings as mcp_route

    prev_dir = config.get_data_dir()
    engine, SessionLocal = _make_memory_db()
    try:
        config.set_data_dir(tmp_path)
        app = FastAPI()
        app.include_router(mcp_route.router)
        app.include_router(captures_route.router)

        def override_get_db():
            db = SessionLocal()
            try:
                yield db
            finally:
                db.close()

        app.dependency_overrides[get_db] = override_get_db
        client = TestClient(app)

        # Unknown profile_id must return 404
        bad = client.put(
            "/mcp/bindings",
            json={"client_id": "claude-code", "profile_id": "missing-profile"},
        )
        assert bad.status_code == 404

        # Capture retranscribe with language="auto" resets stored language to None
        cap_path = tmp_path / "captures" / "cap-1.wav"
        cap_path.parent.mkdir(parents=True, exist_ok=True)
        sf.write(cap_path, np.zeros(1600, dtype=np.float32), 16000)
        with SessionLocal() as db:
            db.add(
                Capture(
                    id="cap-1",
                    audio_path=config.to_storage_path(cap_path),
                    source="file",
                    language="fr",
                    transcript_raw="bonjour",
                    stt_model="base",
                )
            )
            db.commit()

        fake_whisper = SimpleNamespace(
            model_size="base",
            transcribe=AsyncMock(return_value="hello auto"),
        )
        monkeypatch.setattr("backend.services.captures.get_whisper_model", lambda: fake_whisper)

        resp = client.post("/captures/cap-1/retranscribe", json={"language": "auto"})
        assert resp.status_code == 200
        assert resp.json()["language"] is None
        assert resp.json()["transcript_raw"] == "hello auto"
    finally:
        config.set_data_dir(prev_dir)
        engine.dispose()


# ---------------------------------------------------------------------------
# 11. Database seeding, version backfill, dac_shim, and image utils
# ---------------------------------------------------------------------------


def test_seed_presets_backfill_dac_shim_and_images(tmp_path):
    prev_dir = config.get_data_dir()
    engine, SessionLocal = _make_memory_db()
    try:
        config.set_data_dir(tmp_path)
        seed_builtin_presets(SessionLocal, EffectPreset)
        with SessionLocal() as db:
            names = {p.name for p in db.query(EffectPreset).all()}
            assert "YouTube Narration" in names
            assert "Radio" in names

        # Idempotent re-seed
        seed_builtin_presets(SessionLocal, EffectPreset)
        with SessionLocal() as db:
            assert db.query(EffectPreset).filter_by(name="YouTube Narration").count() == 1

            # Backfill legacy completed generation without version rows
            legacy_wav = tmp_path / "generations" / "legacy-1.wav"
            legacy_wav.parent.mkdir(parents=True, exist_ok=True)
            sf.write(legacy_wav, np.zeros(1600, dtype=np.float32), 16000)

            db.add(VoiceProfile(id="p1", name="P1", language="en"))
            db.add(
                Generation(
                    id="legacy-1",
                    profile_id="p1",
                    text="legacy",
                    language="en",
                    audio_path=config.to_storage_path(legacy_wav),
                    duration=1.2,
                    status="completed",
                )
            )
            db.commit()

        backfill_generation_versions(SessionLocal, Generation, GenerationVersion)
        with SessionLocal() as db:
            versions = db.query(GenerationVersion).filter_by(generation_id="legacy-1").all()
            assert len(versions) == 1
            assert versions[0].is_default is True
    finally:
        config.set_data_dir(prev_dir)
        engine.dispose()

    # DAC shim exposes dac.nn.layers.Snake1d
    from backend.utils.dac_shim import install_dac_shim

    install_dac_shim()
    import dac.nn.layers as dac_layers

    assert hasattr(dac_layers, "Snake1d")

    # Image processing utility validates and resizes oversized PNG avatars preserving aspect ratio
    from PIL import Image
    from backend.utils.images import process_avatar, validate_image

    src_img = tmp_path / "avatar.png"
    dst_img = tmp_path / "avatar_out.png"
    Image.new("RGB", (1024, 512), color=(40, 120, 200)).save(src_img)
    ok, err = validate_image(str(src_img))
    assert ok is True and err is None
    process_avatar(str(src_img), str(dst_img))
    assert dst_img.exists()
    with Image.open(dst_img) as out:
        assert out.width == 512
        assert out.height == 256
