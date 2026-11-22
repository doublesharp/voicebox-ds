"""Shared processing order for persisted and immediately returned speech."""

import json
from typing import Any

import numpy as np

from .audio import normalize_audio, protect_audio_peak
from .audio_leveling import level_speech_audio
from .speech_delivery import apply_speed


def effects_chain_from_config(value: Any) -> list[dict[str, Any]] | None:
    """Read stored JSON or the typed effects returned by profile responses."""
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except (ValueError, TypeError):
            return None
    if not isinstance(value, list):
        return None
    result = []
    for effect in value:
        if hasattr(effect, "model_dump"):
            effect = effect.model_dump()
        if not isinstance(effect, dict):
            return None
        result.append(effect)
    return result


def process_generated_audio(
    audio: np.ndarray,
    sample_rate: int,
    *,
    normalize: bool = True,
    effects_chain: list[dict[str, Any]] | None = None,
    speed: float = 1.0,
) -> tuple[np.ndarray, np.ndarray]:
    """Return clean and processed versions using the same output policy.

    Keep the original free of effects, normalize before effects when requested,
    and attenuate hot peaks before either version is encoded as integer PCM.
    Normalization disabled still means no automatic boost to quiet recordings.
    """
    audio = apply_speed(audio, sample_rate, speed)
    clean = normalize_audio(level_speech_audio(audio, sample_rate)) if normalize else protect_audio_peak(audio)
    if not effects_chain or not any(effect.get("enabled", True) for effect in effects_chain):
        return clean, clean

    # Import lazily so requests without effects do not require loading plugins.
    from .effects import apply_effects

    processed = apply_effects(clean.copy(), sample_rate, effects_chain)
    return clean, protect_audio_peak(processed)
