"""Route registration for the voicebox API."""

import copy
from fastapi import FastAPI
from pathlib import Path
from threading import Lock


class _StudioProxy:
    """Allow router registration before the native data directory is configured."""

    def __init__(self, runtime, name):
        self.runtime = runtime
        self.name = name

    def _resolve(self):
        runtime = object.__getattribute__(self, "runtime")
        name = object.__getattribute__(self, "name")
        runtime.initialize()
        return getattr(runtime, name)

    def __getattr__(self, name):
        if name.startswith("__") and name.endswith("__"):
            raise AttributeError(name)
        return getattr(self._resolve(), name)

    def __copy__(self):
        return copy.copy(self._resolve())


class StudioRuntime:
    def __init__(self, data_dir=None):
        self.data_dir = data_dir
        self._lock = Lock()
        self._store = None
        self._jobs = None
        self.store = _StudioProxy(self, "_store")
        self.jobs = _StudioProxy(self, "_jobs")

    def initialize(self):
        if self._store is not None:
            return
        with self._lock:
            if self._store is not None:
                return
            from ..config import get_data_dir
            from ..studio.jobs import StudioJobs
            from ..studio.storage import StudioStore

            def resolve_voice(store, project_id, profile_id, model_size=None):
                from ..studio.voices import snapshot_voice

                return snapshot_voice(store, project_id, profile_id, model_size=model_size)

            root = self.data_dir() if self.data_dir is not None else get_data_dir()
            store = StudioStore(Path(root) / "studio", voice_resolver=resolve_voice)
            jobs = StudioJobs(store)
            self._jobs = jobs
            self._store = store


def register_routers(app: FastAPI) -> None:
    """Include all domain routers on the application."""
    from .health import router as health_router
    from .profiles import router as profiles_router
    from .channels import router as channels_router
    from .generations import router as generations_router
    from .history import router as history_router
    from .transcription import router as transcription_router
    from .llm import router as llm_router
    from .captures import router as captures_router
    from .stories import router as stories_router
    from .effects import router as effects_router
    from .audio import router as audio_router
    from .models import router as models_router
    from .model_residency import router as model_residency_router
    from .settings import router as settings_router
    from .tasks import router as tasks_router
    from .cuda import router as cuda_router
    from .rocm import router as rocm_router
    from .speak import router as speak_router
    from .mcp_bindings import router as mcp_bindings_router
    from .events import router as events_router
    from .cloud import router as cloud_router
    from .openai_compat import router as openai_compat_router
    from .sample_quality import make_sample_quality_router

    app.include_router(health_router)
    app.include_router(profiles_router)
    app.include_router(channels_router)
    app.include_router(generations_router)
    app.include_router(history_router)
    app.include_router(transcription_router)
    app.include_router(llm_router)
    app.include_router(captures_router)
    app.include_router(stories_router)
    app.include_router(effects_router)
    app.include_router(audio_router)
    app.include_router(models_router)
    app.include_router(model_residency_router)
    app.include_router(settings_router)
    app.include_router(tasks_router)
    app.include_router(cuda_router)
    app.include_router(rocm_router)
    app.include_router(speak_router)
    app.include_router(mcp_bindings_router)
    app.include_router(events_router)
    app.include_router(cloud_router)
    app.include_router(openai_compat_router)
    app.include_router(make_sample_quality_router())

    from ..studio.api import make_router

    runtime = StudioRuntime()
    app.state.studio_runtime = runtime
    app.include_router(make_router(runtime.store, runtime.jobs))
