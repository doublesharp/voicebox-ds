"""Generation history endpoints."""

import asyncio
import io
import os
import tempfile
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, Response, StreamingResponse
from sqlalchemy.orm import Session

from .. import config, models
from ..services import export_import, history
from ..utils.ffmpeg import encode_audio
from ..utils.http import safe_content_disposition
from ..utils.upload import copy_bounded_upload
from ..database import Generation as DBGeneration, VoiceProfile as DBVoiceProfile, get_db

router = APIRouter()

HISTORY_IMPORT_MAX_BYTES = 50 * 1024 * 1024
HISTORY_UPLOAD_CHUNK_BYTES = 1024 * 1024


@router.get("/history", response_model=models.HistoryListResponse)
async def list_history(
    profile_id: str | None = None,
    search: str | None = None,
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    cursor: str | None = Query(default=None, max_length=2048),
    include_total: bool = True,
    db: Session = Depends(get_db),
):
    """List generation history with optional filters."""
    query = models.HistoryQuery(
        profile_id=profile_id,
        search=search,
        limit=limit,
        offset=offset,
        cursor=cursor,
        include_total=include_total,
    )
    try:
        return await history.list_generations(query, db)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@router.get("/history/stats")
async def get_stats(db: Session = Depends(get_db)):
    """Get generation statistics."""
    return await history.get_generation_stats(db)


@router.post("/history/import")
async def import_generation(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    """Import a generation from a ZIP archive."""
    content = io.BytesIO()
    await copy_bounded_upload(
        file, content, HISTORY_IMPORT_MAX_BYTES, chunk_size=HISTORY_UPLOAD_CHUNK_BYTES, status=400,
        detail=f"File too large. Maximum size is {HISTORY_IMPORT_MAX_BYTES / (1024 * 1024)}MB",
    )

    try:
        result = await export_import.import_generation_from_zip(content.getvalue(), db)
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/history/failed")
async def clear_failed_generations(db: Session = Depends(get_db)):
    """Delete every generation with status='failed'. Used by the UI's 'Clear failed' button (#410)."""
    count = await history.delete_failed_generations(db)
    return {"deleted": count}


@router.get("/history/{generation_id}", response_model=models.HistoryResponse)
async def get_generation(
    generation_id: str,
    db: Session = Depends(get_db),
):
    """Get a generation by ID."""
    result = (
        db.query(DBGeneration, DBVoiceProfile.name.label("profile_name"))
        .join(DBVoiceProfile, DBGeneration.profile_id == DBVoiceProfile.id)
        .filter(DBGeneration.id == generation_id)
        .first()
    )

    if not result:
        raise HTTPException(status_code=404, detail="Generation not found")

    gen, profile_name = result
    from ..services import versions as versions_mod

    gen_versions = versions_mod.list_versions(gen.id, db)
    active_version = next((v for v in gen_versions if v.is_default), None)
    return models.HistoryResponse(
        id=gen.id,
        profile_id=gen.profile_id,
        profile_name=profile_name,
        text=gen.text,
        language=gen.language,
        audio_path=gen.audio_path,
        duration=gen.duration,
        seed=gen.seed,
        instruct=gen.instruct,
        engine=gen.engine or "qwen",
        model_size=gen.model_size,
        status=gen.status or "completed",
        error=gen.error,
        is_favorited=bool(gen.is_favorited),
        created_at=gen.created_at,
        versions=gen_versions if gen_versions else None,
        active_version_id=active_version.id if active_version else None,
    )


@router.post("/history/{generation_id}/favorite")
async def toggle_favorite(
    generation_id: str,
    db: Session = Depends(get_db),
):
    """Toggle the favorite status of a generation."""
    gen = db.query(DBGeneration).filter_by(id=generation_id).first()
    if not gen:
        raise HTTPException(status_code=404, detail="Generation not found")
    gen.is_favorited = not gen.is_favorited
    db.commit()
    return {"is_favorited": gen.is_favorited}


@router.delete("/history/{generation_id}")
async def delete_generation(
    generation_id: str,
    db: Session = Depends(get_db),
):
    """Delete a generation."""
    success = await history.delete_generation(generation_id, db)
    if not success:
        raise HTTPException(status_code=404, detail="Generation not found")
    return {"message": "Generation deleted successfully"}


@router.get("/history/{generation_id}/export")
async def export_generation(
    generation_id: str,
    db: Session = Depends(get_db),
):
    """Export a generation as a ZIP archive."""
    generation = db.query(DBGeneration).filter_by(id=generation_id).first()
    if not generation:
        raise HTTPException(status_code=404, detail="Generation not found")

    try:
        zip_bytes = export_import.export_generation_to_zip(generation_id, db)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    safe_text = "".join(c for c in generation.text[:30] if c.isalnum() or c in (" ", "-", "_")).strip()
    if not safe_text:
        safe_text = "generation"
    # Append a short id so exports of similarly-worded generations don't collide
    # on the same filename (the first 30 chars are frequently identical).
    filename = f"generation-{safe_text}-{generation_id[:8]}.voicebox.zip"

    return StreamingResponse(
        io.BytesIO(zip_bytes),
        media_type="application/zip",
        headers={"Content-Disposition": safe_content_disposition("attachment", filename)},
    )


_EXPORT_MIME = {"wav": "audio/wav", "mp3": "audio/mpeg"}


@router.get("/history/{generation_id}/export-audio")
async def export_generation_audio(
    generation_id: str,
    format_: str = Query("wav", alias="format"),
    db: Session = Depends(get_db),
):
    """Export only the audio file from a generation.

    ``format=wav`` (default) returns the stored file unchanged; ``format=mp3``
    transcodes it with ffmpeg (160 kbps) and returns 503 when ffmpeg is missing.
    """
    fmt = (format_ or "wav").lower()
    if fmt not in _EXPORT_MIME:
        raise HTTPException(status_code=400, detail=f"Unsupported format: {format_}")

    generation = db.query(DBGeneration).filter_by(id=generation_id).first()
    if not generation:
        raise HTTPException(status_code=404, detail="Generation not found")

    if not generation.audio_path:
        raise HTTPException(status_code=404, detail="Generation has no audio file")

    audio_path = config.resolve_storage_path(generation.audio_path)
    if audio_path is None or not audio_path.is_file():
        raise HTTPException(status_code=404, detail="Audio file not found")

    safe_text = "".join(c for c in generation.text[:30] if c.isalnum() or c in (" ", "-", "_")).strip()
    if not safe_text:
        safe_text = "generation"
    # Append a short id so exports of similarly-worded generations don't collide
    # on the same filename (the first 30 chars are frequently identical).
    filename = f"{safe_text}-{generation_id[:8]}.{fmt}"
    headers = {"Content-Disposition": safe_content_disposition("attachment", filename)}

    if fmt == "wav":
        if audio_path.suffix.lower() == ".wav":
            return FileResponse(audio_path, media_type="audio/wav", headers=headers)
        # Non-WAV imported audio (e.g. .mp3, .flac, .ogg): decode and emit real WAV bytes.
        from ..utils.audio import load_audio, save_audio

        fd, tmp_name = tempfile.mkstemp(suffix=".wav")
        os.close(fd)
        tmp_path = Path(tmp_name)
        try:
            def _to_wav() -> bytes:
                samples, sr = load_audio(str(audio_path), sample_rate=None)
                save_audio(samples, str(tmp_path), sr)
                return tmp_path.read_bytes()

            wav_bytes = await asyncio.to_thread(_to_wav)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to convert audio to WAV: {e}") from e
        finally:
            tmp_path.unlink(missing_ok=True)
        return Response(content=wav_bytes, media_type="audio/wav", headers=headers)

    fd, tmp_name = tempfile.mkstemp(suffix=".mp3")
    os.close(fd)
    tmp_path = Path(tmp_name)
    try:
        # ffmpeg is CPU-bound; keep it off the event loop.
        await asyncio.to_thread(encode_audio, audio_path, tmp_path, fmt)
        mp3_bytes = tmp_path.read_bytes()
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    finally:
        tmp_path.unlink(missing_ok=True)

    return Response(content=mp3_bytes, media_type=_EXPORT_MIME[fmt], headers=headers)
