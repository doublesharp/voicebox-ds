"""Pinned model readiness ignores moving refs and other revisions' downloads."""

import pytest
from huggingface_hub import constants

from backend import backends
from backend.backends.base import is_model_cached
from backend.routes.models import _scan_model_inventory

REVISION = "a" * 40
OTHER = "b" * 40


def write_snapshot(tmp_path, repo, revision, files):
    root = tmp_path / ("models--" + repo.replace("/", "--"))
    snapshot = root / "snapshots" / revision
    for name in files:
        path = snapshot / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"asset")
    return root, snapshot


def test_completed_pinned_assets_do_not_wait_for_another_revision(tmp_path, monkeypatch):
    monkeypatch.setattr(constants, "HF_HUB_CACHE", str(tmp_path))
    root, _ = write_snapshot(tmp_path, "test/model", REVISION, ["config.json", "model.onnx"])
    (root / "blobs").mkdir()
    (root / "blobs" / "unrelated.incomplete").write_bytes(b"partial")
    assert is_model_cached("test/model", revision=REVISION, required_files=["config.json", "model.onnx"])


def test_another_snapshot_cannot_satisfy_pinned_readiness(tmp_path, monkeypatch):
    monkeypatch.setattr(constants, "HF_HUB_CACHE", str(tmp_path))
    write_snapshot(tmp_path, "test/model", OTHER, ["config.json", "model.onnx"])
    assert not is_model_cached("test/model", revision=REVISION, required_files=["config.json", "model.onnx"])


@pytest.mark.parametrize("missing", ["tts", "codec"])
def test_inventory_requires_all_exact_primary_and_auxiliary_assets(tmp_path, monkeypatch, missing):
    monkeypatch.setattr(constants, "HF_HUB_CACHE", str(tmp_path))
    _, tts = write_snapshot(tmp_path, "test/tts", REVISION, ["config.json", "model.onnx"])
    _, codec = write_snapshot(tmp_path, "test/codec", OTHER, ["codec.onnx"])
    cfg = backends.ModelConfig(
        model_name="test-tts",
        display_name="Test",
        engine="test",
        hf_repo_id="test/tts",
        revision=REVISION,
        required_files=("config.json", "model.onnx"),
        aux_hf_repo_ids=("test/codec",),
        aux_revisions={"test/codec": OTHER},
        aux_required_files={"test/codec": ("codec.onnx",)},
    )
    assert _scan_model_inventory([cfg])[cfg.model_name][0]
    (tts / "model.onnx" if missing == "tts" else codec / "codec.onnx").unlink()
    assert not _scan_model_inventory([cfg])[cfg.model_name][0]


def test_required_assets_cannot_be_combined_across_snapshots(tmp_path, monkeypatch):
    monkeypatch.setattr(constants, "HF_HUB_CACHE", str(tmp_path))
    files = ["model.safetensors", "speech_tokenizer/config.json"]
    root, _ = write_snapshot(tmp_path, "test/model", REVISION, files[:1])
    write_snapshot(tmp_path, "test/model", OTHER, files[1:])
    (root / "refs").mkdir()
    (root / "refs" / "main").write_text(REVISION)

    assert not is_model_cached("test/model", required_files=files)


def test_unpinned_offline_load_requires_a_main_ref(tmp_path, monkeypatch):
    monkeypatch.setattr(constants, "HF_HUB_CACHE", str(tmp_path))
    files = ["config.json", "model.safetensors"]
    write_snapshot(tmp_path, "test/model", REVISION, files)

    assert not is_model_cached("test/model", required_files=files)
    assert is_model_cached("test/model", required_files=files, revision=REVISION)


@pytest.mark.parametrize("backend_type", ["pytorch", "mlx"])
def test_qwen_download_status_and_loader_agree_on_the_active_snapshot(
    tmp_path, monkeypatch, backend_type
):
    from backend.backends.qwen_mlx_styles_backend import QwenMLXVoiceDesignBackend
    from backend.backends.qwen_voice_design_backend import QwenVoiceDesignBackend

    monkeypatch.setattr(constants, "HF_HUB_CACHE", str(tmp_path))
    monkeypatch.setattr(backends, "get_backend_type", lambda: backend_type)
    config = backends.get_model_config("qwen-voice-design-1.7B")
    assert config is not None
    backend = QwenMLXVoiceDesignBackend() if backend_type == "mlx" else QwenVoiceDesignBackend()
    files = [
        "config.json", "model.safetensors", "generation_config.json", "merges.txt", "vocab.json",
        "tokenizer_config.json", "preprocessor_config.json", "speech_tokenizer/config.json",
        "speech_tokenizer/configuration.json", "speech_tokenizer/preprocessor_config.json",
        "speech_tokenizer/model.safetensors",
    ]
    if backend_type == "mlx":
        files.append("model.safetensors.index.json")
    repo = config.hf_repo_id
    root, _ = write_snapshot(tmp_path, repo, REVISION, files[:2])
    write_snapshot(tmp_path, repo, OTHER, files)
    (root / "refs").mkdir()
    (root / "refs" / "main").write_text(REVISION)

    assert not _scan_model_inventory([config])[config.model_name][0]
    assert not backend._is_model_cached("1.7B")

    write_snapshot(tmp_path, repo, REVISION, files[2:])
    assert _scan_model_inventory([config])[config.model_name][0]
    assert backend._is_model_cached("1.7B")
