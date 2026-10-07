"""Quick Create autopilot (contract v4): one prompt to a finished film with nobody in the loop.

Why a resumable state machine and not a parent that waits: a worker runs one job at a time,
so a parent sitting in the worker while its frames and takes wait in the queue behind it
would deadlock a single-GPU box. Instead, every time the autopilot is claimed it advances as
far as it can, doing the LLM and vision work inline (short, and nothing else needs the GPU
for it), enqueues the GPU work as ordinary generate / reel_assemble jobs, then hands itself
back to the queue (worker.JobDeferred) at WAIT_PRIORITY. The children run first; the last
one to finish wakes the parent up (wake_parent). Everything it knows lives in the DB: stage
records in job.result, generations tagged params.autopilot=<job id>. So a crash, a worker
restart or POST /jobs/{id}/retry continues at the first unfinished stage.
"""
import copy
import logging
import math
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from fastapi import HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app import ai_jobs, longtake, models_catalog, storyboard as sb, vision
from app import reel as rl
from app.config import get_settings
from app.llm import LLMError, chat_sync
from app.llm import prompts as P
from app.models import Character, Generation, Job, Location, Project, Scene, Shot, utcnow
from app.services import approve, enqueue_generation, generation_file, new_seed, next_version

log = logging.getLogger("mixai.autopilot")

JOB_TYPE = "autopilot"
STAGES = (("outline", "Writing"), ("cast", "Cast"), ("storyboard", "Storyboard"), ("render", "Rendering"),
          ("stitch", "Stitching"), ("upscale", "Upscaling"))
# below every other job type (ai_summarize is -10), so children always run before the parent re-checks
WAIT_PRIORITY = -20
POLL_S = 10.0
TAKE_ATTEMPTS = 2  # first take plus one re-roll
STITCH_ATTEMPTS = 2

# rough wall-clock figures for the ETA
IMAGE_S = 25.0
VISION_S = 20.0
LLM_S = 45.0

STYLE_PRESETS = {
    "cinematic": (
        "Cinematic film still, 35mm anamorphic look, motivated low-key lighting, rich contrast, "
        "subtle film grain, shallow depth of field.",
        "a cinematic short film with a clear dramatic arc",
    ),
    "documentary": (
        "Documentary footage look, handheld 35mm, available natural light, true-to-life colour, "
        "candid framing, no stylisation.",
        "an observational documentary: real places, real textures, a quiet narrative through-line",
    ),
    "animated": (
        "Stylised 3D animated feature look, soft global illumination, vibrant saturated palette, "
        "clean simple shapes, expressive characters.",
        "an animated short with expressive characters and a simple, clear story",
    ),
    "commercial": (
        "High-end commercial look, crisp studio-quality lighting, polished detail, bright clean palette, "
        "sharp focus.",
        "a polished commercial spot: a hook, a reveal and a payoff, every shot clean and aspirational",
    ),
}


def _w():
    from app import worker  # the worker imports this module at the bottom

    return worker


def _iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ---------------------------------------------------------------- sizing (contract v4)

def scene_range(duration_s: float) -> tuple[int, int]:
    if duration_s <= 12:
        return 1, 1
    if duration_s <= 60:
        return 1, 3
    return max(2, math.ceil(duration_s / 40)), max(2, math.floor(duration_s / 20))


def target_scenes(duration_s: float) -> int:
    lo, hi = scene_range(duration_s)
    return max(lo, min(hi, round(duration_s / (20 if duration_s <= 60 else 30))))


def fit_durations(wanted: list[float], total: float) -> list[float]:
    """Scale the outline's scene lengths so they add up to the requested runtime."""
    cap = get_settings().longtake_max_s
    raw = [max(1.0, float(w or 0)) for w in wanted]
    scale = total / sum(raw)
    out = [max(2.0, min(cap, round(w * scale * 2) / 2)) for w in raw]
    # the last scene soaks up the rounding so the film lands on the asked length
    out[-1] = max(2.0, min(cap, round((total - sum(out[:-1])) * 2) / 2))
    return out


def initial_result(upscale: bool) -> dict:
    return {
        "stages": [{"key": k, "label": label, "status": "pending"} for k, label in STAGES],
        "preview_ids": [], "final_render_id": None, "eta_s": None, "waiting_on": [],
        "upscale_requested": upscale,
    }


# ---------------------------------------------------------------- prompts

class QuickOutline(BaseModel):
    title: str = ""
    logline: str
    characters: list[P.OutlineCharacter] = []
    scenes: list[P.OutlineScene] = Field(min_length=1)


NO_DIALOGUE = ("Nobody speaks on screen and there is no voice-over: tell it through action, images and ambient "
               "sound only. Write no character cues and no dialogue lines.")


def outline_messages(project: Project, style: str, dialogue: bool, duration_s: float) -> list[dict]:
    lo, hi = scene_range(duration_s)
    n = target_scenes(duration_s)
    count = "exactly 1 scene" if hi == 1 else f"{n} scenes (anywhere from {lo} to {hi} is fine)"
    talk = "Characters may speak; keep the lines few and short." if dialogue else NO_DIALOGUE
    user = (
        f"The idea, in the client's own words:\n{project.brief.strip()[:3000]}\n\n"
        f"Make it {STYLE_PRESETS[style][1]}. Total running time: {duration_s:g} seconds, so plan {count} whose "
        f"duration_s add up to {duration_s:g}.\n{talk}\n"
        "Each scene is filmed as ONE continuous shot, so keep every scene to one place and one clear action.\n"
        "Give: title (a short film title, at most six words), logline (one sentence), characters (name plus a few "
        "words on their role; only who the idea needs, possibly nobody), and for each scene: heading (a slug line "
        "like EXT. HARBOUR - NIGHT), logline, purpose, time_of_day (one of: " + ", ".join(P.TIMES) + "), mood "
        "(2-4 words), duration_s and characters (names exactly as in the cast)."
    )
    return [{"role": "system", "content": P.DIRECTOR_SYSTEM}, {"role": "user", "content": user}]


def draft_messages(project, chars, scenes, idx: int, plan: dict, dialogue: bool, seconds: float) -> list[dict]:
    msgs = P.draft_scene_messages(project, chars, scenes, idx, plan={**plan, "duration_s": int(seconds)})
    msgs[1]["content"] += (f"\n\nThe scene plays as one continuous {seconds:g}-second shot: one place, one "
                           "unbroken moment, nothing that needs a cut.")
    if not dialogue:
        msgs[1]["content"] += "\n" + NO_DIALOGUE
    return msgs


def portrait_fallback(c: Character) -> str:
    return (f"Head-and-shoulders reference portrait of {c.description or c.name}, slight three-quarter turn, "
            "neutral expression, plain neutral grey background, soft even light, sharp focus on the eyes.")


# ---------------------------------------------------------------- plumbing

class StageFailed(RuntimeError):
    pass


@dataclass
class Wait:
    job_ids: list[str]
    message: str


@dataclass
class Skip:
    detail: str


class _InlineCtx:
    """JobContext stand-in for an ordinary AI handler run inside the autopilot: the child job
    gets its own row (for suggestions and the job list), cancel/heartbeat go through the parent."""

    def __init__(self, ap: "Autopilot", child: Job):
        self.ap, self.db, self.job = ap, ap.db, child
        self.driver_factory = ap.ctx.driver_factory

    def progress(self, fraction: float, message: str = "") -> None:
        if message:
            self.ap.message = message
        self.ap.tick()
        if self.db.scalar(select(Job.status).where(Job.id == self.job.id)) == "cancelled":
            raise _w().JobCancelled()
        self.job.progress = max(0.0, min(1.0, fraction))
        if message:
            self.job.message = message[:500]
        self.job.heartbeat_at = utcnow()
        self.db.commit()


class Autopilot:
    def __init__(self, ctx):
        self.ctx, self.db, self.job = ctx, ctx.db, ctx.job
        self.p = self.job.payload or {}
        self.r = copy.deepcopy(self.job.result or {}) or initial_result(bool(self.p.get("upscale")))
        self.project = self.db.get(Project, self.p.get("project_id"))
        if self.project is None or self.project.workspace_id != self.job.workspace_id:
            raise RuntimeError("The project for this quick video no longer exists")
        self.s = get_settings()
        self.current: str | None = None
        self.idx = 0
        self.frac = 0.0
        self.message = ""
        self.spins = 0

    # ---- state
    def stage(self, key: str) -> dict:
        return next(st for st in self.r["stages"] if st["key"] == key)

    def save(self) -> None:
        self.job.result = copy.deepcopy(self.r)
        flag_modified(self.job, "result")

    def tick(self, frac: float | None = None, message: str | None = None) -> None:
        """Commit state + heartbeat; raises when the job was cancelled or the worker is stopping."""
        if frac is not None:
            self.frac = frac
        if message is not None:
            self.message = message
        label = dict(STAGES).get(self.current or "", "")
        overall = (self.idx + max(0.0, min(1.0, self.frac))) / len(STAGES)
        self.save()
        self.ctx.progress(overall, f"{label}: {self.message}" if label and self.message else self.message or label)

    def llm(self, message: str, role, messages, **kw):
        self.tick(message=message)
        t0 = time.monotonic()
        res = chat_sync(role, messages, tick=lambda: self.tick(message=f"{message} {int(time.monotonic() - t0)} s"),
                        **kw)
        calls = self.r.setdefault("calls", [])
        calls.append({**res.call_info(role), "step": message})
        del calls[:-40]  # a long film makes a lot of calls; the newest are the interesting ones
        return res

    def run_inline(self, type: str, payload: dict, label: str) -> dict:
        W = _w()
        now = utcnow()
        child = Job(workspace_id=self.job.workspace_id, type=type, project_id=self.project.id,
                    payload={**payload, "inline_of": self.job.id}, status="running", attempts=1,
                    priority=ai_jobs.PRIORITY.get(type, 0), started_at=now, heartbeat_at=now, message="Starting")
        self.db.add(child)
        self.db.flush()
        self.r["inline_job_id"] = child.id
        self.tick(message=label)
        child_id = child.id
        try:
            result = W.HANDLERS[type](_InlineCtx(self, child))
        except (W.JobCancelled, W.WorkerStopping) as e:
            self.db.rollback()
            child = self.db.get(Job, child_id)
            child.status = "cancelled" if isinstance(e, W.JobCancelled) else "failed"
            child.message = "Cancelled" if isinstance(e, W.JobCancelled) else "Worker shut down"
            child.finished_at = utcnow()
            self.db.commit()
            raise
        except Exception as e:
            self.db.rollback()
            child = self.db.get(Job, child_id)
            child.status, child.error, child.message, child.finished_at = "failed", str(e), "Failed", utcnow()
            self.db.commit()
            raise StageFailed(f"{label} failed: {e}") from e
        child.status, child.progress, child.message, child.result, child.finished_at = "done", 1.0, "Done", result, utcnow()
        child.gpu_seconds = 0.0
        self.r.pop("inline_job_id", None)
        self.tick()
        return result

    def link(self, g: Generation) -> Generation:
        """Tag a child generation and point its job back at us, for wake_parent."""
        g.params = {**(g.params or {}), "autopilot": self.job.id}
        child = self.db.get(Job, g.job_id)
        child.payload = {**(child.payload or {}), "parent_job_id": self.job.id}
        return g

    # ---- the loop
    def run(self) -> dict:
        for i, (key, _label) in enumerate(STAGES):
            st = self.stage(key)
            if st["status"] in ("done", "skipped"):
                continue
            self.current, self.idx, self.frac = key, i, 0.0
            if st["status"] != "running":
                st.update(status="running", started_at=st.get("started_at") or _iso(), detail=None)
            self.r["eta_s"] = self.eta()
            self.tick(0.0, "")
            fn: Callable[[], object] = getattr(self, f"stage_{key}")
            while True:
                out = fn()
                if isinstance(out, Wait):
                    self.wait(out)  # returns only when the children finished while we polled
                    continue
                break
            st.update(status="skipped" if isinstance(out, Skip) else "done", finished_at=_iso(),
                      detail=out.detail if isinstance(out, Skip) else st.get("detail"))
            self.previews()
            self.tick(1.0, "")
        self.r.update(eta_s=0, waiting_on=[])
        self.project.status = "done"
        self.previews()
        return copy.deepcopy(self.r)

    def pending(self, ids: list[str]) -> list[str]:
        if not ids:
            return []
        return list(self.db.scalars(select(Job.id).where(Job.id.in_(ids), Job.status.in_(("queued", "running")))).all())

    def other_work_queued(self) -> bool:
        return bool(self.db.scalar(select(func.count()).select_from(Job).where(
            Job.status == "queued", Job.priority > WAIT_PRIORITY, Job.id != self.job.id)))

    def wait(self, w: Wait) -> None:
        ids = list(dict.fromkeys(w.job_ids))
        self.r["waiting_on"] = ids
        self.r["eta_s"] = self.eta()
        self.previews()
        self.tick(message=w.message)
        if not self.pending(ids):
            # a generation stuck in "queued" behind a finished job would loop here forever
            self.spins += 1
            if self.spins > 200:
                raise StageFailed("Stuck waiting for work that already finished; retry the job")
            return
        self.spins = 0
        if not self.other_work_queued():
            # children are running on another worker (or blocked): poll a little rather than spin
            deadline = time.monotonic() + POLL_S
            while time.monotonic() < deadline:
                time.sleep(1.0)
                self.tick()
                if not self.pending(ids):
                    return
                if self.other_work_queued():
                    break
        self.db.commit()
        raise _w().JobDeferred(f"{dict(STAGES)[self.current]}: {w.message}", priority=WAIT_PRIORITY)

    def fail(self, err: Exception) -> str:
        """Record the failed stage (the handler's own changes were rolled back)."""
        self.db.rollback()
        self.db.refresh(self.job)
        r = copy.deepcopy(self.job.result or self.r)
        msg = str(err) or type(err).__name__
        if isinstance(err, LLMError):
            msg = f"The AI couldn't be reached: {msg}"
        for st in r.get("stages", []):
            if st["key"] == self.current:
                st.update(status="failed", detail=msg[:500], finished_at=_iso())
        r["waiting_on"] = []
        self.job.result = r
        flag_modified(self.job, "result")
        self.db.commit()
        label = dict(STAGES).get(self.current or "", "Autopilot")
        return f"{label} failed: {msg}" if not msg.startswith(label) else msg

    # ---- helpers
    def scenes(self) -> list[Scene]:
        return ai_jobs.ordered_scenes(self.db, self.project.id)

    def characters(self) -> list[Character]:
        return list(self.db.scalars(select(Character).where(Character.project_id == self.project.id)
                                    .order_by(Character.created_at)).all())

    def locations(self) -> list[Location]:
        return list(self.db.scalars(select(Location).where(Location.project_id == self.project.id)
                                    .order_by(Location.created_at)).all())

    def previews(self) -> None:
        rows = self.db.scalars(select(Generation.id).where(
            Generation.project_id == self.project.id, Generation.status.in_(("ready", "approved")),
            Generation.kind.in_(("portrait", "establishing", "keyframe_start", "keyframe_end", "take", "render")),
        ).order_by(Generation.updated_at.desc()).limit(8)).all()
        self.r["preview_ids"] = list(rows)

    def eta(self) -> int:
        # TODO: calibrate from this server's finished autopilot jobs instead of fixed figures
        d = float(self.p.get("duration_s") or self.project.target_runtime_s)
        n = len(self.scenes()) or target_scenes(d)
        cast = len(self.characters()) + len(self.locations()) or 2
        shots = sb.project_shots(self.db, self.project.id)
        render = sum(longtake.estimate(s.duration_s)["est_wall_s"] for s in shots) if shots else \
            n * longtake.estimate(d / n)["est_wall_s"]
        per = {
            "outline": LLM_S * (n + 2),
            "cast": LLM_S * 2 + cast * (IMAGE_S + VISION_S + LLM_S / 2),
            "storyboard": n * (LLM_S + 2 * (IMAGE_S + VISION_S)),
            "render": render,
            "stitch": 15 + d * 0.5,
            "upscale": d * 8 if self.p.get("upscale") else 0,
        }
        todo = [st["key"] for st in self.r["stages"] if st["status"] not in ("done", "skipped")]
        return int(sum(per[k] for k in todo))

    def _approve(self, g: Generation, check: str, **extra) -> None:
        approve(self.db, g)
        g.params = {**(g.params or {}), "approved_by": "autopilot", "auto_check": check, **extra}

    def _slot(self, target_type: str, target_id: str, kind: str) -> list[Generation]:
        gens = self.db.scalars(select(Generation).where(
            Generation.target_type == target_type, Generation.target_id == target_id, Generation.kind == kind,
        ).order_by(Generation.created_at)).all()
        mine = [g for g in gens if (g.params or {}).get("autopilot") == self.job.id]
        # attempts that were cancelled (job cancel / resume) don't count against the retry budget
        cancelled = set(self.db.scalars(select(Job.id).where(
            Job.id.in_([g.job_id for g in mine if g.job_id]), Job.status == "cancelled")).all())
        return [g for g in mine if g.job_id not in cancelled]

    def _last_error(self, gens: list[Generation]) -> str:
        for g in reversed(gens):
            j = self.db.get(Job, g.job_id) if g.job_id else None
            if j is not None and j.error:
                return j.error
        return "no usable result"

    # ---- auto-approval
    def image_slot(self, target_type: str, target_id: str, kind: str, make: Callable[[], Generation],
                   description: str, reference: Path | None, label: str) -> list[str]:
        """Settle one image: returns the job ids to wait for, [] once something is approved."""
        if sb.approved(self.db, target_type, target_id, kind):
            return []
        gens = self._slot(target_type, target_id, kind)
        pending = [g.job_id for g in gens if g.status in ("queued", "generating")]
        if pending:
            return pending
        ready = [g for g in gens if g.status == "ready"]
        threshold = self.s.auto_approve_score
        for g in ready:
            if (g.score or {}).get("vision") is not None:
                continue
            down = self.r.get("vision_unavailable")
            path = generation_file(g)
            if not down:
                try:
                    v, info = vision.score_image(path, description, reference,
                                                 tick=lambda: self.tick(message=f"Checking {label}"))
                    g.score = {**(g.score or {}), "vision": v.score, "issues": v.issues, "model": info.get("model")}
                    g.params = {**(g.params or {}), "auto_check": "scored"}
                    self.tick(message=f"Checked {label}: {v.score:g}/10")
                    if v.score >= threshold:
                        break  # good enough; don't spend time scoring the rest
                    continue
                except vision.VisionUnavailable as e:
                    log.warning("vision check unavailable, approving unchecked: %s", e)
                    # remembered for the whole job: a dead model would otherwise cost a timeout per image
                    self.r["vision_unavailable"] = str(e)[:300]
            newest = ready[-1]
            self._approve(newest, "unchecked", auto_check_reason=self.r["vision_unavailable"])
            return []
        scored = [g for g in ready if (g.score or {}).get("vision") is not None]
        best = max(scored, key=lambda g: g.score["vision"], default=None)
        if best is not None and best.score["vision"] >= threshold:
            self._approve(best, "passed")
            return []
        if len(gens) < 1 + max(0, self.s.auto_retries):
            # TODO: fold the vision issues into the prompt for the re-roll (rewrite_prompt_from_note)
            g = self.link(make())
            self.db.flush()
            return [g.job_id]
        if best is not None:
            self._approve(best, "below_threshold")
            return []
        raise StageFailed(f"Couldn't generate {label} after {len(gens)} tries: {self._last_error(gens)}")

    def take_slot(self, shot: Shot, label: str) -> list[str]:
        if sb.approved(self.db, "shot", shot.id, "take"):
            return []
        gens = self._slot("shot", shot.id, "take")
        pending = [g.job_id for g in gens if g.status in ("queued", "generating")]
        if pending:
            return pending
        ready = [g for g in gens if g.status == "ready"]
        for g in ready:
            if (g.score or {}).get("check"):
                continue
            self.tick(message=f"Checking {label}")
            expected = float((g.params or {}).get("duration_s") or shot.duration_s)
            try:
                chk = vision.check_take(generation_file(g), expected).as_score()
            except Exception as e:  # a probe hiccup shouldn't sink the film
                chk = {"check": "failed", "issues": [f"couldn't check the video: {e}"]}
            g.score = {**(g.score or {}), **chk}
        passing = next((g for g in ready if g.score.get("check") == "passed"), None)
        if passing is not None:
            self._approve(passing, "passed")
            return []
        if len(gens) < TAKE_ATTEMPTS:
            g = self.link(self._enqueue_shot(shot, "take"))
            self.db.flush()
            return [g.job_id]
        if ready:
            best = min(ready, key=lambda g: len(g.score.get("issues") or []))
            self._approve(best, "flagged", auto_issues=best.score.get("issues") or [])
            return []
        raise StageFailed(f"Couldn't render {label} after {len(gens)} tries: {self._last_error(gens)}")

    def _enqueue_shot(self, shot: Shot, kind: str) -> Generation:
        try:
            prompt, params = sb.prepare_shot_generation(self.db, shot, kind, "", {})
        except HTTPException as e:
            raise StageFailed(str(e.detail)) from e
        return enqueue_generation(self.db, workspace_id=shot.workspace_id, project_id=shot.project_id,
                                  target_type="shot", target_id=shot.id, kind=kind, prompt=prompt, params=params)

    def _reference(self, shot: Shot) -> Path | None:
        for cid in shot.character_ids or []:
            g = sb.approved(self.db, "character", cid, "portrait")
            if g and g.file_path:
                return generation_file(g)
        return None

    # ---------------------------------------------------------------- stages
    def stage_outline(self):
        db, project = self.db, self.project
        o = self.r.setdefault("outline", {})
        style = self.p.get("style") or "cinematic"
        dialogue = bool(self.p.get("dialogue", True))
        total = float(self.p.get("duration_s") or project.target_runtime_s)
        by_id = {s.id: s for s in self.scenes()}
        ids = o.get("scene_ids") or []

        if not ids or any(i not in by_id for i in ids):
            for s in by_id.values():  # stubs from an attempt that died before it published
                db.delete(s)
            db.flush()
            try:
                res = self.llm("Outlining the film", "reasoning", outline_messages(project, style, dialogue, total),
                               schema=QuickOutline, temperature=0.6, max_tokens=8000)
            except LLMError as e:
                raise StageFailed(f"The AI writer isn't available: {e}") from e
            out: QuickOutline = res.data
            _lo, hi = scene_range(total)
            plans = out.scenes[:hi]
            durations = fit_durations([pl.duration_s for pl in plans], total)
            if self.p.get("title_auto", True) and out.title.strip():
                project.title = P.clean_line(out.title)[:300]
            project.logline = project.logline or out.logline.strip()
            scenes = [ai_jobs._new_scene(project, pl) for pl in plans]
            db.add_all(scenes)
            ai_jobs.renumber(scenes)
            db.flush()
            for sc in scenes:
                db.add(ai_jobs.snapshot(sc))
            for c in out.characters:
                ai_jobs.upsert_character(db, project, c.name, "", action="quick", job_id=self.job.id)
            o.update(scene_ids=[s.id for s in scenes], durations={s.id: d for s, d in zip(scenes, durations)},
                     plan=[pl.model_dump() for pl in plans], roles=[[c.name, c.role] for c in out.characters])
            self.tick(0.15, f"Planned {len(scenes)} scene{'s' if len(scenes) != 1 else ''}")
            ids = o["scene_ids"]
            by_id = {s.id: s for s in self.scenes()}

        scenes = [by_id[i] for i in ids]
        for k, (sc, plan) in enumerate(zip(scenes, o["plan"])):
            if sc.script_text.strip():
                continue
            seconds = float(o["durations"][sc.id])
            try:
                res = self.llm(f"Writing scene {k + 1} of {len(scenes)}", "creative",
                               draft_messages(project, self.characters(), scenes, k, plan, dialogue, seconds),
                               temperature=0.8, max_tokens=ai_jobs._tokens_for(P.words_for(int(seconds))))
            except LLMError as e:
                raise StageFailed(f"The AI writer isn't available: {e}") from e
            ai_jobs.write_scene(db, sc, {"script_text": P.clean_script(res.content, sc.heading)}, action="quick",
                                job_id=self.job.id, summarize=False)
            self.tick(0.15 + 0.7 * (k + 1) / len(scenes))

        if o.get("roles") and not o.get("looks_done"):
            script = "\n\n".join(f"{s.heading}\n{s.script_text}" for s in scenes)
            try:
                looks = self.llm("Describing the cast", "creative", P.looks_messages(project, o["roles"], script),
                                 schema=P.CastLooks, temperature=0.5, max_tokens=1500).data
            except LLMError as e:
                raise StageFailed(f"The AI writer isn't available: {e}") from e
            for look in looks.characters:
                ai_jobs.upsert_character(db, project, look.name, look.description, action="quick", job_id=self.job.id)
            o["looks_done"] = True
        project.updated_at = utcnow()
        return None

    def stage_cast(self):
        db, project = self.db, self.project
        c = self.r.setdefault("cast", {})
        if not c.get("extracted"):
            if any(s.script_text.strip() for s in self.scenes()):
                chars = self.characters()
                if chars and any(not ch.description.strip() for ch in chars):
                    self.run_inline("ai_extract_characters", {"project_id": project.id}, "Reading the cast")
                self.run_inline("ai_extract_locations", {"project_id": project.id}, "Finding the locations")
            c["extracted"] = True
            self.tick(0.2, "Cast and locations found")

        prompts = c.setdefault("portrait_prompts", {})
        waits: list[str] = []
        chars, locs = self.characters(), self.locations()
        for ch in chars:
            if ch.id not in prompts and not sb.approved(db, "character", ch.id, "portrait"):
                try:
                    out = self.run_inline("ai_portrait_prompt", {"character_id": ch.id},
                                          f"Writing {ch.name}'s portrait prompt")
                    prompts[ch.id] = out.get("prompt") or portrait_fallback(ch)
                except StageFailed as e:
                    log.warning("portrait prompt fell back to the template: %s", e)
                    prompts[ch.id] = portrait_fallback(ch)

            def make(ch=ch):
                return enqueue_generation(db, workspace_id=ch.workspace_id, project_id=project.id,
                                          target_type="character", target_id=ch.id, kind="portrait",
                                          prompt=sb.with_style(project, prompts[ch.id]),
                                          params=models_catalog.apply_image_choice(
                                              {"aspect_ratio": project.aspect_ratio}, project.settings))

            waits += self.image_slot("character", ch.id, "portrait", make, f"{ch.name}: {ch.description}", None,
                                     f"{ch.name}'s portrait")
        for loc in locs:
            def make_loc(loc=loc):
                prompt, params = sb.prepare_location_generation(db, loc, "establishing", "", {})
                return enqueue_generation(db, workspace_id=loc.workspace_id, project_id=project.id,
                                          target_type="location", target_id=loc.id, kind="establishing",
                                          prompt=prompt, params=params)

            waits += self.image_slot("location", loc.id, "establishing", make_loc,
                                     f"Establishing shot of {loc.name}, no people. {loc.description}", None,
                                     f"the {loc.name} establishing frame")
        n = len(chars) + len(locs)
        if waits:
            done = n - len({*waits})
            return Wait(waits, f"{max(0, done)} of {n} portraits and locations approved")
        return None

    def stage_storyboard(self):
        db, project = self.db, self.project
        scenes = [s for s in self.scenes() if s.script_text.strip()]
        if not scenes:
            raise StageFailed("There's no script to storyboard")
        if any(not sb.scene_shots(db, s.id) for s in scenes):
            self.run_inline("ai_storyboard", {"project_id": project.id, "mode": "scene", "chain": True,
                                              "generate_frames": False, "overwrite": False, "scene_ids": []},
                            "Planning the shots")
            durations = (self.r.get("outline") or {}).get("durations") or {}
            cap = self.s.longtake_max_s
            for s in scenes:
                shots = sb.scene_shots(db, s.id)
                if not shots:
                    raise StageFailed(f"The storyboard has no shot for {s.heading or 'a scene'}")
                if s.id in durations and len(shots) == 1:
                    # one shot per scene in quick mode: the shot is the scene's whole planned length
                    shots[0].duration_s = max(1.0, min(cap, float(durations[s.id])))
            self.tick(0.2, "Shots planned")

        shots = sb.project_shots(db, project.id)
        waits: list[str] = []
        for n, shot in enumerate(shots, start=1):
            prev, _ = sb.neighbours(db, shot)
            kinds = ["keyframe_end"] if sb.is_linked(shot, prev) else ["keyframe_start", "keyframe_end"]
            ref = self._reference(shot)
            for kind in kinds:
                desc = shot.start_prompt if kind == "keyframe_start" else shot.end_prompt
                waits += self.image_slot("shot", shot.id, kind, lambda shot=shot, kind=kind: self._enqueue_shot(shot, kind),
                                         desc or shot.description, ref,
                                         f"shot {n}'s {'first' if kind == 'keyframe_start' else 'last'} frame")
        if waits:
            return Wait(waits, f"Frames for {len(shots)} shot{'s' if len(shots) != 1 else ''}")
        # frames were approved in an arbitrary order, which flags neighbours as stale; nothing is
        for s in shots:
            s.stale = False
        return None

    def stage_render(self):
        shots = sb.project_shots(self.db, self.project.id)
        waits: list[str] = []
        for n, shot in enumerate(shots, start=1):
            waits += self.take_slot(shot, f"shot {n} of {len(shots)}")
        if waits:
            done = len(shots) - len(set(waits))
            return Wait(waits, f"{max(0, done)} of {len(shots)} takes approved")
        return None

    def stage_stitch(self):
        db, project = self.db, self.project
        st = self.r.setdefault("stitch", {})
        if st.get("render_id"):
            g = db.get(Generation, st["render_id"])
            job = db.get(Job, g.job_id) if g and g.job_id else None
            if g is not None and g.status in ("ready", "approved"):
                self.r["final_render_id"] = g.id
                return None
            if job is not None and job.status in ("queued", "running"):
                return Wait([job.id], "Stitching the film")
            if st.get("attempts", 0) >= STITCH_ATTEMPTS:
                raise StageFailed(f"Stitching failed: {(job.error if job else None) or 'the render disappeared'}")

        reel = rl.get_reel(db, project)
        rl.sync(db, reel)
        plans, _ = rl.plan(db, reel)
        sel = rl.select_scenes(plans, None)
        if not sel.plans:
            raise StageFailed("Nothing to stitch: no shot has an approved take")
        render = Generation(
            workspace_id=project.workspace_id, project_id=project.id, target_type="project", target_id=project.id,
            kind="render", version=next_version(db, "project", project.id, "render"), status="queued",
            prompt=f"{project.title} · {sel.auto_title}", seed=new_seed(),
            params={"quality": "draft", "title": sel.auto_title, "title_auto": True, "scene_ids": sel.scene_ids,
                    "scene_range": sel.label, "full": sel.full, "clips": sum(len(p.clips) for p in sel.plans),
                    "duration_s": rl.film_length(sel.plans), "autopilot": self.job.id,
                    "created_by": {"flow": "autopilot", "job_id": self.job.id}},
        )
        db.add(render)
        db.flush()
        job = Job(workspace_id=project.workspace_id, type=rl.ASSEMBLE_JOB, project_id=project.id,
                  generation_id=render.id, message="Waiting for a worker",
                  payload={"project_id": project.id, "quality": "draft", "scene_ids": [], "selection": sel.key,
                           "parent_job_id": self.job.id})
        db.add(job)
        db.flush()
        render.job_id = job.id
        reel.updated_at = utcnow()
        st.update(render_id=render.id, attempts=st.get("attempts", 0) + 1)
        return Wait([job.id], "Stitching the film")

    def stage_upscale(self):
        want = self.p.get("upscale")
        if not want:
            return Skip("Not requested")
        db = self.db
        st = self.r.setdefault("upscale", {})
        if st.get("job_id"):
            job = db.get(Job, st["job_id"])
            if job is not None and job.status in ("queued", "running"):
                return Wait([job.id], "Upscaling the film")
            if job is not None and job.status == "done":
                if job.generation_id:
                    self.r["final_render_id"] = job.generation_id
                return None
            raise StageFailed(f"Upscaling failed: {(job.error if job else None) or 'the job disappeared'} "
                              f"(the stitched film is still available)")
        source = db.get(Generation, self.r.get("final_render_id") or "")
        if source is None:
            raise StageFailed("There's no stitched film to upscale")
        entry = upscale_entry()
        if entry is None:
            return Skip("Upscaling isn't available on this server yet")
        try:
            job = entry(db, source, want.get("engine"), want.get("target") or "1080p")
        except UpscaleUnavailable as e:
            return Skip(f"Upscale unavailable: {e}")
        job.payload = {**(job.payload or {}), "parent_job_id": self.job.id}
        st["job_id"] = job.id
        return Wait([job.id], "Upscaling the film")


# ---------------------------------------------------------------- upscale adapter

def upscale_entry():
    """Adapter over app.upscale (built separately): returns queue(db, source_render, engine, target) -> Job,
    raising Skip-worthy errors as UpscaleUnavailable, or None when the module isn't there."""
    try:
        from app import upscale
    except ImportError:
        return None
    fn = getattr(upscale, "queue_upscale", None)
    if fn is None:
        return None
    err = getattr(upscale, "UpscaleError", RuntimeError)

    def queue(db, source, engine, target):
        try:
            return fn(db, source, engine, target, flow="autopilot")
        except err as e:
            raise UpscaleUnavailable(str(e)) from e

    return queue


class UpscaleUnavailable(RuntimeError):
    pass


# ---------------------------------------------------------------- worker entry points

def handle_autopilot(ctx) -> dict:
    W = _w()
    ap = Autopilot(ctx)
    try:
        return ap.run()
    except (W.JobDeferred, W.WorkerStopping):
        raise
    except W.JobCancelled:
        ap.db.rollback()
        ap.db.refresh(ap.job)
        r = copy.deepcopy(ap.job.result or {})
        for st in r.get("stages", []):
            if st["key"] == ap.current and st["status"] == "running":
                st.update(status="pending", detail="Cancelled")
        r["waiting_on"] = []
        ap.job.result = r
        flag_modified(ap.job, "result")
        ap.db.commit()
        raise
    except Exception as e:
        log.exception("autopilot %s failed in %s", ap.job.id, ap.current)
        raise RuntimeError(ap.fail(e)) from e


def wake_parent(db: Session, job: Job) -> None:
    """Worker hook: when a child finishes, put a waiting autopilot back at normal priority
    once nothing it waits on is still queued or running."""
    pid = (job.payload or {}).get("parent_job_id")
    if not pid:
        return
    parent = db.get(Job, pid)
    if parent is None or parent.status != "queued" or parent.priority != WAIT_PRIORITY:
        return
    ids = (parent.result or {}).get("waiting_on") or []
    busy = db.scalar(select(func.count()).select_from(Job).where(
        Job.id.in_(ids), Job.status.in_(("queued", "running")))) if ids else 0
    if not busy:
        parent.priority = 0


def cancel_children(db: Session, job: Job) -> None:
    """API cancel of an autopilot: its queued children go too, running ones are flagged for the worker."""
    r = job.result or {}
    ids = list(r.get("waiting_on") or [])
    if r.get("inline_job_id"):
        ids.append(r["inline_job_id"])
    if not ids:
        return
    now = utcnow()
    for child in db.scalars(select(Job).where(Job.id.in_(ids), Job.status.in_(("queued", "running")))).all():
        was_running = child.status == "running"
        child.status = "cancelled"
        child.message = "Cancelling…" if was_running else "Cancelled"
        if not was_running:
            child.finished_at = now
            g = db.get(Generation, child.generation_id) if child.generation_id else None
            if g is not None and g.status in ("queued", "generating"):
                g.status = "failed"


def on_retry(job: Job) -> None:
    job.priority = 0
    if job.result:
        job.result = {**job.result, "waiting_on": []}
