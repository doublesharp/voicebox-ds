"""
Captures service — persists raw audio alongside its STT transcript and,
optionally, an LLM-refined version.

A capture is a single voice input event (dictation, long-form recording, or
uploaded file). Storage mirrors the generations flow: audio lives under
``data/captures/<id>.wav`` and rows live in the ``captures`` table.
"""

import contextlib
import json
import logging
import uuid
from pathlib import Path
from typing import Optional

import soundfile as sf
from sqlalchemy.orm import Session

from .. import config
from ..database import Capture as DBCapture
from ..models import CaptureResponse, RefinementFlagsModel
from ..utils.audio import load_audio
from ..utils.async_work import run_blocking, run_owned
from .refinement import RefinementFlags, refine_transcript
from .transcribe import get_whisper_model

logger = logging.getLogger(__name__)


VALID_SOURCES = {"dictation", "recording", "file"}
# Suffixes whisper's miniaudio loader can read directly. Anything outside
# this set has to go through librosa for decode + a soundfile transcode
# before whisper sees it.
WHISPER_NATIVE_FORMATS = (".wav", ".mp3", ".flac", ".ogg")


def _to_response(row: DBCapture) -> CaptureResponse:
    flags_model: Optional[RefinementFlagsModel] = None
    if row.refinement_flags:
        try:
            flags_model = RefinementFlagsModel(**json.loads(row.refinement_flags))
        except (ValueError, TypeError):
            flags_model = None

    return CaptureResponse(
        id=row.id,
        audio_path=row.audio_path,
        source=row.source,
        language=row.language,
        duration_ms=row.duration_ms,
        transcript_raw=row.transcript_raw or "",
        transcript_refined=row.transcript_refined,
        stt_model=row.stt_model,
        llm_model=row.llm_model,
        refinement_flags=flags_model,
        created_at=row.created_at,
    )


def _prepare_capture_audio(raw_path, suffix, audio_bytes, written_files):
    # The caller retains this ledger until the worker drains, including cancellation.
    with raw_path.open("xb") as output:
        written_files.append(raw_path)
        output.write(audio_bytes)
    try:
        audio, sr = load_audio(str(raw_path))
        duration_ms = int(len(audio) / sr * 1000) if sr else None
    except Exception as decode_err:
        logger.warning("Could not decode capture %s (%s): %r", raw_path.stem, suffix, decode_err)
        audio, sr, duration_ms = None, None, None
    if audio is None or sr is None:
        if suffix not in WHISPER_NATIVE_FORMATS:
            raise ValueError(f"Could not decode {suffix} audio — the recording may be empty or corrupt")
        audio_path = raw_path
    elif suffix == ".wav":
        audio_path = raw_path
    else:
        audio_path = raw_path.with_suffix(".wav")
        with audio_path.open("xb"):
            pass
        written_files.append(audio_path)
        sf.write(str(audio_path), audio, sr, format="WAV")
        with contextlib.suppress(OSError):
            raw_path.unlink()
            written_files.remove(raw_path)
    return audio_path, duration_ms


async def create_capture(
    *,
    audio_bytes: bytes,
    filename: str,
    source: str,
    language: Optional[str],
    stt_model: Optional[str],
    db: Session,
) -> CaptureResponse:
    """Persist raw audio, run STT, store the row."""
    if source not in VALID_SOURCES:
        raise ValueError(f"Invalid source '{source}'. Must be one of {sorted(VALID_SOURCES)}")

    capture_id = str(uuid.uuid4())
    suffix = Path(filename).suffix.lower() or ".wav"
    if suffix not in (".wav", ".mp3", ".m4a", ".flac", ".ogg", ".webm", ".aac", ".opus"):
        suffix = ".wav"

    raw_path = config.get_captures_dir() / f"{capture_id}{suffix}"
    written_files: list[Path] = []

    try:
        audio_path, duration_ms = await run_blocking(
            _prepare_capture_audio, raw_path, suffix, audio_bytes, written_files,
        )

        whisper = get_whisper_model()
        resolved_stt = stt_model or whisper.model_size
        transcript = await run_owned(whisper.transcribe(str(audio_path), language, resolved_stt))

        row = DBCapture(
            id=capture_id,
            audio_path=config.to_storage_path(audio_path),
            source=source,
            language=language,
            duration_ms=duration_ms,
            transcript_raw=transcript,
            stt_model=resolved_stt,
        )
        db.add(row)
        db.commit()
    except BaseException:
        # Anything between the first write and the commit means the audio on
        # disk has no row pointing at it — clean up so data/captures doesn't
        # accumulate orphan blobs across failed transcribes.
        try:
            db.rollback()
        finally:
            for path in written_files:
                try:
                    path.unlink()
                except OSError:
                    pass
        raise

    # The row owns the files after commit, even if refreshing it fails.
    db.refresh(row)
    return _to_response(row)


def list_captures(db: Session, limit: int = 50, offset: int = 0) -> tuple[list[CaptureResponse], int]:
    total = db.query(DBCapture).count()
    rows = (
        db.query(DBCapture)
        .order_by(DBCapture.created_at.desc())
        .limit(limit)
        .offset(offset)
        .all()
    )
    return [_to_response(r) for r in rows], total


def get_capture(capture_id: str, db: Session) -> Optional[CaptureResponse]:
    row = db.query(DBCapture).filter(DBCapture.id == capture_id).first()
    return _to_response(row) if row else None


def delete_capture(capture_id: str, db: Session) -> bool:
    row = db.query(DBCapture).filter(DBCapture.id == capture_id).first()
    if not row:
        return False

    resolved = config.resolve_storage_path(row.audio_path)
    db.delete(row)
    try:
        db.commit()
    except Exception:
        db.rollback()
        raise
    if resolved is not None:
        from .history import _remove_deleted_audio

        _remove_deleted_audio({resolved}, db)
    return True


async def refine_capture(
    capture_id: str,
    flags: RefinementFlags,
    model_size: Optional[str],
    db: Session,
) -> Optional[CaptureResponse]:
    row = db.query(DBCapture).filter(DBCapture.id == capture_id).first()
    if not row:
        return None

    refined, llm_size = await refine_transcript(
        row.transcript_raw or "",
        flags,
        model_size=model_size,
        language=row.language,
    )

    row.transcript_refined = refined
    row.llm_model = llm_size
    row.refinement_flags = json.dumps(flags.to_dict())
    db.commit()
    db.refresh(row)
    return _to_response(row)


async def retranscribe_capture(
    capture_id: str,
    stt_model: Optional[str],
    language: Optional[str],
    db: Session,
    *,
    update_language: bool = False,
) -> Optional[CaptureResponse]:
    row = db.query(DBCapture).filter(DBCapture.id == capture_id).first()
    if not row:
        return None

    resolved = config.resolve_storage_path(row.audio_path)
    if not resolved or not resolved.exists():
        raise FileNotFoundError(f"Audio for capture {capture_id} is missing")

    whisper = get_whisper_model()
    resolved_stt = stt_model or whisper.model_size
    transcript = await whisper.transcribe(str(resolved), language, resolved_stt)

    row.transcript_raw = transcript
    row.stt_model = resolved_stt
    # The transcript now reflects this request, including automatic detection.
    row.language = language
    # Refined text is stale after a fresh STT pass — force a re-refine.
    row.transcript_refined = None
    row.llm_model = None
    row.refinement_flags = None
    db.commit()
    db.refresh(row)
    return _to_response(row)
