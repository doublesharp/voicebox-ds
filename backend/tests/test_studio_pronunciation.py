"""Pronunciation aliases are frozen inputs, never edits to the source script."""

import asyncio
import json

import numpy as np
import pytest
import soundfile as sf

from backend.studio.jobs import StudioJobs
from backend.studio.storage import StudioStore, encode


def rule(source="API", replacement="A P I", **kwargs):
    return {
        "id": source,
        "source": source,
        "replacement": replacement,
        "profile_id": None,
        "case_sensitive": False,
        "whole_word": True,
        **kwargs,
    }


def capabilities(voice):
    return {"languages": ["en"], "expressive_tags": [], "supports_instruct": False, "supports_seed": False}


def put_rules(store, project_id, rules):
    with store.connect() as db:
        doc = json.loads(db.execute("SELECT document FROM projects WHERE id=?", (project_id,)).fetchone()[0])
        doc["pronunciation_rules"] = rules
        db.execute("UPDATE projects SET document=? WHERE id=?", (encode(doc), project_id))


@pytest.mark.asyncio
async def test_generation_freezes_aliases_and_preserves_source_text(tmp_path):
    store = StudioStore(tmp_path)
    project = store.create_project("Alias", script="Call the API.")
    pid = project["document"]["passages"][0]["id"]
    put_rules(store, project["id"], [rule()])
    pending, requests = [], []

    async def synth(request):
        requests.append(request)
        return np.zeros(100, dtype="float32"), 1000

    jobs = StudioJobs(
        store, synth=synth, capability_resolver=capabilities, enqueue=lambda _, coro: pending.append(coro)
    )
    jobs.submit(project["id"], "alias", [pid], 1, False)
    # Queued jobs keep their own dictionary even when the draft is changed.
    put_rules(store, project["id"], [rule(replacement="application interface")])
    await pending.pop()
    assert requests[0].get("spoken_text") == "Call the A P I."
    assert requests[0]["passage"]["text"] == "Call the API."
    take = store.get_project(project["id"])["takes"][0]
    assert take["text"] == "Call the API."
    assert take["request"]["spoken_text"] == "Call the A P I."


@pytest.mark.asyncio
async def test_synthesis_passes_frozen_spoken_text_to_existing_chunk_adapter(tmp_path, monkeypatch):
    from backend import backends
    from backend.studio.jobs import synthesize
    from backend.studio.storage import passage
    from backend.utils import chunked_tts

    seen = []

    async def ready(*args):
        return None

    async def generate(model, text, prompt, **kwargs):
        seen.append(text)
        return np.zeros(100, dtype="float32"), 1000

    monkeypatch.setattr(backends, "ensure_model_cached_or_raise", ready)
    monkeypatch.setattr(backends, "load_engine_model", ready)
    monkeypatch.setattr(backends, "get_tts_backend_for_engine", lambda _: object())
    monkeypatch.setattr(backends, "engine_needs_trim", lambda _: False)
    monkeypatch.setattr(backends, "engine_retries_runaway", lambda _: False)
    monkeypatch.setattr(chunked_tts, "generate_chunked", generate)
    p = passage("Call API.", "en")
    p["voice_snapshot"] = {"engine": "test", "voice_type": "preset", "preset_engine": "test", "preset_voice_id": "one"}
    await synthesize({"passage": p, "spoken_text": "Call A P I."}, StudioStore(tmp_path))
    assert seen == ["Call A P I."]


def test_matching_is_leftmost_longest_nonrecursive_and_voice_scoped():
    from backend.studio.pronunciation import spoken_text

    rules = [
        rule(),
        rule("API key", "access key"),
        rule("A P I", "recursive"),
        rule("API", "voice alias", id="voice", profile_id="narrator"),
    ]
    assert spoken_text("API key, API, APIs, api.", rules, None) == "access key, A P I, APIs, A P I."
    assert spoken_text("API key, API.", rules, "narrator") == "access key, voice alias."
    assert (
        spoken_text("C++ and élan", [rule("C++", "C plus plus"), rule("élan", "ay lan")], None)
        == "C plus plus and ay lan"
    )


def test_rule_changes_invalidate_only_affected_passages_and_preserve_selected_audio():
    from backend.studio.pronunciation import apply_pronunciation_command
    from backend.studio.storage import document

    doc = document("API\n\nNothing changes", "en")
    doc["passages"][0]["selected_take_id"] = "original"
    apply_pronunciation_command(doc, {"rules": [rule()]})
    first, second = doc["passages"]
    assert (first["input_revision"], first["selection_token"], first["selected_take_id"]) == (1, 1, "original")
    assert (second["input_revision"], second["selection_token"]) == (0, 0)
    first["locked"] = True
    with pytest.raises(ValueError, match="locked"):
        apply_pronunciation_command(doc, {"rules": []})
    assert doc["pronunciation_rules"] == [rule()]


def test_dictionary_command_is_revisioned_replayable_and_undoable(tmp_path):
    store = StudioStore(tmp_path)
    project = store.create_project("Dictionary", script="API")
    changed = store.command(project["id"], "dictionary", 0, "set_pronunciation_rules", {"rules": [rule()]})
    assert changed["revision"] == 1
    assert changed["document"]["pronunciation_rules"] == [rule()]
    assert store.command(project["id"], "dictionary", 0, "set_pronunciation_rules", {"rules": [rule()]}) == changed
    undone = store.command(project["id"], "undo", 1, "undo", {})
    assert undone["document"].get("pronunciation_rules", []) == []
    restored = StudioStore(tmp_path).get_project(project["id"])
    assert restored["revision"] == 2


def test_recorded_pronunciation_saves_without_alias_and_keeps_spoken_text(tmp_path):
    from backend.studio.archive import write_archive
    from backend.studio.portability import import_archive
    from backend.studio.pronunciation import spoken_text

    store = StudioStore(tmp_path / "studio")
    project = store.create_project("Dictionary", script="Call API.")
    other = store.create_project("Other")
    recording = tmp_path / "example.wav"
    sf.write(recording, np.full(2400, 0.1, dtype=np.float32), 24000)
    foreign = store.add_asset(other["id"], recording)
    with pytest.raises(ValueError, match="not in this project"):
        store.command(project["id"], "foreign", 0, "set_pronunciation_rules", {
            "rules": [rule(replacement="", recording_asset_id=foreign["id"])],
        })

    local = store.add_asset(project["id"], recording)
    recorded = rule(replacement="", recording_asset_id=local["id"])
    store.command(project["id"], "dictionary", 0, "set_pronunciation_rules", {"rules": [recorded]})
    restored = StudioStore(store.root).get_project(project["id"])
    assert restored["document"]["pronunciation_rules"] == [recorded]
    assert spoken_text("Call API.", [recorded]) == "Call API."
    assert restored["document"]["passages"][0]["input_revision"] == 0
    archive = tmp_path / "dictionary.zip"
    write_archive(restored, restored["assets"], store.asset_path, archive, take_scope="used")
    imported = import_archive(store, archive)
    imported_rule = imported["document"]["pronunciation_rules"][0]
    assert imported_rule["recording_asset_id"] != local["id"]
    assert store.asset_path(imported_rule["recording_asset_id"]).read_bytes() == recording.read_bytes()


@pytest.mark.asyncio
async def test_generation_freezes_only_recordings_used_by_the_selected_qwen_voice(tmp_path):
    store = StudioStore(tmp_path / "studio")
    project = store.create_project("Dictionary", script="Call API and API again.")
    pid = project["document"]["passages"][0]["id"]
    recording = tmp_path / "example.wav"
    sf.write(recording, np.full(2400, 0.1, dtype=np.float32), 24000)
    asset = store.add_asset(project["id"], recording)
    with store.connect() as db:
        doc = project["document"]
        doc["passages"][0]["voice_snapshot"] = {"engine": "qwen", "voice_type": "cloned"}
        db.execute("UPDATE projects SET document=? WHERE id=?", (encode(doc), project["id"]))
    put_rules(store, project["id"], [
        rule(replacement="", recording_asset_id=asset["id"]),
        rule(source="USB", replacement="", recording_asset_id=asset["id"]),
        rule(source="Call", replacement="", profile_id="a-different-voice", recording_asset_id=asset["id"]),
    ])
    pending, requests = [], []

    async def synth(request):
        requests.append(request)
        return np.zeros(100, dtype="float32"), 1000

    jobs = StudioJobs(store, synth=synth, capability_resolver=capabilities, enqueue=lambda _, coro: pending.append(coro))
    jobs.submit(project["id"], "recorded-guide", [pid], 1, False)
    put_rules(store, project["id"], [])
    await pending.pop()
    assert requests[0]["spoken_text"] == "Call API and API again."
    assert requests[0]["pronunciation_recordings"] == [{"asset_id": asset["id"], "reference_text": "API"}]


@pytest.mark.asyncio
async def test_dictionary_change_requires_explicit_stale_audio_delivery_approval(tmp_path):
    from backend.studio.delivery import StudioDelivery

    store = StudioStore(tmp_path)
    project = store.create_project("Delivery", script="API")
    pid = project["document"]["passages"][0]["id"]
    pending = []

    async def synth(request):
        return np.zeros(100, dtype="float32"), 1000

    jobs = StudioJobs(
        store, synth=synth, capability_resolver=capabilities, enqueue=lambda _, coro: pending.append(coro)
    )
    jobs.submit(project["id"], "before-rules", [pid], 1, True)
    await pending.pop()
    project = store.get_project(project["id"])
    project = store.command(project["id"], "insert", project["revision"], "insert_passages", {"passage_ids": [pid]})
    project = store.command(project["id"], "rules", project["revision"], "set_pronunciation_rules", {"rules": [rule()]})
    project = store.checkpoint(project["id"], "checkpoint", project["revision"], "Old recording")
    delivery = StudioDelivery(store, schedule=lambda coro: pending.append(coro))
    with pytest.raises(ValueError, match="Stale audio"):
        delivery.submit(project["id"], "render", project["revisions"][0]["id"], "mix", "wav")


@pytest.mark.parametrize(
    "rules",
    [[rule(source="")], [rule(replacement="")], [rule(), rule()], [rule(case_sensitive="yes")], [rule(profile_id=2)]],
)
def test_invalid_dictionary_is_rejected(rules):
    from backend.studio.pronunciation import validate_rules

    with pytest.raises(ValueError, match="pronunciation"):
        validate_rules(rules)


@pytest.mark.asyncio
async def test_phrase_generation_records_phrase_without_adopting_original_selection(tmp_path):
    store = StudioStore(tmp_path)
    project = store.create_project("Repair", script="The original API phrase.")
    pid = project["document"]["passages"][0]["id"]
    put_rules(store, project["id"], [rule()])
    pending, requests = [], []

    async def synth(request):
        requests.append(request)
        return np.zeros(100, dtype="float32"), 1000

    jobs = StudioJobs(
        store, synth=synth, capability_resolver=capabilities, enqueue=lambda _, coro: pending.append(coro)
    )
    jobs.submit(project["id"], "phrase", [pid], 1, False, phrase_text="API phrase")
    await pending.pop()
    request = requests[0]
    assert request["spoken_text"] == "A P I phrase"
    assert request["phrase_repair"] == {"source_text": "The original API phrase.", "source_passage_id": pid}
    project = store.get_project(project["id"])
    assert project["takes"][0]["text"] == "API phrase"
    assert project["document"]["passages"][0]["text"] == "The original API phrase."
    assert project["document"]["passages"][0]["selected_take_id"] is None
    with pytest.raises(ValueError, match="phrase"):
        jobs.submit(project["id"], "bad", [pid], 1, True, phrase_text="API")


@pytest.mark.asyncio
async def test_new_dictionary_prevents_inflight_generation_from_adopting(tmp_path):
    from backend.studio.pronunciation import apply_pronunciation_command

    store = StudioStore(tmp_path)
    project = store.create_project("Guard", script="API")
    pid = project["document"]["passages"][0]["id"]
    started, release = asyncio.Event(), asyncio.Event()
    pending = []

    async def synth(request):
        started.set()
        await release.wait()
        return np.zeros(100, dtype="float32"), 1000

    jobs = StudioJobs(
        store, synth=synth, capability_resolver=capabilities, enqueue=lambda _, coro: pending.append(coro)
    )
    jobs.submit(project["id"], "before-rules", [pid], 1, True)
    task = asyncio.create_task(pending.pop())
    await started.wait()
    with store.connect() as db:
        doc = json.loads(db.execute("SELECT document FROM projects WHERE id=?", (project["id"],)).fetchone()[0])
        apply_pronunciation_command(doc, {"rules": [rule()]})
        db.execute("UPDATE projects SET document=? WHERE id=?", (encode(doc), project["id"]))
    release.set()
    await task
    project = store.get_project(project["id"])
    assert len(project["takes"]) == 1
    assert project["document"]["passages"][0]["selected_take_id"] is None
