"""Durable generation requests; the queue retains ownership until inference returns."""

import copy
import json

from ..utils.inference import serialized_inference
from .capabilities import freeze_passage, resolve_voice
from .job_state import enrich_job, phase, start_attempt
from .pronunciation import spoken_text, validate_rules
from .storage import Conflict, NotFound, encode, now, uid


class StudioJobs:
    def __init__(self, store, synth=None, enqueue=None, capability_resolver=None, delivery_schedule=None):
        self.store = store
        self.delivery_schedule = delivery_schedule
        self.synth = synth
        self.capability_resolver = capability_resolver or resolve_voice
        if enqueue is None:
            from ..services.task_queue import enqueue_generation

            enqueue = enqueue_generation
        self.enqueue = enqueue

    def submit(self, project_id, key, passage_ids, count, adopt, commercial_only=False, phrase_text=None):
        if (
            not isinstance(key, str)
            or not key.strip()
            or not isinstance(passage_ids, list)
            or not passage_ids
            or len(set(passage_ids)) != len(passage_ids)
            or type(count) is not int
            or count not in (1, 2, 3)
            or type(adopt) is not bool
            or type(commercial_only) is not bool
        ):
            raise ValueError("Invalid generation request")
        if phrase_text is not None and (
            not isinstance(phrase_text, str)
            or not phrase_text.strip()
            or len(phrase_text) > 1000
            or len(passage_ids) != 1
            or count != 1
            or adopt
        ):
            raise ValueError("A phrase repair requires 1–1000 characters, one passage, one take and adopt=false")
        request = dict(passage_ids=passage_ids, count=count, adopt=adopt)
        # Keep the pre-policy default request identity replay-compatible.
        if commercial_only:
            request["commercial_only"] = True
        if phrase_text is not None:
            request["phrase_text"] = phrase_text
        scheduled = []
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            old = db.execute("SELECT * FROM job_requests WHERE project_id=? AND key=?", (project_id, key)).fetchone()
            if old:
                if old["request"] != encode(request):
                    raise Conflict("idempotency key already used with different input")
                return json.loads(old["response"])
            project = self.store._project(db, project_id)
            rules = validate_rules(project["document"].get("pronunciation_rules", []))
            passages = {p["id"]: p for p in project["document"]["passages"]}
            for ident in passage_ids:
                p = passages.get(ident)
                if not p:
                    raise NotFound("Passage not found in project")
                if p["locked"]:
                    raise ValueError("Passage is locked")
                original_text = p["text"]
                p = copy.deepcopy(p)
                if phrase_text is not None:
                    p["text"] = phrase_text
                spoken = spoken_text(p["text"], rules, p.get("profile_id"))
                caps, effective = freeze_passage({**p, "text": spoken}, self.capability_resolver)
                if commercial_only and caps.get("commercial_use") != "allowed":
                    raise ValueError(f"Passage {ident}: model is not eligible for commercial-only generation")
                if p.get("voice_snapshot") is not None:
                    p["voice_snapshot"]["capabilities"] = caps
                for _ in range(count):
                    job_id = uid()
                    timestamp = now()
                    frozen = dict(
                        passage=p,
                        adopt=adopt,
                        capabilities=caps,
                        effective_direction=effective,
                        spoken_text=spoken,
                        pronunciation_rules=rules,
                    )
                    if phrase_text is not None:
                        frozen["phrase_repair"] = {"source_text": original_text, "source_passage_id": ident}
                    if commercial_only:
                        frozen["commercial_only"] = True
                    db.execute(
                        "INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?,?,?)",
                        (
                            job_id,
                            project_id,
                            "generation",
                            "queued",
                            ident,
                            None,
                            None,
                            timestamp,
                            timestamp,
                            encode(frozen),
                        ),
                    )
                    scheduled.append(job_id)
            response = [enrich_job(db, j) for j in self.store._project(db, project_id)["jobs"] if j["id"] in scheduled]
            db.execute(
                "INSERT INTO job_requests VALUES (?,?,?,?)", (project_id, key, encode(request), encode(response))
            )
        for job_id in scheduled:
            self.enqueue(job_id, self.run(job_id))
        return response

    def get(self, job_id):
        with self.store.connect() as db:
            row = db.execute("SELECT project_id FROM jobs WHERE id=?", (job_id,)).fetchone()
            if not row:
                raise NotFound("Job not found")
            return enrich_job(
                db, next(j for j in self.store._project(db, row["project_id"])["jobs"] if j["id"] == job_id)
            )

    def cancel(self, job_id):
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT status FROM jobs WHERE id=?", (job_id,)).fetchone()
            if not row:
                raise NotFound("Job not found")
            if row["status"] in ("queued", "running"):
                status = "cancelled" if row["status"] == "queued" else "cancelling"
                db.execute("UPDATE jobs SET status=?,updated_at=? WHERE id=?", (status, now(), job_id))
                last = db.execute("SELECT MAX(attempt) FROM job_attempts WHERE job_id=?", (job_id,)).fetchone()[0]
                if last is not None:
                    phase(db, job_id, last, status)
        return self.get(job_id)

    def retry(self, job_id):
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
            if not row:
                raise NotFound("Job not found")
            if row["status"] not in ("failed", "interrupted"):
                raise ValueError("Only failed or interrupted jobs can be retried")
            kind = row["kind"]
            if kind not in ("generation", "render"):
                raise ValueError("Unknown job kind")
            db.execute("UPDATE jobs SET status=?,error=NULL,updated_at=? WHERE id=?", ("queued", now(), job_id))
        if kind == "generation":
            self.enqueue(job_id, self.run(job_id))
        else:
            from .delivery import StudioDelivery

            delivery = StudioDelivery(self.store, schedule=self.delivery_schedule)
            delivery.schedule(delivery.run(job_id))
        return self.get(job_id)

    def recover_on_startup(self):
        """Resume acknowledged queued jobs; running work needs explicit retry.

        Call once per process after the legacy generation queue is initialized.
        """
        with self.store.connect() as db:
            db.execute(
                "UPDATE jobs SET status='interrupted',error='Server restarted; retry explicitly',updated_at=? WHERE status='running'",
                (now(),),
            )
            db.execute("UPDATE jobs SET status='cancelled',updated_at=? WHERE status='cancelling'", (now(),))
            interrupted = db.execute(
                "SELECT a.job_id,a.attempt,j.status FROM job_attempts a JOIN jobs j ON j.id=a.job_id WHERE a.phase IN ('running','loading_model','generating','processing','mixing','encoding','metering','publishing','cancelling') AND j.status IN ('interrupted','cancelled')"
            ).fetchall()
            for item in interrupted:
                phase(db, item["job_id"], item["attempt"], item["status"])
            queued = db.execute("SELECT id,kind FROM jobs WHERE status='queued' ORDER BY created_at,id").fetchall()
        for row in queued:
            if row["kind"] == "generation":
                self.enqueue(row["id"], self.run(row["id"]))
            elif row["kind"] == "render":
                from .delivery import StudioDelivery

                delivery = StudioDelivery(self.store, schedule=self.delivery_schedule)
                delivery.schedule(delivery.run(row["id"]))

    def interrupt_on_startup(self):
        """Compatibility alias for startup integration."""
        self.recover_on_startup()

    async def run(self, job_id):
        import soundfile as sf

        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
            if not row or row["status"] != "queued":
                return
            db.execute("UPDATE jobs SET status='running',updated_at=? WHERE id=?", (now(), job_id))
            project_id = row["project_id"]
            frozen = json.loads(row["request"])
            attempt = start_attempt(db, job_id)
        frozen["creation_job_id"] = job_id
        frozen["creation_attempt"] = attempt

        def set_phase(value):
            with self.store.connect() as db:
                status = db.execute("SELECT status FROM jobs WHERE id=?", (job_id,)).fetchone()
                if not status or status["status"] != "running":
                    raise RuntimeError("Generation cancelled before the next phase")
                phase(db, job_id, attempt, value)

        temporary = self.store.asset_dir / (".generation-" + job_id)
        try:
            # Version 0-2 jobs already contain a frozen passage but predate capability
            # snapshots. Upgrade only that input, without changing request replay identity.
            if "effective_direction" not in frozen:
                caps, effective = freeze_passage(frozen["passage"], self.capability_resolver)
                frozen["capabilities"] = caps
                frozen["effective_direction"] = effective
                if frozen["passage"].get("voice_snapshot") is not None:
                    frozen["passage"]["voice_snapshot"]["capabilities"] = caps
                stored = {k: v for k, v in frozen.items() if k not in ("creation_job_id", "creation_attempt")}
                with self.store.connect() as db:
                    db.execute("UPDATE jobs SET request=? WHERE id=? AND status='running'", (encode(stored), job_id))
            audio, rate = await (
                self.synth(frozen) if self.synth is not None else synthesize(frozen, self.store, set_phase)
            )
            set_phase("processing")
            sf.write(str(temporary), audio, rate, format="WAV")
            with self.store.connect() as db:
                row = db.execute("SELECT status FROM jobs WHERE id=?", (job_id,)).fetchone()
                if not row or row["status"] != "running":
                    return
            asset = self.store.add_asset(project_id, temporary)
            with self.store.connect() as db:
                db.execute("BEGIN IMMEDIATE")
                row = db.execute("SELECT status FROM jobs WHERE id=?", (job_id,)).fetchone()
                if not row or row["status"] != "running":
                    return
                p = frozen["passage"]
                snapshot = p.get("voice_snapshot") or {}
                take_id = uid()
                db.execute(
                    "INSERT INTO takes VALUES (?,?,?,?,?,?,?,?,?)",
                    (
                        take_id,
                        project_id,
                        p["id"],
                        asset["id"],
                        p["text"],
                        snapshot.get("engine", "unknown"),
                        snapshot.get("model_size"),
                        now(),
                        encode(frozen),
                    ),
                )
                project = self.store._project(db, project_id)
                current = next((x for x in project["document"]["passages"] if x["id"] == p["id"]), None)
                if (
                    frozen["adopt"]
                    and current
                    and not current["locked"]
                    and current["input_revision"] == p["input_revision"]
                    and current["selection_token"] == p["selection_token"]
                ):
                    row = db.execute("SELECT undo FROM projects WHERE id=?", (project_id,)).fetchone()
                    undo = json.loads(row["undo"])
                    undo.append(
                        dict(
                            document=copy.deepcopy(project["document"]),
                            name=project["name"],
                            client_label=project["client_label"],
                        )
                    )
                    current["selected_take_id"] = take_id
                    current["selection_token"] += 1
                    self.store._remember_intents(db, project_id, project["document"])
                    db.execute(
                        "UPDATE projects SET document=?,undo=?,redo=?,revision=revision+1,updated_at=? WHERE id=?",
                        (encode(project["document"]), encode(undo), "[]", now(), project_id),
                    )
                phase(db, job_id, attempt, "completed")
                db.execute(
                    "UPDATE jobs SET status='completed',result=?,updated_at=? WHERE id=?",
                    (encode({"take_id": take_id, "asset_id": asset["id"]}), now(), job_id),
                )
        except Exception as exc:
            with self.store.connect() as db:
                status = db.execute("SELECT status FROM jobs WHERE id=?", (job_id,)).fetchone()
                if status and status["status"] == "running":
                    phase(db, job_id, attempt, "failed", str(exc))
                db.execute(
                    "UPDATE jobs SET status='failed',error=?,updated_at=? WHERE id=? AND status='running'",
                    (str(exc), now(), job_id),
                )
        finally:
            temporary.unlink(missing_ok=True)
            with self.store.connect() as db:
                status = db.execute("SELECT status FROM jobs WHERE id=?", (job_id,)).fetchone()
                if status and status["status"] == "cancelling":
                    phase(db, job_id, attempt, "cancelled")
                db.execute(
                    "UPDATE jobs SET status='cancelled',updated_at=? WHERE id=? AND status='cancelling'",
                    (now(), job_id),
                )


@serialized_inference
async def synthesize(request, store, set_phase=None):
    """Use the copied snapshot, never the mutable profile row."""
    from ..backends import (
        engine_needs_trim,
        engine_retries_runaway,
        ensure_model_cached_or_raise,
        get_tts_backend_for_engine,
        load_engine_model,
    )
    from ..utils.audio import has_tts_runaway, trim_tts_output
    from ..utils.chunked_tts import generate_chunked

    p = request["passage"]
    voice = p.get("voice_snapshot")
    if not voice:
        raise ValueError("Assign a voice before generation")
    engine = voice["engine"]
    size = voice.get("model_size") or "default"
    if set_phase:
        set_phase("loading_model")
    # Refuse a platform/registry change rather than run a different model under a frozen identity.
    if (
        request.get("capabilities")
        and resolve_voice(voice)["registry_identity"] != request["capabilities"]["registry_identity"]
    ):
        raise ValueError("Frozen model identity is unavailable on this runtime; reassign the voice")
    await ensure_model_cached_or_raise(engine, size)
    model = get_tts_backend_for_engine(engine)
    await load_engine_model(engine, size)
    combined_path = None
    try:
        if voice["voice_type"] == "preset":
            prompt = {k: voice[k] for k in ("voice_type", "preset_engine", "preset_voice_id")}
        elif voice["voice_type"] == "designed":
            prompt = {"voice_type": "designed", "design_prompt": voice["design_prompt"]}
        else:
            samples = voice.get("samples", [])
            if not samples:
                raise ValueError("Voice reference snapshot is missing")
            paths = [str(store.asset_path(s["asset_id"])) for s in samples]
            if len(paths) == 1:
                prompt, _ = await model.create_voice_prompt(paths[0], samples[0]["reference_text"], use_cache=False)
            else:
                import soundfile as sf

                combined, reference_text = await model.combine_voice_prompts(paths, [s["reference_text"] for s in samples])
                combined_path = store.asset_dir / (".combined-" + uid())
                sf.write(str(combined_path), combined, 24000, format="WAV")
                # Keep combined_path on disk until generate_chunked completes: MLX and
                # Chatterbox backends store ref_audio lazily and read it inside generate().
                prompt, _ = await model.create_voice_prompt(str(combined_path), reference_text, use_cache=False)
        d = request.get("effective_direction", p["direction"])
        if set_phase:
            set_phase("generating")
        audio, rate = await generate_chunked(
            model,
            request.get("spoken_text", p["text"]),
            prompt,
            language=p["language"],
            seed=d["seed"],
            instruct=d["instruct"] or None,
            max_chunk_chars=d["max_chunk_chars"],
            crossfade_ms=d["crossfade_ms"],
            trim_fn=trim_tts_output if engine_needs_trim(engine) else None,
            runaway_detector=has_tts_runaway if engine_retries_runaway(engine) else None,
        )
        speed = float(d.get("speed", 1.0) or 1.0)
        if abs(speed - 1.0) >= 1e-3:
            from ..utils.audio import protect_audio_peak
            from ..utils.speech_delivery import apply_speed

            audio = protect_audio_peak(apply_speed(audio, rate, speed))
        return audio, rate
    finally:
        if combined_path is not None:
            combined_path.unlink(missing_ok=True)
