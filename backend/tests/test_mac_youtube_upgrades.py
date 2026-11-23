"""Regression & feature tests for macOS MLX, Studio audio quality, and YouTube narration workflows."""

from __future__ import annotations

from pathlib import Path
import tempfile
from types import SimpleNamespace
import xml.etree.ElementTree as ET

import numpy as np
import pytest
import soundfile as sf
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend import backends
from backend.studio.api import make_router
from backend.studio.captions import estimate_youtube_captions, split_caption_text
from backend.studio.chapters import extract_chapters, format_csv_markers, format_fcpxml_chapters, format_youtube_chapters
from backend.studio.jobs import synthesize
from backend.studio.pronunciation import BUILTIN_PRONUNCIATION_PACKS, scan_script_jargon
from backend.studio.rendering import _find_ffmpeg, render_project
from backend.studio.storage import StudioStore, passage, uid
from backend.utils.chunked_tts import generate_chunked, split_pause_segments
from backend.utils.effects import BUILTIN_PRESETS, EFFECT_REGISTRY, apply_effects, validate_effects_chain
from backend.utils.speech_delivery import apply_speed


@pytest.mark.asyncio
@pytest.mark.parametrize("sample_count,source_format,with_guide", [(1, "WAV", False), (2, "WAV", False), (1, "FLAC", False), (1, "WAV", True)])
async def test_studio_voice_keeps_named_wav_until_generate_finishes(tmp_path, monkeypatch, sample_count, source_format, with_guide):
    """Regression: MLX and Chatterbox read ref_audio lazily inside generate()."""
    # Python can cache a temporary directory that disappears after startup.
    monkeypatch.setattr(tempfile, "tempdir", str(tmp_path / "removed-build-directory"))
    store = StudioStore(tmp_path / "studio")
    project = store.create_project("Clone", script="Testing multi sample voice.")
    assets = []
    for idx in range(sample_count):
        src = tmp_path / f"ref_{idx}"
        sf.write(src, np.full(2400, 0.1 * (idx + 1), dtype=np.float32), 24000, format=source_format)
        assets.append(store.add_asset(project["id"], src))

    seen_ref_paths: list[tuple[str, bool]] = []
    guide = tmp_path / "guide.wav"
    sf.write(guide, np.full(2400, 0.2, dtype=np.float32), 24000)

    class LazyMLXBackend:
        async def combine_voice_prompts(self, paths, texts):
            if with_guide:
                assert paths[0] == str(store.asset_path(assets[0]["id"]))
                assert texts == ["Reference", "Testing"]
            return np.full(4800, 0.1, dtype=np.float32), " ".join(texts)

        async def create_voice_prompt(self, audio_path, reference_text, use_cache=True):
            return {"ref_audio": str(audio_path), "ref_text": reference_text}, False

        async def generate(self, text, voice_prompt, language="en", seed=None, instruct=None):
            ref = voice_prompt["ref_audio"]
            seen_ref_paths.append((ref, Path(ref).is_file()))
            assert Path(ref).suffix == ".wav"
            assert sf.info(ref).format == "WAV"
            return np.full(2400, 0.1, dtype=np.float32), 24000

    async def noop(*args, **kwargs):
        return None

    monkeypatch.setattr(backends, "ensure_model_cached_or_raise", noop)
    monkeypatch.setattr(backends, "load_engine_model", noop)
    monkeypatch.setattr(backends, "get_tts_backend_for_engine", lambda _: LazyMLXBackend())
    monkeypatch.setattr(backends, "engine_needs_trim", lambda _: False)
    monkeypatch.setattr(backends, "engine_retries_runaway", lambda _: False)

    p = passage("Testing multi sample voice.", "en")
    p["voice_snapshot"] = {
        "engine": "qwen",
        "model_size": "1.7B",
        "voice_type": "cloned",
        "samples": [{"asset_id": asset["id"], "reference_text": "Reference"} for asset in assets],
    }
    request = {"passage": p, "spoken_text": p["text"]}
    if with_guide:
        asset = store.add_asset(project["id"], guide)
        request["pronunciation_recordings"] = [{"asset_id": asset["id"], "reference_text": "Testing"}]
    audio, rate = await synthesize(request, store)
    assert rate == 24000 and len(audio) == 2400
    assert len(seen_ref_paths) == 1
    reference_path, existed_during_generate = seen_ref_paths[0]
    assert existed_during_generate is True
    assert not Path(reference_path).exists()
    assert all(store.asset_path(asset["id"]).is_file() for asset in assets)


def test_studio_ffmpeg_discovery_uses_desktop_fallback(monkeypatch):
    from backend.studio import rendering

    monkeypatch.setattr(rendering.shutil, "which", lambda _: None)
    monkeypatch.setattr(rendering, "_desktop_find_ffmpeg", lambda name="ffmpeg": "/opt/homebrew/bin/ffmpeg")
    assert _find_ffmpeg() == "/opt/homebrew/bin/ffmpeg"


def test_broadcast_effects_and_youtube_narration_preset():
    for effect_type in ("low_shelf", "peak_filter", "high_shelf", "noise_gate", "limiter"):
        assert effect_type in EFFECT_REGISTRY
    preset = BUILTIN_PRESETS["youtube_narration"]
    assert validate_effects_chain(preset["effects_chain"]) is None
    sr = 48000
    signal = (0.2 * np.sin(2 * np.pi * 440 * np.arange(sr // 2) / sr)).astype(np.float32)
    out = apply_effects(signal, sr, preset["effects_chain"])
    assert len(out) == len(signal)
    assert np.isfinite(out).all()


@pytest.mark.asyncio
async def test_inline_pause_markers_insert_exact_silence():
    assert split_pause_segments("Hello [pause 500ms] world [pause 1.5s]!") == [
        ("speech", "Hello"),
        ("pause", 0.5),
        ("speech", "world"),
        ("pause", 1.5),
        ("speech", "!"),
    ]
    calls = []

    class DummyBackend:
        async def generate(self, text, voice_prompt, language="en", seed=None, instruct=None):
            calls.append(text)
            return np.full(2400, 0.25, dtype=np.float32), 24000

    audio, sr = await generate_chunked(DummyBackend(), "First part. [pause 250ms] Second part.", {})
    assert calls == ["First part.", "Second part."]
    assert sr == 24000
    # 2400 + 6000 (250ms @ 24kHz) + 2400 = 10800 samples
    assert len(audio) == 10800
    assert np.allclose(audio[2400:8400], 0.0)


def test_automatic_music_ducking_attenuates_music_during_voice(tmp_path):
    rate = 48000
    voice_path = tmp_path / "voice.wav"
    music_path = tmp_path / "music.wav"
    # 0.5s voice placed at 1.0s..1.5s; 2.5s constant music bed from 0..2.5s
    sf.write(voice_path, np.zeros(rate // 2, dtype=np.float32), rate, subtype="FLOAT")
    sf.write(music_path, np.full(int(rate * 2.5), 0.4, dtype=np.float32), rate, subtype="FLOAT")
    doc = {
        "sample_rate": rate,
        "channels": 2,
        "tracks": [
            {"id": "v", "kind": "voice", "gain": 1.0, "mute": False, "solo": False},
            {"id": "m", "kind": "music", "gain": 1.0, "mute": False, "solo": False},
        ],
        "clips": [
            {
                "id": "vc",
                "asset_id": "v",
                "track_id": "v",
                "start_sample": rate,
                "trim_start_sample": 0,
                "trim_end_sample": 0,
                "gain": 1.0,
                "fade_in_samples": 0,
                "fade_out_samples": 0,
            },
            {
                "id": "mc",
                "asset_id": "m",
                "track_id": "m",
                "start_sample": 0,
                "trim_start_sample": 0,
                "trim_end_sample": 0,
                "gain": 1.0,
                "fade_in_samples": 0,
                "fade_out_samples": 0,
            },
        ],
        "mix": {
            "normalize": False,
            "target_lufs": -14.0,
            "max_true_peak_dbtp": -1.0,
            "duck_music": True,
            "duck_db": -12.0,
            "duck_attack_ms": 50.0,
            "duck_release_ms": 100.0,
        },
    }
    result = render_project(
        doc,
        {"v": {}, "m": {}},
        lambda aid: voice_path if aid == "v" else music_path,
        tmp_path / "out",
    )
    pcm, _ = sf.read(result["files"][0]["path"], always_2d=True)
    # Before attack (at 0.2s): full music gain (~0.4)
    assert np.isclose(pcm[int(rate * 0.2), 0], 0.4, atol=1e-4)
    # During voice (at 1.25s): ducked by -12 dB (~0.4 * 10^(-12/20) ≈ 0.1005)
    assert np.isclose(pcm[int(rate * 1.25), 0], 0.4 * 10 ** (-12 / 20), atol=1e-3)
    # After release (at 2.0s): back to full music gain (~0.4)
    assert np.isclose(pcm[int(rate * 2.0), 0], 0.4, atol=1e-4)


def test_two_pass_linear_loudnorm_passes_measured_stats(tmp_path, monkeypatch):
    from backend.studio import rendering

    rate = 48000
    source = tmp_path / "voice.wav"
    sf.write(source, 0.1 * np.sin(2 * np.pi * 440 * np.arange(rate) / rate), rate, subtype="FLOAT")
    commands_seen: list[list[str]] = []

    def fake_process(cmd, cancelled=None):
        commands_seen.append(cmd)
        if "-f" in cmd and "null" in cmd:
            return (
                '{"input_i": "-23.10", "input_tp": "-6.20", "input_lra": "4.50", '
                '"input_thresh": "-33.40", "target_offset": "0.15"}'
            )
        # Copy input to output path for the simulated encode pass
        sf.write(cmd[-1], np.zeros((rate, 1), dtype=np.float32), rate, subtype="PCM_24")
        return ""

    monkeypatch.setattr(rendering, "_find_ffmpeg", lambda: "/usr/bin/ffmpeg")
    monkeypatch.setattr(rendering, "_process", fake_process)
    doc = {
        "sample_rate": rate,
        "channels": 1,
        "tracks": [{"id": "t", "kind": "voice", "gain": 1.0}],
        "clips": [
            {
                "id": "c",
                "asset_id": "a",
                "track_id": "t",
                "start_sample": 0,
                "trim_start_sample": 0,
                "trim_end_sample": 0,
                "gain": 1.0,
                "fade_in_samples": 0,
                "fade_out_samples": 0,
            }
        ],
        "mix": {"normalize": True, "target_lufs": -14.0, "max_true_peak_dbtp": -1.0},
    }
    render_project(doc, {"a": {}}, lambda _: source, tmp_path / "out")
    encode_cmds = [cmd for cmd in commands_seen if "-c:a" in cmd]
    assert len(encode_cmds) == 1
    af_arg = encode_cmds[0][encode_cmds[0].index("-af") + 1]
    assert "linear=true" in af_arg
    assert "measured_I=-23.1000" in af_arg
    assert "offset=0.1500" in af_arg


def test_youtube_caption_splitting_chapters_and_pronunciation_scanner(tmp_path):
    # Caption splitting wraps to <= 42 chars per line and <= 2 lines per cue
    long_text = (
        "In this video we build custom STM32 firmware for an MP3 player using I2S and DMA ring buffers. "
        "Every audio frame streams from FAT32 straight to our PCM5102 DAC at 48kHz without dropouts."
    )
    parts = split_caption_text(long_text, max_chars_per_line=42, max_lines=2)
    assert len(parts) >= 2
    for part in parts:
        lines = part.split("\n")
        assert 1 <= len(lines) <= 2

    # Jargon scanner finds firmware acronyms, hex, units, and snake_case identifiers
    suggestions = scan_script_jargon(
        [{"text": "Configure STM32 I2S DMA at 48kHz with 0x1F and ring_buffer_init [pause 300ms]."}],
        existing_rules=[{"source": "DMA", "case_sensitive": True}],
    )
    found = {item["source"]: item for item in suggestions}
    assert "STM32" in found and found["STM32"]["suggested_replacement"] == "S T M thirty two"
    assert "I2S" in found and found["I2S"]["suggested_replacement"] == "eye two ess"
    assert "0x1F" in found and found["0x1F"]["suggested_replacement"] == "zero ex 1 F"
    assert "ring_buffer_init" in found
    assert "DMA" not in found
    assert "embedded_firmware" in BUILTIN_PRONUNCIATION_PACKS

    # Chapters & FCPXML/CSV export via Studio HTTP router
    store = StudioStore(tmp_path / "studio")
    project = store.create_project("MP3 Firmware Video")
    project = store.command(
        project["id"],
        uid(),
        project["revision"],
        "add_passages",
        {
            "texts": ["Welcome to my custom MP3 player firmware.", "Let us look at the I2S DMA pipeline."],
            "chapters": ["Intro", "I2S & DMA Pipeline"],
        },
    )
    src = tmp_path / "clip.wav"
    sf.write(src, np.full(96000, 0.1, dtype=np.float32), 48000)
    asset = store.add_asset(project["id"], src)
    with store.connect() as db:
        import json

        doc = json.loads(db.execute("SELECT document FROM projects WHERE id=?", (project["id"],)).fetchone()[0])
        p0, p1 = doc["passages"]
        t_id = doc["tracks"][0]["id"]
        doc["clips"] = [
            {
                "id": "c0",
                "passage_id": p0["id"],
                "take_id": None,
                "asset_id": asset["id"],
                "track_id": t_id,
                "start_sample": 0,
                "trim_start_sample": 0,
                "trim_end_sample": 0,
                "gain": 1.0,
                "fade_in_samples": 0,
                "fade_out_samples": 0,
            },
            {
                "id": "c1",
                "passage_id": p1["id"],
                "take_id": None,
                "asset_id": asset["id"],
                "track_id": t_id,
                "start_sample": 48000 * 15,
                "trim_start_sample": 0,
                "trim_end_sample": 0,
                "gain": 1.0,
                "fade_in_samples": 0,
                "fade_out_samples": 0,
            },
        ]
        db.execute("UPDATE projects SET document=? WHERE id=?", (json.dumps(doc), project["id"]))

    app = FastAPI()
    app.include_router(make_router(store, jobs=object()))
    client = TestClient(app)

    ch_resp = client.get(f"/studio/v1/projects/{project['id']}/chapters")
    assert ch_resp.status_code == 200
    assert ch_resp.json()["youtube_text"] == "00:00 Intro\n00:15 I2S & DMA Pipeline\n"

    fcpxml_resp = client.get(f"/studio/v1/projects/{project['id']}/chapters/export?format=fcpxml")
    assert fcpxml_resp.status_code == 200
    root = ET.fromstring(fcpxml_resp.text)
    markers = root.findall(".//chapter-marker")
    assert [m.attrib["value"] for m in markers] == ["Intro", "I2S & DMA Pipeline"]

    csv_resp = client.get(f"/studio/v1/projects/{project['id']}/chapters/export?format=csv")
    assert csv_resp.status_code == 200
    assert "00:00:15:00" in csv_resp.text and "I2S & DMA Pipeline" in csv_resp.text

    # YouTube caption estimate command with split_cues=True
    proj = store.get_project(project["id"])
    est_resp = client.post(
        f"/studio/v1/projects/{project['id']}/commands",
        json={
            "operation_id": uid(),
            "expected_revision": proj["revision"],
            "type": "estimate_captions",
            "payload": {"split_cues": True, "max_chars_per_line": 42, "max_lines": 2},
        },
    )
    assert est_resp.status_code == 200
    assert len(est_resp.json()["document"]["captions"]["cues"]) >= 2

    # Align endpoint falls back gracefully to proportional YouTube cues when Whisper isn't cached
    align_resp = client.post(f"/studio/v1/projects/{project['id']}/captions/align")
    assert align_resp.status_code == 200
    assert align_resp.json()["method"] in ("whisper", "proportional")
    assert len(align_resp.json()["captions"]["cues"]) >= 2


@pytest.mark.asyncio
async def test_mlx_variants_layer_instruct_and_dispatch_on_mlx_thread(monkeypatch):
    from backend.backends import qwen_mlx_variants as mod

    called_on_mlx_thread = []

    async def fake_run(fn, *args):
        called_on_mlx_thread.append(fn.__name__)
        return fn(*args)

    monkeypatch.setattr(mod, "_run_on_mlx_thread", fake_run)

    # CustomVoice MLX
    cv = mod.QwenCustomVoiceMLXBackend("1.7B")
    cv_calls = []

    class FakeCVModel:
        sample_rate = 24000

        def generate_custom_voice(self, text, speaker, language, instruct=None, verbose=False):
            cv_calls.append((text, speaker, language, instruct))
            return [SimpleNamespace(audio=np.full(1200, 0.1, dtype=np.float32), sample_rate=24000)]

    cv.model = FakeCVModel()
    cv._current_model_size = "1.7B"
    audio, sr = await cv.generate(
        "Hello.", {"preset_voice_id": "Ryan"}, language="en", instruct="Speak enthusiastically"
    )
    assert sr == 24000 and len(audio) == 1200
    assert cv_calls == [("Hello.", "Ryan", "English", "Speak enthusiastically")]

    # VoiceDesign MLX
    vd = mod.QwenVoiceDesignMLXBackend("1.7B")
    vd_calls = []

    class FakeVDModel:
        sample_rate = 24000

        def generate_voice_design(self, text, instruct, language, verbose=False):
            vd_calls.append((text, instruct, language))
            return [SimpleNamespace(audio=np.full(1200, 0.1, dtype=np.float32), sample_rate=24000)]

    vd.model = FakeVDModel()
    vd._current_model_size = "1.7B"
    audio, sr = await vd.generate(
        "Hello.",
        {"voice_type": "designed", "design_prompt": "Crisp tech narrator."},
        language="en",
        instruct="Slightly slower",
    )
    assert sr == 24000 and len(audio) == 1200
    assert vd_calls == [("Hello.", "Crisp tech narrator. Slightly slower", "English")]
    assert len(called_on_mlx_thread) == 2


def test_speed_control_preserves_length_and_pitch_with_ffmpeg():
    sr = 24000
    source = (0.2 * np.sin(2 * np.pi * 440 * np.arange(sr) / sr)).astype(np.float32)
    for speed in (0.85, 1.25):
        out = apply_speed(source, sr, speed)
        assert len(out) == pytest.approx(len(source) / speed, abs=1)
        middle = out[len(out) // 10 : -len(out) // 10]
        freqs = np.fft.rfftfreq(len(middle), 1 / sr)
        peak_hz = freqs[np.argmax(np.abs(np.fft.rfft(middle)))]
        assert peak_hz == pytest.approx(440, abs=4)
