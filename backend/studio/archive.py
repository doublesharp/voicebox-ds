"""Versioned, validated portable studio archives; no database access."""

import hashlib
import json
import math
import os
import re
import shutil
import stat
import tempfile
import zipfile
from pathlib import Path, PurePosixPath

import soundfile as sf

from .archive_scope import (
    asset_references as _references,  # noqa: F401 - retain the prior private collector alias.
    mark_missing_references,
    prepare_export,
    required_references,
    unavailable_references,
    validate_reference_markers,
    validate_scope,
    voice_snapshots,
)
from .timing import resampled_frames


def _records(items, label):
    if not isinstance(items, list):
        raise ValueError(f"invalid {label} list")
    result = {}
    for item in items:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not item["id"] or item["id"] in result:
            raise ValueError(f"invalid or duplicate {label} id")
        result[item["id"]] = item
    return result


def _nonnegative_integer(value, label):
    if type(value) is not int or value < 0:
        raise ValueError(f"invalid {label}")
    return value


def _finite(value, label, minimum=None, maximum=None):
    if type(value) not in (int, float) or not math.isfinite(value):
        raise ValueError(f"invalid {label}")
    if (minimum is not None and value < minimum) or (maximum is not None and value > maximum):
        raise ValueError(f"invalid {label}")
    return value


def _string(value, label):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"invalid {label}")
    return value


def _validate_generation(passage, assets):
    direction = passage.get("direction")
    if not isinstance(direction, dict) or not isinstance(direction.get("instruct"), str):
        raise ValueError("invalid passage direction")
    if "seed" not in direction or (direction["seed"] is not None and type(direction["seed"]) is not int):
        raise ValueError("invalid generation seed")
    if not 1 <= _nonnegative_integer(direction.get("max_chunk_chars"), "chunk size") <= 100000:
        raise ValueError("invalid generation chunk size")
    if _nonnegative_integer(direction.get("crossfade_ms"), "crossfade") > 10000:
        raise ValueError("invalid generation crossfade")
    if "speed" in direction:
        _finite(direction["speed"], "generation speed", 0.5, 2.0)
    if "chapter" in passage and passage["chapter"] is not None:
        ch = passage["chapter"]
        if not isinstance(ch, str) or len(ch.strip()) > 120 or "\n" in ch or "\r" in ch:
            raise ValueError("invalid passage chapter")
    voice = passage.get("voice_snapshot")
    if voice is None:
        return
    if not isinstance(voice, dict):
        raise ValueError("invalid voice snapshot")
    _string(voice.get("engine"), "voice engine")
    if voice.get("model_size") is not None:
        _string(voice["model_size"], "voice model size")
    kind = voice.get("voice_type")
    if kind == "preset":
        _string(voice.get("preset_engine"), "preset engine")
        _string(voice.get("preset_voice_id"), "preset voice")
    elif kind == "designed":
        _string(voice.get("design_prompt"), "voice design")
    elif kind == "cloned":
        missing = unavailable_references(voice)
        samples = voice.get("samples")
        if not isinstance(samples, list) or not samples:
            raise ValueError("missing voice samples")
        for sample in samples:
            if (
                not isinstance(sample, dict)
                or not isinstance(sample.get("asset_id"), str)
                or (sample["asset_id"] not in assets and sample["asset_id"] not in missing)
                or not isinstance(sample.get("reference_text"), str)
            ):
                raise ValueError("invalid voice sample")
    else:
        raise ValueError("invalid voice type")


def _validate_document(doc, assets, takes):
    if not isinstance(doc, dict) or type(doc.get("schema_version")) is not int or doc["schema_version"] != 1:
        raise ValueError("unsupported document schema")
    rate = _nonnegative_integer(doc.get("sample_rate"), "working sample rate")
    if rate != 48000 or type(doc.get("channels")) is not int or doc["channels"] != 2:
        raise ValueError("Unsupported project format: S1 requires 48 kHz stereo")
    passages = _records(doc.get("passages"), "passage")
    tracks = _records(doc.get("tracks"), "track")
    clips = _records(doc.get("clips"), "clip")
    from .captions import validate_caption_document
    from .pronunciation import validate_rules

    for rule in validate_rules(doc.get("pronunciation_rules", [])):
        recording = rule.get("recording_asset_id")
        if recording is not None and recording not in assets:
            raise ValueError("A pronunciation recording is not in this project")
    validate_caption_document(doc, assets, takes)
    annotations = doc.get("take_annotations", {})
    if not isinstance(annotations, dict):
        raise ValueError("invalid take annotations")
    for take_id, annotation in annotations.items():
        if (
            take_id not in takes
            or not isinstance(annotation, dict)
            or set(annotation) != {"name", "note"}
            or any(
                not isinstance(annotation[key], str) or len(annotation[key]) > limit
                for key, limit in (("name", 120), ("note", 4000))
            )
        ):
            raise ValueError("invalid take annotation")
    if not isinstance(doc.get("language"), str) or not doc["language"]:
        raise ValueError("invalid project language")
    for passage in passages.values():
        _validate_generation(passage, assets)
        if not isinstance(passage.get("text"), str) or not isinstance(passage.get("language"), str):
            raise ValueError("invalid passage text or language")
        if type(passage.get("locked")) is not bool:
            raise ValueError("invalid passage lock")
        for key in ("input_revision", "selection_token"):
            _nonnegative_integer(passage.get(key), key)
        take_id = passage.get("selected_take_id")
        if take_id is not None and (take_id not in takes or takes[take_id].get("passage_id") != passage["id"]):
            raise ValueError("selected take is not available for passage")
    for track in tracks.values():
        _finite(track.get("gain"), "track gain", 0)
        if type(track.get("mute")) is not bool or type(track.get("solo")) is not bool:
            raise ValueError("invalid track mute or solo")
    for clip in clips.values():
        asset_id = clip.get("asset_id")
        if asset_id not in assets or clip.get("track_id") not in tracks:
            raise ValueError("clip references missing asset or track")
        passage_id, take_id = clip.get("passage_id"), clip.get("take_id")
        if passage_id is not None and passage_id not in passages:
            raise ValueError("clip references missing passage")
        if take_id is not None and (
            take_id not in takes
            or takes[take_id].get("asset_id") != asset_id
            or (passage_id is not None and takes[take_id].get("passage_id") != passage_id)
        ):
            raise ValueError("clip take does not match its audio or passage")
        values = {
            key: _nonnegative_integer(clip.get(key), key)
            for key in ("start_sample", "trim_start_sample", "trim_end_sample", "fade_in_samples", "fade_out_samples")
        }
        asset = assets[asset_id]
        frames = resampled_frames(asset["frames"], asset["sample_rate"], rate)
        length = frames - values["trim_start_sample"] - values["trim_end_sample"]
        if length <= 0:
            raise ValueError("invalid clip source range")
        from .fades import fade_envelopes

        fade_envelopes(clip, length, frames)
        _finite(clip.get("gain"), "clip gain", 0)
    for track in tracks.values():
        _finite(track.get("effect_gain_db", 0), "track gain effect", -40, 40)
        from .processing import validate_chain

        validate_chain(track.get("effects_chain", []))
    mix = doc.get("mix")
    if not isinstance(mix, dict) or type(mix.get("normalize")) is not bool:
        raise ValueError("invalid mix settings")
    _finite(mix.get("target_lufs"), "loudness target", -70, -5)
    _finite(mix.get("max_true_peak_dbtp"), "true peak target", -9, 0)
    _finite(mix.get("master_gain", 1), "master gain", 0, 16)
    if type(mix.get("limiter", False)) is not bool:
        raise ValueError("invalid sample peak limiter")
    if type(mix.get("duck_music", False)) is not bool:
        raise ValueError("invalid music ducking")
    _finite(mix.get("duck_db", -14.0), "ducking depth", -30, 0)
    _finite(mix.get("duck_attack_ms", 80.0), "ducking attack", 5, 1000)
    _finite(mix.get("duck_release_ms", 350.0), "ducking release", 20, 3000)


def _validate_project(project, assets):
    if not isinstance(project, dict) or not isinstance(project.get("document"), dict):
        raise ValueError("invalid project")
    _string(project.get("id"), "project id")
    _string(project.get("name"), "project name")
    if project.get("client_label") is not None and not isinstance(project["client_label"], str):
        raise ValueError("invalid client label")
    takes = _records(project.get("takes", []), "take")
    for take in takes.values():
        if (
            take.get("asset_id") not in assets
            or not isinstance(take.get("text"), str)
            or not isinstance(take.get("passage_id"), str)
        ):
            raise ValueError("invalid take or missing take audio")
        _string(take.get("engine"), "take engine")
        _string(take.get("created_at"), "take date")
        if not isinstance(take.get("request", {}), dict):
            raise ValueError("invalid take request")
        if "passage" in take.get("request", {}) and not isinstance(take["request"]["passage"], dict):
            raise ValueError("invalid frozen passage snapshot")
        recordings = take.get("request", {}).get("pronunciation_recordings", [])
        if not isinstance(recordings, list) or len(recordings) > 200 or any(
            not isinstance(recording, dict)
            or not isinstance(recording.get("asset_id"), str)
            or recording["asset_id"] not in assets
            or not isinstance(recording.get("reference_text"), str)
            for recording in recordings
        ):
            raise ValueError("invalid take pronunciation recording")
    documents = [project["document"]]
    revisions = _records(project.get("revisions", []), "revision")
    from .review_schema import validate_reviews

    validate_reviews(project)
    for revision in revisions.values():
        if not isinstance(revision, dict) or not isinstance(revision.get("document"), dict):
            raise ValueError("invalid revision")
        _string(revision.get("name"), "revision name")
        _string(revision.get("created_at"), "revision date")
        _nonnegative_integer(revision.get("project_revision"), "checkpoint revision")
        documents.append(revision["document"])
    for doc in documents:
        _validate_document(doc, assets, takes)
    for approval in _records(project.get("approvals", []), "approval").values():
        _string(approval.get("created_at"), "approval date")
        if approval.get("revision_id") not in revisions:
            raise ValueError("approval references missing revision")
    for item in _records(project.get("recording_acknowledgements", []), "recording acknowledgement").values():
        if item.get("revision_id") not in revisions or not isinstance(item.get("recordings"), list):
            raise ValueError("invalid recording acknowledgement")
        _string(item.get("created_at"), "acknowledgement date")
        clips = {c["id"]: c for c in revisions[item["revision_id"]]["document"]["clips"]}
        for recording in item["recordings"]:
            if (
                not isinstance(recording, dict)
                or recording.get("clip_id") not in clips
                or recording.get("take_id") not in takes
                or clips[recording["clip_id"]].get("take_id") != recording["take_id"]
                or recording.get("text") != takes[recording["take_id"]]["text"]
            ):
                raise ValueError("invalid acknowledged recording")
    validate_reference_markers(project, assets)
    if not required_references(project).issubset(assets):
        raise ValueError("missing referenced asset")


def _metadata(assets):
    if not isinstance(assets, list):
        raise ValueError("invalid assets")
    ids = {}
    for asset in assets:
        if not isinstance(asset, dict) or not isinstance(asset.get("id"), str) or not asset["id"] or asset["id"] in ids:
            raise ValueError("invalid or duplicate asset id")
        if not isinstance(asset.get("hash"), str) or not re.fullmatch(r"[0-9a-f]{64}", asset["hash"]):
            raise ValueError("invalid asset hash")
        if (
            isinstance(asset.get("size_bytes"), bool)
            or not isinstance(asset.get("size_bytes"), int)
            or asset["size_bytes"] < 0
        ):
            raise ValueError("invalid asset size")
        if (
            _nonnegative_integer(asset.get("sample_rate"), "source sample rate") <= 0
            or type(asset.get("channels")) is not int
            or asset["channels"] not in (1, 2)
            or _nonnegative_integer(asset.get("frames"), "source frame count") <= 0
        ):
            raise ValueError("invalid source format")
        duration = _finite(asset.get("duration"), "source duration", 0)
        if not math.isclose(duration, asset["frames"] / asset["sample_rate"], rel_tol=1e-9, abs_tol=1e-9):
            raise ValueError("source duration mismatch")
        ids[asset["id"]] = asset
    return ids


def _digest(path):
    digest = hashlib.sha256()
    size = 0
    with open(path, "rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
            size += len(chunk)
    return digest.hexdigest(), size


def _validate_audio(path, metadata):
    try:
        info = sf.info(str(path))
        if info.frames <= 0 or info.channels not in (1, 2) or info.samplerate <= 0:
            raise ValueError("invalid audio asset")
        if (info.samplerate, info.channels, info.frames) != (
            metadata["sample_rate"],
            metadata["channels"],
            metadata["frames"],
        ):
            raise ValueError("audio metadata mismatch")
    except (RuntimeError, OSError) as exc:
        raise ValueError("invalid audio asset") from exc


def write_archive(
    project_payload, assets, resolve_asset, output_path, *, take_scope="all", include_regeneration_references=True
):
    project_payload, assets, scope = prepare_export(
        project_payload, assets, take_scope=take_scope, include_regeneration_references=include_regeneration_references
    )
    ids = _metadata(assets)
    _validate_project(project_payload, ids)
    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=".archive-", suffix=".zip", dir=output.parent)
    os.close(fd)
    try:
        manifest_assets = []
        with zipfile.ZipFile(name, "w", compression=zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
            for index, asset in enumerate(assets):
                source = Path(resolve_asset(asset["id"]))
                if source.is_symlink() or not source.is_file():
                    raise ValueError("invalid source asset")
                _validate_audio(source, asset)
                if _digest(source) != (asset["hash"], asset["size_bytes"]):
                    raise ValueError("asset integrity mismatch")
                entry = f"assets/{index:08d}"
                metadata = {k: v for k, v in asset.items() if k != "path"}
                metadata["archive_path"] = entry
                manifest_assets.append(metadata)
                archive.write(source, entry)
            manifest = {"schema_version": 1, "project": project_payload, "assets": manifest_assets, "scope": scope}
            archive.writestr("manifest.json", json.dumps(manifest, allow_nan=False, separators=(",", ":")))
        with zipfile.ZipFile(name, "r") as check:
            for asset in manifest_assets:
                digest = hashlib.sha256()
                size = 0
                with check.open(asset["archive_path"]) as source:
                    while chunk := source.read(1024 * 1024):
                        digest.update(chunk)
                        size += len(chunk)
                if (digest.hexdigest(), size) != (asset["hash"], asset["size_bytes"]):
                    raise ValueError("asset changed during archive creation")
        os.replace(name, output)
        return {"path": str(output), "size_bytes": output.stat().st_size}
    finally:
        if os.path.exists(name):
            os.unlink(name)


def read_archive(archive_path, destination, *, max_total_bytes=1073741824, max_files=10000):
    if max_total_bytes < 0 or max_files < 1:
        raise ValueError("invalid archive limits")
    destination = Path(destination)
    if destination.is_symlink():
        raise ValueError("invalid destination")
    destination.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix="studio-import-", dir=destination))
    try:
        with zipfile.ZipFile(archive_path, "r") as archive:
            entries = archive.infolist()
            if len(entries) > max_files or sum(e.file_size for e in entries) > max_total_bytes:
                raise ValueError("archive exceeds limits")
            names = set()
            for entry in entries:
                name = entry.filename
                path = PurePosixPath(name)
                mode = entry.external_attr >> 16
                if (
                    not name
                    or "\\" in name
                    or path.is_absolute()
                    or any(p in ("", ".", "..") for p in name.split("/"))
                    or name in names
                    or stat.S_ISLNK(mode)
                    or entry.is_dir()
                ):
                    raise ValueError("unsafe archive entry")
                names.add(name)
            if "manifest.json" not in names:
                raise ValueError("missing manifest")
            if archive.getinfo("manifest.json").file_size > min(max_total_bytes, 8 * 1024 * 1024):
                raise ValueError("manifest exceeds limits")
            try:

                def invalid_constant(value):
                    raise ValueError("nonfinite JSON value")

                manifest = json.loads(archive.read("manifest.json"), parse_constant=invalid_constant)
            except (ValueError, UnicodeError) as exc:
                raise ValueError("invalid manifest") from exc
            if (
                not isinstance(manifest, dict)
                or type(manifest.get("schema_version")) is not int
                or manifest["schema_version"] != 1
            ):
                raise ValueError("unsupported archive schema")
            scope = validate_scope(manifest.get("scope"))
            assets = manifest.get("assets")
            ids = _metadata(assets)
            _validate_project(manifest.get("project"), ids)
            paths = [asset.get("archive_path") for asset in assets]
            if (
                any(not isinstance(p, str) or not re.fullmatch(r"assets/[0-9]{8}", p) for p in paths)
                or len(set(paths)) != len(paths)
                or names - {"manifest.json", *paths}
            ):
                raise ValueError("invalid asset entries")
            missing = {asset["id"] for asset in assets if asset["archive_path"] not in names}
            if missing:
                import copy

                from .voice_identity import rekey_portable_tracks

                original = copy.deepcopy(manifest["project"])
                original_assets = assets
                mark_missing_references(manifest["project"], missing)
                assets = [asset for asset in assets if asset["id"] not in missing]
                rekey_portable_tracks(original, manifest["project"], original_assets, assets)
                ids = _metadata(assets)
                _validate_project(manifest["project"], ids)
                paths = [asset["archive_path"] for asset in assets]
                if scope is not None:
                    scope["missing_reference_count"] = len(
                        set().union(*(unavailable_references(v) for v in voice_snapshots(manifest["project"])))
                    )
            staged = []
            for asset, entry in zip(assets, paths, strict=False):
                info = archive.getinfo(entry)
                if info.file_size != asset["size_bytes"]:
                    raise ValueError("asset size mismatch")
                target = stage / Path(entry).name
                digest = hashlib.sha256()
                size = 0
                with archive.open(info) as source, target.open("xb") as output:
                    while chunk := source.read(1024 * 1024):
                        size += len(chunk)
                        if size > asset["size_bytes"]:
                            raise ValueError("asset size mismatch")
                        digest.update(chunk)
                        output.write(chunk)
                if size != asset["size_bytes"] or digest.hexdigest() != asset["hash"]:
                    raise ValueError("asset integrity mismatch")
                _validate_audio(target, asset)
                staged.append({**{k: v for k, v in asset.items() if k != "archive_path"}, "path": str(target)})
            return {"project": manifest["project"], "assets": staged, "scope": scope}
    except Exception:
        shutil.rmtree(stage, ignore_errors=True)
        raise
