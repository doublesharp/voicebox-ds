"""Render frozen checkpoints into managed, immutable deliverables."""

import asyncio
import hashlib
import json
import shutil
import threading
import time
from pathlib import Path

from .storage import Conflict, NotFound, encode, now, uid


class StudioDelivery:
    def __init__(self, store, schedule=None):
        self.store = store
        if schedule is None:
            from ..services.task_queue import create_background_task

            schedule = create_background_task
        self.schedule = schedule
        self.directory = store.root / "deliverables"
        self.directory.mkdir(exist_ok=True)

    def _discard_unregistered(self, paths):
        # A successful COMMIT can lose its acknowledgement. Re-read durable
        # publication before deleting; an unavailable readback preserves files.
        try:
            with self.store.connect() as db:
                registered = {row[0] for row in db.execute("SELECT path FROM deliverables")}
        except Exception:
            return
        for path in paths:
            if path.name not in registered:
                path.unlink(missing_ok=True)

    def submit(self, project_id, idempotency_key, revision_id, kind, format, allow_stale_audio=False, processing=None):  # noqa: A002 - public API keyword
        if (
            not isinstance(idempotency_key, str)
            or not idempotency_key.strip()
            or kind not in ("mix", "stems")
            or format not in ("wav", "mp3")
            or type(allow_stale_audio) is not bool
            or processing not in (None, "dry", "processed")
        ):
            raise ValueError("Invalid render request")
        request = dict(revision_id=revision_id, kind=kind, format=format, allow_stale_audio=allow_stale_audio)
        if processing is not None:
            request["processing"] = processing
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            old = db.execute(
                "SELECT * FROM render_requests WHERE project_id=? AND key=?", (project_id, idempotency_key)
            ).fetchone()
            if old:
                if old["request"] != encode(request):
                    raise Conflict("idempotency key already used with different input")
                return json.loads(old["response"])
            project = self.store._project(db, project_id)
            revision = next((r for r in project["revisions"] if r["id"] == revision_id), None)
            if not revision:
                raise NotFound("Revision not found")
            doc = revision["document"]
            assets = {a["id"]: a for a in project["assets"]}
            takes = {t["id"]: t for t in project["takes"]}
            passages = {p["id"]: p for p in doc["passages"]}
            solo = any(t.get("solo") and not t.get("mute") for t in doc["tracks"])
            audible = {
                t["id"]
                for t in doc["tracks"]
                if not t.get("mute") and (not solo or t.get("solo")) and t.get("gain", 1) > 0
            }
            for passage in passages.values():
                selected = takes.get(passage.get("selected_take_id"))
                if not selected or selected["passage_id"] != passage["id"]:
                    raise ValueError("Incomplete narration: choose a take for every passage")
                if not any(
                    c.get("passage_id") == passage["id"] and c["track_id"] in audible and c.get("gain", 1) > 0
                    for c in doc["clips"]
                ):
                    raise ValueError("Incomplete narration: insert every passage on an audible track")
            recordings = []
            stem_voices = {}
            for clip in doc["clips"]:
                self.store._validate_clip(db, project_id, doc, clip)
                asset = assets.get(clip["asset_id"])
                if not asset or not self.store.asset_path(asset["id"]).is_file():
                    raise ValueError("Required audio missing")
                if clip.get("passage_id"):
                    p = passages.get(clip["passage_id"])
                    take = takes.get(clip.get("take_id"))
                    if not p or not take or take["passage_id"] != p["id"] or take["asset_id"] != clip["asset_id"]:
                        raise ValueError("Invalid clip source")
                    if kind == "stems":
                        from .voice_identity import frozen_identity

                        identity = encode(frozen_identity(take, lambda ident: assets.get(ident, {}).get("hash")))
                        previous = stem_voices.setdefault(clip["track_id"], identity)
                        if previous != identity:
                            raise ValueError("A stem track contains multiple frozen voice identities")
                    frozen_passage = take.get("request", {}).get("passage")
                    stale = take["text"] != p["text"] or (
                        frozen_passage is not None and frozen_passage.get("input_revision") != p["input_revision"]
                    )
                    if not allow_stale_audio and stale:
                        raise ValueError("Stale audio requires explicit approval")
                    recordings.append(
                        {
                            "clip_id": clip["id"],
                            "take_id": take["id"],
                            "text": take["text"],
                            "script_text": p["text"],
                            "stale": stale,
                        }
                    )
            if not doc["clips"]:
                raise ValueError("Nothing to render")
            if format == "mp3":
                from .rendering import preflight_mp3

                preflight_mp3()
            needs_ffmpeg = format == "mp3" or (
                (doc["mix"]["normalize"] or doc["mix"].get("limiter", False)) and kind == "mix" and processing != "dry"
            )
            if needs_ffmpeg:
                from .rendering import _find_ffmpeg

                if not _find_ffmpeg():
                    raise ValueError("Requested encoder or normalization is unavailable")
            job_id = uid()
            stamp = now()
            frozen = {
                "document": doc,
                "assets": assets,
                "recordings": recordings,
                "project_name": project["name"],
                "revision_name": revision["name"],
                **request,
            }
            if allow_stale_audio:
                db.execute(
                    "INSERT INTO recording_acknowledgements VALUES (?,?,?,?,?)",
                    (uid(), project_id, revision_id, stamp, encode(recordings)),
                )
            db.execute(
                "INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?,?,?)",
                (job_id, project_id, "render", "queued", None, None, None, stamp, stamp, encode(frozen)),
            )
            result = next(j for j in self.store._project(db, project_id)["jobs"] if j["id"] == job_id)
            db.execute(
                "INSERT INTO render_requests VALUES (?,?,?,?)",
                (project_id, idempotency_key, encode(request), encode(result)),
            )
        self.schedule(self.run(job_id))
        return result

    async def run(self, job_id):
        from .job_state import phase, start_attempt
        from .rendering import render_project

        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
            if not row or row["status"] != "queued":
                return
            db.execute("UPDATE jobs SET status='running',updated_at=? WHERE id=?", (now(), job_id))
            attempt = start_attempt(db, job_id)
            phase(db, job_id, attempt, "mixing")
            project_id = row["project_id"]
            frozen = json.loads(row["request"])
        work = self.directory / (".render-" + job_id)
        published = []
        stop = threading.Event()
        last_progress = [0.0]

        def cancelled():
            if stop.is_set():
                return True
            with self.store.connect() as db:
                row = db.execute("SELECT status FROM jobs WHERE id=?", (job_id,)).fetchone()
                return not row or row["status"] != "running"

        def progress(done, total):
            if time.monotonic() - last_progress[0] < 0.25:
                return
            last_progress[0] = time.monotonic()
            with self.store.connect() as db:
                db.execute(
                    "UPDATE jobs SET result=?,updated_at=? WHERE id=? AND status='running'",
                    (encode({"progress": 0.9 * done / max(total, 1)}), now(), job_id),
                )

        def render_phase(value):
            with self.store.connect() as db:
                row = db.execute("SELECT status FROM jobs WHERE id=?", (job_id,)).fetchone()
                if row and row["status"] == "running":
                    phase(db, job_id, attempt, value)

        operation = None
        created_work = False
        try:
            work.mkdir()
            created_work = True
            operation = asyncio.create_task(
                asyncio.to_thread(
                    render_project,
                    frozen["document"],
                    frozen["assets"],
                    self.store.asset_path,
                    work,
                    kind=frozen["kind"],
                    format=frozen["format"],
                    processing=frozen.get("processing"),
                    cancelled=cancelled,
                    progress=progress,
                    phase=render_phase,
                )
            )
            result = await asyncio.shield(operation)
            hashes = {}
            for output in result["files"]:
                source = Path(output["path"]).resolve()
                if source.parent != work.resolve() or not source.is_file():
                    raise ValueError("Invalid rendered output")
                digest = hashlib.sha256()
                with source.open("rb") as rendered:
                    for block in iter(lambda: rendered.read(1024 * 1024), b""):
                        if cancelled():
                            raise ValueError("Render cancelled")
                        digest.update(block)
                hashes[str(source)] = digest.hexdigest()
            with self.store.connect() as db:
                db.execute("BEGIN IMMEDIATE")
                row = db.execute("SELECT status FROM jobs WHERE id=?", (job_id,)).fetchone()
                if not row or row["status"] != "running":
                    return
                phase(db, job_id, attempt, "publishing")
                items = []
                for output in result["files"]:
                    source = Path(output["path"]).resolve()
                    if source.parent != work.resolve() or not source.is_file():
                        raise ValueError("Invalid rendered output")
                    ident = uid()
                    dest = self.directory / ident
                    source.replace(dest)
                    published.append(dest)
                    data = {k: v for k, v in output.items() if k != "path"}
                    import re

                    label = (
                        re.sub(r"[^a-zA-Z0-9._-]+", "-", frozen["project_name"] + "-" + frozen["revision_name"]).strip(
                            "-"
                        )[:140]
                        or "studio"
                    )
                    filename = f"{label}-{output['kind']}-{ident[:8]}.{frozen['format']}"
                    measurement = next(
                        (v for k, v in result["measurements"].items() if k == Path(output["path"]).name), None
                    )
                    data.update(
                        revision_id=frozen["revision_id"],
                        format=frozen["format"],
                        size_bytes=dest.stat().st_size,
                        filename=filename,
                        created_at=now(),
                        measurements=measurement,
                        recordings=frozen["recordings"],
                        allow_stale_audio=frozen["allow_stale_audio"],
                        recipe={
                            "document": frozen["document"],
                            "kind": frozen["kind"],
                            "format": frozen["format"],
                            "processing": frozen.get("processing")
                            or ("processed" if frozen["kind"] == "mix" else "dry"),
                            "source_hashes": {key: asset.get("hash") for key, asset in frozen["assets"].items()},
                        },
                    )
                    data["sha256"] = hashes[str(source)]
                    db.execute("INSERT INTO deliverables VALUES (?,?,?,?)", (ident, project_id, encode(data), ident))
                    items.append({"id": ident, **data})
                db.execute(
                    "UPDATE jobs SET status='completed',result=?,updated_at=? WHERE id=?",
                    (
                        encode(
                            {
                                "deliverables": items,
                                "measurements": result["measurements"],
                                "warnings": result["warnings"],
                            }
                        ),
                        now(),
                        job_id,
                    ),
                )
                phase(db, job_id, attempt, "completed")
        except asyncio.CancelledError:
            stop.set()
            # to_thread cancellation does not stop its native worker. Reap it
            # before removing staging or allowing another attempt of this job.
            while operation is not None and not operation.done():
                try:
                    await asyncio.shield(operation)
                except asyncio.CancelledError:
                    continue
                except Exception:
                    break
            if operation is not None and not operation.cancelled():
                operation.exception()
            self._discard_unregistered(published)
            with self.store.connect() as db:
                db.execute(
                    "UPDATE jobs SET status='interrupted',error='Render interrupted',updated_at=? WHERE id=? AND status='running'",
                    (now(), job_id),
                )
                phase(db, job_id, attempt, "interrupted", "Render interrupted")
            raise
        except Exception as exc:
            self._discard_unregistered(published)
            with self.store.connect() as db:
                db.execute(
                    "UPDATE jobs SET status='failed',error=?,updated_at=? WHERE id=? AND status='running'",
                    (str(exc), now(), job_id),
                )
                row = db.execute("SELECT status FROM jobs WHERE id=?", (job_id,)).fetchone()
                if row and row["status"] == "failed":
                    phase(db, job_id, attempt, "failed", str(exc))
        finally:
            if created_work:
                shutil.rmtree(work, ignore_errors=True)
            with self.store.connect() as db:
                db.execute(
                    "UPDATE jobs SET status='cancelled',updated_at=? WHERE id=? AND status='cancelling'",
                    (now(), job_id),
                )
                row = db.execute("SELECT status FROM jobs WHERE id=?", (job_id,)).fetchone()
                if row and row["status"] == "cancelled":
                    phase(db, job_id, attempt, "cancelled")

    def path(self, ident):
        with self.store.connect() as db:
            row = db.execute("SELECT path,data FROM deliverables WHERE id=?", (ident,)).fetchone()
            if not row:
                raise NotFound("Deliverable not found")
            path = self.directory / row["path"]
            if not path.is_file():
                raise NotFound("Deliverable audio missing")
            return path, json.loads(row["data"])
