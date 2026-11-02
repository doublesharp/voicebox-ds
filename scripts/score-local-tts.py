#!/usr/bin/env python3
"""Score generated speech offline: Whisper ASR error rates against the input
text, duration/finite/clipping facts, repetition and omission flags, and a
speaker-similarity signal against each reference.

Input is a manifest written by compare-local-tts.py (or by hand):
{"language": "en", "references": {"a": {"wav": ..., "text": ...}}, "rows": [
  {"id": ..., "wav": ..., "text": ..., "group": ..., "reference_id": "a", ...}]}
ASR is openai/whisper-base at a pinned revision from the local cache; the
speaker encoder is the Chatterbox GE2E voice encoder (ve.safetensors) from the
local chatterbox-turbo cache. Importing is inert; main() installs the offline
guard before importing model libraries.
"""

import argparse
from collections import Counter
from dataclasses import asdict, dataclass
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import re
import sys
import wave


REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))
from scripts.portable_output import Output  # noqa: E402
from scripts import device_telemetry as telemetry  # noqa: E402

_spec = importlib.util.spec_from_file_location("benchmark_local_tts", Path(__file__).with_name("benchmark-local-tts.py"))
bench = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = bench
_spec.loader.exec_module(bench)

WHISPER_REPO = "openai/whisper-base"
WHISPER_REVISION = "e37978b90ca9030d5170a5c07aadb050351a65bb"
WHISPER_FILES = ("config.json", "generation_config.json", "model.safetensors", "preprocessor_config.json",
                 "tokenizer.json", "tokenizer_config.json", "vocab.json", "merges.txt", "normalizer.json",
                 "special_tokens_map.json", "added_tokens.json")
WHISPER_SAMPLE_RATE = 16000
WINDOW_SECONDS = 30
FULL_SCALE = 32767 / 32768
SPEAKER_METHOD = ("Chatterbox VoiceEncoder: GE2E LSTM speaker-verification embedding (256-d, Resemblyzer lineage) "
                  "loaded from the local ResembleAI/chatterbox-turbo ve.safetensors; cosine between unit embeddings")
SPEAKER_HONESTY = ("relative signal only: the encoder is not calibrated to a same-speaker threshold on this data, "
                   "was trained for English speaker verification, and is independent of the Qwen speaker encoder; "
                   "compare groups against the same reference and against reference_similarity as the different-speaker floor")


@dataclass(frozen=True)
class Settings:
    manifest: Path
    cache_root: Path
    output_root: Path
    device: str
    whisper_revision: str = WHISPER_REVISION


def validate(settings):
    if not re.fullmatch(r"cpu|cuda(:\d+)?", settings.device):
        raise ValueError("device must be cpu, cuda or cuda:N; nothing is auto-selected")
    if not settings.cache_root.is_absolute() or not settings.cache_root.is_dir():
        raise ValueError("cache root must be an existing absolute Hugging Face hub directory")
    if not settings.manifest.is_absolute() or not settings.manifest.is_file():
        raise ValueError("manifest must be an existing absolute JSON file")
    if not re.fullmatch(r"[a-fA-F0-9]{40}", settings.whisper_revision):
        raise ValueError("whisper revision must be a 40-hex commit")


def read_manifest(path):
    payload = bench.read_json(path)
    if payload.get("language") not in bench.LANGUAGES:
        raise ValueError("manifest language must be one of the supported codes")
    references = payload.get("references")
    if not isinstance(references, dict) or not references:
        raise ValueError("manifest needs at least one reference")
    for key, reference in references.items():
        if not isinstance(reference, dict) or not isinstance(reference.get("wav"), str) or not isinstance(reference.get("text"), str):
            raise ValueError(f"reference {key!r} needs wav and text")
    rows = payload.get("rows")
    if not isinstance(rows, list):
        raise ValueError("manifest rows must be a list")
    seen = set()
    for index, row in enumerate(rows):
        for key in ("id", "wav", "text", "group"):
            if not isinstance(row, dict) or not isinstance(row.get(key), str) or not row[key]:
                raise ValueError(f"manifest row {index} needs a nonempty {key}")
        if row["id"] in seen:
            raise ValueError(f"manifest row id repeated: {row['id']}")
        seen.add(row["id"])
    return payload


def admit_whisper(settings):
    def check(snapshot, required):
        for name in WHISPER_FILES:
            required(name)
        return {"config_sha256": hashlib.sha256((snapshot / "config.json").read_bytes()).hexdigest()}

    admitted = bench.admit_local_snapshot(settings.cache_root, WHISPER_REPO, check)
    if admitted["revision"].lower() != settings.whisper_revision.lower():
        raise ValueError(f"local {WHISPER_REPO} is {admitted['revision']}, not the pinned {settings.whisper_revision}")
    return admitted


def admit_voice_encoder(settings):
    def check(snapshot, required):
        return {"ve_sha256": hashlib.sha256(required("ve.safetensors").read_bytes()).hexdigest()}

    return bench.admit_local_snapshot(settings.cache_root, bench.TURBO_REPO, check)


def load_wav(path):
    import numpy as np
    with wave.open(str(path), "rb") as source:
        if source.getnchannels() != 1 or source.getsampwidth() != 2 or source.getcomptype() != "NONE":
            raise ValueError("expected mono 16-bit PCM WAV")
        rate, frames = source.getframerate(), source.getnframes()
        payload = source.readframes(frames)
    if len(payload) != frames * 2 or not frames:
        raise ValueError("WAV payload is empty or truncated")
    return np.frombuffer(payload, dtype="<i2").astype(np.float32) / 32768, rate


def normalize_basic(text):
    """Fallback normalization (lowercase, punctuation to spaces, apostrophes
    kept inside words); the real transcriber supplies Whisper's English normalizer."""
    text = re.sub(r"[^\w']+", " ", text.lower())
    return re.sub(r"\s+", " ", text).strip()


def edit_operations(reference, hypothesis):
    """Substitutions, deletions and insertions of the minimal edit alignment;
    at equal cost a substitution beats a deletion plus an insertion."""
    rows = [[(j, 0, 0, j) for j in range(len(hypothesis) + 1)]]
    for i in range(1, len(reference) + 1):
        row = [(i, 0, i, 0)]
        for j in range(1, len(hypothesis) + 1):
            diagonal = rows[i - 1][j - 1]
            if reference[i - 1] == hypothesis[j - 1]:
                row.append(diagonal)
                continue
            up, left = rows[i - 1][j], row[j - 1]
            candidates = ((diagonal[0] + 1, diagonal[1] + 1, diagonal[2], diagonal[3]),
                          (up[0] + 1, up[1], up[2] + 1, up[3]),
                          (left[0] + 1, left[1], left[2], left[3] + 1))
            row.append(min(candidates, key=lambda c: (c[0], c[2] + c[3])))
        rows.append(row)
    _, substitutions, deletions, insertions = rows[-1][-1]
    return {"substitutions": substitutions, "deletions": deletions, "insertions": insertions}


def error_rate(reference, hypothesis):
    if not reference:
        return 0.0 if not hypothesis else 1.0
    return sum(edit_operations(reference, hypothesis).values()) / len(reference)


def repeated_phrase(reference, hypothesis, n=3, run=3):
    """A 3-gram said more often than the text contains it, or one word said
    three or more times in a row."""
    reference_grams = Counter(tuple(reference[i:i + n]) for i in range(len(reference) - n + 1))
    hypothesis_grams = Counter(tuple(hypothesis[i:i + n]) for i in range(len(hypothesis) - n + 1))
    if any(count >= 2 and count > reference_grams[gram] for gram, count in hypothesis_grams.items()):
        return True
    return any(len(set(hypothesis[i:i + run])) == 1 for i in range(len(hypothesis) - run + 1))


def flags(reference, hypothesis, threshold=0.2):
    operations = edit_operations(reference, hypothesis)
    scale = max(len(reference), 1)
    return {"repetition": operations["insertions"] / scale > threshold or repeated_phrase(reference, hypothesis),
            "omission": operations["deletions"] / scale > threshold}


def audio_facts(samples, rate):
    import numpy as np
    finite = bool(np.isfinite(samples).all())
    rms = float(np.sqrt(np.mean(np.square(samples, dtype=np.float64)))) if finite else None
    return {"duration_s": samples.size / rate, "finite": finite,
            "clipped_samples": int(np.count_nonzero(np.abs(samples) >= FULL_SCALE)) if finite else None,
            "peak_abs": float(np.abs(samples).max()) if finite else None,
            "rms_dbfs": 20 * math.log10(rms) if rms else None}


def cosine(left, right):
    import numpy as np
    left, right = np.asarray(left, dtype=np.float64).ravel(), np.asarray(right, dtype=np.float64).ravel()
    return float(left @ right / (np.linalg.norm(left) * np.linalg.norm(right)))


def resampled(samples, rate, target_rate):
    """float32 mono at target_rate through torchaudio; librosa's resampler
    needs resampy, which the stack does not ship."""
    if rate == target_rate:
        return samples
    import torch
    import torchaudio.functional
    return torchaudio.functional.resample(torch.from_numpy(samples), rate, target_rate).numpy()


class WhisperTranscriber:
    """Greedy single-window Whisper decoding from the admitted snapshot."""

    def __init__(self, snapshot, device):
        import torch
        from transformers import WhisperForConditionalGeneration, WhisperProcessor
        self.torch, self.device = torch, device
        self.processor = WhisperProcessor.from_pretrained(snapshot, local_files_only=True)
        self.model = WhisperForConditionalGeneration.from_pretrained(snapshot, local_files_only=True).to(device).eval()

    def transcribe(self, samples, rate, language):
        audio = resampled(samples, rate, WHISPER_SAMPLE_RATE)
        inputs = self.processor(audio, sampling_rate=WHISPER_SAMPLE_RATE, return_tensors="pt").to(self.device)
        with self.torch.inference_mode():
            ids = self.model.generate(inputs["input_features"], language=language, task="transcribe",
                                      num_beams=1, do_sample=False)
        return self.processor.batch_decode(ids, skip_special_tokens=True)[0].strip()

    def normalize(self, text):
        return self.processor.tokenizer.normalize(text)


class TurboVoiceEncoder:
    def __init__(self, snapshot, device):
        import torch
        from chatterbox.models.voice_encoder import VoiceEncoder
        from safetensors.torch import load_file
        self.torch = torch
        encoder = VoiceEncoder()
        encoder.load_state_dict(load_file(Path(snapshot) / "ve.safetensors"))
        self.encoder = encoder.to(device).eval()

    def embed(self, samples, rate):
        import numpy as np
        target = self.encoder.hp.sample_rate
        audio = resampled(samples, rate, target)
        with self.torch.inference_mode():
            return np.asarray(self.encoder.embeds_from_wavs([audio], sample_rate=target, as_spk=True), dtype=np.float32)


DECODING = {"model": WHISPER_REPO, "greedy": True, "num_beams": 1, "task": "transcribe", "window": "single 30 s window",
            "sample_rate": WHISPER_SAMPLE_RATE}


def score_row(row, samples, rate, language, transcriber, encoder, reference_embeddings):
    facts = audio_facts(samples, rate)
    if not facts["finite"]:
        raise ValueError("audio contains nonfinite samples")
    transcript = transcriber.transcribe(samples, rate, language)
    normalized_text, normalized_transcript = transcriber.normalize(row["text"]), transcriber.normalize(transcript)
    reference_words, hypothesis_words = normalized_text.split(), normalized_transcript.split()
    return {**row, **facts, "transcript": transcript, "normalized_transcript": normalized_transcript,
            "normalized_text": normalized_text,
            "wer": error_rate(reference_words, hypothesis_words),
            "cer": error_rate(list(normalized_text), list(normalized_transcript)),
            "edit_operations": edit_operations(reference_words, hypothesis_words),
            "flags": flags(reference_words, hypothesis_words),
            "chars_per_second": len(row["text"]) / facts["duration_s"],
            "speaker_similarity": {key: cosine(encoder.embed(samples, rate), embedding)
                                   for key, embedding in reference_embeddings.items()}}


def group_summary(rows, errors, reference_ids):
    def dist(key):
        return bench.distribution([row[key] for row in rows])

    return {"count": len(rows), "error_count": len(errors), "small_sample": len(rows) < 10,
            "wer": dist("wer"), "cer": dist("cer"), "duration_s": dist("duration_s"),
            "chars_per_second": dist("chars_per_second"),
            "repetition_count": sum(row["flags"]["repetition"] for row in rows),
            "omission_count": sum(row["flags"]["omission"] for row in rows),
            "nonfinite_count": sum(error["type"] == "ValueError" and "nonfinite" in error["message"] for error in errors),
            "clipped_rows": sum(row["clipped_samples"] > 0 for row in rows),
            "speaker_similarity": {key: bench.distribution([row["speaker_similarity"][key] for row in rows])
                                   for key in reference_ids}}


def score(settings, output, *, transcriber_factory=WhisperTranscriber, encoder_factory=TurboVoiceEncoder,
          admit_asr=admit_whisper, admit_encoder=admit_voice_encoder, identify=bench.device_identity,
          get_provenance=bench.provenance):
    """Injectable test boundary. Caller owns offline setup and validation."""
    report = {"schema_version": 1, "status": "failed", "config": asdict(settings), "provenance": get_provenance(),
              "manifest": {"path": str(settings.manifest), "sha256": hashlib.sha256(settings.manifest.read_bytes()).hexdigest()},
              "decoding": DECODING,
              "normalization": "transcriber.normalize applied to transcript and input text before WER/CER",
              "speaker_encoder": {"method": SPEAKER_METHOD, "honesty": SPEAKER_HONESTY},
              "notes": {"small_sample": "a group with fewer than 10 scored rows is marked small_sample; its p95 is not a tail estimate"},
              "rows": [], "errors": [], "groups": {}, "stages": {}}
    meter = None
    try:
        manifest = read_manifest(settings.manifest)
        language = manifest["language"]
        report["manifest"].update({"language": language, "rows": len(manifest["rows"]), "references": sorted(manifest["references"])})
        report["asr"] = admit_asr(settings)
        report["speaker_encoder"]["admitted"] = admit_encoder(settings)
        report["device"] = identify(settings)
        device = bench.torch_device(settings)
        meter = telemetry.StageMeter.for_device(device)
        with meter.stage("asr_load"):
            transcriber = transcriber_factory(report["asr"].get("snapshot"), device)
        with meter.stage("encoder_load"):
            encoder = encoder_factory(report["speaker_encoder"]["admitted"].get("snapshot"), device)
        with meter.stage("reference_embeddings"):
            embeddings = {}
            for key, reference in manifest["references"].items():
                bench.reference_info(Path(reference["wav"]))
                embeddings[key] = encoder.embed(*load_wav(reference["wav"]))
        keys = sorted(embeddings)
        report["reference_similarity"] = {f"{a}_vs_{b}": cosine(embeddings[a], embeddings[b])
                                          for i, a in enumerate(keys) for b in keys[i + 1:]}
        with meter.stage("scoring"):
            for row in manifest["rows"]:
                try:
                    samples, rate = load_wav(row["wav"])
                    if samples.size / rate > WINDOW_SECONDS:
                        raise ValueError(f"audio longer than the {WINDOW_SECONDS} s single window")
                    report["rows"].append(score_row(row, samples, rate, language, transcriber, encoder, embeddings))
                except (ValueError, OSError, EOFError, wave.Error) as exc:
                    report["errors"].append({"id": row["id"], "group": row["group"], "type": type(exc).__name__,
                                             "message": str(exc)[:500]})
        groups = sorted({row["group"] for row in manifest["rows"]})
        report["groups"] = {group: group_summary([r for r in report["rows"] if r["group"] == group],
                                                 [e for e in report["errors"] if e["group"] == group], keys)
                            for group in groups}
        report["status"] = "ok"
    except (Exception, KeyboardInterrupt) as exc:
        report["error"] = {"type": type(exc).__name__, "message": str(exc)[:2000]}
    finally:
        if meter is not None:
            report["stages"] = {name: asdict(m) for name, m in meter.stages.items()}
        with output.open("quality.json") as handle:
            handle.write(json.dumps(report, default=str, indent=2, allow_nan=False).encode() + b"\n")
    return report


def parse_args(argv):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    for name in ("manifest", "cache-root", "output-root"):
        parser.add_argument("--" + name, required=True, type=Path)
    parser.add_argument("--device", required=True)
    parser.add_argument("--whisper-revision", default=WHISPER_REVISION)
    return Settings(**vars(parser.parse_args(argv)))


def main(argv=None):
    output = None
    try:
        settings = parse_args(argv)
        validate(settings)
        output = Output(settings.output_root)
        bench.configure_offline(settings, output)
        report = score(settings, output)
        print(str(output.path / "quality.json"))
        if report["status"] != "ok":
            print(json.dumps(report["error"]), file=sys.stderr)
            return 2
        return 0
    except (OSError, ValueError) as exc:
        print(f"scoring refused: {exc}", file=sys.stderr)
        return 2
    finally:
        if output is not None:
            output.close()


if __name__ == "__main__":
    raise SystemExit(main())
