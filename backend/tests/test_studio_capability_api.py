"""The HTTP project and capability readers expose the frozen Studio contract."""

from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.studio.api import make_router
from backend.studio.job_state import phase, start_attempt
from backend.studio.jobs import StudioJobs
from backend.studio.storage import StudioStore, encode, now


def client_for(store):
    app = FastAPI()
    app.include_router(make_router(store))
    return TestClient(app)


def test_commercial_engine_query_excludes_unknown_and_restricted_models(tmp_path):
    with client_for(StudioStore(tmp_path)) as client:
        all_models = client.get("/studio/v1/engines").json()["items"]
        assert all_models
        response = client.get("/studio/v1/engines?commercial_only=true")
        assert response.status_code == 200
        assert all(model["commercial_use"] == "allowed" for model in response.json()["items"])


def test_project_reader_exposes_the_same_job_attempt_and_phase_as_job_reader(tmp_path):
    store = StudioStore(tmp_path)
    project = store.create_project("Progress", script="Words")
    with store.connect() as db:
        db.execute(
            "INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?,?,?)",
            ("job", project["id"], "generation", "running", None, None, None, now(), now(), encode({})),
        )
        attempt = start_attempt(db, "job")
        phase(db, "job", attempt, "generating")
    with client_for(store) as client:
        direct = client.get("/studio/v1/jobs/job").json()
        projected = client.get(f"/studio/v1/projects/{project['id']}").json()["jobs"][0]
        assert projected.get("phase") == direct["phase"] == "generating"
        assert projected.get("attempts") == direct["attempts"]


def test_integrated_router_exposes_bounded_audition_levels(tmp_path):
    import numpy as np
    import soundfile as sf

    store = StudioStore(tmp_path / "studio")
    project = store.create_project("Audition")
    source = tmp_path / "take.wav"
    sf.write(source, np.full(2400, 0.25), 24000)
    asset = store.add_asset(project["id"], source)
    with client_for(store) as client:
        response = client.get(f"/studio/v1/assets/{asset['id']}/audition-level")
        assert response.status_code == 200
        assert response.json()["method"] == "sample_rms_v1"
        assert response.json()["rms"] == 0.25


def test_commercial_generation_policy_is_checked_before_any_job_is_queued(tmp_path):
    import numpy as np
    import soundfile as sf

    store = StudioStore(tmp_path / "studio")
    project = store.create_project("Client narration", script="Words")
    source = tmp_path / "reference.wav"
    sf.write(source, np.zeros(2400), 24000)
    asset = store.add_asset(project["id"], source)
    passage = project["document"]["passages"][0]
    passage["voice_snapshot"] = {
        "engine": "omnivoice",
        "model_size": "default",
        "voice_type": "cloned",
        "samples": [{"asset_id": asset["id"], "reference_text": "Words"}],
    }
    with store.connect() as db:
        db.execute("UPDATE projects SET document=? WHERE id=?", (encode(project["document"]), project["id"]))
    pending = []
    jobs = StudioJobs(store, enqueue=lambda ident, coro: pending.append(coro))
    app = FastAPI()
    app.include_router(make_router(store, jobs))
    request = {"idempotency_key": "client-job", "passage_ids": [passage["id"]], "count": 1, "adopt": False}
    try:
        with TestClient(app) as client:
            response = client.post(
                f"/studio/v1/projects/{project['id']}/generation-jobs",
                json={**request, "commercial_only": True},
            )
            assert response.status_code == 422
            assert "commercial" in response.json()["detail"].lower()
            assert pending == []
            assert store.get_project(project["id"])["jobs"] == []
            response = client.post(
                f"/studio/v1/projects/{project['id']}/generation-jobs",
                json={**request, "commercial_only": False},
            )
            assert response.status_code == 202
    finally:
        for coro in pending:
            coro.close()


def test_commercial_generation_allows_verified_apache_engines(tmp_path):
    import numpy as np
    import soundfile as sf

    store = StudioStore(tmp_path / "studio")
    project = store.create_project("YouTube narration", script="Words")
    source = tmp_path / "reference.wav"
    sf.write(source, np.zeros(2400), 24000)
    asset = store.add_asset(project["id"], source)
    passage = project["document"]["passages"][0]
    passage["voice_snapshot"] = {
        "engine": "qwen",
        "model_size": "1.7B",
        "voice_type": "cloned",
        "samples": [{"asset_id": asset["id"], "reference_text": "Words"}],
    }
    with store.connect() as db:
        db.execute("UPDATE projects SET document=? WHERE id=?", (encode(project["document"]), project["id"]))
    pending = []
    jobs = StudioJobs(store, enqueue=lambda ident, coro: pending.append(coro))
    app = FastAPI()
    app.include_router(make_router(store, jobs))
    try:
        with TestClient(app) as client:
            response = client.post(
                f"/studio/v1/projects/{project['id']}/generation-jobs",
                json={
                    "idempotency_key": "yt-job",
                    "passage_ids": [passage["id"]],
                    "count": 1,
                    "adopt": False,
                    "commercial_only": True,
                },
            )
            assert response.status_code == 202
            assert len(pending) == 1
    finally:
        for coro in pending:
            coro.close()
