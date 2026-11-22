"""Regression tests for consistent speech loudness across and within generated chunks."""

from types import SimpleNamespace

import numpy as np
import pytest

from backend.utils.audio_processing import process_generated_audio
from backend.utils.chunked_tts import generate_chunked

SR = 24000


def _voiced(seconds: float, amplitude: float, freq: float = 180.0) -> np.ndarray:
    """Synthetic speech-like harmonic burst with gentle syllable modulation."""
    t = np.arange(round(SR * seconds), dtype=np.float64) / SR
    syllables = 0.7 + 0.3 * np.sin(2 * np.pi * 3.5 * t) ** 2
    wave = amplitude * syllables * (np.sin(2 * np.pi * freq * t) + 0.35 * np.sin(4 * np.pi * freq * t))
    return wave.astype(np.float32)


def _active_rms(audio: np.ndarray, threshold: float = 1e-3) -> float:
    frame_len = SR // 50  # 20 ms
    n = len(audio) // frame_len
    frames = audio[: n * frame_len].reshape(n, frame_len).astype(np.float64)
    rms = np.sqrt(np.mean(frames**2, axis=1))
    active = rms[rms >= threshold]
    return float(np.sqrt(np.mean(active**2))) if active.size else 0.0


def _db_diff(a: float, b: float) -> float:
    return float(20.0 * np.log10(a / b))


@pytest.mark.asyncio
async def test_generate_chunked_matches_loudness_when_middle_chunk_is_quiet():
    amplitudes = [0.24, 0.06, 0.24]  # middle chunk is -12 dB quieter

    class VaryingBackend:
        def __init__(self):
            self.index = 0

        async def generate(self, text, *_args, **_kwargs):
            amp = amplitudes[self.index]
            self.index += 1
            return _voiced(1.5, amp), SR

    text = "First sentence here. Second sentence here. Third sentence here."
    audio, sr = await generate_chunked(VaryingBackend(), text, {}, max_chunk_chars=24, crossfade_ms=0)
    assert sr == SR

    third = len(audio) // 3
    first_rms = _active_rms(audio[:third])
    middle_rms = _active_rms(audio[third : 2 * third])
    last_rms = _active_rms(audio[2 * third :])

    assert abs(_db_diff(middle_rms, first_rms)) < 1.0
    assert abs(_db_diff(last_rms, first_rms)) < 1.0


@pytest.mark.asyncio
async def test_generate_chunked_matches_loudness_across_pause_segments_without_corrupting_silence():
    amplitudes = [0.24, 0.06, 0.24]

    class VaryingBackend:
        def __init__(self):
            self.index = 0

        async def generate(self, text, *_args, **_kwargs):
            amp = amplitudes[self.index]
            self.index += 1
            return _voiced(1.0, amp), SR

    text = "First part. [pause 250ms] Quiet middle part. [pause 250ms] Final part."
    audio, sr = await generate_chunked(VaryingBackend(), text, {}, crossfade_ms=0)
    assert sr == SR

    seg = SR
    gap = round(0.25 * SR)
    first = audio[:seg]
    pause_one = audio[seg : seg + gap]
    middle = audio[seg + gap : 2 * seg + gap]
    pause_two = audio[2 * seg + gap : 2 * seg + 2 * gap]
    last = audio[2 * seg + 2 * gap :]

    assert np.allclose(pause_one, 0.0)
    assert np.allclose(pause_two, 0.0)
    assert abs(_db_diff(_active_rms(middle), _active_rms(first))) < 1.0
    assert abs(_db_diff(_active_rms(last), _active_rms(first))) < 1.0


@pytest.mark.asyncio
async def test_generate_chunked_matches_loudness_for_runaway_retry_subchunks():
    class RetryBackend:
        def __init__(self):
            self.calls = 0

        async def generate(self, text, *_args, **_kwargs):
            self.calls += 1
            if self.calls == 1:
                return np.concatenate([_voiced(0.5, 0.2), np.zeros(SR, dtype=np.float32), _voiced(0.5, 0.2)]), SR
            amp = 0.24 if self.calls == 2 else 0.06
            return _voiced(1.0, amp), SR

    text = f"{'A' * 119}. {'B' * 119}."
    audio, _ = await generate_chunked(
        RetryBackend(),
        text,
        {},
        max_chunk_chars=800,
        crossfade_ms=0,
        runaway_detector=lambda wav, _sr: len(wav) > SR,
    )
    half = len(audio) // 2
    assert abs(_db_diff(_active_rms(audio[half:]), _active_rms(audio[:half]))) < 1.0


@pytest.mark.asyncio
async def test_chunk_matching_ignores_different_silence_padding_and_prevents_clipping():
    # Both chunks have identical speech loudness (0.20), only different silence lengths.
    chunk_a = _voiced(1.0, 0.20)
    chunk_b = np.concatenate([np.zeros(SR, dtype=np.float32), _voiced(1.0, 0.20), np.zeros(SR, dtype=np.float32)])

    class PaddedBackend:
        def __init__(self):
            self.chunks = [chunk_a, chunk_b]

        async def generate(self, *_args, **_kwargs):
            return self.chunks.pop(0), SR

    audio, _ = await generate_chunked(PaddedBackend(), "First chunk here. Second chunk here.", {}, max_chunk_chars=20, crossfade_ms=0)
    assert abs(_db_diff(_active_rms(audio[: len(chunk_a)]), _active_rms(audio[len(chunk_a) :]))) < 0.5
    assert float(np.max(np.abs(audio))) <= 0.99

    # Quiet chunk with a hot transient must not clip after matching.
    spiky_quiet = _voiced(1.0, 0.05)
    spiky_quiet[SR // 2] = 0.45

    class SpikyBackend:
        def __init__(self):
            self.chunks = [_voiced(1.0, 0.20), spiky_quiet, _voiced(1.0, 0.20)]

        async def generate(self, *_args, **_kwargs):
            return self.chunks.pop(0), SR

    spiky_out, _ = await generate_chunked(
        SpikyBackend(),
        "First sentence here. Second sentence here. Third sentence here.",
        {},
        max_chunk_chars=24,
        crossfade_ms=0,
    )
    assert float(np.max(np.abs(spiky_out))) <= 0.991
    third = len(spiky_out) // 3
    assert abs(_db_diff(_active_rms(spiky_out[third : 2 * third]), _active_rms(spiky_out[:third]))) < 1.0


def test_mlx_variant_collector_matches_loudness_across_internal_chunks():
    from backend.backends.qwen_mlx_variants import _collect_mlx_audio

    results = [
        SimpleNamespace(audio=_voiced(1.0, 0.24), sample_rate=SR),
        SimpleNamespace(audio=_voiced(1.0, 0.06), sample_rate=SR),
        SimpleNamespace(audio=_voiced(1.0, 0.24), sample_rate=SR),
    ]
    audio, sr = _collect_mlx_audio(results)
    assert sr == SR
    third = len(audio) // 3
    assert abs(_db_diff(_active_rms(audio[third : 2 * third]), _active_rms(audio[:third]))) < 1.0


def test_process_generated_audio_levels_sustained_quiet_middle_without_pumping_or_overshoot():
    """Reproduces the waveform shape: loud start, gradual drop into a quiet middle, abrupt jump back up."""
    pause = np.zeros(round(0.25 * SR), dtype=np.float32)

    # 0..6s loud (0.24)
    loud_start = np.concatenate([_voiced(1.8, 0.24), pause, _voiced(1.8, 0.24), pause, _voiced(1.9, 0.24)])
    # 6..7.5s gradual taper from 0.24 -> 0.06
    taper = _voiced(1.5, 1.0) * np.linspace(0.24, 0.06, round(1.5 * SR), dtype=np.float32)
    # 7.5..14s sustained quiet middle (0.06, -12 dB) with natural word pauses
    quiet_mid = np.concatenate(
        [_voiced(1.5, 0.06), pause, _voiced(1.5, 0.06), pause, _voiced(1.5, 0.06), pause, _voiced(1.25, 0.06)]
    )
    # 14..18s abrupt step-jump right back to loud (0.24)
    loud_end = np.concatenate([pause, _voiced(1.8, 0.24), pause, _voiced(1.95, 0.24)])

    source = np.concatenate([loud_start, taper, quiet_mid, loud_end]).astype(np.float32)
    clean, processed = process_generated_audio(source, SR, normalize=True)
    np.testing.assert_array_equal(clean, processed)

    start_rms = _active_rms(clean[: len(loud_start)])
    mid_begin = len(loud_start) + len(taper)
    mid_end = mid_begin + len(quiet_mid)
    mid_rms = _active_rms(clean[mid_begin:mid_end])
    end_rms = _active_rms(clean[mid_end:])

    # Quiet middle should now be leveled close to start & end (was -12 dB before).
    assert abs(_db_diff(mid_rms, start_rms)) < 2.5
    assert abs(_db_diff(end_rms, start_rms)) < 2.0

    # Silent pause inside the quiet section must stay silent (no pumping).
    inner_pause_start = mid_begin + round(1.5 * SR) + round(0.05 * SR)
    inner_pause_end = inner_pause_start + round(0.15 * SR)
    assert float(np.max(np.abs(clean[inner_pause_start:inner_pause_end]))) < 1e-5

    # First 0.5s after the abrupt jump back to loud must not overshoot the steady loud level.
    resumption = clean[mid_end + len(pause) : mid_end + len(pause) + round(0.5 * SR)]
    steady_start_peak = float(np.max(np.abs(clean[: len(loud_start)])))
    assert float(np.max(np.abs(resumption))) <= steady_start_peak * 10 ** (2.0 / 20.0)


def test_process_generated_audio_leaves_uniform_speech_and_unnormalized_audio_intact():
    pause = np.zeros(round(0.2 * SR), dtype=np.float32)
    uniform = np.concatenate([_voiced(1.5, 0.20), pause, _voiced(1.5, 0.20), pause, _voiced(1.5, 0.20)])

    # When normalize=False, quiet middle must NOT be boosted.
    uneven = np.concatenate([_voiced(2.0, 0.24), _voiced(4.0, 0.06), _voiced(2.0, 0.24)])
    unnorm_clean, _ = process_generated_audio(uneven, SR, normalize=False)
    assert _db_diff(_active_rms(unnorm_clean[2 * SR : 6 * SR]), _active_rms(unnorm_clean[: 2 * SR])) < -10.0

    # Uniform speech normalized should match pure scalar normalization closely.
    from backend.utils.audio import normalize_audio

    leveled, _ = process_generated_audio(uniform, SR, normalize=True)
    scalar = normalize_audio(uniform)
    np.testing.assert_allclose(leveled, scalar, atol=1e-5)
