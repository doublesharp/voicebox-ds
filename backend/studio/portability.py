"""Bridge validated archives into studio-owned identifiers and files."""

import copy
import shutil

import soundfile as sf

from .archive_scope import unavailable_references, voice_snapshots
from .publication import discard_unregistered, publish_audio
from .review_schema import remap_reviews, validate_reviews
from .reviews import restore_reviews
from .storage import encode, now, uid


def import_archive(store, archive_path):
    from .archive import read_archive

    staging = store.root / (".import-" + uid())
    staging.mkdir()
    copied = []
    try:
        payload = read_archive(archive_path, staging)
        project = payload["project"]
        validate_reviews(project)
        assets = payload["assets"]
        for asset in assets:
            info = sf.info(asset["path"])
            if (info.samplerate, info.channels, info.frames) != (
                asset.get("sample_rate"),
                asset.get("channels"),
                asset.get("frames"),
            ):
                raise ValueError("Asset audio metadata mismatch")
            if abs(asset.get("duration", -1) - info.frames / info.samplerate) > 1e-9:
                raise ValueError("Asset duration mismatch")
        mapping = {project["id"]: uid()}
        for asset in assets:
            mapping[asset["id"]] = uid()
        for voice_snapshot in voice_snapshots(project):
            for ident in unavailable_references(voice_snapshot):
                mapping.setdefault(ident, uid())
        for section in ("takes", "revisions", "approvals"):
            for item in project.get(section, []):
                mapping[item["id"]] = uid()
        for item in project.get("recording_acknowledgements", []):
            mapping[item["id"]] = uid()
        for take in project.get("takes", []):
            mapping.setdefault(take["passage_id"], uid())
        docs = [project["document"]] + [r["document"] for r in project.get("revisions", [])]
        for doc in docs:
            for section in ("passages", "tracks", "clips"):
                for item in doc[section]:
                    mapping.setdefault(item["id"], uid())

        def ref(value):
            return mapping.get(value, value) if isinstance(value, str) else value

        def voice(value):
            if not isinstance(value, dict):
                return value
            if "unavailable_references" in value:
                value["unavailable_references"] = [ref(x) for x in value["unavailable_references"]]
            for sample in value.get("samples", []):
                sample["asset_id"] = ref(sample["asset_id"])
            if "reference_assets" in value:
                value["reference_assets"] = [ref(x) for x in value["reference_assets"]]
            return value

        def passage(value):
            value["id"] = ref(value["id"])
            value["selected_take_id"] = ref(value.get("selected_take_id"))
            voice(value.get("voice_snapshot"))
            return value

        def document(value):
            if "take_annotations" in value:
                value["take_annotations"] = {ref(key): item for key, item in value["take_annotations"].items()}
            for rule in value.get("pronunciation_rules", []):
                if rule.get("recording_asset_id") is not None:
                    rule["recording_asset_id"] = ref(rule["recording_asset_id"])
            for item in value["passages"]:
                passage(item)
            for track in value["tracks"]:
                track["id"] = ref(track["id"])
                if track.get("voice_key", "").startswith(("{", "null")):
                    import json

                    track["voice_key"] = encode(voice(json.loads(track["voice_key"])))
            for clip in value["clips"]:
                for key in ("id", "asset_id", "take_id", "passage_id", "track_id"):
                    clip[key] = ref(clip.get(key))
            if "scene_targets" in value:
                value["scene_targets"] = {ref(key): target for key, target in value["scene_targets"].items()}
            if value.get("captions"):
                for cue in value["captions"]["cues"]:
                    cue["clip_id"] = ref(cue["clip_id"])
                # Import rekeys source identities. Retain edits and require a
                # fresh listen/review against the imported arrangement.
                value["captions"]["reviewed"] = False

        imported = copy.deepcopy(project)
        imported["id"] = ref(imported["id"])
        document(imported["document"])
        if payload.get("scope") is not None:
            imported["document"]["archive_scope"] = payload["scope"]
        for take in imported.get("takes", []):
            for key in ("id", "asset_id", "passage_id"):
                take[key] = ref(take[key])
            if isinstance(take.get("request", {}).get("passage"), dict):
                passage(take["request"]["passage"])
            request = take.get("request", {})
            for recording in request.get("pronunciation_recordings", []):
                recording["asset_id"] = ref(recording["asset_id"])
            composition = request.get("composition")
            if isinstance(composition, dict) and isinstance(composition.get("segments"), list):
                for segment in composition["segments"]:
                    if not isinstance(segment, dict):
                        raise ValueError("Invalid composition provenance")
                    segment["asset_id"] = ref(segment.get("asset_id"))
                    old_take = segment.get("take_id")
                    if isinstance(old_take, str):
                        mapping.setdefault(old_take, uid())
                        segment["take_id"] = ref(old_take)
            repair = request.get("phrase_repair")
            if isinstance(repair, dict):
                repair["source_passage_id"] = ref(repair.get("source_passage_id"))
        for revision in imported.get("revisions", []):
            revision["id"] = ref(revision["id"])
            document(revision["document"])
        for item in imported.get("approvals", []):
            item["id"] = ref(item["id"])
            item["revision_id"] = ref(item["revision_id"])
        for item in imported.get("recording_acknowledgements", []):
            item["id"] = ref(item["id"])
            item["revision_id"] = ref(item["revision_id"])
            for recording in item["recordings"]:
                for key in ("clip_id", "take_id"):
                    recording[key] = ref(recording[key])
        imported["reviews"] = remap_reviews(project, mapping)
        from .voice_identity import rekey_portable_tracks

        rekey_portable_tracks(
            project,
            imported,
            assets,
            [{**asset, "id": mapping[asset["id"]]} for asset in assets],
            mapping,
            bind_unkeyed=True,
        )
        project_id = imported["id"]
        stamp = now()
        with store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute(
                "INSERT INTO projects VALUES (?,?,?,?,?,?,?,?,?)",
                (
                    project_id,
                    imported["name"],
                    imported.get("client_label"),
                    0,
                    stamp,
                    stamp,
                    encode(imported["document"]),
                    "[]",
                    "[]",
                ),
            )
            for asset in assets:
                ident = mapping[asset["id"]]
                target = store.asset_dir / ident
                publish_audio(db, store.asset_dir, project_id, asset["path"], ident, expected=asset)
                copied.append(target)
            for take in imported.get("takes", []):
                db.execute(
                    "INSERT INTO takes VALUES (?,?,?,?,?,?,?,?,?)",
                    (
                        take["id"],
                        project_id,
                        take["passage_id"],
                        take["asset_id"],
                        take["text"],
                        take["engine"],
                        take.get("model_size"),
                        take["created_at"],
                        encode(take.get("request", {})),
                    ),
                )
            for revision in imported.get("revisions", []):
                db.execute(
                    "INSERT INTO revisions VALUES (?,?,?,?,?,?)",
                    (
                        revision["id"],
                        project_id,
                        revision["name"],
                        revision["created_at"],
                        encode(revision["document"]),
                        revision["project_revision"],
                    ),
                )
            restore_reviews(db, project_id, imported["reviews"])
            for approval in imported.get("approvals", []):
                if not db.execute(
                    "SELECT 1 FROM revisions WHERE id=? AND project_id=?", (approval["revision_id"], project_id)
                ).fetchone():
                    raise ValueError("Approval revision missing")
                db.execute(
                    "INSERT INTO approvals VALUES (?,?,?,?,?)",
                    (approval["id"], project_id, approval["revision_id"], approval.get("note"), approval["created_at"]),
                )
            for item in imported.get("recording_acknowledgements", []):
                db.execute(
                    "INSERT INTO recording_acknowledgements VALUES (?,?,?,?,?)",
                    (item["id"], project_id, item["revision_id"], item["created_at"], encode(item["recordings"])),
                )
            for doc in [imported["document"]] + [r["document"] for r in imported.get("revisions", [])]:
                for clip in doc["clips"]:
                    store._validate_clip(db, project_id, doc, clip)
                for p in doc["passages"]:
                    if (
                        p.get("selected_take_id")
                        and not db.execute(
                            "SELECT 1 FROM takes WHERE id=? AND project_id=? AND passage_id=?",
                            (p["selected_take_id"], project_id, p["id"]),
                        ).fetchone()
                    ):
                        raise ValueError("Invalid selected take")
            return store._project(db, project_id)
    except BaseException:
        if copied:
            discard_unregistered(db, copied)
        raise
    finally:
        shutil.rmtree(staging, ignore_errors=True)
