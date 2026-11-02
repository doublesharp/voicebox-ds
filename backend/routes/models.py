"""Model management endpoints."""

import asyncio
from contextlib import AsyncExitStack
import os
import shutil
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from .. import models
from ..services.inference_scheduler import run_serialized_inference, serialized_inference
from ..services.task_queue import create_background_task
from ..utils.model_inventory import model_inventory
from ..utils.progress import get_progress_manager
from ..utils.tasks import get_task_manager

router = APIRouter()


def _get_dir_size(path: Path) -> int:
    """Get total size of a directory in bytes."""
    total = 0
    for f in path.rglob("*"):
        if not f.is_symlink() and f.is_file():
            total += f.stat().st_size
    return total


def _copy_with_progress(src: Path, dst: Path, progress_manager, copied_so_far: int, total_bytes: int, source_root=None, destination_root=None) -> int:
    """Copy a directory tree with byte-level progress tracking."""
    if source_root is None:
        source_root, destination_root = src.parent.absolute(), dst.parent.absolute()
    dst.mkdir(parents=True, exist_ok=True)
    for item in src.iterdir():
        dest_item = dst / item.name
        if item.is_symlink():
            target = Path(os.readlink(item))
            if target.is_absolute():
                try:
                    relative = target.relative_to(source_root)
                except ValueError:
                    pass
                else:
                    target = Path(os.path.relpath(destination_root / relative, dest_item.parent))
            dest_item.symlink_to(target)
        elif item.is_dir():
            copied_so_far = _copy_with_progress(item, dest_item, progress_manager, copied_so_far, total_bytes, source_root, destination_root)
        else:
            size = item.stat().st_size
            shutil.copy2(str(item), str(dest_item))
            copied_so_far += size
            progress_manager.update_progress(
                "migration",
                copied_so_far,
                total_bytes,
                filename=item.name,
                status="downloading",
            )
    return copied_so_far


async def _finish_thread_before_cancelling(function, *args):
    """Do not roll back a destination while its worker is still writing."""
    worker = asyncio.create_task(asyncio.to_thread(function, *args))
    try:
        return await asyncio.shield(worker)
    except asyncio.CancelledError:
        # Further cancellation requests must not cancel the asyncio wrapper:
        # the underlying thread would keep writing after rollback begins.
        while not worker.done():
            try:
                await asyncio.shield(worker)
            except asyncio.CancelledError:
                continue
            except Exception:
                break
        # Retrieve any worker exception so it does not become unhandled.
        if not worker.cancelled():
            worker.exception()
        raise


def _same_filesystem(source: Path, destination: Path) -> bool:
    try:
        return source.stat().st_dev == destination.stat().st_dev
    except OSError:
        return False


DEFAULT_QWEN_MODEL_SIZE = "1.7B"


async def _run_model_work(configuration, operation):
    """Reserve TTS state only for TTS loads; STT/LLM keep their own policies."""
    from ..backends import TTS_ENGINES

    async def invoke():
        result = operation()
        return await result if asyncio.iscoroutine(result) else result

    if configuration is None or configuration.engine in TTS_ENGINES:
        return await run_serialized_inference(invoke)
    return await invoke()


async def _unload_model_work(configuration):
    """Wait for an active speech or LLM operation before unloading its model."""
    from ..backends import get_llm_backend_for_engine, unload_model_by_config

    if configuration.engine in ("qwen_llm", "whisper"):
        if configuration.engine == "qwen_llm":
            backend = get_llm_backend_for_engine("qwen_llm")
        else:
            from ..services.transcribe import get_whisper_model
            backend = get_whisper_model()
        lock = getattr(backend, "_op_lock", None)
        if lock is not None:
            async with lock:
                return unload_model_by_config(configuration)
    return await _run_model_work(configuration, lambda: unload_model_by_config(configuration))


def _resolve_model_config(model_name: str):
    """Look up a model config by name or raise a 400 listing the valid ids."""
    from ..backends import get_all_model_configs, get_model_config

    config = get_model_config(model_name)
    if config is None:
        known = sorted(cfg.model_name for cfg in get_all_model_configs())
        raise HTTPException(
            status_code=400,
            detail=f"Unknown model: {model_name!r}. Available: {known}",
        )
    return config


@router.post("/models/load")
async def load_model(
    request: models.ModelLoadRequest | None = None,
    model_size: str | None = None,
):
    """Load a model into memory.

    Pass ``{"model_name": "kokoro"}`` to target any registered engine. Only an
    absent ``model_name`` falls back to the default Qwen TTS backend, selected
    by the ``model_size`` query parameter, which is what callers did before
    ``model_name`` existed. A supplied-but-empty name is a bad request, not a
    request for the default — silently loading Qwen there is the very bug this
    endpoint had.
    """
    from ..backends import get_model_load_func
    from ..backends.qwen_cuda_variants import cuda_graph_unavailable_reason, is_cuda_graph_variant
    from ..services import tts

    requested_name = request.model_name if request else None
    requested_size = (request.model_size if request else None) or model_size

    if requested_name is not None:
        config = _resolve_model_config(requested_name)
        try:
            await _run_model_work(config, get_model_load_func(config))
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e)) from e
        finally:
            model_inventory.invalidate()
        return {"message": f"Model {config.model_name} loaded successfully"}

    size = requested_size or DEFAULT_QWEN_MODEL_SIZE
    if is_cuda_graph_variant(size):
        reason = cuda_graph_unavailable_reason()
        if reason is not None:
            raise HTTPException(status_code=400, detail=f"Model {size} is not available on this host: {reason}")
    try:
        tts_model = tts.get_tts_model()
        await _run_model_work(None, lambda: tts_model.load_model_async(size))
        return {"message": f"Model {size} loaded successfully"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
    finally:
        model_inventory.invalidate()


@router.post("/models/unload")
async def unload_model(request: models.ModelLoadRequest | None = None):
    """Unload a model from memory.

    Pass ``{"model_name": "chatterbox-tts"}`` to target a specific engine —
    same behaviour as ``POST /models/{model_name}/unload``. Only an absent
    ``model_name`` unloads the default Qwen TTS model, as it always has; a
    supplied-but-empty name is a bad request.
    """
    from ..backends import unload_model_by_config
    from ..services import tts

    requested_name = request.model_name if request else None

    if requested_name is not None:
        config = _resolve_model_config(requested_name)
        try:
            was_loaded = await _unload_model_work(config)
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e)) from e
        if not was_loaded:
            return {"message": f"Model {config.model_name} is not loaded"}
        return {"message": f"Model {config.model_name} unloaded successfully"}

    try:
        await _run_model_work(None, tts.unload_tts_model)
        return {"message": "Model unloaded successfully"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e


@router.post("/models/{model_name}/unload")
async def unload_model_by_name(model_name: str):
    """Unload a specific model from memory without deleting it from disk."""
    from ..backends import get_model_config, unload_model_by_config

    config = get_model_config(model_name)
    if not config:
        raise HTTPException(status_code=400, detail=f"Unknown model: {model_name}")

    try:
        was_loaded = await _unload_model_work(config)
        if not was_loaded:
            return {"message": f"Model {model_name} is not loaded"}
        return {"message": f"Model {model_name} unloaded successfully"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e


@router.get("/models/progress/{model_name}")
async def get_model_progress(model_name: str, include_terminal: bool = False):
    """Get model download progress via Server-Sent Events."""
    progress_manager = get_progress_manager()

    async def event_generator():
        async for event in progress_manager.subscribe(model_name, include_terminal=include_terminal):
            yield event

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/models/cache-dir")
async def get_models_cache_dir():
    """Get the path to the HuggingFace model cache directory."""
    from huggingface_hub import constants as hf_constants

    return {"path": str(Path(hf_constants.HF_HUB_CACHE))}


@router.post("/models/migrate")
async def migrate_models(request: models.ModelMigrateRequest):
    """Move all downloaded models to a new directory with byte-level progress via SSE."""
    from huggingface_hub import constants as hf_constants

    source = Path(hf_constants.HF_HUB_CACHE)
    destination = Path(request.destination)

    if not source.exists():
        raise HTTPException(status_code=404, detail="Current model cache directory not found")

    if source.resolve() == destination.resolve():
        raise HTTPException(status_code=400, detail="Source and destination are the same directory")

    if destination.resolve().is_relative_to(source.resolve()):
        raise HTTPException(status_code=400, detail="Destination cannot be inside the current cache directory")

    progress_manager = get_progress_manager()
    active = progress_manager.get_progress("migration")
    if active and active.get("status") in ("downloading", "extracting"):
        raise HTTPException(status_code=409, detail="A model migration is already in progress")
    model_dirs = [d for d in source.iterdir() if d.name.startswith("models--") and d.is_dir()]
    if not model_dirs:
        progress_manager.update_progress("migration", 1, 1, status="complete")
        progress_manager.mark_complete("migration")
        return {"moved": 0, "errors": [], "source": str(source), "destination": str(destination)}

    conflicts = [item.name for item in model_dirs if os.path.lexists(destination / item.name)]
    if conflicts:
        raise HTTPException(status_code=409, detail=f"Destination already contains models: {', '.join(sorted(conflicts))}")

    destination.mkdir(parents=True, exist_ok=True)
    # Clear any terminal state before returning, so late SSE subscribers
    # cannot mistake the previous migration for this one.
    progress_manager.update_progress("migration", 0, 1, status="downloading")

    same_fs = _same_filesystem(source, destination)

    started = False

    async def migrate_background():
        nonlocal started
        started = True
        moved = []
        copied = []
        deletion_started = False
        try:
            if same_fs:
                total = len(model_dirs)
                for i, item in enumerate(model_dirs):
                    dest_item = destination / item.name
                    if os.path.lexists(dest_item):
                        raise FileExistsError(f"Destination already exists: {dest_item}")
                    shutil.move(str(item), str(dest_item))
                    moved.append((item, dest_item))
                    progress_manager.update_progress(
                        "migration", i + 1, total, filename=item.name, status="downloading"
                    )
            else:
                total_bytes = sum(_get_dir_size(d) for d in model_dirs)
                progress_manager.update_progress(
                    "migration", 0, total_bytes, filename="Calculating...", status="downloading"
                )
                copied_bytes = 0
                for item in model_dirs:
                    dest_item = destination / item.name
                    if os.path.lexists(dest_item):
                        raise FileExistsError(f"Destination already exists: {dest_item}")
                    # Claim the new directory exclusively before copying.
                    dest_item.mkdir()
                    copied.append(dest_item)
                    copied_bytes = await _finish_thread_before_cancelling(
                        _copy_with_progress, item, dest_item, progress_manager, copied_bytes, total_bytes
                    )
                # Keep every original until every copy has finished, so a
                # copy error can be rolled back without losing source files.
                deletion_started = True
                for item in model_dirs:
                    await _finish_thread_before_cancelling(shutil.rmtree, str(item))

            progress_manager.update_progress("migration", 1, 1, status="complete")
            progress_manager.mark_complete("migration")
        except (Exception, asyncio.CancelledError) as e:
            rollback_errors = []
            if same_fs:
                for original, target in reversed(moved):
                    try:
                        if os.path.lexists(original):
                            raise FileExistsError(f"Cannot restore over existing source: {original}")
                        shutil.move(str(target), str(original))
                    except Exception as rollback_error:
                        rollback_errors.append(str(rollback_error))
            elif not deletion_started:
                for target in copied:
                    try:
                        shutil.rmtree(target)
                    except FileNotFoundError:
                        pass
                    except Exception as rollback_error:
                        rollback_errors.append(str(rollback_error))
            message = str(e) or "Model migration cancelled"
            if deletion_started and not same_fs:
                message += "; copied models remain in the destination; source cleanup was incomplete"
            if rollback_errors:
                message += "; rollback incomplete: " + "; ".join(rollback_errors)
            progress_manager.mark_error("migration", message)
            if isinstance(e, asyncio.CancelledError):
                raise
        finally:
            model_inventory.invalidate()

    model_inventory.invalidate()
    work = migrate_background()
    try:
        task = create_background_task(work)
        def clear_cancelled_before_start(done):
            if done.cancelled() and not started:
                progress_manager.mark_error("migration", "Model migration cancelled before starting")
        task.add_done_callback(clear_cancelled_before_start)
    except Exception as e:
        work.close()
        progress_manager.mark_error("migration", str(e))
        raise

    return {"source": str(source), "destination": str(destination)}


@router.get("/models/migrate/progress")
async def get_migration_progress():
    """Get model migration progress via Server-Sent Events."""
    progress_manager = get_progress_manager()

    async def event_generator():
        async for event in progress_manager.subscribe("migration", include_terminal=True):
            yield event

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


def _scan_model_inventory(configurations):
    """Disk-only state, run on a worker and shared by polling clients."""
    from huggingface_hub import constants as hf_constants

    from ..backends.base import has_in_progress_download, is_model_cached

    repositories = {}
    try:
        from huggingface_hub import scan_cache_dir

        repositories = {repo.repo_id: repo for repo in scan_cache_dir(hf_constants.HF_HUB_CACHE).repos}
    except Exception:
        pass

    result = {}
    extensions = (".safetensors", ".bin", ".pt", ".pth", ".npz")
    for configuration in configurations:
        downloaded, size_mb = False, None
        try:
            repo_id = configuration.hf_repo_id
            repo_cache = Path(hf_constants.HF_HUB_CACHE) / ("models--" + repo_id.replace("/", "--"))
            repo = repositories.get(repo_id)
            if repo is not None:
                downloaded = any(
                    file.file_name.lower().endswith(extensions) and file.file_path.is_file()
                    for revision in repo.revisions for file in revision.files
                ) and not has_in_progress_download(repo_cache / "blobs")
                if downloaded:
                    size_mb = sum(revision.size_on_disk for revision in repo.revisions) / (1024 * 1024)
            if not downloaded and is_model_cached(repo_id, weight_extensions=extensions):
                downloaded = True
                size_mb = sum(
                    file.stat().st_size for file in repo_cache.rglob("*")
                    if file.is_file() and not file.name.endswith(".incomplete")
                ) / (1024 * 1024)
            revision = getattr(configuration, "revision", None)
            if revision:
                downloaded = is_model_cached(repo_id, revision=revision, required_files=list(configuration.required_files))
                size_mb = sum(path.stat().st_size for path in (repo_cache / "snapshots" / revision).rglob("*") if path.is_file()) / (1024 * 1024) if downloaded else None
            aux_revisions = getattr(configuration, "aux_revisions", {})
            aux_files = getattr(configuration, "aux_required_files", {})
            if downloaded and not all(is_model_cached(repo, revision=aux_revisions.get(repo), required_files=list(aux_files.get(repo, ()))) for repo in configuration.aux_hf_repo_ids):
                downloaded = False
        except Exception:
            pass
        result[configuration.model_name] = (downloaded, size_mb)
    return result


@router.get("/models/status", response_model=models.ModelStatusListResponse)
async def get_model_status():
    """Read cached disk inventory, overlaying live model and download state."""
    from huggingface_hub import constants as hf_constants

    from ..backends import check_model_loaded, get_all_model_configs

    configurations = get_all_model_configs()
    task_manager = get_task_manager()
    # Including pending downloads observes loads initiated by generation/STT,
    # not only downloads explicitly requested through this router.
    pending = tuple(sorted(
        (task.model_name, str(getattr(task, "started_at", "")), getattr(task, "status", ""))
        for task in task_manager.get_pending_downloads()
    ))
    key = (str(hf_constants.HF_HUB_CACHE), tuple(
        (cfg.model_name, cfg.hf_repo_id, tuple(cfg.aux_hf_repo_ids), getattr(cfg, "revision", None), tuple(sorted(getattr(cfg, "aux_revisions", {}).items()))) for cfg in configurations
    ), pending)
    inventory = await model_inventory.get(key, lambda: _scan_model_inventory(configurations))
    model_to_repo = {cfg.model_name: cfg.hf_repo_id for cfg in configurations}
    active_repositories = {model_to_repo.get(task.model_name) for task in task_manager.get_pending_downloads()}
    statuses = []
    for cfg in configurations:
        downloaded, size_mb = inventory[cfg.model_name]
        try:
            loaded = check_model_loaded(cfg)
        except Exception:
            loaded = False
        downloading = cfg.hf_repo_id in active_repositories
        statuses.append(models.ModelStatus(
            model_name=cfg.model_name,
            display_name=cfg.display_name,
            hf_repo_id=cfg.hf_repo_id,
            revision=getattr(cfg, "revision", None),
            license=getattr(cfg, "license", None),
            auxiliary_revisions=dict(getattr(cfg, "aux_revisions", {})),
            downloaded=downloaded and not downloading,
            downloading=downloading,
            size_mb=None if downloading else size_mb,
            loaded=loaded,
        ))
    return models.ModelStatusListResponse(models=statuses)


@router.post("/models/download")
async def trigger_model_download(request: models.ModelDownloadRequest):
    """Trigger download of a specific model."""
    from ..backends import get_model_config, get_model_load_func

    task_manager = get_task_manager()
    progress_manager = get_progress_manager()

    config = get_model_config(request.model_name)
    if not config:
        raise HTTPException(status_code=400, detail=f"Unknown model: {request.model_name}")

    existing = next((task for task in task_manager.get_active_downloads()
                     if task.model_name == request.model_name), None)
    progress = progress_manager.get_progress(request.model_name)
    if ((existing is not None and existing.status in ("downloading", "extracting"))
            or (existing is None and progress and progress.get("status") in ("downloading", "extracting"))):
        raise HTTPException(status_code=409, detail=f"Model {request.model_name} is already downloading")

    load_func = get_model_load_func(config)

    async def download_in_background():
        try:
            await _run_model_work(config, load_func)
            progress_manager.mark_complete(request.model_name)
            task_manager.complete_download(request.model_name)
        except Exception as e:
            task_manager.error_download(request.model_name, str(e))
            progress_manager.mark_error(request.model_name, str(e))
        finally:
            model_inventory.invalidate()

    model_inventory.invalidate()
    task_manager.start_download(request.model_name)

    progress_manager.update_progress(
        model_name=request.model_name,
        current=0,
        total=0,
        filename="Connecting to HuggingFace...",
        status="downloading",
    )

    create_background_task(download_in_background())

    return {"message": f"Model {request.model_name} download started"}


@router.post("/models/download/cancel")
async def cancel_model_download(request: models.ModelDownloadRequest):
    """Cancel or dismiss an errored/stale download task."""
    task_manager = get_task_manager()
    progress_manager = get_progress_manager()

    task = next((task for task in task_manager.get_active_downloads()
                 if task.model_name == request.model_name), None)
    progress = progress_manager.get_progress(request.model_name)
    if ((task is not None and task.status in ("downloading", "extracting"))
            or (task is None and progress and progress.get("status") in ("downloading", "extracting"))):
        raise HTTPException(status_code=409, detail="A running download cannot be dismissed")

    removed = task_manager.cancel_download(request.model_name)

    progress_removed = False
    with progress_manager._lock:
        if request.model_name in progress_manager._progress:
            del progress_manager._progress[request.model_name]
            progress_removed = True

    if removed or progress_removed:
        return {"message": f"Download task for {request.model_name} cancelled"}
    return {"message": f"No active task found for {request.model_name}"}


@router.delete("/models/{model_name}")
@serialized_inference
async def delete_model(model_name: str):
    """Delete a downloaded model from the HuggingFace cache."""
    from huggingface_hub import constants as hf_constants

    from ..backends import check_model_loaded, get_all_model_configs, get_llm_backend_for_engine, get_model_config, unload_model_by_config

    config = get_model_config(model_name)
    if not config:
        raise HTTPException(status_code=400, detail=f"Unknown model: {model_name}")

    hf_repo_id = config.hf_repo_id
    # A CUDA-graph variant lives in the stock size's cache directory.
    sharers = [cfg for cfg in get_all_model_configs() if cfg.hf_repo_id == hf_repo_id and cfg.model_name != model_name]
    loaded_sharers = [cfg.model_name for cfg in sharers if check_model_loaded(cfg)]
    if loaded_sharers:
        raise HTTPException(
            status_code=409,
            detail=f"Model {model_name} shares its weights with {', '.join(loaded_sharers)}, which is loaded; unload it before deleting",
        )
    message = f"Model {model_name} deleted successfully"
    if sharers:
        message += f"; its weights were shared with {', '.join(cfg.model_name for cfg in sharers)}, which is no longer downloaded either"
    model_inventory.invalidate()

    try:
        async with AsyncExitStack() as stack:
            if config.engine in ("qwen_llm", "whisper"):
                if config.engine == "qwen_llm":
                    backend = get_llm_backend_for_engine("qwen_llm")
                else:
                    from ..services.transcribe import get_whisper_model
                    backend = get_whisper_model()
                lock = getattr(backend, "_op_lock", None)
                if lock is not None:
                    await stack.enter_async_context(lock)
            unload_model_by_config(config)

            cache_dir = hf_constants.HF_HUB_CACHE
            repo_cache_dir = Path(cache_dir) / ("models--" + hf_repo_id.replace("/", "--"))

            if not repo_cache_dir.exists():
                raise HTTPException(status_code=404, detail=f"Model {model_name} not found in cache")

            try:
                shutil.rmtree(repo_cache_dir)
                for aux_repo_id in config.aux_hf_repo_ids:
                    aux_cache_dir = Path(cache_dir) / ("models--" + aux_repo_id.replace("/", "--"))
                    if aux_cache_dir.exists():
                        shutil.rmtree(aux_cache_dir)
            except OSError as e:
                raise HTTPException(status_code=500, detail=f"Failed to delete model cache directory: {str(e)}")

            return {"message": message}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to delete model: {str(e)}")
    finally:
        model_inventory.invalidate()
