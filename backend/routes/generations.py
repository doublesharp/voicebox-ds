"""TTS generation endpoints."""

import asyncio
import json
import logging
import math
import uuid
from contextlib import aclosing
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from ..services.inference_scheduler import check_inference_cancelled, run_serialized_inference, serialized_inference
from .. import config, models
from ..services import history, personality, profiles, tts
from ..database import Generation as DBGeneration, VoiceProfile as DBVoiceProfile, get_db
from ..services.generation import release_generation_memory, run_generation
from ..services.task_queue import cancel_generation as cancel_generation_job, enqueue_generation
from ..utils.audio import load_audio
from ..utils.tasks import get_task_manager
from ..utils.async_work import run_blocking

logger = logging.getLogger(__name__)

router = APIRouter()

IMPORTED_AUDIO_PROFILE_NAME = "Imported Audio"
IMPORT_AUDIO_EXTENSIONS = {".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac", ".webm"}
IMPORT_AUDIO_MAX_BYTES = 200 * 1024 * 1024  # 200 MB


def _get_or_create_import_profile(db: Session) -> DBVoiceProfile:
    """Singleton profile every imported audio clip points at — keeps the
    Generation FK happy without making profile_id nullable across the schema."""
    row = (
        db.query(DBVoiceProfile)
        .filter(DBVoiceProfile.name == IMPORTED_AUDIO_PROFILE_NAME)
        .first()
    )
    if row is not None:
        return row
    row = DBVoiceProfile(
        id=str(uuid.uuid4()),
        name=IMPORTED_AUDIO_PROFILE_NAME,
        description="External audio imported into a story timeline.",
        language="en",
        voice_type="import",
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def _resolve_generation_engine(data: models.GenerationRequest, profile) -> str:
    return data.engine or profiles.default_engine_for_profile(profile)


def _enqueue_generation_or_recover(generation_id, coro, db, previous_state=None):
    """Do not leave a persisted generation active if admission fails."""
    try:
        enqueue_generation(generation_id, coro)
    except Exception as exc:
        coro.close()
        row = db.query(DBGeneration).filter_by(id=generation_id).first()
        if row is not None:
            if previous_state is None:
                row.status = "failed"
                row.error = "Generation queue unavailable"
            else:
                for field, value in previous_state.items():
                    setattr(row, field, value)
            try:
                db.commit()
            except Exception:
                db.rollback()
                logger.exception("Could not recover generation %s after queue admission failed", generation_id)
        raise HTTPException(status_code=503, detail="Generation queue unavailable") from exc


def _generation_recovery_state(gen):
    return {name: getattr(gen, name) for name in ("status", "error", "audio_path", "duration", "synthesis_config")}


@router.post("/generate", response_model=models.GenerationResponse)
async def generate_speech(
    data: models.GenerationRequest,
    db: Session = Depends(get_db),
):
    """Generate speech from text using a voice profile."""
    task_manager = get_task_manager()
    generation_id = str(uuid.uuid4())

    profile = await profiles.get_profile(data.profile_id, db)
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")

    from ..backends import engine_has_model_sizes, resolve_engine_model_size

    engine = _resolve_generation_engine(data, profile)
    try:
        profiles.validate_profile_engine(profile, engine)
        data.chatterbox_options(engine)
        model_size = resolve_engine_model_size(engine, data.model_size)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    text = data.text
    source = "manual"
    if data.personality and getattr(profile, "personality", None):
        try:
            llm_result = await personality.rewrite_as_profile(profile.personality, data.text)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        text = llm_result.text.strip()
        if not text:
            raise HTTPException(status_code=500, detail="LLM produced empty output; nothing to speak.")
        source = "personality_speak"

    effects_chain_config = None
    if data.effects_chain is not None:
        effects_chain_config = [e.model_dump() for e in data.effects_chain]
    else:
        import json as _json

        profile_obj = db.query(DBVoiceProfile).filter_by(id=data.profile_id).first()
        if profile_obj and profile_obj.effects_chain:
            try:
                effects_chain_config = _json.loads(profile_obj.effects_chain)
            except Exception:
                pass

    synthesis_config = {
        "version": 1,
        "normalize": data.normalize,
        "max_chunk_chars": data.max_chunk_chars,
        "crossfade_ms": data.crossfade_ms,
        "effects_chain": effects_chain_config,
        **{name: getattr(data, name) for name in models.SPEECH_DELIVERY_FIELDS},
    }

    generation = await history.create_generation(
        profile_id=data.profile_id,
        text=text,
        language=data.language,
        audio_path="",
        duration=0,
        seed=data.seed,
        db=db,
        instruct=data.instruct,
        generation_id=generation_id,
        status="generating",
        engine=engine,
        model_size=model_size if engine_has_model_sizes(engine) else None,
        source=source,
        synthesis_config=synthesis_config,
    )

    _enqueue_generation_or_recover(
        generation_id,
        run_generation(
            generation_id=generation_id,
            profile_id=data.profile_id,
            text=text,
            language=data.language,
            engine=engine,
            model_size=model_size,
            seed=data.seed,
            normalize=data.normalize,
            effects_chain=effects_chain_config,
            instruct=data.instruct,
            mode="generate",
            max_chunk_chars=data.max_chunk_chars,
            crossfade_ms=data.crossfade_ms,
            **{name: getattr(data, name) for name in models.SPEECH_DELIVERY_FIELDS},
        ),
        db,
    )
    task_manager.start_generation(task_id=generation_id, profile_id=data.profile_id, text=text)

    return generation


def _replay_synthesis_config(generation: DBGeneration) -> dict:
    """Replay immutable request settings, including explicit False and zero.

    Legacy/imported rows have no recoverable request snapshot. Use the normal
    GenerationRequest defaults and no effects, never the profile's mutable
    current defaults. Persist that choice when the first replay is requested.
    """
    options = {
        name: models.GenerationRequest.model_fields[name].default
        for name in ("normalize", "max_chunk_chars", "crossfade_ms", "effects_chain", *models.SPEECH_DELIVERY_FIELDS)
    }
    saved = getattr(generation, "synthesis_config", None)
    if saved is None:
        return options
    try:
        stored = json.loads(saved)
        if not isinstance(stored, dict) or stored.get("version", 1) != 1:
            raise ValueError("Unsupported synthesis configuration")
        options.update({name: stored[name] for name in options if name in stored})
        if type(options["normalize"]) is not bool:
            raise ValueError("Invalid normalize setting")
        for name, lower, upper in (("max_chunk_chars", 100, 5000), ("crossfade_ms", 0, 500)):
            value = options[name]
            if type(value) is not int or not lower <= value <= upper:
                raise ValueError(f"Invalid {name} setting")
        delivery = models.SpeechDeliverySettings(**{name: options[name] for name in models.SPEECH_DELIVERY_FIELDS})
        delivery.chatterbox_options(generation.engine or "qwen")
        options.update(delivery.model_dump())
        effects = options["effects_chain"]
        if effects is not None and (not isinstance(effects, list) or any(not isinstance(effect, dict) for effect in effects)):
            raise ValueError("Invalid effects settings")
    except (TypeError, ValueError) as error:
        raise HTTPException(status_code=400, detail="Saved generation settings are invalid; create a new generation.") from error
    return options


@router.post("/generate/{generation_id}/retry", response_model=models.GenerationResponse)
async def retry_generation(generation_id: str, db: Session = Depends(get_db)):
    """Retry a failed generation using the same parameters."""
    gen = db.query(DBGeneration).filter_by(id=generation_id).first()
    if not gen:
        raise HTTPException(status_code=404, detail="Generation not found")

    if (gen.status or "completed") != "failed":
        raise HTTPException(status_code=400, detail="Only failed generations can be retried")

    from ..backends import resolve_engine_model_size

    engine_name = gen.engine or "qwen"
    try:
        model_size = resolve_engine_model_size(engine_name, gen.model_size)
    except ValueError:
        model_size = resolve_engine_model_size(engine_name, None)
    synthesis_config = _replay_synthesis_config(gen)
    previous_state = _generation_recovery_state(gen)
    if gen.synthesis_config is None:
        gen.synthesis_config = json.dumps({"version": 1, **synthesis_config})
    gen.status = "generating"
    gen.error = None
    gen.audio_path = ""
    gen.duration = 0
    db.commit()
    db.refresh(gen)

    task_manager = get_task_manager()
    _enqueue_generation_or_recover(
        generation_id,
        run_generation(
            generation_id=generation_id,
            profile_id=gen.profile_id,
            text=gen.text,
            language=gen.language,
            engine=gen.engine or "qwen",
            model_size=model_size,
            seed=gen.seed,
            instruct=gen.instruct,
            **synthesis_config,
            mode="retry",
        ),
        db,
        previous_state,
    )
    task_manager.start_generation(task_id=generation_id, profile_id=gen.profile_id, text=gen.text)

    return models.GenerationResponse.model_validate(gen)


@router.post(
    "/generate/{generation_id}/regenerate",
    response_model=models.GenerationResponse,
)
async def regenerate_generation(generation_id: str, db: Session = Depends(get_db)):
    """Re-run TTS with the same parameters and save the result as a new version."""
    gen = db.query(DBGeneration).filter_by(id=generation_id).first()
    if not gen:
        raise HTTPException(status_code=404, detail="Generation not found")
    if (gen.status or "completed") != "completed":
        raise HTTPException(status_code=400, detail="Generation must be completed to regenerate")

    from ..backends import resolve_engine_model_size

    engine_name = gen.engine or "qwen"
    try:
        model_size = resolve_engine_model_size(engine_name, gen.model_size)
    except ValueError:
        model_size = resolve_engine_model_size(engine_name, None)
    synthesis_config = _replay_synthesis_config(gen)
    previous_state = _generation_recovery_state(gen)
    if gen.synthesis_config is None:
        gen.synthesis_config = json.dumps({"version": 1, **synthesis_config})
    gen.status = "generating"
    gen.error = None
    db.commit()
    db.refresh(gen)

    task_manager = get_task_manager()
    version_id = str(uuid.uuid4())

    _enqueue_generation_or_recover(
        generation_id,
        run_generation(
            generation_id=generation_id,
            profile_id=gen.profile_id,
            text=gen.text,
            language=gen.language,
            engine=gen.engine or "qwen",
            model_size=model_size,
            seed=gen.seed,
            instruct=gen.instruct,
            **synthesis_config,
            mode="regenerate",
            version_id=version_id,
        ),
        db,
        previous_state,
    )
    task_manager.start_generation(task_id=generation_id, profile_id=gen.profile_id, text=gen.text)

    return models.GenerationResponse.model_validate(gen)


@router.post("/generate/{generation_id}/cancel")
async def cancel_generation(generation_id: str, db: Session = Depends(get_db)):
    """Cancel a queued or running generation."""
    gen = db.query(DBGeneration).filter_by(id=generation_id).first()
    if not gen:
        raise HTTPException(status_code=404, detail="Generation not found")

    if (gen.status or "completed") not in ("loading_model", "generating"):
        raise HTTPException(status_code=400, detail="Only active generations can be cancelled")

    cancellation_state = cancel_generation_job(generation_id)
    if cancellation_state is None or cancellation_state == "queued":
        # A worker or another process can finish the row after the initial
        # read. Update only while it is still active, so a late cancellation
        # cannot overwrite a completed recording.
        orphaned = cancellation_state is None
        error = "Generation orphaned by worker" if orphaned else "Generation cancelled"
        changed = (
            db.query(DBGeneration)
            .filter(
                DBGeneration.id == generation_id,
                DBGeneration.status.in_(("loading_model", "generating")),
            )
            .update({DBGeneration.status: "failed", DBGeneration.error: error}, synchronize_session=False)
        )
        if not changed:
            db.rollback()
            raise HTTPException(status_code=409, detail="Generation is no longer active")
        db.commit()
        get_task_manager().complete_generation(generation_id)
        return {"message": "Orphaned generation cleared" if orphaned else "Queued generation cancelled"}

    return {"message": "Generation cancellation requested"}


def _generation_status_snapshot(bind, generation_id):
    # The stream retains only primitive data; no transaction spans its yield.
    with Session(bind=bind) as db:
        gen = db.query(DBGeneration).filter_by(id=generation_id).first()
        if gen is None:
            return {"status": "not_found", "id": generation_id}
        return {
            "id": gen.id,
            "profile_id": gen.profile_id,
            "text": gen.text,
            "status": gen.status or "completed",
            "duration": gen.duration,
            "error": gen.error,
            "source": gen.source,
        }


@router.get("/generate/{generation_id}/status")
async def get_generation_status(generation_id: str, db: Session = Depends(get_db)):
    """SSE status reads own short worker sessions, released before each event."""
    bind = db.get_bind()

    async def event_stream():
        try:
            while True:
                payload = await asyncio.to_thread(_generation_status_snapshot, bind, generation_id)
                yield f"data: {json.dumps(payload)}\n\n"
                if payload["status"] in ("completed", "failed", "not_found"):
                    return
                await asyncio.sleep(1)
        except (BrokenPipeError, ConnectionResetError, asyncio.CancelledError):
            logger.debug("SSE client disconnected for generation %s", generation_id)

    return StreamingResponse(event_stream(), media_type="text/event-stream", headers={
        "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no",
    })


@router.post("/generate/stream")
async def stream_speech(
    data: models.GenerationRequest,
    db: Session = Depends(get_db),
    incremental: bool = False,
):
    """Return mastered WAV, or opt into bounded incremental preview delivery.

    ``incremental=true`` requires ``normalize=false`` and no enabled effects.
    Preview uses text groups of at most 240 characters and an unknown-length
    PCM WAV header; buffered mode preserves full-file processing and headers.
    """
    if incremental:
        return await _incremental_speech(data, db)
    return await _buffered_speech(data, db)


async def _incremental_speech(data: models.GenerationRequest, db: Session):
    from ..backends import (
        engine_needs_trim, engine_retries_runaway, ensure_model_cached_or_raise,
        get_tts_backend_for_engine, load_engine_model,
    )
    from ..utils.audio import has_tts_runaway, trim_tts_output
    from ..utils.audio_processing import effects_chain_from_config
    from ..utils.streaming_audio import iter_speech_audio, pcm16_bytes, serialized_byte_stream, streaming_wav_header

    profile = await profiles.get_profile(data.profile_id, db)
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")
    chain = (
        [effect.model_dump() for effect in data.effects_chain]
        if data.effects_chain is not None else effects_chain_from_config(profile.effects_chain)
    )
    if (data.normalize or any(effect.get("enabled", True) for effect in chain or [])
            or data.speed != 1.0
            or any(getattr(data, name) is not None for name in models.SPEECH_DELIVERY_FIELDS[1:])):
        raise HTTPException(
            status_code=400,
            detail="Incremental preview requires normalize=false, speed=1, default delivery, and no enabled effects; use effects_chain=[] "
                   "to override profile effects. Buffered mode supports whole-file mastering.",
        )
    from ..backends import resolve_engine_model_size

    engine = _resolve_generation_engine(data, profile)
    try:
        profiles.validate_profile_engine(profile, engine)
        data.chatterbox_options(engine)
        model_size = resolve_engine_model_size(engine, data.model_size) or "default"
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    await ensure_model_cached_or_raise(engine, model_size)
    # Own a session for the response lifetime, independently of FastAPI's
    # dependency teardown policy while waiting for another inference request.
    bind = db.get_bind()

    async def produce(send):
        backend = get_tts_backend_for_engine(engine)
        try:
            await load_engine_model(engine, model_size)
            check_inference_cancelled()
            with Session(bind=bind) as stream_db:
                prompt = await profiles.create_voice_prompt_for_profile(data.profile_id, stream_db, engine=engine)
            first = True
            async with aclosing(iter_speech_audio(
                backend, data.text, prompt, language=data.language, seed=data.seed,
                instruct=data.instruct, max_chunk_chars=min(data.max_chunk_chars, 240),
                crossfade_ms=data.crossfade_ms,
                trim_fn=trim_tts_output if engine_needs_trim(engine) else None,
                runaway_detector=has_tts_runaway if engine_retries_runaway(engine) else None,
            )) as audio_stream:
                async for audio, rate in audio_stream:
                    if first:
                        await send(streaming_wav_header(rate))
                        first = False
                    await send(pcm16_bytes(audio))
        finally:
            release_generation_memory(backend)

    return StreamingResponse(
        serialized_byte_stream(produce), media_type="audio/wav",
        headers={
            "Content-Disposition": 'inline; filename="speech-preview.wav"',
            "Cache-Control": "no-store", "X-Accel-Buffering": "no",
            "X-Voicebox-Audio-Mode": "incremental-preview",
        },
    )


@serialized_inference
async def _buffered_speech(
    data: models.GenerationRequest,
    db: Session,
):
    """Generate speech and stream the WAV audio directly without saving to disk."""
    from ..backends import (
        engine_needs_trim,
        engine_retries_runaway,
        ensure_model_cached_or_raise,
        get_tts_backend_for_engine,
        load_engine_model,
    )

    profile = await profiles.get_profile(data.profile_id, db)
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")

    from ..backends import resolve_engine_model_size

    engine = _resolve_generation_engine(data, profile)
    try:
        profiles.validate_profile_engine(profile, engine)
        generation_options = data.chatterbox_options(engine)
        model_size = resolve_engine_model_size(engine, data.model_size) or "default"
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    tts_model = get_tts_backend_for_engine(engine)

    await ensure_model_cached_or_raise(engine, model_size)
    try:
        await load_engine_model(engine, model_size)
        check_inference_cancelled()

        voice_prompt = await profiles.create_voice_prompt_for_profile(
            data.profile_id,
            db,
            engine=engine,
        )

        from ..utils.chunked_tts import generate_chunked

        trim_fn = None
        runaway_detector = None
        if engine_needs_trim(engine):
            from ..utils.audio import trim_tts_output

            trim_fn = trim_tts_output
        if engine_retries_runaway(engine):
            from ..utils.audio import has_tts_runaway

            runaway_detector = has_tts_runaway

        audio, sample_rate = await generate_chunked(
            tts_model,
            data.text,
            voice_prompt,
            language=data.language,
            seed=data.seed,
            instruct=data.instruct,
            max_chunk_chars=data.max_chunk_chars,
            crossfade_ms=data.crossfade_ms,
            trim_fn=trim_fn,
            runaway_detector=runaway_detector,
            **({"generation_options": generation_options} if generation_options else {}),
        )
    finally:
        release_generation_memory(tts_model)

    from ..utils.audio_processing import effects_chain_from_config, process_generated_audio

    effects_chain_config = None
    if data.effects_chain is not None:
        effects_chain_config = [e.model_dump() for e in data.effects_chain]
    else:
        effects_chain_config = effects_chain_from_config(profile.effects_chain)

    _, audio = await asyncio.to_thread(
        process_generated_audio, audio, sample_rate, normalize=data.normalize, effects_chain=effects_chain_config, speed=data.speed
    )

    check_inference_cancelled()
    wav_bytes = await asyncio.to_thread(tts.audio_to_wav_bytes, audio, sample_rate)
    check_inference_cancelled()

    async def _wav_stream():
        try:
            chunk_size = 64 * 1024
            for i in range(0, len(wav_bytes), chunk_size):
                yield wav_bytes[i : i + chunk_size]
        except (BrokenPipeError, ConnectionResetError, asyncio.CancelledError):
            logger.debug("Client disconnected during audio stream")

    return StreamingResponse(
        _wav_stream(),
        media_type="audio/wav",
        headers={"Content-Disposition": 'attachment; filename="speech.wav"'},
    )


@router.post("/generate/import", response_model=models.GenerationResponse)
async def import_audio(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    """Register an external audio file as a generation row.

    Designed for the story timeline so users can drop in music or other
    non-TTS audio. The row points at a singleton "Imported Audio" profile
    so the existing generation/story plumbing keeps working unchanged."""
    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in IMPORT_AUDIO_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported audio format '{suffix}'. Allowed: {sorted(IMPORT_AUDIO_EXTENSIONS)}",
        )

    generation_id = str(uuid.uuid4())
    target = config.get_generations_dir() / f"{generation_id}{suffix}"
    owned_file = False
    history_started = False
    try:
        # Never overwrite an existing generation, and stream the upload so
        # the size limit does not require buffering the whole file in RAM.
        with target.open("xb") as output:
            owned_file = True
            total = 0
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > IMPORT_AUDIO_MAX_BYTES:
                    raise HTTPException(
                        status_code=413,
                        detail=f"File exceeds {IMPORT_AUDIO_MAX_BYTES // (1024 * 1024)} MB limit.",
                    )
                output.write(chunk)
        if not total:
            raise HTTPException(status_code=400, detail="Empty audio file.")

        try:
            audio, sr = await run_blocking(load_audio, str(target))
            duration = float(len(audio) / sr) if sr else 0.0
            if not math.isfinite(duration) or duration <= 0:
                raise ValueError("Audio has no playable duration")
        except Exception as decode_err:
            raise HTTPException(
                status_code=400,
                detail=f"Could not decode audio: {decode_err}",
            ) from decode_err

        profile = _get_or_create_import_profile(db)
        display_name = Path(file.filename or "Imported audio").stem or "Imported audio"
        stored_path = config.to_storage_path(target)
        history_started = True
        generation = await history.create_generation(
            profile_id=profile.id,
            text=display_name,
            language="en",
            audio_path=stored_path,
            duration=duration,
            seed=None,
            db=db,
            generation_id=generation_id,
            status="completed",
            engine="import",
            model_size=None,
            source="import",
        )
        from ..services import versions as versions_mod

        versions_mod.create_version(
            generation_id=generation_id,
            label="original",
            audio_path=stored_path,
            db=db,
            effects_chain=None,
            is_default=True,
        )
        return generation
    except BaseException:
        if owned_file:
            # A failure can happen after history committed. Only remove audio
            # when a fresh read confirms that no generation references it.
            remove_file = not history_started
            if history_started:
                try:
                    db.rollback()
                    with Session(bind=db.get_bind()) as check_db:
                        remove_file = check_db.query(DBGeneration).filter_by(id=generation_id).first() is None
                except Exception:
                    logger.exception("Could not verify imported audio ownership after failure")
            if remove_file:
                try:
                    target.unlink(missing_ok=True)
                except OSError:
                    logger.exception("Could not remove failed audio import %s", target)
        raise
