"""DELETE /models/{name} for a CUDA-graph variant, whose HF cache directory is the
stock size's directory: deleting one removes the other's weights."""

import asyncio
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from huggingface_hub import constants as hf_constants
from starlette.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend import backends
from backend.routes import models as models_routes
from backend.services.inference_scheduler import run_serialized_inference

REPO = "Qwen/Qwen3-TTS-12Hz-0.6B-Base"
STOCK = backends.ModelConfig(model_name="qwen-tts-0.6B", display_name="Qwen 0.6B", engine="qwen", hf_repo_id=REPO, model_size="0.6B")
VARIANT = backends.ModelConfig(model_name="qwen-tts-0.6B-cudagraph", display_name="Qwen 0.6B (CUDA graphs)", engine="qwen",
                               hf_repo_id=REPO, model_size="0.6B-cudagraph")
OTHER = backends.ModelConfig(model_name="kokoro", display_name="Kokoro", engine="kokoro", hf_repo_id="hexgrad/Kokoro-82M")


@pytest.fixture
def registry(monkeypatch, tmp_path):
    cache_dir = tmp_path / "hub" / ("models--" + REPO.replace("/", "--"))
    cache_dir.mkdir(parents=True)
    (cache_dir / "weights.safetensors").write_bytes(b"w")
    monkeypatch.setattr(hf_constants, "HF_HUB_CACHE", str(tmp_path / "hub"))
    state = {"loaded": set(), "unloaded": [], "cache_dir": cache_dir}
    configs = [STOCK, VARIANT, OTHER]
    monkeypatch.setattr(backends, "get_all_model_configs", lambda: list(configs))
    monkeypatch.setattr(backends, "get_model_config", lambda name: next((c for c in configs if c.model_name == name), None))
    monkeypatch.setattr(backends, "check_model_loaded", lambda config: config.model_name in state["loaded"])

    def unload(config):
        state["unloaded"].append(config.model_name)
        was_loaded = config.model_name in state["loaded"]
        state["loaded"].discard(config.model_name)
        return was_loaded

    monkeypatch.setattr(backends, "unload_model_by_config", unload)
    return state


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(models_routes.router)
    with TestClient(app) as test_client:
        yield test_client


def test_deleting_the_variant_while_the_stock_size_is_loaded_is_refused_and_keeps_the_weights(client, registry):
    registry["loaded"].add("qwen-tts-0.6B")
    response = client.delete("/models/qwen-tts-0.6B-cudagraph")
    assert response.status_code == 409
    assert "qwen-tts-0.6B" in response.json()["detail"] and "shar" in response.json()["detail"]
    assert registry["cache_dir"].exists() and registry["unloaded"] == []


def test_deleting_the_stock_size_while_the_variant_is_loaded_is_refused_too(client, registry):
    registry["loaded"].add("qwen-tts-0.6B-cudagraph")
    response = client.delete("/models/qwen-tts-0.6B")
    assert response.status_code == 409 and "qwen-tts-0.6B-cudagraph" in response.json()["detail"]
    assert registry["cache_dir"].exists() and registry["unloaded"] == []


def test_deleting_the_loaded_variant_itself_unloads_it_and_names_the_sharer(client, registry):
    registry["loaded"].add("qwen-tts-0.6B-cudagraph")
    response = client.delete("/models/qwen-tts-0.6B-cudagraph")
    assert response.status_code == 200
    assert registry["unloaded"] == ["qwen-tts-0.6B-cudagraph"] and not registry["cache_dir"].exists()
    assert "shared with qwen-tts-0.6B" in response.json()["message"]


def test_deleting_an_unshared_model_keeps_its_old_message(client, registry):
    monkeypatch_dir = Path(hf_constants.HF_HUB_CACHE) / "models--hexgrad--Kokoro-82M"
    monkeypatch_dir.mkdir()
    assert client.delete("/models/kokoro").json() == {"message": "Model kokoro deleted successfully"}


@pytest.mark.asyncio
async def test_delete_waits_for_the_inference_owner_before_unloading(registry):
    """A replay in flight owns the graphs; close() tears them down in place."""
    registry["loaded"].add("qwen-tts-0.6B-cudagraph")
    release = asyncio.Event()

    async def generation():
        await release.wait()
        return "audio"

    owner = asyncio.create_task(run_serialized_inference(generation))
    await asyncio.sleep(0)
    delete = asyncio.create_task(models_routes.delete_model("qwen-tts-0.6B-cudagraph"))
    await asyncio.sleep(0.05)
    assert registry["unloaded"] == [] and not delete.done()
    release.set()
    assert await owner == "audio"
    assert (await delete)["message"].startswith("Model qwen-tts-0.6B-cudagraph deleted")
    assert registry["unloaded"] == ["qwen-tts-0.6B-cudagraph"]
