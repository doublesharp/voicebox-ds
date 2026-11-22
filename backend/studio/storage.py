"""Independent, transactional studio project storage."""

from __future__ import annotations

import copy
import hashlib
import json
import math
import re
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path

from .fades import fade_envelopes, set_segment_fade
from .timing import nearest_sample, resampled_frames

UNDO_MAX_STATES = 100
UNDO_MAX_BYTES = 8 * 1024 * 1024


def uid():
    return str(uuid.uuid4())


def now():
    return datetime.now(timezone.utc).isoformat()


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _history_json(states):
    """Retain recent undo states without rewriting an unlimited edit history.

    One snapshot larger than the budget is retained so the last edit remains
    undoable even for a project whose document itself exceeds the budget.
    Named checkpoints and acknowledged operation receipts are never pruned.
    """
    selected = []
    size = 2
    for state in reversed(states[-UNDO_MAX_STATES:]):
        raw = encode(state)
        additional = len(raw) + bool(selected)
        if selected and size + additional > UNDO_MAX_BYTES:
            break
        selected.append(raw)
        size += additional
        if size > UNDO_MAX_BYTES:
            break
    return "[" + ",".join(reversed(selected)) + "]"


class Conflict(Exception):
    def __init__(self, message, current_revision=None):
        super().__init__(message)
        self.current_revision = current_revision


class NotFound(Exception):
    pass


def passage(text, language):
    return dict(
        id=uid(),
        text=text,
        language=language,
        profile_id=None,
        voice_snapshot=None,
        direction=dict(instruct="", seed=None, max_chunk_chars=300, crossfade_ms=0),
        input_revision=0,
        selection_token=0,
        selected_take_id=None,
        locked=False,
    )


def document(script, language):
    return dict(
        schema_version=1,
        sample_rate=48000,
        channels=2,
        language=language,
        passages=[passage(t.strip(), language) for t in re.split(r"\n\s*\n", script) if t.strip()],
        tracks=[dict(id=uid(), name="Voice", kind="voice", mute=False, solo=False, gain=1.0)],
        clips=[],
        mix=dict(target_lufs=-16.0, max_true_peak_dbtp=-1.0, normalize=False),
    )


class StudioStore:
    def __init__(self, root, voice_resolver=None):
        self.root = Path(root)
        self.voice_resolver = voice_resolver
        self.root.mkdir(parents=True, exist_ok=True)
        self.asset_dir = self.root / "assets"
        self.db_path = self.root / "studio.sqlite"
        from .migrations import migrate

        migrate(self.db_path)
        self.asset_dir.mkdir(exist_ok=True)
        self._recover_unpublished()

    def _recover_unpublished(self):
        # All Studio publishers hold this database write lock through registration.
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            registered = {row[0] for row in db.execute("SELECT path FROM assets")}
            for path in self.asset_dir.iterdir():
                name = path.name
                candidate = name.removeprefix(".publish-")
                try:
                    owned = str(uuid.UUID(candidate)) == candidate
                except ValueError:
                    owned = False
                if not owned or name in registered or not path.is_file() or path.is_symlink():
                    continue
                recovery = self.root / "recovery" / str(uuid.uuid4())
                recovery.mkdir(parents=True)
                path.rename(recovery / name)

    def connect(self):
        db = sqlite3.connect(self.db_path, timeout=30)
        db.row_factory = sqlite3.Row
        return db

    def create_project(self, name, client_label=None, script="", language="en"):
        if (
            not isinstance(name, str)
            or not name.strip()
            or not isinstance(script, str)
            or not isinstance(language, str)
            or not language.strip()
        ):
            raise ValueError("Name, script and language must be valid strings")
        identifier, timestamp = uid(), now()
        with self.connect() as db:
            db.execute(
                "INSERT INTO projects VALUES (?,?,?,?,?,?,?,?,?)",
                (
                    identifier,
                    name.strip(),
                    client_label,
                    0,
                    timestamp,
                    timestamp,
                    encode(document(script, language)),
                    "[]",
                    "[]",
                ),
            )
            return self._project(db, identifier)

    def list_projects(self):
        with self.connect() as db:
            return [
                dict(row)
                for row in db.execute(
                    "SELECT id,name,client_label,revision,created_at,updated_at FROM projects ORDER BY updated_at DESC"
                )
            ]

    def _project(self, db, project_id, *, compact=False):
        row = db.execute(
            "SELECT id,name,client_label,revision,created_at,updated_at,document FROM projects WHERE id=?",
            (project_id,),
        ).fetchone()
        if row is None:
            raise NotFound("Project not found")
        result = {k: row[k] for k in ("id", "name", "client_label", "revision", "created_at", "updated_at")}
        result["document"] = json.loads(row["document"])
        for table in (
            "takes",
            "assets",
            "jobs",
            "revisions",
            "approvals",
            "deliverables",
            "recording_acknowledgements",
        ):
            items = []
            columns = "id,project_id,name,created_at,project_revision" if compact and table == "revisions" else "*"
            for item in db.execute(f"SELECT {columns} FROM {table} WHERE project_id=?", (project_id,)):
                item = dict(item)
                item.pop("project_id", None)
                item.pop("path", None)
                for key in ("document", "request", "result", "data", "recordings"):
                    if item.get(key) is not None:
                        item[key] = json.loads(item[key])
                if table == "deliverables":
                    item = {"id": item["id"], **item["data"]}
                items.append(item)
            if table == "jobs":
                from .job_state import enrich_jobs

                items = enrich_jobs(db, items)
            result[table] = items
        return result

    def get_project(self, project_id):
        with self.connect() as db:
            return self._project(db, project_id)

    def poll_project(self, project_id, since=None):
        """Read the token and projection from one snapshot, or skip the projection."""
        with self.connect() as db:
            db.execute("BEGIN")
            row = db.execute(
                "SELECT c.token FROM project_changes c JOIN projects p ON p.id=c.project_id WHERE p.id=?",
                (project_id,),
            ).fetchone()
            if row is None:
                raise NotFound("Project not found")
            token = '"' + row["token"] + '"'
            if since == token:
                return None, token
            project = self._project(db, project_id, compact=True)
            project["change_token"] = token
            return project, token

    def get_revision(self, project_id, revision_id):
        with self.connect() as db:
            row = db.execute(
                "SELECT id,name,created_at,project_revision,document FROM revisions WHERE project_id=? AND id=?",
                (project_id, revision_id),
            ).fetchone()
            if row is None:
                raise NotFound("Checkpoint not found")
            result = dict(row)
            result["document"] = json.loads(result["document"])
            return result

    def _receipt_projection(self, db, project_id, receipt, *, compact=False):
        if receipt.get("studio_receipt_version") != 1:
            # Legacy responses remain exactly replayable. Compact clients can
            # still omit their inline checkpoint documents on the wire.
            if compact and isinstance(receipt.get("revisions"), list):
                receipt["revisions"] = [
                    {key: value for key, value in revision.items() if key != "document"}
                    for revision in receipt["revisions"]
                ]
            return receipt
        response = receipt["project"]
        if compact or not response["revisions"]:
            return response
        # Checkpoints are immutable and retained independently of undo. Only
        # their IDs are repeated in each receipt; metadata stays frozen in it.
        ids = [revision["id"] for revision in response["revisions"]]
        documents = {}
        for start in range(0, len(ids), 500):
            batch = ids[start:start + 500]
            placeholders = ",".join("?" for _ in batch)
            for row in db.execute(
                f"SELECT id,document FROM revisions WHERE project_id=? AND id IN ({placeholders})",
                [project_id, *batch],
            ):
                documents[row["id"]] = json.loads(row["document"])
        if len(documents) != len(set(ids)):
            raise NotFound("Saved operation checkpoint is unavailable")
        response["revisions"] = [
            {**revision, "document": documents[revision["id"]]} for revision in response["revisions"]
        ]
        return response

    def _operation(self, db, project_id, operation_id, request, *, compact=False):
        if not isinstance(operation_id, str) or not operation_id.strip():
            raise ValueError("operation_id is required")
        old = db.execute(
            "SELECT request,response FROM operations WHERE project_id=? AND operation_id=?", (project_id, operation_id)
        ).fetchone()
        if old:
            if old["request"] != encode(request):
                raise Conflict("operation_id already used with different input")
            return self._receipt_projection(db, project_id, json.loads(old["response"]), compact=compact)
        return None

    def _record(self, db, project_id, operation_id, request, *, compact=False):
        response = self._project(db, project_id, compact=True)
        receipt = {"studio_receipt_version": 1, "project": response}
        db.execute(
            "INSERT INTO operations VALUES (?,?,?,?)", (project_id, operation_id, encode(request), encode(receipt))
        )
        return self._receipt_projection(db, project_id, receipt, compact=compact)

    def command(self, project_id, operation_id, expected_revision, type, payload, *, compact=False):
        published = []
        try:
            return self._command(project_id, operation_id, expected_revision, type, payload, published, compact=compact)
        except BaseException:
            # _command has exited its transaction before checking uncertain commits.
            from .publication import discard_unregistered

            with self.connect() as db:
                discard_unregistered(db, published)
            raise

    def _command(self, project_id, operation_id, expected_revision, type, payload, published, *, compact=False):
        request = dict(expected_revision=expected_revision, type=type, payload=payload)
        voice_snapshot = None
        if type == "assign_voice":
            with self.connect() as db:
                prior = self._operation(db, project_id, operation_id, request, compact=compact)
                if prior is not None:
                    return prior
                project = self._project(db, project_id, compact=True)
                if project["revision"] != expected_revision:
                    raise Conflict("Project revision changed", project["revision"])
                ids = payload.get("passage_ids")
                if (
                    not isinstance(ids, list)
                    or not ids
                    or len(set(ids)) != len(ids)
                    or not set(ids) <= {p["id"] for p in project["document"]["passages"]}
                ):
                    raise ValueError("Invalid passage IDs")
                if any(p["locked"] for p in project["document"]["passages"] if p["id"] in ids):
                    raise ValueError("Passage is locked")
            if self.voice_resolver is None:
                raise ValueError("Voice resolver unavailable")
            kwargs = {"model_size": payload["model_size"]} if "model_size" in payload else {}
            voice_snapshot = self.voice_resolver(self, project_id, payload.get("profile_id"), **kwargs)
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            prior = self._operation(db, project_id, operation_id, request, compact=compact)
            if prior is not None:
                return prior
            row = db.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
            if row is None:
                raise NotFound("Project not found")
            if row["revision"] != expected_revision:
                raise Conflict("Project revision changed", row["revision"])
            doc = json.loads(row["document"])
            undo = json.loads(row["undo"])
            redo = json.loads(row["redo"])
            self._remember_intents(db, project_id, doc)
            state = dict(document=copy.deepcopy(doc), name=row["name"], client_label=row["client_label"])
            if type in ("undo", "redo"):
                source, target = (undo, redo) if type == "undo" else (redo, undo)
                if not source:
                    raise ValueError("Nothing to " + type)
                restored = source.pop()
                target.append(state)
                self._invalidate(db, project_id, doc, restored["document"])
                state = restored
            elif type == "restore_revision":
                rev = db.execute(
                    "SELECT document FROM revisions WHERE id=? AND project_id=?",
                    (payload.get("revision_id"), project_id),
                ).fetchone()
                if not rev:
                    raise NotFound("Revision not found")
                restored = json.loads(rev["document"])
                self._invalidate(db, project_id, doc, restored)
                undo.append(state)
                redo.clear()
                state = {**state, "document": restored}
            else:
                self._apply(db, project_id, state, type, payload, voice_snapshot, published)
                undo.append(dict(document=doc, name=row["name"], client_label=row["client_label"]))
                redo.clear()
            from .archive import _validate_document

            project = self._project(db, project_id, compact=True)
            _validate_document(
                state["document"], {a["id"]: a for a in project["assets"]}, {t["id"]: t for t in project["takes"]}
            )
            self._remember_intents(db, project_id, state["document"])
            db.execute(
                "UPDATE projects SET name=?,client_label=?,document=?,undo=?,redo=?,revision=revision+1,updated_at=? WHERE id=?",
                (
                    state["name"],
                    state["client_label"],
                    encode(state["document"]),
                    _history_json(undo),
                    _history_json(redo),
                    now(),
                    project_id,
                ),
            )
            return self._record(db, project_id, operation_id, request, **({"compact": True} if compact else {}))

    def _remember_intents(self, db, project_id, doc):
        for p in doc["passages"]:
            db.execute(
                "INSERT INTO passage_intents VALUES (?,?,?) ON CONFLICT(project_id,passage_id) DO UPDATE SET epoch=MAX(epoch,excluded.epoch)",
                (project_id, p["id"], p["selection_token"]),
            )

    def _invalidate(self, db, project_id, current, restored):
        tokens = {p["id"]: p["selection_token"] for p in current["passages"]}
        for p in restored["passages"]:
            old = db.execute(
                "SELECT epoch FROM passage_intents WHERE project_id=? AND passage_id=?", (project_id, p["id"])
            ).fetchone()
            p["selection_token"] = max(p["selection_token"], tokens.get(p["id"], 0), old["epoch"] if old else 0) + 1

    def _apply(self, db, project_id, state, kind, payload, voice_snapshot=None, published=None):
        if not isinstance(payload, dict):
            raise ValueError("payload must be an object")
        doc = state["document"]
        passages = doc["passages"]
        clips = doc["clips"]
        tracks = doc["tracks"]

        def find(items, identifier):
            result = next((x for x in items if x["id"] == identifier), None)
            if result is None:
                raise NotFound("Item not found in project")
            return result

        if kind in ("update_passage", "select_take", "delete_passage", "assign_voice"):
            ids = payload.get("passage_ids", []) if kind == "assign_voice" else [payload.get("passage_id")]
            if any(find(passages, ident)["locked"] for ident in ids):
                raise ValueError("Passage is locked")
        if kind == "set_pronunciation_rules":
            from .pronunciation import apply_pronunciation_command

            apply_pronunciation_command(doc, payload)
        elif kind == "set_speech_review":
            from .speech_review import save_review

            save_review(self, db, project_id, doc, payload)
        elif kind in ("set_video_reference", "set_scene_target", "estimate_captions", "recognize_captions", "set_captions"):
            from .captions import apply_caption_command

            apply_caption_command(self, db, project_id, doc, kind, payload)
        elif kind == "compose_take":
            from .phrase_repairs import compose_take

            compose_take(self, db, project_id, doc, payload, published)
        elif kind == "update_project":
            for key in ("name", "client_label"):
                if key in payload:
                    if key == "name" and (not isinstance(payload[key], str) or not payload[key].strip()):
                        raise ValueError("Name is required")
                    state[key] = payload[key]
        elif kind == "add_passages":
            texts = payload.get("texts")
            chapters = payload.get("chapters")
            if not isinstance(texts, list) or not texts or any(not isinstance(t, str) or not t.strip() for t in texts):
                raise ValueError("Passages require text")
            if chapters is not None and (
                not isinstance(chapters, list)
                or len(chapters) != len(texts)
                or any(
                    c is not None and (not isinstance(c, str) or len(c.strip()) > 120 or "\n" in c or "\r" in c)
                    for c in chapters
                )
            ):
                raise ValueError("Invalid passage chapters")
            index = len(passages)
            if payload.get("after_id") is not None:
                index = passages.index(find(passages, payload["after_id"])) + 1
            created = []
            for idx, text in enumerate(texts):
                item = passage(text, doc["language"])
                if chapters is not None and chapters[idx] and chapters[idx].strip():
                    item["chapter"] = chapters[idx].strip()
                created.append(item)
            passages[index:index] = created
        elif kind == "update_passage":
            p = find(passages, payload.get("passage_id"))
            for key in ("text", "language"):
                if key in payload:
                    if not isinstance(payload[key], str) or not payload[key].strip():
                        raise ValueError(f"{key} is required")
                    p[key] = payload[key]
            if "chapter" in payload:
                ch = payload["chapter"]
                if ch is None or (isinstance(ch, str) and not ch.strip()):
                    p.pop("chapter", None)
                elif not isinstance(ch, str) or len(ch.strip()) > 120 or "\n" in ch or "\r" in ch:
                    raise ValueError("Invalid passage chapter")
                else:
                    p["chapter"] = ch.strip()
            if "direction" in payload:
                direction = payload["direction"]
                allowed_direction = set(p["direction"]) | {"speed"}
                if not isinstance(direction, dict) or set(direction) - allowed_direction:
                    raise ValueError("Invalid direction")
                p["direction"].update(direction)
                d = p["direction"]
                speed = d.get("speed", 1.0)
                if (
                    not isinstance(d["instruct"], str)
                    or (d["seed"] is not None and (type(d["seed"]) is not int))
                    or type(d["max_chunk_chars"]) is not int
                    or d["max_chunk_chars"] <= 0
                    or type(d["crossfade_ms"]) is not int
                    or d["crossfade_ms"] < 0
                    or not _finite(speed)
                    or not 0.5 <= speed <= 2.0
                ):
                    raise ValueError("Invalid direction")
            p["input_revision"] += 1
            p["selection_token"] += 1
        elif kind == "assign_voice":
            for ident in payload["passage_ids"]:
                p = find(passages, ident)
                p["profile_id"] = payload["profile_id"]
                p["voice_snapshot"] = copy.deepcopy(voice_snapshot)
                p["input_revision"] += 1
                p["selection_token"] += 1
        elif kind == "delete_passage":
            p = find(passages, payload.get("passage_id"))
            passages.remove(p)
            doc["clips"] = [c for c in clips if c["passage_id"] != p["id"]]
            doc.get("scene_targets", {}).pop(p["id"], None)
        elif kind == "reorder_passages":
            ids = payload.get("passage_ids")
            if not isinstance(ids, list) or len(ids) != len(passages) or set(ids) != {p["id"] for p in passages}:
                raise ValueError("Expected all passage IDs exactly once")
            doc["passages"] = [find(passages, x) for x in ids]
        elif kind == "set_lock":
            p = find(passages, payload.get("passage_id"))
            if type(payload.get("locked")) is not bool:
                raise ValueError("locked must be boolean")
            p["locked"] = payload["locked"]
            p["selection_token"] += 1
        elif kind == "annotate_take":
            if not isinstance(payload.get("take_id"), str) or not payload["take_id"]:
                raise ValueError("Take ID must be a nonempty string")
            take = db.execute(
                "SELECT id FROM takes WHERE id=? AND project_id=?", (payload.get("take_id"), project_id)
            ).fetchone()
            if not take:
                raise NotFound("Take not found in project")
            if not {"name", "note"}.intersection(payload) or set(payload) - {"take_id", "name", "note"}:
                raise ValueError("Expected take name or note")
            annotation = doc.setdefault("take_annotations", {}).setdefault(take["id"], {"name": "", "note": ""})
            for key, limit in (("name", 120), ("note", 4000)):
                if key in payload:
                    if not isinstance(payload[key], str) or len(payload[key]) > limit:
                        raise ValueError(f"Take {key} must be a string of at most {limit} characters")
                    annotation[key] = payload[key]
        elif kind == "select_take":
            for flag in ("replace_clips", "reset_trims"):
                if flag in payload and type(payload[flag]) is not bool:
                    raise ValueError(f"{flag} must be boolean")
            if payload.get("reset_trims") and not payload.get("replace_clips"):
                raise ValueError("Reset trims requires replacing linked clips")
            p = find(passages, payload.get("passage_id"))
            take = db.execute(
                "SELECT * FROM takes WHERE id=? AND project_id=? AND passage_id=?",
                (payload.get("take_id"), project_id, p["id"]),
            ).fetchone()
            if not take:
                raise NotFound("Take not found for passage")
            p["selected_take_id"] = take["id"]
            p["selection_token"] += 1
            if payload.get("replace_clips"):
                for clip in clips:
                    if clip["passage_id"] == p["id"]:
                        clip["take_id"] = take["id"]
                        clip["asset_id"] = take["asset_id"]
                        clip["track_id"] = self._voice_track(db, project_id, doc, take, p)["id"]
                        for direction in ("in", "out"):
                            clip.pop(f"fade_{direction}_total_samples", None)
                            clip.pop(f"fade_{direction}_offset_samples", None)
                        if payload.get("reset_trims"):
                            clip["trim_start_sample"] = clip["trim_end_sample"] = 0
                            length = self._clip_length(db, project_id, doc, clip)
                            for key in ("fade_in_samples", "fade_out_samples"):
                                if clip[key] > length:
                                    clip[key] = 0
                        self._validate_clip(db, project_id, doc, clip)
        elif kind == "update_track":
            track = find(tracks, payload.get("track_id"))
            for key in ("name", "mute", "solo", "gain", "effect_gain_db", "effects_chain"):
                if key in payload:
                    track[key] = payload[key]
            if (
                not isinstance(track["name"], str)
                or not track["name"].strip()
                or type(track["mute"]) is not bool
                or type(track["solo"]) is not bool
                or not _gain(track["gain"])
                or not _finite(track.get("effect_gain_db", 0))
                or not -40 <= track.get("effect_gain_db", 0) <= 40
            ):
                raise ValueError("Invalid track")
            from .processing import validate_chain
            validate_chain(track.get("effects_chain", []))
        elif kind == "update_mix":
            for key in (
                "target_lufs",
                "max_true_peak_dbtp",
                "normalize",
                "master_gain",
                "limiter",
                "duck_music",
                "duck_db",
                "duck_attack_ms",
                "duck_release_ms",
            ):
                if key in payload:
                    doc["mix"][key] = payload[key]
            m = doc["mix"]
            if (
                any(not _finite(m[k]) for k in ("target_lufs", "max_true_peak_dbtp"))
                or type(m["normalize"]) is not bool
                or not _finite(m.get("master_gain", 1))
                or not 0 <= m.get("master_gain", 1) <= 16
                or type(m.get("limiter", False)) is not bool
                or type(m.get("duck_music", False)) is not bool
                or not _finite(m.get("duck_db", -14.0))
                or not -30 <= m.get("duck_db", -14.0) <= 0
                or not _finite(m.get("duck_attack_ms", 80.0))
                or not 5 <= m.get("duck_attack_ms", 80.0) <= 1000
                or not _finite(m.get("duck_release_ms", 350.0))
                or not 20 <= m.get("duck_release_ms", 350.0) <= 3000
            ):
                raise ValueError("Invalid mix")
        elif kind in ("update_clip", "duplicate_clip", "delete_clip", "split_clip"):
            clip = find(clips, payload.get("clip_id"))
            if kind == "delete_clip":
                clips.remove(clip)
            elif kind == "duplicate_clip":
                clips.append({**clip, "id": uid()})
            elif kind == "update_clip":
                trim_changed = any(
                    key in payload and payload[key] != clip[key]
                    for key in ("trim_start_sample", "trim_end_sample")
                )
                for direction in ("in", "out"):
                    fade_key = f"fade_{direction}_samples"
                    if trim_changed or (fade_key in payload and payload[fade_key] != clip[fade_key]):
                        clip.pop(f"fade_{direction}_total_samples", None)
                        clip.pop(f"fade_{direction}_offset_samples", None)
                for key in (
                    "start_sample",
                    "trim_start_sample",
                    "trim_end_sample",
                    "gain",
                    "fade_in_samples",
                    "fade_out_samples",
                    "track_id",
                ):
                    if key in payload:
                        clip[key] = payload[key]
                self._validate_clip(db, project_id, doc, clip)
            else:
                at = payload.get("at_sample")
                length = self._clip_length(db, project_id, doc, clip)
                if type(at) is not int or not clip["start_sample"] < at < clip["start_sample"] + length:
                    raise ValueError("Split outside clip")
                left = at - clip["start_sample"]
                right = length - left
                source_frames = length + clip["trim_start_sample"] + clip["trim_end_sample"]
                (fade_in, in_offset), (fade_out, out_offset) = fade_envelopes(clip, length, source_frames)
                other = {
                    **clip,
                    "id": uid(),
                    "start_sample": at,
                    "trim_start_sample": clip["trim_start_sample"] + left,
                }
                clip["trim_end_sample"] += right
                set_segment_fade(clip, "in", left, fade_in, in_offset)
                set_segment_fade(clip, "out", left, fade_out, out_offset + right)
                set_segment_fade(other, "in", right, fade_in, in_offset + left)
                set_segment_fade(other, "out", right, fade_out, out_offset)
                clips.append(other)
        elif kind == "insert_asset":
            asset_id = payload.get("asset_id")
            if not db.execute("SELECT 1 FROM assets WHERE id=? AND project_id=?", (asset_id, project_id)).fetchone():
                raise NotFound("Asset not found in project")
            track_id = payload.get("track_id")
            if track_id is None:
                media_kind = payload.get("kind", "music")
                name = payload.get("name", "Imported audio")
                if media_kind not in ("music", "sfx", "voice") or not isinstance(name, str) or not name.strip():
                    raise ValueError("Invalid imported track")
                track = dict(id=uid(), name=name, kind=media_kind, mute=False, solo=False, gain=1.0)
                tracks.append(track)
                track_id = track["id"]
            clip = dict(
                id=uid(),
                passage_id=None,
                take_id=None,
                asset_id=asset_id,
                track_id=track_id,
                start_sample=payload.get("start_sample", 0),
                trim_start_sample=0,
                trim_end_sample=0,
                gain=1.0,
                fade_in_samples=0,
                fade_out_samples=0,
            )
            self._validate_clip(db, project_id, doc, clip)
            clips.append(clip)
        elif kind == "insert_passages":
            ids = payload.get("passage_ids")
            if not isinstance(ids, list) or not ids or len(set(ids)) != len(ids):
                raise ValueError("passage_ids required")
            gap = payload.get("gap_ms", 0)
            start = payload.get("start_sample")
            if not _finite(gap) or gap < 0 or (start is not None and (type(start) is not int or start < 0)):
                raise ValueError("Invalid placement")
            if start is None:
                start = max((c["start_sample"] + self._clip_length(db, project_id, doc, c) for c in clips), default=0)
            for ident in ids:
                p = find(passages, ident)
                take = db.execute(
                    "SELECT * FROM takes WHERE id=? AND project_id=? AND passage_id=?",
                    (p["selected_take_id"], project_id, ident),
                ).fetchone()
                if not take:
                    raise ValueError("Passage has no selected take")
                track = self._voice_track(db, project_id, doc, take, p)
                c = dict(
                    id=uid(),
                    passage_id=ident,
                    take_id=take["id"],
                    asset_id=take["asset_id"],
                    track_id=track["id"],
                    start_sample=start,
                    trim_start_sample=0,
                    trim_end_sample=0,
                    gain=1.0,
                    fade_in_samples=0,
                    fade_out_samples=0,
                )
                clips.append(c)
                start += self._clip_length(db, project_id, doc, c) + nearest_sample(gap * doc["sample_rate"] / 1000)
        else:
            raise ValueError("Unknown command: " + str(kind))

    def _voice_track(self, db, project_id, doc, take, passage):
        tracks, clips = doc["tracks"], doc["clips"]
        from .voice_identity import frozen_identity

        frozen = json.loads(take["request"]).get("passage", {})
        voice = frozen.get("voice_snapshot", passage.get("voice_snapshot"))
        def asset_hash(ident):
            source = db.execute("SELECT hash FROM assets WHERE id=? AND project_id=?", (ident, project_id)).fetchone()
            return source["hash"] if source else None
        identity = frozen_identity(dict(take), asset_hash)
        voice_key = hashlib.sha256(encode(identity).encode()).hexdigest()
        track = next((t for t in tracks if t.get("voice_key") == voice_key), None)
        if track is None:
            track = next(
                (
                    t
                    for t in tracks
                    if t["kind"] == "voice"
                    and not t.get("voice_key")
                    and not any(c["track_id"] == t["id"] for c in clips)
                ),
                None,
            )
            if track is None:
                track = dict(
                    id=uid(),
                    name=(voice or {}).get("name") or "Voice " + str(sum(t["kind"] == "voice" for t in tracks) + 1),
                    kind="voice",
                    mute=False,
                    solo=False,
                    gain=1.0,
                )
                tracks.append(track)
            track["voice_key"] = voice_key
        return track

    def _clip_length(self, db, project_id, doc, clip):
        asset = db.execute(
            "SELECT * FROM assets WHERE id=? AND project_id=?", (clip["asset_id"], project_id)
        ).fetchone()
        if not asset:
            raise NotFound("Asset not found in project")
        return (
            resampled_frames(asset["frames"], asset["sample_rate"], doc["sample_rate"])
            - clip["trim_start_sample"]
            - clip["trim_end_sample"]
        )

    def _validate_clip(self, db, project_id, doc, clip):
        if not any(t["id"] == clip["track_id"] for t in doc["tracks"]):
            raise NotFound("Track not found")
        for key in ("start_sample", "trim_start_sample", "trim_end_sample", "fade_in_samples", "fade_out_samples"):
            if type(clip[key]) is not int or clip[key] < 0:
                raise ValueError("Invalid clip position")
        length = self._clip_length(db, project_id, doc, clip)
        if length <= 0 or not _gain(clip["gain"]):
            raise ValueError("Invalid clip range or gain")
        source_frames = length + clip["trim_start_sample"] + clip["trim_end_sample"]
        fade_envelopes(clip, length, source_frames)

    def checkpoint(self, project_id, operation_id, expected_revision, name, *, compact=False):
        request = dict(action="checkpoint", expected_revision=expected_revision, name=name)
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            prior = self._operation(db, project_id, operation_id, request, compact=compact)
            if prior is not None:
                return prior
            project = self._project(db, project_id, compact=True)
            if project["revision"] != expected_revision:
                raise Conflict("Project revision changed", project["revision"])
            if not isinstance(name, str) or not name.strip():
                raise ValueError("Revision name required")
            db.execute(
                "INSERT INTO revisions VALUES (?,?,?,?,?,?)",
                (uid(), project_id, name.strip(), now(), encode(project["document"]), expected_revision),
            )
            return self._record(db, project_id, operation_id, request, **({"compact": True} if compact else {}))

    def approve(self, project_id, operation_id, revision_id, note=None, *, compact=False):
        request = dict(action="approve", revision_id=revision_id, note=note)
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            prior = self._operation(db, project_id, operation_id, request, compact=compact)
            if prior is not None:
                return prior
            if not db.execute(
                "SELECT 1 FROM revisions WHERE id=? AND project_id=?", (revision_id, project_id)
            ).fetchone():
                raise NotFound("Revision not found")
            db.execute("INSERT INTO approvals VALUES (?,?,?,?,?)", (uid(), project_id, revision_id, note, now()))
            return self._record(db, project_id, operation_id, request, **({"compact": True} if compact else {}))

    def add_asset(self, project_id, source):
        from .publication import discard_unregistered, publish_audio

        asset_id = uid()
        target = self.asset_dir / asset_id
        published = False
        db = self.connect()
        try:
            db.execute("BEGIN IMMEDIATE")
            self._project(db, project_id)
            publish_audio(db, self.asset_dir, project_id, source, asset_id)
            published = True
            result = next(a for a in self._project(db, project_id)["assets"] if a["id"] == asset_id)
            db.commit()
            return result
        except BaseException:
            db.rollback()
            if published:
                discard_unregistered(db, [target])
            raise
        finally:
            db.close()

    def asset_path(self, asset_id):
        with self.connect() as db:
            row = db.execute("SELECT path FROM assets WHERE id=?", (asset_id,)).fetchone()
            if not row:
                raise NotFound("Asset not found")
            path = self.asset_dir / row["path"]
            if not path.is_file():
                raise NotFound("Asset audio missing")
            return path


def _finite(value):
    return type(value) in (int, float) and math.isfinite(value)


def _gain(value):
    return _finite(value) and value >= 0
