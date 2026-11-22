"""YouTube chapter timestamps and NLE timeline marker exports (FCPXML / Resolve CSV)."""

from __future__ import annotations

import csv
import io
import math
import re
import xml.etree.ElementTree as ET
from fractions import Fraction

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response

from .captions import _sources
from .storage import NotFound


def _first_label(text: str, max_chars: int = 72) -> str:
    cleaned = " ".join(text.split())
    if not cleaned:
        return "Section"
    first = re.split(r"(?<=[.!?])\s+", cleaned, maxsplit=1)[0]
    first = first.rstrip(".!?").strip()
    if len(first) <= max_chars:
        return first
    cut = first[: max_chars - 1].rsplit(" ", 1)[0] or first[: max_chars - 1]
    return cut.rstrip(",;:- ") + "…"


def format_youtube_time(seconds: float, *, force_hours: bool = False) -> str:
    total = max(0, int(round(seconds)))
    hours, rem = divmod(total, 3600)
    minutes, secs = divmod(rem, 60)
    if hours > 0 or force_hours:
        return f"{hours}:{minutes:02d}:{secs:02d}"
    return f"{minutes:02d}:{secs:02d}"


def format_smpte(seconds: float, fps: float) -> str:
    nominal = max(1, int(round(fps)))
    total_frames = max(0, int(round(seconds * nominal)))
    frames = total_frames % nominal
    total_seconds = total_frames // nominal
    secs = total_seconds % 60
    total_minutes = total_seconds // 60
    mins = total_minutes % 60
    hours = total_minutes // 60
    return f"{hours:02d}:{mins:02d}:{secs:02d}:{frames:02d}"


def extract_chapters(doc: dict, assets, takes) -> list[dict]:
    """Build ordered chapter markers from audible clips and passage chapter headings.

    If any placed passage carries an explicit ``chapter`` heading, chapters are
    emitted at the first audible clip of each headed passage. Otherwise each
    distinct placed passage becomes a chapter titled from its opening sentence.
    """
    sources = sorted(
        _sources(doc, assets, takes),
        key=lambda item: (item["clip"]["start_sample"], item["clip"]["id"]),
    )
    if not sources:
        return []
    rate = doc["sample_rate"]
    has_explicit = any(
        item["passage"] and isinstance(item["passage"].get("chapter"), str) and item["passage"]["chapter"].strip()
        for item in sources
    )
    seen_passages: set[str] = set()
    chapters: list[dict] = []
    for item in sources:
        passage = item["passage"]
        clip = item["clip"]
        if passage is None:
            continue
        pid = passage["id"]
        if pid in seen_passages:
            continue
        explicit = passage.get("chapter")
        if has_explicit:
            if not isinstance(explicit, str) or not explicit.strip():
                continue
            title = explicit.strip()
        else:
            title = _first_label(passage.get("text") or item["text"])
        seen_passages.add(pid)
        start_sample = int(clip["start_sample"])
        chapters.append(
            {
                "passage_id": pid,
                "clip_id": clip["id"],
                "title": title,
                "start_sample": start_sample,
                "start_seconds": start_sample / rate,
            }
        )
    if not chapters:
        return []
    total_seconds = max(
        (item["clip"]["start_sample"] + item["length"]) / rate for item in sources
    )
    force_hours = total_seconds >= 3600
    for chapter in chapters:
        chapter["timestamp"] = format_youtube_time(chapter["start_seconds"], force_hours=force_hours)
    return chapters


def format_youtube_chapters(chapters: list[dict]) -> str:
    if not chapters:
        return ""
    lines = []
    # YouTube requires the first chapter to begin at 00:00.
    first = chapters[0]
    if first["start_seconds"] >= 1.0:
        prefix = "0:00:00" if first["timestamp"].count(":") == 2 else "00:00"
        lines.append(f"{prefix} Intro")
    for chapter in chapters:
        lines.append(f"{chapter['timestamp']} {chapter['title']}")
    return "\n".join(lines) + "\n"


def _fcpxml_rational(seconds: float, fps: float) -> str:
    frac = Fraction(fps).limit_denominator(1001)
    # Express time in frame-aligned rational seconds (e.g. 1001/30000s for 29.97fps).
    frame_duration = Fraction(1, 1) / frac
    frames = max(0, int(round(seconds / float(frame_duration))))
    total = frame_duration * frames
    if total.denominator == 1:
        return f"{total.numerator}s"
    return f"{total.numerator}/{total.denominator}s"


def _fcpxml_frame_duration(fps: float) -> str:
    frac = Fraction(fps).limit_denominator(1001)
    frame_duration = Fraction(1, 1) / frac
    return f"{frame_duration.numerator}/{frame_duration.denominator}s"


def format_fcpxml_chapters(project_name: str, doc: dict, assets, takes, chapters: list[dict]) -> str:
    """Export an FCPXML 1.10 timeline with chapter markers for Final Cut Pro & DaVinci Resolve."""
    video_ref = doc.get("video_reference") or {}
    fps = float(video_ref.get("frame_rate") or 30.0)
    if not math.isfinite(fps) or not 1.0 <= fps <= 240.0:
        fps = 30.0
    rate = doc["sample_rate"]
    sources = _sources(doc, assets, takes)
    total_seconds = max(
        ((item["clip"]["start_sample"] + item["length"]) / rate for item in sources),
        default=10.0,
    )
    frame_dur = _fcpxml_frame_duration(fps)
    seq_dur = _fcpxml_rational(total_seconds, fps)

    root = ET.Element("fcpxml", version="1.10")
    resources = ET.SubElement(root, "resources")
    ET.SubElement(
        resources,
        "format",
        id="r1",
        name=f"FFVideoFormat1080p{int(round(fps))}",
        frameDuration=frame_dur,
        width="1920",
        height="1080",
    )
    library = ET.SubElement(root, "library")
    event = ET.SubElement(library, "event", name=project_name)
    project_el = ET.SubElement(event, "project", name=project_name)
    sequence = ET.SubElement(
        project_el,
        "sequence",
        format="r1",
        duration=seq_dur,
        tcStart="0s",
        tcFormat="NDF",
        audioLayout="stereo",
        audioRate=f"{rate // 1000}k" if rate % 1000 == 0 else str(rate),
    )
    spine = ET.SubElement(sequence, "spine")
    gap = ET.SubElement(spine, "gap", name="Narration Timeline", offset="0s", duration=seq_dur, start="0s")
    for chapter in chapters:
        ET.SubElement(
            gap,
            "chapter-marker",
            start=_fcpxml_rational(chapter["start_seconds"], fps),
            duration=frame_dur,
            value=chapter["title"],
            posterOffset="0s",
        )
    xml_body = ET.tostring(root, encoding="unicode")
    return '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n' + xml_body + "\n"


def format_csv_markers(chapters: list[dict], fps: float = 30.0) -> str:
    """Export DaVinci Resolve / NLE marker CSV."""
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\n")
    writer.writerow(["Timecode", "YouTube", "Name", "Color", "Duration", "Notes"])
    for chapter in chapters:
        writer.writerow(
            [
                format_smpte(chapter["start_seconds"], fps),
                chapter["timestamp"],
                chapter["title"],
                "Blue",
                "1",
                f"Passage {chapter['passage_id'][:8]}",
            ]
        )
    return buf.getvalue()


def make_chapter_router(store):
    router = APIRouter()

    def project_value(project_id):
        try:
            return store.get_project(project_id)
        except NotFound as exc:
            raise HTTPException(404, detail=str(exc)) from exc

    @router.get("/projects/{project_id}/chapters")
    def chapters(project_id: str):
        project = project_value(project_id)
        try:
            items = extract_chapters(project["document"], project["assets"], project["takes"])
        except ValueError as exc:
            raise HTTPException(422, detail=str(exc)) from exc
        return {
            "chapters": items,
            "youtube_text": format_youtube_chapters(items),
        }

    @router.get("/projects/{project_id}/chapters/export")
    def export_chapters(
        project_id: str,
        chapter_format: str = Query(default="youtube", alias="format"),
    ):
        if chapter_format not in ("youtube", "fcpxml", "csv"):
            raise HTTPException(422, detail="Unsupported chapter export format; choose youtube, fcpxml, or csv")
        project = project_value(project_id)
        doc = project["document"]
        try:
            items = extract_chapters(doc, project["assets"], project["takes"])
        except ValueError as exc:
            raise HTTPException(422, detail=str(exc)) from exc
        if not items:
            raise HTTPException(422, detail="Place narration clips on the timeline before exporting chapters")
        video_ref = doc.get("video_reference") or {}
        fps = float(video_ref.get("frame_rate") or 30.0)
        safe_name = re.sub(r"[^a-zA-Z0-9._-]+", "-", project["name"]).strip("-")[:100] or "studio"
        if chapter_format == "youtube":
            body = format_youtube_chapters(items)
            media_type = "text/plain; charset=utf-8"
            filename = f"{safe_name}-chapters.txt"
        elif chapter_format == "fcpxml":
            body = format_fcpxml_chapters(project["name"], doc, project["assets"], project["takes"], items)
            media_type = "application/xml; charset=utf-8"
            filename = f"{safe_name}-markers.fcpxml"
        else:
            body = format_csv_markers(items, fps=fps)
            media_type = "text/csv; charset=utf-8"
            filename = f"{safe_name}-markers.csv"
        return Response(
            body,
            media_type=media_type,
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    return router
