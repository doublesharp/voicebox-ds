"""Pitch-preserving speaking rate shared by generated speech APIs."""

import math
import subprocess

import numpy as np

from .ffmpeg import find_ffmpeg


def _atempo_chain(speed: float) -> str:
    """Build an ffmpeg atempo filter graph supporting any positive rate.

    ffmpeg's atempo accepts [0.5, 2.0] per stage, so extreme rates chain stages.
    """
    stages: list[float] = []
    remaining = float(speed)
    while remaining > 2.0:
        stages.append(2.0)
        remaining /= 2.0
    while remaining < 0.5:
        stages.append(0.5)
        remaining /= 0.5
    stages.append(remaining)
    return ",".join(f"atempo={stage:.8f}" for stage in stages)


def _stretch_with_ffmpeg(audio: np.ndarray, sample_rate: int, speed: float) -> np.ndarray | None:
    """High-quality WSOLA time-stretch via ffmpeg atempo over stdio float32 PCM."""
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        return None
    pcm_in = np.ascontiguousarray(audio, dtype="<f4")
    cmd = [
        ffmpeg,
        "-nostdin",
        "-hide_banner",
        "-v",
        "error",
        "-f",
        "f32le",
        "-ar",
        str(int(sample_rate)),
        "-ac",
        "1",
        "-i",
        "pipe:0",
        "-af",
        _atempo_chain(speed),
        "-f",
        "f32le",
        "-ar",
        str(int(sample_rate)),
        "-ac",
        "1",
        "pipe:1",
    ]
    try:
        proc = subprocess.run(cmd, input=pcm_in.tobytes(), capture_output=True, check=False, timeout=120)
    except (OSError, subprocess.SubprocessError):
        return None
    if proc.returncode != 0 or not proc.stdout:
        return None
    usable = len(proc.stdout) - (len(proc.stdout) % 4)
    if usable <= 0:
        return None
    out = np.frombuffer(proc.stdout[:usable], dtype="<f4").copy()
    if not np.isfinite(out).all():
        return None
    target_len = max(1, round(len(audio) / speed))
    if len(out) > target_len:
        out = out[:target_len]
    elif len(out) < target_len:
        out = np.pad(out, (0, target_len - len(out)))
    return out


def apply_speed(audio: np.ndarray, sample_rate: int, speed: float) -> np.ndarray:
    """Time-stretch without changing pitch; rates below one lengthen speech.

    Uses ffmpeg's WSOLA ``atempo`` filter when available (much cleaner vocal
    transients than a basic phase vocoder) and falls back to librosa otherwise.
    Keep the input untouched at the normal rate. Model adapters must not
    receive this value: several accept a speed argument but ignore it.
    """
    if not math.isfinite(speed) or speed <= 0:
        raise ValueError("Speech speed must be finite and positive")
    if abs(speed - 1.0) < 1e-3 or audio.size == 0:
        return audio

    if audio.ndim == 1 and audio.size >= 4096:
        stretched = _stretch_with_ffmpeg(audio, sample_rate, speed)
        if stretched is not None:
            return stretched.astype(audio.dtype, copy=False)

    import librosa

    stretched = librosa.effects.time_stretch(audio.astype(np.float32), rate=speed)
    return stretched.astype(audio.dtype, copy=False)
