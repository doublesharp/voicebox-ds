"""HTTP interface for the independent studio store."""

import asyncio
import copy
from concurrent.futures import Future
import zipfile
from typing import Literal
from fastapi import APIRouter, File, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from starlette.background import BackgroundTask
from starlette.concurrency import run_in_threadpool
from pydantic import BaseModel, Field, StrictStr
from ..utils.async_work import run_blocking
from .jobs import StudioJobs
from .storage import Conflict, NotFound, uid


class Create(BaseModel):
    name: str
    client_label: str | None = None
    script: str = ""
    language: str = "en"


class Command(BaseModel):
    operation_id: str
    expected_revision: int
    type: str
    payload: dict


class Revision(BaseModel):
    operation_id: str
    expected_revision: int
    name: str


class Approval(BaseModel):
    operation_id: str
    revision_id: str
    note: str | None = None


class Render(BaseModel):
    idempotency_key: str
    revision_id: str
    kind: str
    format: str
    allow_stale_audio: bool = False
    processing: Literal["dry", "processed"] | None = None


class Generate(BaseModel):
    idempotency_key: str
    passage_ids: list[str]
    count: int = Field(ge=1, le=3)
    adopt: bool
    commercial_only: bool = False
    phrase_text: str | None = Field(default=None, min_length=1, max_length=1000)


class StoryImport(BaseModel):
    idempotency_key: StrictStr | None = Field(default=None, min_length=1, max_length=200)


def make_router(store, jobs=None):
    router = APIRouter(prefix="/studio/v1")
    from .preview import make_preview_router
    from .waveforms import make_waveform_router
    from .audition import make_audition_router
    from .reviews import make_review_router
    from .cleanup import make_cleanup_router
    from .captions import make_caption_router
    from .chapters import make_chapter_router

    router.include_router(make_preview_router(store))
    router.include_router(make_waveform_router(store))
    router.include_router(make_audition_router(store))
    router.include_router(make_review_router(store))
    router.include_router(make_cleanup_router(store))
    router.include_router(make_caption_router(store))
    router.include_router(make_chapter_router(store))
    jobs = jobs or StudioJobs(store)

    def get_delivery():
        from .delivery import StudioDelivery

        return StudioDelivery(store)

    def call(fn, *args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except Conflict as exc:
            raise HTTPException(409, detail={"message": str(exc), "current_revision": exc.current_revision}) from exc
        except NotFound as exc:
            raise HTTPException(404, detail=str(exc)) from exc
        except (ValueError, TypeError, zipfile.BadZipFile) as exc:
            raise HTTPException(422, detail=str(exc)) from exc

    def on_loop(loop, callback):
        # Admission owns its worker until enqueue/schedule has completed on-loop.
        def forwarded(*args):
            result = Future()
            def invoke():
                try:
                    result.set_result(callback(*args))
                except BaseException as error:
                    result.set_exception(error)
            loop.call_soon_threadsafe(invoke)
            return result.result()
        return forwarded

    async def job_work(method, *args, **kwargs):
        from ..services.task_queue import create_background_task

        worker = copy.copy(jobs)
        loop = asyncio.get_running_loop()
        worker.enqueue = on_loop(loop, jobs.enqueue)
        worker.delivery_schedule = on_loop(loop, create_background_task)
        return await run_blocking(call, getattr(worker, method), *args, **kwargs)

    @router.get("/projects")
    def projects():
        return {"items": store.list_projects()}

    @router.post("/projects")
    def create(body: Create):
        return call(store.create_project, **body.model_dump())

    @router.get("/projects/{project_id}")
    def project(project_id: str, compact: bool = False, if_none_match: str | None = Header(default=None)):
        if compact:
            result, token = call(store.poll_project, project_id, if_none_match)
            headers = {"ETag": token, "Cache-Control": "no-cache"}
            return Response(status_code=304, headers=headers) if result is None else JSONResponse(result, headers=headers)
        return call(store.get_project, project_id)

    @router.get("/projects/{project_id}/revisions/{revision_id}")
    def revision_detail(project_id: str, revision_id: str):
        return call(store.get_revision, project_id, revision_id)

    @router.post("/projects/{project_id}/commands")
    def command(project_id: str, body: Command, x_studio_projection: str | None = Header(default=None)):
        return call(store.command, project_id, **body.model_dump(), compact=x_studio_projection == "compact")

    @router.post("/projects/{project_id}/revisions")
    def revision(project_id: str, body: Revision, x_studio_projection: str | None = Header(default=None)):
        return call(store.checkpoint, project_id, **body.model_dump(), compact=x_studio_projection == "compact")

    @router.post("/projects/{project_id}/approvals")
    def approval(project_id: str, body: Approval, x_studio_projection: str | None = Header(default=None)):
        return call(store.approve, project_id, **body.model_dump(), compact=x_studio_projection == "compact")

    @router.get("/engines")
    def get_engines(commercial_only: bool = False):
        from .voices import engines

        return {"items": engines(commercial_only=commercial_only)}

    @router.get("/pronunciation-packs")
    def get_pronunciation_packs():
        from .pronunciation import BUILTIN_PRONUNCIATION_PACKS

        return {"items": list(BUILTIN_PRONUNCIATION_PACKS.values())}

    @router.get("/projects/{project_id}/pronunciation-scan")
    def pronunciation_scan(project_id: str):
        from .pronunciation import scan_script_jargon

        project = call(store.get_project, project_id)
        doc = project["document"]
        return {
            "items": scan_script_jargon(doc.get("passages", []), doc.get("pronunciation_rules", [])),
        }

    @router.post("/projects/{project_id}/generation-jobs", status_code=202)
    async def generate(project_id: str, body: Generate):
        return {
            "jobs": await job_work(
                "submit", project_id, body.idempotency_key, body.passage_ids, body.count, body.adopt,
                commercial_only=body.commercial_only,
                phrase_text=body.phrase_text,
            )
        }

    @router.get("/jobs/{job_id}")
    def get_job(job_id: str):
        return call(jobs.get, job_id)

    @router.post("/jobs/{job_id}/cancel")
    def cancel(job_id: str):
        return call(jobs.cancel, job_id)

    @router.post("/jobs/{job_id}/retry")
    async def retry(job_id: str):
        return await job_work("retry", job_id)

    @router.post("/projects/{project_id}/render-jobs", status_code=202)
    async def render(project_id: str, body: Render):
        delivery = get_delivery()
        delivery.schedule = on_loop(asyncio.get_running_loop(), delivery.schedule)
        return {"job": await run_blocking(call, delivery.submit, project_id, **body.model_dump())}

    @router.get("/deliverables/{ident}/audio")
    @router.get("/deliverables/{ident}/download")
    def deliverable(ident: str):
        path, meta = call(get_delivery().path, ident)
        return FileResponse(
            path,
            media_type="audio/mpeg" if meta["format"] == "mp3" else "audio/wav",
            filename=meta.get("filename", "studio." + meta["format"]),
        )

    @router.get("/projects/{project_id}/archive")
    def archive(
        project_id: str,
        take_scope: Literal["all", "used"] = "all",
        include_regeneration_references: bool = True,
    ):
        from .archive import write_archive
        from .reviews import StudioReviews

        project = call(store.get_project, project_id)
        project["reviews"] = call(StudioReviews(store).export, project_id)
        target = store.root / (".archive-" + uid() + ".zip")
        try:
            call(
                write_archive, project, project["assets"], store.asset_path, target,
                take_scope=take_scope, include_regeneration_references=include_regeneration_references,
            )
        except BaseException:
            target.unlink(missing_ok=True)
            raise
        return FileResponse(
            target,
            media_type="application/zip",
            filename="studio.zip",
            background=BackgroundTask(target.unlink, missing_ok=True),
        )

    @router.post("/imports/archive")
    async def import_project(file: UploadFile = File(...)):
        from .portability import import_archive

        path = store.root / (".archive-upload-" + uid())
        try:
            with path.open("xb") as dest:
                while chunk := await file.read(1024 * 1024):
                    if dest.tell() + len(chunk) > 1024 * 1024 * 1024:
                        raise HTTPException(413, detail="Archive is too large")
                    dest.write(chunk)
            return await run_in_threadpool(call, import_archive, store, path)
        finally:
            path.unlink(missing_ok=True)
            await file.close()

    @router.post("/imports/story/{story_id}")
    def import_legacy_story(story_id: str, body: StoryImport | None = None):
        from ..database import get_db
        from .story import import_story

        db = next(get_db())
        try:
            return call(import_story, store, story_id, db, idempotency_key=body.idempotency_key if body else None)
        finally:
            db.close()

    @router.get("/assets/{asset_id}/audio")
    def audio(asset_id: str):
        return FileResponse(call(store.asset_path, asset_id), media_type="audio/wav")

    @router.post("/projects/{project_id}/assets")
    async def upload(project_id: str, file: UploadFile = File(...)):
        path = store.root / (".upload-" + uid())
        try:
            with path.open("xb") as dest:
                while chunk := await file.read(1024 * 1024):
                    if dest.tell() + len(chunk) > 200 * 1024 * 1024:
                        raise HTTPException(413, detail="Audio file is too large")
                    dest.write(chunk)
            return await run_in_threadpool(call, store.add_asset, project_id, path)
        finally:
            path.unlink(missing_ok=True)
            await file.close()

    return router
