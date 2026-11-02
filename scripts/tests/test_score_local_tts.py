"""Offline speech-quality scorer logic with labelled fake ASR and speaker encoders (no weights)."""

from dataclasses import replace
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import wave

import numpy as np
import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "score-local-tts.py"
SPEC = importlib.util.spec_from_file_location("score_local_tts", SCRIPT)
score = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = score
SPEC.loader.exec_module(score)

WHISPER_REVISION = "e37978b90ca9030d5170a5c07aadb050351a65bb"


def write_wav(path, samples, rate=24000):
    pcm = (np.clip(np.asarray(samples, dtype=np.float64), -1, 1) * 32767).astype("<i2").tobytes()
    with wave.open(str(path), "wb") as target:
        target.setnchannels(1)
        target.setsampwidth(2)
        target.setframerate(rate)
        target.writeframes(pcm)
    return path


class FakeTranscriber:
    """Labelled fake ASR: transcripts keyed by row id; normalization lowercases and strips punctuation."""

    def __init__(self, transcripts):
        self.transcripts, self.calls = transcripts, []

    def transcribe(self, samples, rate, language):
        self.calls.append((int(samples.size), rate, language))
        return self.transcripts[len(self.calls) - 1]

    def normalize(self, text):
        return score.normalize_basic(text)


class FakeEncoder:
    """Labelled fake speaker encoder: a unit vector derived from the audio's mean level."""

    def embed(self, samples, rate):
        level = float(np.abs(samples).mean())
        vector = np.array([1.0, level * 10, 0.0])
        return vector / np.linalg.norm(vector)


@pytest.fixture
def manifest(tmp_path):
    rate = 24000
    refs = {"a": write_wav(tmp_path / "ref-a.wav", np.full(rate, 0.05)), "b": write_wav(tmp_path / "ref-b.wav", np.full(rate, 0.5))}
    rows = []
    for index, (group, level) in enumerate([("baseline", 0.05), ("baseline", 0.06), ("candidate", 0.5)]):
        samples = np.full(rate * 2, level)
        rows.append({"id": f"row-{index}", "wav": str(write_wav(tmp_path / f"row-{index}.wav", samples)),
                     "text": "The cat sat on the mat.", "group": group, "text_id": "short", "reference_id": "a",
                     "seed": index, "kind": "warm"})
    payload = {"language": "en", "references": {key: {"wav": str(path), "text": f"Reference {key}."} for key, path in refs.items()},
               "rows": rows}
    path = tmp_path / "quality-manifest.json"
    path.write_text(json.dumps(payload))
    return path


@pytest.fixture
def settings(manifest, tmp_path):
    cache = tmp_path / "hub"
    cache.mkdir()
    return score.Settings(manifest, cache, tmp_path / "quality", "cpu")


def run(settings, transcriber, encoder=FakeEncoder(), **kwargs):
    output = score.Output(settings.output_root)
    try:
        report = score.score(settings, output, transcriber_factory=lambda *a: transcriber,
                             encoder_factory=lambda *a: encoder, admit_asr=lambda *a: {"fixture": "asr"},
                             admit_encoder=lambda *a: {"fixture": "ve"}, identify=lambda *a: {"fixture": True},
                             get_provenance=lambda: {"fixture": True}, **kwargs)
    finally:
        output.close()
    saved = json.loads((settings.output_root / "quality.json").read_text())
    assert saved["status"] == report["status"]
    return report


def test_edit_operations_and_rates_follow_the_alignment():
    assert score.edit_operations(["the", "cat", "sat"], ["the", "cat"]) == {"substitutions": 0, "deletions": 1, "insertions": 0}
    assert score.edit_operations(["the", "cat", "sat"], ["the", "cat", "sat", "sat"]) == {"substitutions": 0, "deletions": 0, "insertions": 1}
    assert score.edit_operations(["a", "b", "c"], ["a", "x", "c"]) == {"substitutions": 1, "deletions": 0, "insertions": 0}
    assert score.edit_operations([], ["a"]) == {"substitutions": 0, "deletions": 0, "insertions": 1}
    assert score.edit_operations("x a".split(), "a y".split()) == {"substitutions": 2, "deletions": 0, "insertions": 0}
    assert score.error_rate(["the", "cat", "sat"], ["the", "cat"]) == pytest.approx(1 / 3)
    assert score.error_rate([], []) == 0.0 and score.error_rate([], ["x"]) == 1.0


def test_normalize_basic_lowercases_and_strips_punctuation():
    assert score.normalize_basic("Dr. O'Neil paid $1,250.50 -- on March 3rd!") == "dr o'neil paid 1 250 50 on march 3rd"
    assert score.normalize_basic("  Hello,   world  ") == "hello world"


def test_repetition_and_omission_flags_come_from_alignment_and_repeated_phrases():
    reference = "the quick brown fox jumps over the lazy dog".split()
    assert score.flags(reference, reference) == {"repetition": False, "omission": False}
    assert score.flags(reference, "the quick brown fox".split())["omission"] is True
    doubled = "the quick brown fox the quick brown fox jumps over the lazy dog".split()
    assert score.flags(reference, doubled)["repetition"] is True
    assert score.flags(reference, "the quick brown fox jumps over the lazy dog dog dog dog".split())["repetition"] is True
    assert score.flags([], ["anything"]) == {"repetition": True, "omission": False}
    long_reference = [f"w{i}" for i in range(20)]
    stutter = long_reference[:10] + ["no", "no", "no"] + long_reference[10:]
    assert score.flags(long_reference, stutter)["repetition"] is True, "a short run is below the insertion ratio"
    assert score.flags(long_reference, long_reference[:10] + ["no", "yes", "no"] + long_reference[10:])["repetition"] is False
    echoed = long_reference[:10] + long_reference[7:10] + long_reference[10:]
    assert score.flags(long_reference, echoed)["repetition"] is True, "a phrase said twice is a repetition below the insertion ratio"


def test_audio_facts_measure_duration_finite_clipping_and_level(tmp_path):
    samples = np.array([0.0, 0.5, -0.5, 1.0, -1.0, 0.0])
    facts = score.audio_facts(samples, 6)
    assert facts["duration_s"] == 1 and facts["finite"] is True and facts["clipped_samples"] == 2
    assert facts["peak_abs"] == 1.0 and facts["rms_dbfs"] == pytest.approx(20 * np.log10(np.sqrt(2.5 / 6)))
    nonfinite = score.audio_facts(np.array([0.0, float("nan")]), 2)
    assert nonfinite["finite"] is False and nonfinite["rms_dbfs"] is None
    silent = score.audio_facts(np.zeros(4), 4)
    assert silent["rms_dbfs"] is None and silent["clipped_samples"] == 0


def test_rows_are_scored_against_text_and_references_and_grouped(settings):
    transcriber = FakeTranscriber(["The cat sat on the mat.", "The cat sat on the", "The cat sat on the mat mat mat mat."])
    report = run(settings, transcriber)
    assert report["status"] == "ok", report.get("error")
    assert transcriber.calls == [(48000, 24000, "en")] * 3
    rows = {row["id"]: row for row in report["rows"]}
    assert rows["row-0"]["wer"] == 0 and rows["row-0"]["cer"] == 0 and rows["row-0"]["flags"] == {"repetition": False, "omission": False}
    assert rows["row-1"]["wer"] == pytest.approx(1 / 6) and rows["row-1"]["flags"]["omission"] is False
    assert rows["row-2"]["wer"] == pytest.approx(3 / 6) and rows["row-2"]["flags"]["repetition"] is True
    assert rows["row-0"]["transcript"] == "The cat sat on the mat." and rows["row-0"]["normalized_transcript"] == "the cat sat on the mat"
    assert rows["row-0"]["normalized_text"] == "the cat sat on the mat"
    assert rows["row-0"]["duration_s"] == 2 and rows["row-0"]["finite"] is True
    assert rows["row-0"]["speaker_similarity"]["a"] > rows["row-0"]["speaker_similarity"]["b"]
    assert rows["row-2"]["speaker_similarity"]["b"] > rows["row-2"]["speaker_similarity"]["a"]
    assert rows["row-0"]["speaker_similarity"]["a"] == pytest.approx(1.0)
    assert rows["row-0"]["chars_per_second"] == len("The cat sat on the mat.") / 2
    assert report["reference_similarity"]["a_vs_b"] < 1
    groups = report["groups"]
    assert groups["baseline"]["count"] == 2 and groups["candidate"]["count"] == 1
    assert groups["baseline"]["wer"] == {"count": 2, "p50": pytest.approx(1 / 12), "p95": pytest.approx(0.95 / 6)}
    assert groups["baseline"]["repetition_count"] == 0 and groups["candidate"]["repetition_count"] == 1
    assert groups["baseline"]["omission_count"] == 0 and groups["baseline"]["nonfinite_count"] == 0
    assert groups["candidate"]["speaker_similarity"]["b"]["count"] == 1
    assert groups["baseline"]["small_sample"] is True and "fewer than 10" in report["notes"]["small_sample"]
    assert report["asr"] == {"fixture": "asr"} and report["speaker_encoder"]["admitted"] == {"fixture": "ve"}
    assert "GE2E" in report["speaker_encoder"]["method"] and "not calibrated" in report["speaker_encoder"]["honesty"]
    assert report["normalization"] == "transcriber.normalize applied to transcript and input text before WER/CER"


def test_nonfinite_or_overlong_rows_are_recorded_as_errors_without_stopping(settings, tmp_path, manifest):
    payload = json.loads(manifest.read_text())
    bad = tmp_path / "bad.wav"
    write_wav(bad, np.zeros(10))
    bad.write_bytes(bad.read_bytes()[:-5])
    payload["rows"].append({"id": "row-bad", "wav": str(bad), "text": "x", "group": "candidate", "text_id": "short",
                            "reference_id": "a", "seed": 0, "kind": "warm"})
    payload["rows"].append({"id": "row-long", "wav": str(write_wav(tmp_path / "long.wav", np.zeros(31), rate=1)), "text": "x",
                            "group": "candidate", "text_id": "short", "reference_id": "a", "seed": 0, "kind": "warm"})
    manifest.write_text(json.dumps(payload))
    transcriber = FakeTranscriber(["The cat sat on the mat."] * 3)
    report = run(settings, transcriber)
    assert report["status"] == "ok" and len(transcriber.calls) == 3
    assert {e["id"]: e["type"] for e in report["errors"]} == {"row-bad": "ValueError", "row-long": "ValueError"}
    assert report["groups"]["candidate"]["count"] == 1 and report["groups"]["candidate"]["error_count"] == 2


def test_transcriber_failure_fails_the_run_and_keeps_scored_rows(settings):
    class Broken(FakeTranscriber):
        def transcribe(self, samples, rate, language):
            if len(self.calls) == 1:
                raise RuntimeError("decoder exploded")
            return super().transcribe(samples, rate, language)

    report = run(settings, Broken(["ok", "ok", "ok"]))
    assert report["status"] == "failed" and report["error"]["type"] == "RuntimeError"
    assert len(report["rows"]) == 1


@pytest.fixture
def whisper_cached(settings):
    repo = settings.cache_root / "models--openai--whisper-base"
    snapshot = repo / "snapshots" / WHISPER_REVISION
    snapshot.mkdir(parents=True)
    (repo / "refs").mkdir()
    (repo / "refs" / "main").write_text(WHISPER_REVISION)
    for name in score.WHISPER_FILES:
        (snapshot / name).write_text("{}")
    return repo, snapshot


def test_whisper_admission_pins_the_revision_and_requires_every_file(settings, whisper_cached):
    repo, snapshot = whisper_cached
    admitted = score.admit_whisper(settings)
    assert admitted["repo_id"] == "openai/whisper-base" and admitted["revision"] == WHISPER_REVISION
    assert admitted["snapshot"] == str(snapshot) and len(admitted["config_sha256"]) == 64
    with pytest.raises(ValueError, match="pinned"):
        score.admit_whisper(replace(settings, whisper_revision="f" * 40))
    (snapshot / "normalizer.json").unlink()
    with pytest.raises(ValueError, match="not locally ready"):
        score.admit_whisper(settings)


def test_speaker_encoder_admission_requires_the_turbo_voice_encoder(settings):
    repo = settings.cache_root / "models--ResembleAI--chatterbox-turbo"
    snapshot = repo / "snapshots" / ("c" * 40)
    snapshot.mkdir(parents=True)
    (repo / "refs").mkdir()
    (repo / "refs" / "main").write_text("c" * 40)
    with pytest.raises(ValueError, match="not locally ready"):
        score.admit_voice_encoder(settings)
    (snapshot / "ve.safetensors").write_bytes(b"weights")
    admitted = score.admit_voice_encoder(settings)
    assert admitted["repo_id"] == "ResembleAI/chatterbox-turbo" and len(admitted["ve_sha256"]) == 64


@pytest.mark.parametrize("change", [{"device": "auto"}, {"device": "mlx"}, {"cache_root": Path("relative")},
                                    {"whisper_revision": "main"}, {"manifest": Path("missing.json")}])
def test_invalid_settings_are_refused(settings, change):
    with pytest.raises(ValueError):
        score.validate(replace(settings, **change))


def test_manifest_shape_is_validated_before_scoring(settings, manifest):
    payload = json.loads(manifest.read_text())
    del payload["rows"][0]["text"]
    manifest.write_text(json.dumps(payload))
    with pytest.raises(ValueError, match="row"):
        score.read_manifest(manifest)
    manifest.write_text(json.dumps({"language": "en", "references": {}, "rows": []}))
    with pytest.raises(ValueError, match="reference"):
        score.read_manifest(manifest)
    manifest.write_text(json.dumps({"language": "xx", "references": {"a": {"wav": "a.wav", "text": "t"}}, "rows": [{}]}))
    with pytest.raises(ValueError, match="language"):
        score.read_manifest(manifest)
    manifest.write_text(json.dumps({"language": "en", "references": {"a": {"wav": "a.wav"}}, "rows": []}))
    with pytest.raises(ValueError, match="needs wav and text"):
        score.read_manifest(manifest)
    manifest.write_text(json.dumps({"language": "en", "references": {"a": {"wav": "a.wav", "text": "t"}}, "rows": {}}))
    with pytest.raises(ValueError, match="list"):
        score.read_manifest(manifest)
    row = {"id": "same", "wav": "x.wav", "text": "t", "group": "g"}
    manifest.write_text(json.dumps({"language": "en", "references": {"a": {"wav": "a.wav", "text": "t"}}, "rows": [row, row]}))
    with pytest.raises(ValueError, match="repeated"):
        score.read_manifest(manifest)


def test_cosine_similarity_of_unit_vectors():
    assert score.cosine(np.array([1.0, 0.0]), np.array([1.0, 0.0])) == pytest.approx(1.0)
    assert score.cosine(np.array([1.0, 0.0]), np.array([0.0, 2.0])) == pytest.approx(0.0)


def test_cli_refuses_missing_cache_before_loading_models(settings, tmp_path):
    result = subprocess.run([sys.executable, "-B", str(SCRIPT), "--manifest", str(settings.manifest), "--device", "cpu",
                             "--cache-root", str(settings.cache_root), "--output-root", str(tmp_path / "cli")],
                            capture_output=True, text=True, timeout=60)
    assert result.returncode == 2, result.stdout + result.stderr
    assert "not locally ready" in result.stderr
    assert json.loads((tmp_path / "cli" / "quality.json").read_text())["status"] == "failed"
    assert subprocess.run([sys.executable, "-B", str(SCRIPT), "--help"], capture_output=True, text=True, timeout=30).returncode == 0


def test_main_success_path_closes_output(settings, monkeypatch):
    import functools
    monkeypatch.setattr(score.bench, "configure_offline", lambda *args: None)
    transcriber = FakeTranscriber(["The cat sat on the mat."] * 3)
    monkeypatch.setattr(score, "score", functools.partial(
        score.score, transcriber_factory=lambda *a: transcriber, encoder_factory=lambda *a: FakeEncoder(),
        admit_asr=lambda *a: {}, admit_encoder=lambda *a: {}, identify=lambda *a: {}, get_provenance=lambda: {}))
    assert score.main(["--manifest", str(settings.manifest), "--device", "cpu", "--cache-root", str(settings.cache_root),
                       "--output-root", str(settings.output_root)]) == 0
    assert json.loads((settings.output_root / "quality.json").read_text())["groups"]["baseline"]["count"] == 2
    assert score.main(["--manifest", str(settings.manifest), "--device", "gpu", "--cache-root", str(settings.cache_root),
                       "--output-root", str(settings.output_root.with_name("q2"))]) == 2


def test_offline_guard_is_installed_by_the_scorer_entry_point(settings):
    probe = SCRIPT.with_name("tests") / "offline_guard_probe.py"
    result = subprocess.run([sys.executable, "-B", str(probe), str(SCRIPT), str(settings.cache_root), str(settings.output_root)],
                            capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr


def test_load_wav_returns_float_mono_and_refuses_stereo(tmp_path):
    path = write_wav(tmp_path / "mono.wav", [0.0, 0.5, -0.5], rate=3)
    samples, rate = score.load_wav(path)
    assert rate == 3 and samples.dtype == np.float32 and samples.tolist() == pytest.approx([0.0, 0.5, -0.5], abs=1e-4)
    with wave.open(str(tmp_path / "stereo.wav"), "wb") as target:
        target.setnchannels(2)
        target.setsampwidth(2)
        target.setframerate(3)
        target.writeframes(b"\0\0\0\0" * 3)
    with pytest.raises(ValueError, match="mono"):
        score.load_wav(tmp_path / "stereo.wav")


def test_resampled_changes_rate_only_when_needed():
    pytest.importorskip("torchaudio")
    samples = np.zeros(48, dtype=np.float32)
    assert score.resampled(samples, 48, 48) is samples
    assert score.resampled(samples, 48, 16).shape == (16,)


def test_score_row_refuses_nonfinite_audio_before_transcribing():
    transcriber = FakeTranscriber(["never"])
    with pytest.raises(ValueError, match="nonfinite"):
        score.score_row({"id": "x", "text": "t"}, np.array([0.0, float("nan")], dtype=np.float32), 2, "en", transcriber, FakeEncoder(), {})
    assert transcriber.calls == []


def test_main_reports_a_failed_scoring_run(settings, monkeypatch, capsys):
    import functools
    monkeypatch.setattr(score.bench, "configure_offline", lambda *args: None)

    class Broken(FakeTranscriber):
        def transcribe(self, samples, rate, language):
            raise RuntimeError("decoder exploded")

    monkeypatch.setattr(score, "score", functools.partial(
        score.score, transcriber_factory=lambda *a: Broken([]), encoder_factory=lambda *a: FakeEncoder(),
        admit_asr=lambda *a: {}, admit_encoder=lambda *a: {}, identify=lambda *a: {}, get_provenance=lambda: {}))
    assert score.main(["--manifest", str(settings.manifest), "--device", "cpu", "--cache-root", str(settings.cache_root),
                       "--output-root", str(settings.output_root)]) == 2
    assert "decoder exploded" in capsys.readouterr().err


def test_real_whisper_and_voice_encoder_from_a_local_cache(tmp_path):
    """Opt-in: VOICEBOX_SCORER_CACHE names a hub with openai/whisper-base at the
    pinned revision and ResembleAI/chatterbox-turbo; skipped otherwise."""
    import os
    hub = os.environ.get("VOICEBOX_SCORER_CACHE")
    if not hub:
        pytest.skip("VOICEBOX_SCORER_CACHE not set")
    pytest.importorskip("torch")
    settings = score.Settings(tmp_path / "unused.json", Path(hub), tmp_path / "out", "cpu")
    whisper = score.WhisperTranscriber(score.admit_whisper(settings)["snapshot"], "cpu")
    encoder = score.TurboVoiceEncoder(score.admit_voice_encoder(settings)["snapshot"], "cpu")
    rate = 24000
    t = np.arange(rate) / rate
    tone = (0.2 * np.sin(2 * np.pi * 220 * t) * np.sin(2 * np.pi * 3 * t)).astype(np.float32)
    assert isinstance(whisper.transcribe(tone, rate, "en"), str)
    assert whisper.normalize("Dr. Smith paid $1,250!") == "doctor smith paid $1250"
    embedding = encoder.embed(tone, rate)
    assert embedding.shape == (256,) and np.isfinite(embedding).all()
    assert score.cosine(embedding, embedding) == pytest.approx(1.0)
