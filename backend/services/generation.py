"""
Unified TTS generation orchestration.

Replaces the three near-identical closures (_run_generation, _run_retry,
_run_regenerate) that lived in main.py with a single ``run_generation()``
function parameterized by *mode*.

Mode differences:
  - "generate"   : full pipeline -- save clean version, optionally apply
                    effects and create a processed version.
  - "retry"      : re-runs a failed generation with the same seed/settings,
                    preserving any existing clean or processed versions.
  - "regenerate" : re-runs with seed=None for variation. Creates a clean
                    take plus its effects render, retaining source provenance.
"""

from __future__ import annotations

import asyncio
import logging
import traceback
from typing import Literal, Optional

from .inference_scheduler import check_inference_cancelled, serialized_inference
from .. import config
from . import history, profiles
from ..database import get_db
from ..utils.tasks import get_task_manager


def release_generation_memory(tts_model) -> None:
    """Best-effort post-generation memory cleanup.

    Collects garbage and flushes the device allocator cache so the process heap
    does not grow across consecutive generations (#923). Never raises: a
    cleanup failure (e.g. a poisoned CUDA context) must not replace the
    generation's own result or error.
    """
    from ..backends.base import empty_device_cache, empty_mlx_cache

    try:
        device = getattr(tts_model, "device", None) or getattr(tts_model, "_device", None) or "cpu"
        empty_device_cache(device)
        if tts_model is not None and "mlx" in type(tts_model).__module__.lower():
            empty_mlx_cache()
    except Exception as e:
        logging.getLogger(__name__).debug("post-generation cache cleanup failed: %s", e)


@serialized_inference
async def run_generation(
    *,
    generation_id: str,
    profile_id: str,
    text: str,
    language: str,
    engine: str,
    model_size: str,
    seed: Optional[int],
    normalize: bool = False,
    effects_chain: Optional[list] = None,
    speed: float = 1.0,
    chatterbox_temperature: float | None = None,
    chatterbox_cfg_weight: float | None = None,
    chatterbox_exaggeration: float | None = None,
    instruct: Optional[str] = None,
    mode: Literal["generate", "retry", "regenerate"],
    max_chunk_chars: Optional[int] = None,
    crossfade_ms: Optional[int] = None,
    version_id: Optional[str] = None,
) -> None:
    """Execute TTS inference and persist the result.

    This is the single entry point for all background generation work.
    It is designed to be enqueued via ``services.task_queue.enqueue_generation``.
    """
    from ..backends import (
        engine_needs_trim,
        engine_retries_runaway,
        get_tts_backend_for_engine,
        load_engine_model,
    )
    from ..utils.chunked_tts import generate_chunked
    from ..utils.audio import has_tts_runaway, save_audio, trim_tts_output
    from ..utils.audio_processing import effects_chain_from_config, process_generated_audio

    task_manager = get_task_manager()
    bg_db = next(get_db())
    tts_model = None

    try:
        from ..models import SpeechDeliverySettings

        delivery = SpeechDeliverySettings(
            speed=speed, chatterbox_temperature=chatterbox_temperature,
            chatterbox_cfg_weight=chatterbox_cfg_weight,
            chatterbox_exaggeration=chatterbox_exaggeration,
        )
        generation_options = delivery.chatterbox_options(engine)

        tts_model = get_tts_backend_for_engine(engine)

        if not tts_model.is_loaded():
            await history.update_generation_status(generation_id, "loading_model", bg_db)

        await load_engine_model(engine, model_size)
        check_inference_cancelled()

        voice_prompt = await profiles.create_voice_prompt_for_profile(
            profile_id,
            bg_db,
            use_cache=True,
            engine=engine,
        )

        check_inference_cancelled()
        await history.update_generation_status(generation_id, "generating", bg_db)
        trim_fn = trim_tts_output if engine_needs_trim(engine) else None
        runaway_detector = has_tts_runaway if engine_retries_runaway(engine) else None

        gen_kwargs: dict = dict(
            language=language,
            seed=seed if mode != "regenerate" else None,
            instruct=instruct,
            trim_fn=trim_fn,
            runaway_detector=runaway_detector,
        )
        if generation_options:
            gen_kwargs["generation_options"] = generation_options
        if max_chunk_chars is not None:
            gen_kwargs["max_chunk_chars"] = max_chunk_chars
        if crossfade_ms is not None:
            gen_kwargs["crossfade_ms"] = crossfade_ms

        audio, sample_rate = await generate_chunked(tts_model, text, voice_prompt, **gen_kwargs)

        effects_chain = effects_chain_from_config(effects_chain)
        if effects_chain:
            from ..utils.effects import validate_effects_chain

            error = validate_effects_chain(effects_chain)
            if error:
                logging.getLogger(__name__).warning("invalid effects chain, skipping: %s", error)
                effects_chain = None
        clean_audio, processed_audio = await asyncio.to_thread(
            process_generated_audio, audio, sample_rate,
            normalize=normalize, effects_chain=effects_chain, speed=speed,
        )
        check_inference_cancelled()
        duration = len(processed_audio) / sample_rate

        # --- Persist audio and update status -----------------------------
        if mode == "generate":
            final_path = _save_generate(
                generation_id=generation_id,
                audio=clean_audio,
                processed_audio=processed_audio,
                sample_rate=sample_rate,
                effects_chain=effects_chain,
                save_audio=save_audio,
                db=bg_db,
            )
        elif mode == "retry":
            final_path = _save_retry(
                generation_id=generation_id,
                audio=clean_audio,
                processed_audio=processed_audio,
                sample_rate=sample_rate,
                effects_chain=effects_chain,
                save_audio=save_audio,
                db=bg_db,
            )
        elif mode == "regenerate":
            final_path = _save_regenerate(
                generation_id=generation_id,
                version_id=version_id,
                audio=clean_audio,
                processed_audio=processed_audio,
                sample_rate=sample_rate,
                effects_chain=effects_chain,
                save_audio=save_audio,
                db=bg_db,
            )

        await history.update_generation_status(
            generation_id=generation_id,
            status="completed",
            db=bg_db,
            audio_path=final_path,
            duration=duration,
        )

    except asyncio.CancelledError:
        await history.update_generation_status(
            generation_id=generation_id,
            status="failed",
            db=bg_db,
            error="Generation cancelled",
        )
        _notify_speak_end(generation_id, status="cancelled")
    except Exception as e:
        traceback.print_exc()
        await history.update_generation_status(
            generation_id=generation_id,
            status="failed",
            db=bg_db,
            error=str(e),
        )
        _notify_speak_end(generation_id, status="failed")
    else:
        _notify_speak_end(generation_id, status="completed")
    finally:
        task_manager.complete_generation(generation_id)
        bg_db.close()
        release_generation_memory(tts_model)


def _notify_speak_end(generation_id: str, *, status: str) -> None:
    """Publish a speak-end event; the frontend ignores unknown ids."""
    try:
        from ..mcp_server import events as mcp_events

        mcp_events.publish(
            "speak-end",
            {"generation_id": generation_id, "status": status},
        )
    except Exception:
        # Never let event pub/sub break generation completion.
        pass


def _save_generate(
    *,
    generation_id: str,
    audio,
    processed_audio,
    sample_rate: int,
    effects_chain: Optional[list],
    save_audio,
    db,
    clean_label: str = "original",
    filename_token: Optional[str] = None,
) -> str:
    """Save clean version and optionally an effects-processed version.

    Returns the final audio path (processed if effects were applied,
    otherwise clean).
    """
    from . import versions as versions_mod

    filename = f"{generation_id}_{filename_token}" if filename_token else generation_id
    clean_audio_path = config.get_generations_dir() / f"{filename}.wav"
    save_audio(audio, str(clean_audio_path), sample_rate)

    has_effects = effects_chain and any(e.get("enabled", True) for e in effects_chain)

    clean_version = versions_mod.create_version(
        generation_id=generation_id,
        label=clean_label,
        audio_path=config.to_storage_path(clean_audio_path),
        db=db,
        effects_chain=None,
        is_default=not has_effects,
    )

    final_audio_path = str(clean_audio_path)

    if has_effects:
        processed_path = config.get_generations_dir() / f"{filename}_processed.wav"
        save_audio(processed_audio, str(processed_path), sample_rate)
        final_audio_path = str(processed_path)
        versions_mod.create_version(
            generation_id=generation_id,
            label="version-2" if clean_label == "original" else f"{clean_label}-effects",
            audio_path=config.to_storage_path(processed_path),
            db=db,
            effects_chain=effects_chain,
            source_version_id=clean_version.id,
            is_default=True,
        )

    return config.to_storage_path(final_audio_path)


def _save_retry(
    *,
    generation_id: str,
    audio,
    processed_audio,
    sample_rate: int,
    effects_chain: Optional[list],
    save_audio,
    db,
) -> str:
    """Retry with both clean and processed audio, preserving partial versions."""
    from ..database import GenerationVersion as DBGenerationVersion
    import uuid

    count = db.query(DBGenerationVersion).filter_by(generation_id=generation_id).count()
    return _save_generate(
        generation_id=generation_id,
        audio=audio,
        processed_audio=processed_audio,
        sample_rate=sample_rate,
        effects_chain=effects_chain,
        save_audio=save_audio,
        db=db,
        clean_label=f"retry-{count + 1}" if count else "original",
        filename_token=uuid.uuid4().hex[:12] if count else None,
    )


@serialized_inference
async def generate_audio_sync(
    *,
    profile_id: str,
    text: str,
    language: str,
    engine: str,
    model_size: str,
    seed: Optional[int] = None,
    instruct: Optional[str] = None,
    normalize: bool = True,
    max_chunk_chars: Optional[int] = None,
    crossfade_ms: Optional[int] = None,
    effects_chain: Optional[list] = None,
    speed: float = 1.0,
    chatterbox_temperature: float | None = None,
    chatterbox_cfg_weight: float | None = None,
    chatterbox_exaggeration: float | None = None,
) -> bytes:
    """Run a TTS generation synchronously and return the resulting wav bytes.

    Unlike :func:`run_generation`, this path does not touch the
    ``generations`` table, enqueue work, or write anything to the
    generations directory. It's used by ``POST /profiles/{id}/speak``
    when the caller passes ``persist=false`` — they just want the audio
    back in the HTTP response without polluting their history.

    Loads the engine model on demand, runs ``generate_chunked``, optional
    normalize, then encodes in-memory via :func:`tts.audio_to_wav_bytes`
    (same helper ``/generate/stream`` uses).
    """
    from ..backends import (
        engine_needs_trim,
        engine_retries_runaway,
        get_tts_backend_for_engine,
        load_engine_model,
    )
    from ..utils.chunked_tts import generate_chunked
    from ..utils.audio import has_tts_runaway, trim_tts_output
    from ..utils.audio_processing import effects_chain_from_config, process_generated_audio
    from . import tts

    from ..models import SpeechDeliverySettings

    delivery = SpeechDeliverySettings(
        speed=speed, chatterbox_temperature=chatterbox_temperature,
        chatterbox_cfg_weight=chatterbox_cfg_weight,
        chatterbox_exaggeration=chatterbox_exaggeration,
    )
    generation_options = delivery.chatterbox_options(engine)
    bg_db = next(get_db())
    tts_model = None
    try:
        try:
            tts_model = get_tts_backend_for_engine(engine)
            await load_engine_model(engine, model_size)
            check_inference_cancelled()

            voice_prompt = await profiles.create_voice_prompt_for_profile(
                profile_id,
                bg_db,
                use_cache=True,
                engine=engine,
            )
            check_inference_cancelled()
            if effects_chain is None:
                profile = await profiles.get_profile(profile_id, bg_db)
                effects_chain = effects_chain_from_config(profile.effects_chain if profile else None)
        finally:
            bg_db.close()
        trim_fn = trim_tts_output if engine_needs_trim(engine) else None
        runaway_detector = has_tts_runaway if engine_retries_runaway(engine) else None

        gen_kwargs: dict = dict(
            language=language,
            seed=seed,
            instruct=instruct,
            trim_fn=trim_fn,
            runaway_detector=runaway_detector,
        )
        if generation_options:
            gen_kwargs["generation_options"] = generation_options
        if max_chunk_chars is not None:
            gen_kwargs["max_chunk_chars"] = max_chunk_chars
        if crossfade_ms is not None:
            gen_kwargs["crossfade_ms"] = crossfade_ms

        audio, sample_rate = await generate_chunked(
            tts_model, text, voice_prompt, **gen_kwargs
        )

        _, processed_audio = await asyncio.to_thread(
            process_generated_audio, audio, sample_rate, normalize=normalize, effects_chain=effects_chain, speed=speed
        )
        check_inference_cancelled()
        wav_bytes = await asyncio.to_thread(tts.audio_to_wav_bytes, processed_audio, sample_rate)
        check_inference_cancelled()
        return wav_bytes
    finally:
        if tts_model is not None:
            release_generation_memory(tts_model)


def _save_regenerate(
    *,
    generation_id: str,
    version_id: Optional[str],
    audio,
    processed_audio,
    sample_rate: int,
    effects_chain: Optional[list],
    save_audio,
    db,
) -> str:
    """Save an alternate clean take and its optional effects render."""
    from ..database import GenerationVersion as DBGenerationVersion
    import uuid

    count = db.query(DBGenerationVersion).filter_by(generation_id=generation_id).count()
    return _save_generate(
        generation_id=generation_id,
        audio=audio,
        processed_audio=processed_audio,
        sample_rate=sample_rate,
        effects_chain=effects_chain,
        save_audio=save_audio,
        db=db,
        clean_label=f"take-{count + 1}",
        filename_token=uuid.uuid4().hex[:12],
    )
