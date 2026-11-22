"""Offline, sample-domain studio rendering. Sources are never modified."""

import contextlib
import json
import math
import os
import shutil
import subprocess
import tempfile
import time
import uuid
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

from ..utils.ffmpeg import find_ffmpeg as _desktop_find_ffmpeg
from .fades import fade_envelopes
from .processing import make_board, tail_frames, validate_chain
from .timing import resampled_frames


def _find_ffmpeg():
    """Locate ffmpeg honoring VOICEBOX_FFMPEG_DIR, then PATH, then desktop install directories."""
    if os.environ.get("VOICEBOX_FFMPEG_DIR"):
        return _desktop_find_ffmpeg("ffmpeg")
    return shutil.which("ffmpeg") or _desktop_find_ffmpeg("ffmpeg")


def _integer(value, name):
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{name} must be a nonnegative integer")
    return value


def _gain(value):
    if isinstance(value, bool) or not isinstance(value, int | float) or not math.isfinite(value) or value < 0:
        raise ValueError("gain must be finite and nonnegative")
    return float(value)


BLOCK_FRAMES = 65536
MAX_DURATION_SECONDS = 7200
# Pre-resample unique short/medium assets once per render pass up to this total RAM budget.
_RESAMPLE_CACHE_MAX_ASSET_SECONDS = 60
_RESAMPLE_CACHE_MAX_BYTES = 128 * 1024 * 1024


def _check_cancel(cancelled):
    if cancelled and cancelled():
        raise ValueError("Render cancelled")


def _process(command, cancelled=None):
    """Reap an encoder before returning, including on cancellation."""
    with subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE) as process:
        started = time.monotonic()
        try:
            while True:
                _check_cancel(cancelled)
                if time.monotonic() - started > 3600:
                    raise ValueError("Encoder time limit exceeded")
                try:
                    out, err = process.communicate(timeout=0.2)
                    if process.returncode:
                        raise ValueError("Audio encoder or meter failed: " + err.decode(errors="replace")[-1000:])
                    return err.decode(errors="replace")
                except subprocess.TimeoutExpired:
                    continue
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate()


def _parse_loudnorm_report(stderr: str) -> dict[str, float] | None:
    try:
        report = json.loads(stderr[stderr.rindex("{") : stderr.rindex("}") + 1])
        parsed = {
            "input_i": float(report["input_i"]),
            "input_tp": float(report["input_tp"]),
            "input_lra": float(report["input_lra"]),
            "input_thresh": float(report["input_thresh"]),
            "target_offset": float(report["target_offset"]),
        }
        if all(math.isfinite(value) for value in parsed.values()):
            return parsed
    except (ValueError, KeyError, json.JSONDecodeError):
        pass
    return None


def _measure_loudnorm_pass1(ffmpeg, path, target, tp, cancelled=None):
    """Measure loudness stats for two-pass linear loudnorm (avoids single-pass pumping)."""
    _check_cancel(cancelled)
    try:
        stderr = _process(
            [
                ffmpeg,
                "-nostdin",
                "-hide_banner",
                "-i",
                str(path),
                "-af",
                f"loudnorm=I={target}:TP={tp}:LRA=11:print_format=json",
                "-f",
                "null",
                "-",
            ],
            cancelled,
        )
        return _parse_loudnorm_report(stderr)
    except ValueError:
        _check_cancel(cancelled)
        return None


def _measure(path, cancelled=None):
    ffmpeg = _find_ffmpeg()
    if not ffmpeg:
        return {"status": "unavailable", "integrated_lufs": None, "true_peak_dbtp": None}

    _check_cancel(cancelled)
    try:
        stderr = _process(
            [
                ffmpeg,
                "-nostdin",
                "-hide_banner",
                "-i",
                str(path),
                "-af",
                "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json",
                "-f",
                "null",
                "-",
            ],
            cancelled,
        )
        report = json.loads(stderr[stderr.rindex("{") : stderr.rindex("}") + 1])
        loudness, peak = float(report["input_i"]), float(report["input_tp"])
        if not math.isfinite(loudness) or not math.isfinite(peak):
            return {"status": "unavailable", "integrated_lufs": None, "true_peak_dbtp": None}
        return {"status": "measured", "integrated_lufs": loudness, "true_peak_dbtp": peak, "method": "ffmpeg loudnorm"}
    except (ValueError, KeyError, json.JSONDecodeError):
        _check_cancel(cancelled)
        return {"status": "unavailable", "integrated_lufs": None, "true_peak_dbtp": None}


def preflight_mp3():
    """Encode a short silent signal to verify the actual configured MP3 encoder."""
    ffmpeg = _find_ffmpeg()
    if not ffmpeg:
        raise ValueError("MP3 encoder unavailable")
    try:
        _process(
            [
                ffmpeg,
                "-nostdin",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "anullsrc=r=48000:cl=stereo",
                "-t",
                "0.01",
                "-c:a",
                "libmp3lame",
                "-f",
                "mp3",
                "-",
            ]
        )
    except (OSError, ValueError) as exc:
        raise ValueError("MP3 encoder unavailable") from exc


def _read_from_source(source, info, rate, start, end):
    if info.samplerate == rate:
        source.seek(start)
        data = source.read(end - start, dtype="float64", always_2d=True)
    else:
        divisor = math.gcd(rate, info.samplerate)
        up, down = rate // divisor, info.samplerate // divisor
        # scipy's default FIR extends 10*max(up,down) samples on either side.
        padding = math.ceil(10 * max(up, down) / up) + 2
        left = max(0, (math.floor(start * down / up) - padding) // down * down)
        right = min(info.frames, math.ceil(end * down / up) + padding)
        source.seek(left)
        data = source.read(right - left, dtype="float64", always_2d=True)
        data = resample_poly(data, up, down, axis=0)
        offset = start - left * up // down
        data = data[offset : offset + end - start]
    if len(data) != end - start or not np.isfinite(data).all():
        raise ValueError("Invalid source audio range")
    return data


def _source_range(path, info, rate, start, end, *, handle=None, resampled=None):
    """Read only a working-sample range, retaining the resampler's global phase."""
    if resampled is not None:
        data = resampled[start:end]
        if len(data) != end - start or not np.isfinite(data).all():
            raise ValueError("Invalid source audio range")
        return data
    if handle is not None:
        return _read_from_source(handle, info, rate, start, end)
    with sf.SoundFile(str(path)) as source:
        return _read_from_source(source, info, rate, start, end)


def _merge_intervals(intervals: list[tuple[int, int]]) -> list[tuple[int, int]]:
    if not intervals:
        return []
    ordered = sorted(intervals)
    merged = [ordered[0]]
    for start, end in ordered[1:]:
        prev_start, prev_end = merged[-1]
        if start <= prev_end:
            merged[-1] = (prev_start, max(prev_end, end))
        else:
            merged.append((start, end))
    return merged


def _ducking_envelope(
    offset: int,
    end: int,
    voice_intervals: list[tuple[int, int]],
    duck_linear: float,
    attack_samples: int,
    release_samples: int,
) -> np.ndarray:
    """Compute a smooth per-sample ducking gain curve for ``[offset, end)``."""
    length = end - offset
    envelope = np.ones(length, dtype=np.float64)
    if not voice_intervals or duck_linear >= 1.0:
        return envelope
    for v_start, v_end in voice_intervals:
        ramp_in_start = v_start - attack_samples
        ramp_out_end = v_end + release_samples
        if ramp_out_end <= offset or ramp_in_start >= end:
            continue
        # Attack ramp before speech starts: 1.0 -> duck_linear
        if attack_samples > 0:
            lo, hi = max(offset, ramp_in_start), min(end, v_start)
            if lo < hi:
                t = (np.arange(lo, hi, dtype=np.float64) - ramp_in_start) / attack_samples
                curve = 1.0 - (1.0 - duck_linear) * (0.5 - 0.5 * np.cos(np.pi * t))
                np.minimum(envelope[lo - offset : hi - offset], curve, out=envelope[lo - offset : hi - offset])
        # Hold ducked gain across the speech interval
        lo, hi = max(offset, v_start), min(end, v_end)
        if lo < hi:
            np.minimum(envelope[lo - offset : hi - offset], duck_linear, out=envelope[lo - offset : hi - offset])
        # Release ramp after speech ends: duck_linear -> 1.0
        if release_samples > 0:
            lo, hi = max(offset, v_end), min(end, ramp_out_end)
            if lo < hi:
                t = (np.arange(lo, hi, dtype=np.float64) - v_end) / release_samples
                curve = duck_linear + (1.0 - duck_linear) * (0.5 - 0.5 * np.cos(np.pi * t))
                np.minimum(envelope[lo - offset : hi - offset], curve, out=envelope[lo - offset : hi - offset])
    return envelope


def render_project(
    document,
    assets,
    resolve_asset,
    output_path,
    *,
    kind="mix",
    format="wav",  # noqa: A002 - public renderer keyword retained for compatibility.
    processing=None,
    cancelled=None,
    progress=None,
    phase=None,
):
    if kind not in ("mix", "stems") or format not in ("wav", "mp3"):
        raise ValueError("unsupported render kind or format")
    if processing is None:
        processing = "processed" if kind == "mix" else "dry"
    if processing not in ("dry", "processed"):
        raise ValueError("unsupported processing")
    mix_settings = document.get("mix", {})
    master_gain = _gain(mix_settings.get("master_gain", 1))
    limiter = mix_settings.get("limiter", False)
    duck_music = mix_settings.get("duck_music", False)
    duck_db = mix_settings.get("duck_db", -14.0)
    duck_attack_ms = mix_settings.get("duck_attack_ms", 80.0)
    duck_release_ms = mix_settings.get("duck_release_ms", 350.0)
    if (
        master_gain > 16
        or type(limiter) is not bool
        or type(duck_music) is not bool
        or isinstance(duck_db, bool)
        or not isinstance(duck_db, int | float)
        or not math.isfinite(duck_db)
        or not -30 <= duck_db <= 0
        or isinstance(duck_attack_ms, bool)
        or not isinstance(duck_attack_ms, int | float)
        or not math.isfinite(duck_attack_ms)
        or not 5 <= duck_attack_ms <= 1000
        or isinstance(duck_release_ms, bool)
        or not isinstance(duck_release_ms, int | float)
        or not math.isfinite(duck_release_ms)
        or not 20 <= duck_release_ms <= 3000
    ):
        raise ValueError("Invalid master processing")
    rate = _integer(document["sample_rate"], "sample rate")
    channels = document["channels"]
    if not 8000 <= rate <= 192000 or type(channels) is not int or channels not in (1, 2):
        raise ValueError("unsupported working format")
    tracks = document["tracks"]
    if len(tracks) > 128 or len(document["clips"]) > 10000:
        raise ValueError("Render exceeds track or clip limits")
    by_id = {t["id"]: t for t in tracks}
    if len(by_id) != len(tracks):
        raise ValueError("duplicate track")
    for track in tracks:
        validate_chain(track.get("effects_chain", []))
        effect_gain_db = track.get("effect_gain_db", 0)
        if (
            isinstance(effect_gain_db, bool)
            or not isinstance(effect_gain_db, int | float)
            or not math.isfinite(effect_gain_db)
            or not -40 <= effect_gain_db <= 40
        ):
            raise ValueError("Invalid track gain effect")
    solo = any(t.get("solo", False) and not t.get("mute", False) for t in tracks)
    active = {t["id"] for t in tracks if not t.get("mute", False) and (not solo or t.get("solo", False))}
    parts = []
    sources = {}
    length = 0
    for clip in document["clips"]:
        _check_cancel(cancelled)
        track_id, asset_id = clip["track_id"], clip["asset_id"]
        if track_id not in by_id or asset_id not in assets:
            raise ValueError("unknown track or asset")
        start = _integer(clip["start_sample"], "start")
        left = _integer(clip["trim_start_sample"], "trim start")
        right = _integer(clip["trim_end_sample"], "trim end")
        gain = _gain(clip["gain"]) * _gain(by_id[track_id].get("gain", 1))
        if processing == "processed":
            gain *= 10 ** (by_id[track_id].get("effect_gain_db", 0) / 20)
        if not math.isfinite(gain):
            raise ValueError("Invalid combined gain")
        if asset_id not in sources:
            path = Path(resolve_asset(asset_id))
            info = sf.info(str(path))
            if info.channels not in (1, 2) or not 1000 <= info.samplerate <= 384000 or info.frames <= 0:
                raise ValueError("invalid source audio")
            sources[asset_id] = path, info
        path, info = sources[asset_id]
        frames = resampled_frames(info.frames, info.samplerate, rate)
        duration = frames - left - right
        if duration <= 0:
            raise ValueError("trim removes source")
        (fade_in, in_offset), (fade_out, out_offset) = fade_envelopes(clip, duration, frames)
        if start + duration > rate * MAX_DURATION_SECONDS:
            raise ValueError("Render exceeds two-hour duration limit")
        if track_id in active:
            parts.append((asset_id, track_id, start, duration, left, gain, fade_in, in_offset, fade_out, out_offset, path, info))
            length = max(length, start + duration)

    # Pre-compute active voice clip intervals for smooth automatic music ducking.
    voice_intervals: list[tuple[int, int]] = []
    if kind == "mix" and processing == "processed" and duck_music:
        for _aid, tid, start, duration, _left, gain, _fi, _fio, _fo, _foo, _path, _info in parts:
            if gain > 0 and by_id[tid].get("kind", "voice") == "voice":
                voice_intervals.append((start, start + duration))
        voice_intervals = _merge_intervals(voice_intervals)
    duck_linear = 10 ** (duck_db / 20.0)
    duck_attack_samples = int(round(duck_attack_ms * rate / 1000.0))
    duck_release_samples = int(round(duck_release_ms * rate / 1000.0))

    arrangement_length = length
    tail_truncated = False
    if processing == "processed":
        tail = max((tail_frames(by_id[tid].get("effects_chain", []), rate) for tid in active), default=0)
        length = min(rate * MAX_DURATION_SECONDS, length + tail)
        tail_truncated = length < arrangement_length + tail
    output = Path(output_path)
    output.mkdir(parents=True, exist_ok=True)
    warnings = []
    if tail_truncated:
        warnings.append("Effect tail truncated at the two-hour output limit")
    if processing == "processed" and any(
        effect.get("type") == "pitch_shift" and effect.get("enabled", True)
        for tid in active
        for effect in by_id[tid].get("effects_chain", [])
    ):
        warnings.append("Pitch shifting may introduce plugin latency; clip placement is not latency compensated")
    files = []
    measurements = {}
    # Unique names make each publication independent of earlier deliverables.
    staging = Path(tempfile.mkdtemp(prefix=".render-", dir=output))
    published = []
    try:
        # Keep unique SoundFile handles open across blocks and pre-resample short/medium
        # mismatched-rate assets once so multi-clip projects don't re-open & resample
        # every 65k-frame block.
        resampled_cache: dict[str, np.ndarray] = {}
        cached_bytes = 0
        with contextlib.ExitStack() as stack:
            handles: dict[str, sf.SoundFile] = {}
            for asset_id, (path, info) in sources.items():
                handle = stack.enter_context(sf.SoundFile(str(path)))
                handles[asset_id] = handle
                if info.samplerate != rate:
                    target_frames = resampled_frames(info.frames, info.samplerate, rate)
                    est_bytes = target_frames * info.channels * 8
                    if (
                        target_frames <= rate * _RESAMPLE_CACHE_MAX_ASSET_SECONDS
                        and cached_bytes + est_bytes <= _RESAMPLE_CACHE_MAX_BYTES
                    ):
                        _check_cancel(cancelled)
                        handle.seek(0)
                        raw = handle.read(info.frames, dtype="float64", always_2d=True)
                        divisor = math.gcd(rate, info.samplerate)
                        up, down = rate // divisor, info.samplerate // divisor
                        resampled = resample_poly(raw, up, down, axis=0)
                        if len(resampled) > target_frames:
                            resampled = resampled[:target_frames]
                        elif len(resampled) < target_frames:
                            resampled = np.pad(resampled, ((0, target_frames - len(resampled)), (0, 0)))
                        resampled_cache[asset_id] = resampled
                        cached_bytes += resampled.nbytes

            targets = [(None, "mix")] if kind == "mix" else [(t["id"], "stem") for t in tracks if t["id"] in active]
            for target_index, (track_id, file_kind) in enumerate(targets):
                if phase:
                    phase("mixing")
                peak = 0.0
                target_tracks = [
                    t["id"] for t in tracks if t["id"] in active and (track_id is None or t["id"] == track_id)
                ]
                boards = (
                    {tid: make_board(by_id[tid].get("effects_chain", [])) for tid in target_tracks}
                    if processing == "processed"
                    else {}
                )
                intermediate = staging / f"{uuid.uuid4().hex}.wav"
                # Block mixing keeps memory independent of project/source duration.
                with sf.SoundFile(str(intermediate), "w", samplerate=rate, channels=channels, subtype="FLOAT") as stream:
                    for offset in range(0, max(length, 1), BLOCK_FRAMES):
                        _check_cancel(cancelled)
                        end = min(offset + BLOCK_FRAMES, max(length, 1))
                        mixed = np.zeros((end - offset, channels), dtype=np.float64)
                        duck_env = (
                            _ducking_envelope(
                                offset,
                                end,
                                voice_intervals,
                                duck_linear,
                                duck_attack_samples,
                                duck_release_samples,
                            )
                            if voice_intervals
                            else None
                        )
                        for target_tid in target_tracks:
                            track_block = np.zeros_like(mixed)
                            for aid, tid, start, duration, left, gain, fade_in, in_offset, fade_out, out_offset, path, info in parts:
                                if tid != target_tid:
                                    continue
                                lo, hi = max(offset, start), min(end, start + duration)
                                if lo >= hi:
                                    continue
                                local = lo - start
                                data = _source_range(
                                    path,
                                    info,
                                    rate,
                                    left + local,
                                    left + hi - start,
                                    handle=handles.get(aid),
                                    resampled=resampled_cache.get(aid),
                                )
                                if channels == 2 and info.channels == 1:
                                    data = np.repeat(data, 2, axis=1)
                                elif channels == 1 and info.channels == 2:
                                    data = data.mean(axis=1, keepdims=True)
                                scale = np.full(hi - lo, gain)
                                positions = np.arange(local, local + hi - lo)
                                if fade_in:
                                    scale *= np.minimum((positions + in_offset) / fade_in, 1.0)
                                if fade_out:
                                    scale *= np.minimum((duration - positions + out_offset) / fade_out, 1.0)
                                track_block[lo - offset : hi - offset] += data * scale[:, None]
                            board = boards.get(target_tid)
                            if board is not None:
                                track_block = board(track_block.T.astype(np.float32), rate, reset=False).T
                            if duck_env is not None and by_id[target_tid].get("kind") == "music":
                                track_block = track_block * duck_env[:, None]
                            mixed += track_block
                        if not np.isfinite(mixed).all():
                            raise ValueError("Invalid mixed samples")
                        if kind == "mix" and processing == "processed":
                            mixed *= master_gain
                        if length > arrangement_length:
                            # Fixed tail budget, with a short fade only in the appended tail.
                            positions = np.arange(offset, end)
                            fade = min(int(rate * 0.02), length - arrangement_length)
                            if fade:
                                mixed *= np.minimum(1, np.maximum(0, (length - positions) / fade))[:, None]
                        peak = max(peak, float(np.max(np.abs(mixed))))
                        stream.write(mixed)
                        if progress:
                            progress(target_index * max(length, 1) + end, len(targets) * max(length, 1))
                normalize = kind == "mix" and processing == "processed" and document.get("mix", {}).get("normalize", False)
                limit_enabled = kind == "mix" and processing == "processed" and limiter
                if peak > 1 and not limit_enabled:
                    warnings.append(
                        f"{file_kind} exceeds full scale before encoding" + ("; output clips" if not normalize else "")
                    )
                mix = document.get("mix", {})
                ffmpeg = _find_ffmpeg()
                encoded = staging / f"{uuid.uuid4().hex}.{format}"
                if phase:
                    phase("encoding")
                filters = []
                if normalize:
                    if not ffmpeg:
                        raise ValueError("normalization requires ffmpeg loudnorm")
                    target = float(mix.get("target_lufs", -16))
                    tp = float(mix.get("max_true_peak_dbtp", -1.5))
                    if not math.isfinite(target) or not math.isfinite(tp) or not -70 <= target <= -5 or not -9 <= tp <= 0:
                        raise ValueError("unsupported loudness target")
                    # Two-pass linear loudnorm preserves vocal dynamics without single-pass pumping.
                    stats = _measure_loudnorm_pass1(ffmpeg, intermediate, target, tp, cancelled)
                    if stats is not None:
                        filters.append(
                            f"loudnorm=I={target}:TP={tp}:LRA=11"
                            f":measured_I={stats['input_i']:.4f}"
                            f":measured_TP={stats['input_tp']:.4f}"
                            f":measured_LRA={stats['input_lra']:.4f}"
                            f":measured_thresh={stats['input_thresh']:.4f}"
                            f":offset={stats['target_offset']:.4f}"
                            f":linear=true"
                        )
                    else:
                        filters.append(f"loudnorm=I={target}:TP={tp}:LRA=11")
                if limit_enabled:
                    tp = mix.get("max_true_peak_dbtp", -1.5)
                    if (
                        isinstance(tp, bool)
                        or not isinstance(tp, int | float)
                        or not math.isfinite(tp)
                        or not -9 <= tp <= 0
                    ):
                        raise ValueError("unsupported limiter target")
                    ceiling = 10 ** (tp / 20)
                    filters.extend(
                        [f"aresample={rate * 4}", f"alimiter=limit={ceiling:.9f}:level=0:latency=1", f"aresample={rate}"]
                    )
                    warnings.append(
                        "Oversampled limiter uses the peak target; final true-peak compliance is not guaranteed"
                    )
                filter_arg = ",".join(filters) or "anull"
                if format == "mp3" or normalize or limit_enabled:
                    if not ffmpeg:
                        raise ValueError("ffmpeg encoder unavailable")
                    codec = ["-c:a", "libmp3lame", "-b:a", "192k"] if format == "mp3" else ["-c:a", "pcm_s24le"]
                    _process(
                        [
                            ffmpeg,
                            "-nostdin",
                            "-v",
                            "error",
                            "-y",
                            "-i",
                            str(intermediate),
                            "-af",
                            filter_arg,
                            "-ar",
                            str(rate),
                            "-ac",
                            str(channels),
                            *codec,
                            str(encoded),
                        ],
                        cancelled,
                    )
                else:
                    with (
                        sf.SoundFile(str(intermediate)) as source,
                        sf.SoundFile(str(encoded), "w", samplerate=rate, channels=channels, subtype="PCM_24") as target,
                    ):
                        while True:
                            _check_cancel(cancelled)
                            block = source.read(BLOCK_FRAMES, dtype="float64", always_2d=True)
                            if not len(block):
                                break
                            target.write(block)
                if phase:
                    phase("metering")
                measurement = _measure(encoded, cancelled)
                measurement["pre_encode_sample_peak"] = peak
                if measurement["status"] != "measured":
                    warnings.append(
                        f"{file_kind} loudness and true peak unavailable (silence, short audio, or meter unavailable)"
                    )
                name = f"{file_kind}-{uuid.uuid4().hex}.{format}"
                final = output / name
                _check_cancel(cancelled)
                os.replace(encoded, final)
                published.append(final)
                files.append(
                    {
                        "path": str(final),
                        "kind": file_kind,
                        "track_id": track_id,
                        "sample_rate": rate,
                        "channels": channels,
                        "processing": processing,
                    }
                )
                measurements[name] = measurement
                intermediate.unlink()
        if kind == "stems" and document.get("mix", {}).get("normalize"):
            warnings.append("Dry stems preserve relative track levels; master normalization omitted")
        return {"files": files, "measurements": measurements, "warnings": warnings}
    except Exception:
        for path in published:
            path.unlink(missing_ok=True)
        raise
    finally:
        shutil.rmtree(staging, ignore_errors=True)
