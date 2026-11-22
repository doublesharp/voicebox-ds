"""The shared studio runtime follows the final configured application data root."""

from concurrent.futures import ThreadPoolExecutor

from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.routes import StudioRuntime
from backend.studio.api import make_router


def test_router_registration_is_lazy_and_uses_final_data_directory(tmp_path):
    original = tmp_path / "original"
    final = tmp_path / "final"
    selected = {"path": original}
    runtime = StudioRuntime(data_dir=lambda: selected["path"])
    app = FastAPI()
    app.include_router(make_router(runtime.store, runtime.jobs))
    assert not original.exists()
    selected["path"] = final
    with TestClient(app) as client:
        created = client.post("/studio/v1/projects", json={"name": "Persisted", "script": "Hello"})
        assert created.status_code == 200
        assert client.get("/studio/v1/projects").json()["items"][0]["id"] == created.json()["id"]
    assert not original.exists()
    assert (final / "studio" / "studio.sqlite").is_file()


def test_concurrent_initialization_uses_one_store_and_job_manager(tmp_path):
    runtime = StudioRuntime(data_dir=lambda: tmp_path)
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(lambda _: runtime.initialize(), range(12)))
    store, jobs = runtime._store, runtime._jobs
    runtime.initialize()
    assert runtime._store is store and runtime._jobs is jobs
    assert jobs.store is store


def test_generation_job_submission_through_runtime_proxy_does_not_recurse(tmp_path):
    import asyncio
    import copy
    import threading

    runtime = StudioRuntime(data_dir=lambda: tmp_path)
    app = FastAPI()
    app.include_router(make_router(runtime.store, runtime.jobs))

    with TestClient(app) as client:
        created = client.post("/studio/v1/projects", json={"name": "Gnarlyr", "script": "Hello Gnarlyr"})
        assert created.status_code == 200
        project_id = created.json()["id"]

        # Validation failures must return 422, not crash with 500 RecursionError in copy.copy(jobs).
        invalid = client.post(
            f"/studio/v1/projects/{project_id}/generation-jobs",
            json={"idempotency_key": "empty-passages", "passage_ids": [], "count": 1, "adopt": False},
        )
        assert invalid.status_code == 422

        # copy.copy on the lazy proxy must shallow-copy the underlying StudioJobs instance.
        copied = copy.copy(runtime.jobs)
        assert type(copied) is type(runtime._jobs)
        assert copied is not runtime._jobs

        # Assign a minimal voice snapshot and verify submit schedules enqueue on the event loop thread
        # without mutating runtime._jobs.enqueue.
        passage_id = created.json()["document"]["passages"][0]["id"]
        with runtime._store.connect() as db:
            doc = runtime._store._project(db, project_id)["document"]
            doc["passages"][0]["profile_id"] = "prof-1"
            doc["passages"][0]["voice_snapshot"] = {
                "id": "prof-1",
                "name": "Narrator",
                "voice_type": "preset",
                "preset_engine": "kokoro",
                "preset_voice_id": "af_heart",
                "engine": "kokoro",
                "model_size": "default",
            }
            import json

            db.execute("UPDATE projects SET document=? WHERE id=?", (json.dumps(doc), project_id))

        enqueued = []
        enqueue_threads = []
        runtime._jobs.capability_resolver = lambda _voice: {
            "supports_instruct": False,
            "supports_voice_design": False,
            "supports_seed": True,
            "languages": ["en"],
            "expressive_tags": [],
            "recognized_tags": [],
            "commercial_use": "allowed",
            "registry_identity": {"engine": "kokoro", "model_size": "default"},
            "registry_revision": "rev-1",
        }

        def fake_enqueue(job_id, coro):
            enqueue_threads.append(threading.get_ident())
            asyncio.get_running_loop()  # Must run on the ASGI event loop thread.
            enqueued.append(job_id)
            coro.close()

        runtime._jobs.enqueue = fake_enqueue

        submitted = client.post(
            f"/studio/v1/projects/{project_id}/generation-jobs",
            json={
                "idempotency_key": "valid-submit",
                "passage_ids": [passage_id],
                "count": 1,
                "adopt": True,
            },
        )
        assert submitted.status_code == 202
        jobs = submitted.json()["jobs"]
        assert len(jobs) == 1
        assert enqueued == [jobs[0]["id"]]
        assert runtime._jobs.enqueue is fake_enqueue

