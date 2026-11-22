"""Pure-NumPy speech loudness consistency helpers.

Keeps multi-chunk TTS generations and long single-chunk utterances from
drifting into noticeably quieter passages while preserving pauses,
headroom, and natural syllable dynamics.
"""

from __future__ import annotations

import math
from collections.abc import Sequence

import numpy as np


def _moving_sum(values: np.ndarray, half_window: int) -> np.ndarray:
    """Centered sliding sum without zero-padding dilution at the edges."""
    n = len(values)
    cumsum = np.empty(n + 1, dtype=np.float64)
    cumsum[0] = 0.0
    np.cumsum(values, dtype=np.float64, out=cumsum[1:])
    idx = np.arange(n)
    lo = np.maximum(0, idx - half_window)
    hi = np.minimum(n, idx + half_window + 1)
    return cumsum[hi] - cumsum[lo]


def _frame_rms(audio: np.ndarray, frame_len: int) -> np.ndarray:
    """Per-frame RMS in float64, including any trailing partial frame."""
    n_samples = len(audio)
    n_frames = (n_samples + frame_len - 1) // frame_len
    padded = np.pad(audio.astype(np.float64, copy=False), (0, n_frames * frame_len - n_samples))
    frames = padded.reshape(n_frames, frame_len)
    counts = np.full(n_frames, frame_len, dtype=np.float64)
    counts[-1] = n_samples - (n_frames - 1) * frame_len
    return np.sqrt(np.sum(frames**2, axis=1) / counts)


def _active_speech_rms(
    audio: np.ndarray,
    sample_rate: int,
    *,
    frame_ms: int = 20,
    silence_floor_db: float = -55.0,
    relative_gate_db: float = -20.0,
    min_active_ms: int = 100,
) -> float | None:
    """Measure active-speech RMS ignoring pauses and silence padding."""
    if audio.ndim != 1 or audio.size == 0:
        return None
    frame_len = max(1, int(sample_rate * frame_ms / 1000))
    if audio.size < frame_len:
        return None

    rms = _frame_rms(audio, frame_len)
    peak_rms = float(np.max(rms))
    abs_floor = 10.0 ** (silence_floor_db / 20.0)
    if peak_rms < abs_floor:
        return None

    threshold = max(abs_floor, peak_rms * (10.0 ** (relative_gate_db / 20.0)))
    active = rms[rms >= threshold]
    min_frames = max(1, round(min_active_ms / frame_ms))
    if active.size < min_frames:
        return None
    return float(np.sqrt(np.mean(active**2)))


def match_chunk_loudness(
    chunks: Sequence[np.ndarray],
    sample_rate: int,
    *,
    frame_ms: int = 20,
    silence_floor_db: float = -55.0,
    relative_gate_db: float = -20.0,
    min_active_ms: int = 100,
    max_boost_db: float = 18.0,
    max_cut_db: float = 18.0,
    peak_limit: float = 0.99,
) -> list[np.ndarray]:
    """Match active-speech RMS across independently synthesized chunks.

    Chunks that are silent or shorter than ``min_active_ms`` are left
    untouched. If matching any quiet chunk would push a transient peak over
    ``peak_limit``, all chunks are attenuated together so relative loudness
    remains aligned without clipping.
    """
    arrays = [np.asarray(chunk, dtype=np.float32) for chunk in chunks]
    if len(arrays) <= 1 or sample_rate <= 0:
        return arrays

    measured: list[float | None] = []
    for chunk in arrays:
        if chunk.size and not np.isfinite(chunk).all():
            return arrays
        measured.append(
            _active_speech_rms(
                chunk,
                sample_rate,
                frame_ms=frame_ms,
                silence_floor_db=silence_floor_db,
                relative_gate_db=relative_gate_db,
                min_active_ms=min_active_ms,
            )
        )

    valid_rms = [value for value in measured if value is not None and value > 0.0]
    if len(valid_rms) < 2:
        return arrays

    target_rms = float(np.exp(np.median(np.log(np.asarray(valid_rms, dtype=np.float64)))))
    min_gain = 10.0 ** (-max_cut_db / 20.0)
    max_gain = 10.0 ** (max_boost_db / 20.0)

    gains: list[float] = []
    any_adjusted = False
    for value in measured:
        if value is None or value <= 0.0:
            gains.append(1.0)
            continue
        gain = float(np.clip(target_rms / value, min_gain, max_gain))
        if abs(gain - 1.0) > 1e-4:
            any_adjusted = True
        gains.append(gain)

    if not any_adjusted:
        return arrays

    scaled = [chunk * np.float32(gain) if gain != 1.0 else chunk for chunk, gain in zip(arrays, gains, strict=True)]
    max_peak = max((float(np.max(np.abs(chunk))) for chunk in scaled if chunk.size), default=0.0)
    if max_peak > peak_limit > 0.0:
        headroom_scale = np.float32(peak_limit / max_peak)
        scaled = [chunk * headroom_scale for chunk in scaled]
    return scaled


def level_speech_audio(
    audio: np.ndarray,
    sample_rate: int,
    *,
    frame_ms: int = 20,
    window_ms: int = 1500,
    short_window_ms: int = 200,
    min_duration_s: float = 2.0,
    min_active_s: float = 1.5,
    deadzone_db: float = 1.0,
    knee_db: float = 1.0,
    max_boost_db: float = 15.0,
    max_cut_db: float = 12.0,
    attack_ms: float = 40.0,
    release_ms: float = 300.0,
    lookahead_ms: float = 40.0,
) -> np.ndarray:
    """Smoothly recover sustained loudness drops within a spoken clip.

    Measures local loudness over active speech frames only, interpolates gain
    across pauses so silence is never pumped, leaves small natural phrasing
    variations (within ``deadzone_db``) untouched, and caps boost using a
    short-window detector with lookahead so sudden loud resumptions never
    overshoot.
    """
    audio = np.asarray(audio, dtype=np.float32)
    if not np.isfinite(audio).all():
        raise ValueError("Audio samples must be finite")
    if sample_rate <= 0:
        raise ValueError("Sample rate must be positive")
    if audio.ndim != 1 or audio.size == 0:
        return audio.copy()
    if audio.size < int(sample_rate * min_duration_s):
        return audio.copy()

    frame_len = max(1, int(sample_rate * frame_ms / 1000))
    rms = _frame_rms(audio, frame_len)
    n_frames = len(rms)

    nonzero = rms[rms > 1e-6]
    min_active_frames = max(2, round(min_active_s * 1000.0 / frame_ms))
    if nonzero.size < min_active_frames:
        return audio.copy()

    # Scale-invariant voice activity threshold (28 dB below 90th-percentile speech)
    # retains passages that dropped 10-18 dB while excluding pauses and floor noise.
    p90 = float(np.percentile(nonzero, 90))
    speech_thresh = max(1e-5, p90 * (10.0 ** (-28.0 / 20.0)))
    is_active = rms >= speech_thresh
    if int(np.count_nonzero(is_active)) < min_active_frames:
        return audio.copy()

    active_energy = np.where(is_active, rms**2, 0.0)
    active_mask = is_active.astype(np.float64)

    half_long = max(1, round(window_ms / (2.0 * frame_ms)))
    sum_e_long = _moving_sum(active_energy, half_long)
    sum_c_long = _moving_sum(active_mask, half_long)
    min_window_frames = max(2, round(150.0 / frame_ms))
    valid = sum_c_long >= min_window_frames
    if int(np.count_nonzero(valid)) < 2:
        return audio.copy()

    long_rms = np.zeros(n_frames, dtype=np.float64)
    long_rms[valid] = np.sqrt(sum_e_long[valid] / sum_c_long[valid])

    half_short = max(0, round(short_window_ms / (2.0 * frame_ms)))
    sum_e_short = _moving_sum(active_energy, half_short)
    sum_c_short = _moving_sum(active_mask, half_short)
    short_rms = np.zeros(n_frames, dtype=np.float64)
    short_valid = sum_c_short > 0.0
    short_rms[short_valid] = np.sqrt(sum_e_short[short_valid] / sum_c_short[short_valid])

    target_rms = float(np.exp(np.median(np.log(long_rms[valid]))))
    if target_rms <= 0.0 or not math.isfinite(target_rms):
        return audio.copy()

    error_db = 20.0 * np.log10(target_rms / long_rms[valid])
    abs_err = np.abs(error_db)
    mag = np.zeros_like(abs_err)
    in_knee = (abs_err > deadzone_db) & (abs_err < deadzone_db + knee_db)
    above_knee = abs_err >= deadzone_db + knee_db
    if knee_db > 0.0:
        mag[in_knee] = ((abs_err[in_knee] - deadzone_db) ** 2) / (2.0 * knee_db)
    mag[above_knee] = abs_err[above_knee] - deadzone_db - 0.5 * knee_db
    valid_corr_db = np.clip(np.sign(error_db) * mag, -max_cut_db, max_boost_db)

    # Interpolate smoothly across silent gaps so pauses are never pumped.
    frame_indices = np.arange(n_frames, dtype=np.float64)
    valid_indices = np.flatnonzero(valid).astype(np.float64)
    corr_db = np.interp(frame_indices, valid_indices, valid_corr_db)

    # Cap positive boost whenever the short window is already loud so abrupt
    # loud resumptions do not overshoot target_rms.
    boost_short = short_valid & (corr_db > 0.0) & (short_rms > 0.0)
    if np.any(boost_short):
        max_short_db = np.maximum(0.0, 20.0 * np.log10(target_rms / short_rms[boost_short]))
        corr_db[boost_short] = np.minimum(corr_db[boost_short], max_short_db)

    # Short lookahead prevents transients at sudden loud jumps from clipping
    # before the attack smoother catches up.
    lookahead_frames = max(0, round(lookahead_ms / frame_ms))
    if lookahead_frames > 0 and n_frames > 1:
        looked = corr_db.copy()
        for shift in range(1, min(lookahead_frames, n_frames - 1) + 1):
            looked[:-shift] = np.minimum(looked[:-shift], corr_db[shift:])
        corr_db = looked

    alpha_attack = 1.0 - math.exp(-frame_ms / max(attack_ms, 1e-3))
    alpha_release = 1.0 - math.exp(-frame_ms / max(release_ms, 1e-3))
    smoothed_db = np.empty(n_frames, dtype=np.float64)
    state = float(corr_db[0])
    smoothed_db[0] = state
    for i in range(1, n_frames):
        target = float(corr_db[i])
        alpha = alpha_attack if target < state else alpha_release
        state += alpha * (target - state)
        smoothed_db[i] = state

    if float(np.max(np.abs(smoothed_db))) < 1e-4:
        return audio.copy()

    frame_gain = 10.0 ** (smoothed_db / 20.0)
    n_samples = len(audio)
    centers = np.minimum(frame_indices * frame_len + 0.5 * frame_len, n_samples - 1)
    sample_gain = np.interp(np.arange(n_samples, dtype=np.float64), centers, frame_gain)
    return (audio.astype(np.float64) * sample_gain).astype(np.float32)
