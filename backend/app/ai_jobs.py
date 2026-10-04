"""AI writing jobs run by the worker, plus the lock rules they share with the API.

Lock rule (PLAN 2b): AI writes straight into a field only when it is empty or the scene
is still an untouched AI draft (source 'ai', not locked). Anything else becomes a
Suggestion the user accepts or rejects.
"""
import logging
import re
import time
from datetime import timedelta

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.llm import LLMError, chat_sync
from app.llm import prompts as P
from app.llm.client import is_warm, model_for
from app.models import Character, Job, Project, Scene, SceneVersion, Suggestion, utcnow

log = logging.getLogger("mixai.ai")

SCRIPT_FIELDS = ("heading", "logline", "script_text")
META_FIELDS = ("time_of_day", "mood")

PRIORITY = {
    "ai_assist": 5,
    "ai_portrait_prompt": 5,
    "ai_extract_characters": 3,
    "ai_write_missing": 2,
    "ai_continue": 2,
    "ai_outline": 1,
    "ai_summarize": -10,
}
SUMMARY_QUIET = timedelta(seconds=8)
SUMMARY_MAX_WAIT = 30.0


# ---------------------------------------------------------------- queueing

def enqueue_ai(db: Session, *, workspace_id: str, type: str, payload: dict, project_id: str | None) -> Job:
    job = Job(
        workspace_id=workspace_id,
        type=type,
        payload=payload,
        project_id=project_id,
        priority=PRIORITY.get(type, 0),
        message="Waiting for a worker",
    )
    db.add(job)
    db.flush()
    return job


def active_job(db: Session, type: str, project_id: str, **match) -> Job | None:
    rows = db.scalars(
        select(Job).where(Job.type == type, Job.project_id == project_id, Job.status.in_(("queued", "running")))
    ).all()
    for j in rows:
        if all((j.payload or {}).get(k) == v for k, v in match.items()):
            return j
    return None


def queue_summary(db: Session, scene: Scene) -> Job | None:
    """Debounced: one queued summary job per scene; the job itself waits for typing to stop."""
    queued = db.scalars(
        select(Job).where(Job.type == "ai_summarize", Job.project_id == scene.project_id, Job.status == "queued")
    ).all()
    if any((j.payload or {}).get("scene_id") == scene.id for j in queued):
        return None
    return enqueue_ai(
        db, workspace_id=scene.workspace_id, type="ai_summarize", payload={"scene_id": scene.id}, project_id=scene.project_id
    )


# ---------------------------------------------------------------- lock rules

def ordered_scenes(db: Session, project_id: str) -> list[Scene]:
    return list(
        db.scalars(select(Scene).where(Scene.project_id == project_id).order_by(Scene.order, Scene.created_at)).all()
    )


def renumber(scenes: list[Scene]) -> None:
    for i, s in enumerate(scenes, start=1):
        s.order = i


def snapshot(scene: Scene, user_id: str | None = None) -> SceneVersion:
    return SceneVersion(
        workspace_id=scene.workspace_id,
        scene_id=scene.id,
        version=scene.version,
        heading=scene.heading,
        logline=scene.logline,
        script_text=scene.script_text,
        source=scene.source,
        created_by=user_id,
    )


def ai_may_write(current: str | None, source: str, locked: bool) -> bool:
    return not (current or "").strip() or (source == "ai" and not locked)


def suggest(db: Session, *, target, target_type: str, field: str, proposed: str, action: str, job_id: str | None) -> Suggestion:
    # a newer suggestion for the same field replaces the old one
    db.execute(
        update(Suggestion)
        .where(
            Suggestion.target_type == target_type,
            Suggestion.target_id == target.id,
            Suggestion.field == field,
            Suggestion.status == "pending",
        )
        .values(status="rejected", resolved_at=utcnow())
    )
    s = Suggestion(
        workspace_id=target.workspace_id,
        project_id=target.project_id,
        target_type=target_type,
        target_id=target.id,
        field=field,
        current_text=getattr(target, field) or "",
        proposed_text=proposed,
        action=action,
        job_id=job_id,
    )
    db.add(s)
    db.flush()
    return s


def write_scene(db: Session, scene: Scene, values: dict, *, action: str, job_id: str | None,
                summarize: bool = True) -> dict:
    """Apply AI output to a scene under the lock rules. Returns which fields were written / suggested."""
    untouched_ai = scene.source == "ai" and not scene.locked
    had_text = any((getattr(scene, f) or "").strip() for f in SCRIPT_FIELDS)
    written, suggested = [], []

    for field in SCRIPT_FIELDS:
        new = (values.get(field) or "").strip()
        cur = getattr(scene, field) or ""
        if not new or new == cur.strip():
            continue
        if ai_may_write(cur, scene.source, scene.locked):
            setattr(scene, field, new)
            written.append(field)
        else:
            suggested.append(suggest(db, target=scene, target_type="scene", field=field, proposed=new,
                                     action=action, job_id=job_id).id)

    # chips are cheap to change back, so they never need a suggestion
    for field in META_FIELDS:
        new = values.get(field)
        if new and (not getattr(scene, field) or untouched_ai):
            setattr(scene, field, new)

    if written:
        if not had_text or untouched_ai:
            scene.source, scene.locked = "ai", False
        elif scene.source == "user":
            scene.source = "ai_edited"
        scene.version += 1
        db.add(snapshot(scene))
        if "script_text" in written and summarize:
            queue_summary(db, scene)
    return {"written": written, "suggestion_ids": suggested}


def _clean_name(name: str) -> str:
    n = re.sub(r"\(.*?\)", "", name).strip(" .:-")
    return n.title() if n.isupper() else n


def upsert_character(db: Session, project: Project, name: str, description: str, *, action: str, job_id: str | None):
    name = _clean_name(name)
    if not name:
        return None, "skipped"
    description = description.strip()
    existing = next(
        (c for c in db.scalars(select(Character).where(Character.project_id == project.id)).all()
         if c.name.casefold() == name.casefold()),
        None,
    )
    if existing is None:
        c = Character(workspace_id=project.workspace_id, project_id=project.id, name=name,
                      description=description, source="ai", locked=False)
        db.add(c)
        db.flush()
        return c, "created"
    if not description or description == existing.description.strip():
        return existing, "unchanged"
    if ai_may_write(existing.description, existing.source, existing.locked):
        existing.description = description
        if existing.source != "ai":
            existing.source = "ai_edited" if existing.locked else "ai"
        return existing, "updated"
    s = suggest(db, target=existing, target_type="character", field="description", proposed=description,
                action=action, job_id=job_id)
    return existing, s.id


def accept(db: Session, s: Suggestion, user_id: str):
    if s.target_type == "scene":
        target = db.get(Scene, s.target_id)
    elif s.target_type == "character":
        target = db.get(Character, s.target_id)
    else:
        target = None
    if target is None:
        raise LookupError("The scene or character for this suggestion no longer exists")
    setattr(target, s.field, s.proposed_text)
    # the user chose this text, so it is theirs now: mixed provenance, locked
    target.source = "ai_edited"
    target.locked = True
    if s.target_type == "scene":
        target.version += 1
        db.add(snapshot(target, user_id))
        if s.field == "script_text":
            queue_summary(db, target)
    s.status = "accepted"
    s.resolved_at = utcnow()
    return target


# ---------------------------------------------------------------- job plumbing

class AiRun:
    """Tracks the LLM calls of one job: progress text, timings and the model's thinking."""

    def __init__(self, ctx):
        self.ctx = ctx
        self.calls: list[dict] = []
        self.thinking: list[str] = []
        self.extra: dict = {}

    def call(self, label: str, frac: float, role, messages, **kw):
        cold = not is_warm(role)
        shown = f"{label} (loading {model_for(role)}, the first call can take a few minutes)" if cold else label
        self.ctx.progress(frac, shown + "…")
        t0 = time.monotonic()

        def tick():
            self.ctx.progress(frac, f"{shown}… {int(time.monotonic() - t0)} s")

        res = chat_sync(role, messages, tick=tick, **kw)
        info = res.call_info(role)
        info["step"] = label
        self.calls.append(info)
        if res.thinking and role == "reasoning":
            self.thinking.append(res.thinking)
        log.info("%s: %s %.1fs", label, res.model, res.seconds)
        return res

    def result(self, **more) -> dict:
        out = {**self.extra, **more, "calls": self.calls}
        if self.thinking:
            out["thinking"] = "\n\n---\n\n".join(self.thinking)
        return out

    def publish(self, **more) -> None:
        # visible to the UI on the next progress commit; new dict so the JSON column notices
        self.extra.update(more)
        self.ctx.job.result = self.result()


def _owned(db: Session, model, obj_id: str | None, job: Job, label: str):
    obj = db.get(model, obj_id) if obj_id else None
    if obj is None or obj.workspace_id != job.workspace_id:
        raise RuntimeError(f"{label} no longer exists")
    return obj


def _characters(db: Session, project_id: str) -> list[Character]:
    return list(db.scalars(select(Character).where(Character.project_id == project_id).order_by(Character.created_at)).all())


def _tokens_for(words: int) -> int:
    return int(words * 2.2) + 300


def _new_scene(project: Project, plan: P.OutlineScene) -> Scene:
    return Scene(
        workspace_id=project.workspace_id,
        project_id=project.id,
        heading=plan.heading.strip().upper(),
        logline=plan.logline.strip(),
        summary=plan.logline.strip(),
        time_of_day=plan.time_of_day,
        mood=plan.mood.strip()[:200],
        source="ai",
        locked=False,
        version=1,
    )


def _draft_into(run: AiRun, db: Session, project: Project, scenes: list[Scene], idx: int, plan: dict, frac: float,
                action: str) -> dict:
    s = scenes[idx]
    words = P.words_for(plan.get("duration_s") or 30)
    res = run.call(
        f"Writing scene {idx + 1} of {len(scenes)}: {s.heading or 'untitled'}", frac, "creative",
        P.draft_scene_messages(project, _characters(db, project.id), scenes, idx, plan=plan),
        temperature=0.8, max_tokens=_tokens_for(words),
    )
    # outline/continue scenes already carry the planned logline as their summary
    return write_scene(db, s, {"script_text": P.clean_script(res.content, s.heading)}, action=action,
                       job_id=run.ctx.job.id, summarize=False)


# ---------------------------------------------------------------- handlers

def _resume_outline(db: Session, job: Job, project: Project, run: "AiRun"):
    """A retried outline job picks up the scenes its earlier attempt created instead of starting over."""
    prev = job.result or {}
    ids = prev.get("scene_ids") or []
    by_id = {s.id: s for s in ordered_scenes(db, project.id)}
    if not ids or not prev.get("plan") or any(i not in by_id for i in ids):
        return None
    if prev.get("thinking"):
        run.thinking.append(prev["thinking"])
    run.calls.extend(prev.get("calls") or [])
    return [by_id[i] for i in ids], prev["plan"], prev.get("roles") or []


def handle_outline(ctx) -> dict:
    db, job = ctx.db, ctx.job
    project = _owned(db, Project, job.payload.get("project_id"), job, "Project")
    run = AiRun(ctx)
    resumed = _resume_outline(db, job, project, run)

    if resumed:
        scenes, plans, roles = resumed
        ctx.progress(0.15, "Picking up where the AI Director left off")
    else:
        existing = ordered_scenes(db, project.id)
        if any((s.script_text or s.heading or s.logline).strip() for s in existing):
            raise RuntimeError("This project already has scenes. Use Write missing scenes or Continue story instead.")
        for s in existing:  # empty stubs only
            db.delete(s)

        res = run.call("The AI Director is outlining your film", 0.03, "reasoning", P.outline_messages(project),
                       schema=P.Outline, temperature=0.6, max_tokens=8000)
        outline: P.Outline = res.data
        if not project.logline.strip():
            project.logline = outline.logline.strip()

        scenes = [_new_scene(project, plan) for plan in outline.scenes]
        db.add_all(scenes)
        renumber(scenes)
        db.flush()
        for sc in scenes:
            db.add(snapshot(sc))
        for c in outline.characters:
            upsert_character(db, project, c.name, "", action="outline", job_id=job.id)
        plans = [pl.model_dump() for pl in outline.scenes]
        roles = [[c.name, c.role] for c in outline.characters]
        run.publish(scene_ids=[s.id for s in scenes], drafted_ids=[], plan=plans, roles=roles)

    drafted = [s.id for s in scenes if s.script_text.strip()]
    n = len(scenes)
    for i, plan in enumerate(plans):
        if scenes[i].script_text.strip():
            continue
        _draft_into(run, db, project, scenes, i, plan, 0.15 + 0.7 * i / n, "outline")
        drafted.append(scenes[i].id)
        run.publish(drafted_ids=list(drafted))

    script = "\n\n".join(f"{s.heading}\n{s.script_text}" for s in scenes)
    char_ids = []
    if roles:
        looks = run.call("Describing the cast", 0.9, "creative", P.looks_messages(project, roles, script),
                         schema=P.CastLooks, temperature=0.5, max_tokens=1500).data
        for look in looks.characters:
            c, _ = upsert_character(db, project, look.name, look.description, action="outline", job_id=job.id)
            if c:
                char_ids.append(c.id)
    project.updated_at = utcnow()
    return run.result(scene_ids=[s.id for s in scenes], drafted_ids=drafted, character_ids=char_ids)


def handle_write_missing(ctx) -> dict:
    db, job = ctx.db, ctx.job
    p = job.payload
    project = _owned(db, Project, p.get("project_id"), job, "Project")
    scenes = ordered_scenes(db, project.id)
    wanted = set(p.get("scene_ids") or [])
    targets = [s for s in scenes if not (s.script_text or "").strip() and (not wanted or s.id in wanted)]

    if not targets and p.get("after_scene_id"):
        idx = next((i for i, s in enumerate(scenes) if s.id == p["after_scene_id"]), None)
        if idx is None:
            raise RuntimeError("The scene to insert after no longer exists")
        fresh = [Scene(workspace_id=project.workspace_id, project_id=project.id, source="ai", locked=False, version=1)
                 for _ in range(int(p.get("count") or 1))]
        scenes[idx + 1:idx + 1] = fresh
        renumber(scenes)
        db.add_all(fresh)
        db.flush()
        targets = fresh
    if not targets:
        raise RuntimeError("Every scene already has a script. Add an empty scene where the gap is, then try again.")

    run = AiRun(ctx)
    run.publish(scene_ids=[t.id for t in targets], drafted_ids=[])
    suggestions, drafted = [], []
    for k, s in enumerate(targets):
        idx = scenes.index(s)
        res = run.call(f"Writing scene {idx + 1} ({k + 1} of {len(targets)})", 0.05 + 0.9 * k / len(targets),
                       "creative", P.draft_json_messages(project, _characters(db, project.id), scenes, idx),
                       schema=P.SceneDraft, temperature=0.8, max_tokens=_tokens_for(P.words_for(45)))
        d: P.SceneDraft = res.data
        out = write_scene(db, s, {"heading": d.heading.upper(), "logline": d.logline, "time_of_day": d.time_of_day,
                                  "mood": d.mood, "script_text": P.clean_script(d.script_text, d.heading)},
                          action="write_missing", job_id=job.id)
        suggestions += out["suggestion_ids"]
        drafted.append(s.id)
        run.publish(drafted_ids=list(drafted))
    return run.result(scene_ids=[t.id for t in targets], drafted_ids=drafted, suggestion_ids=suggestions)


def handle_continue(ctx) -> dict:
    db, job = ctx.db, ctx.job
    project = _owned(db, Project, job.payload.get("project_id"), job, "Project")
    count = int(job.payload.get("count") or 1)
    scenes = ordered_scenes(db, project.id)
    if not any((s.script_text or "").strip() for s in scenes):
        raise RuntimeError("There's no story to continue yet. Write a scene or let the AI Director outline the film.")

    run = AiRun(ctx)
    plans = run.call("Planning what happens next", 0.05, "reasoning",
                     P.next_scenes_messages(project, _characters(db, project.id), scenes, count),
                     schema=P.NextScenes, temperature=0.7, max_tokens=4000).data.scenes[:count]
    fresh = [_new_scene(project, pl) for pl in plans]
    scenes += fresh
    renumber(scenes)
    db.add_all(fresh)
    db.flush()
    for sc in fresh:
        db.add(snapshot(sc))
    run.publish(scene_ids=[s.id for s in fresh], drafted_ids=[])

    drafted = []
    for k, (sc, pl) in enumerate(zip(fresh, plans)):
        _draft_into(run, db, project, scenes, scenes.index(sc), pl.model_dump(), 0.3 + 0.65 * k / len(fresh), "continue")
        drafted.append(sc.id)
        run.publish(drafted_ids=list(drafted))
    project.updated_at = utcnow()
    return run.result(scene_ids=[s.id for s in fresh], drafted_ids=drafted)


def handle_assist(ctx) -> dict:
    db, job = ctx.db, ctx.job
    p = job.payload
    scene = _owned(db, Scene, p.get("scene_id"), job, "Scene")
    project = db.get(Project, scene.project_id)
    scenes = ordered_scenes(db, project.id)
    idx = scenes.index(scene)
    chars = _characters(db, project.id)
    action = p.get("action")
    run = AiRun(ctx)

    if action == "draft_from_idea":
        d: P.SceneDraft = run.call("Drafting the scene from your idea", 0.1, "creative",
                                   P.draft_json_messages(project, chars, scenes, idx, idea=p.get("idea") or ""),
                                   schema=P.SceneDraft, temperature=0.8, max_tokens=_tokens_for(P.words_for(45))).data
        values = {"heading": d.heading.upper(), "logline": d.logline, "time_of_day": d.time_of_day, "mood": d.mood,
                  "script_text": P.clean_script(d.script_text, d.heading or scene.heading)}
    elif action == "suggest_logline":
        if not scene.script_text.strip():
            raise RuntimeError("Write or draft the scene first; the logline is taken from its script.")
        res = run.call("Writing a logline", 0.1, "creative", P.logline_messages(project, scene),
                       temperature=0.5, max_tokens=200)
        values = {"logline": P.clean_line(res.content)}
    elif action in P.ASSIST_INSTRUCTIONS:
        if not scene.script_text.strip():
            raise RuntimeError("This scene has no script yet. Use Let AI draft first.")
        words = len(scene.script_text.split())
        scale = {"expand": 2.2, "tighten": 1.0}.get(action, 1.5)
        label = {"expand": "Expanding", "tighten": "Tightening", "rewrite_tone": "Rewriting",
                 "write_dialogue": "Writing dialogue for"}[action]
        res = run.call(f"{label} the scene", 0.1, "creative",
                       P.assist_messages(project, chars, scenes, idx, action, tone=p.get("tone") or ""),
                       temperature=0.8, max_tokens=_tokens_for(int(words * scale) + 60))
        values = {"script_text": P.clean_script(res.content, scene.heading)}
    else:
        raise RuntimeError(f"Unknown AI Assist action '{action}'")

    out = write_scene(db, scene, values, action=action, job_id=job.id)
    outcome = "suggested" if out["suggestion_ids"] else ("written" if out["written"] else "unchanged")
    return run.result(action=action, outcome=outcome, scene_ids=[scene.id] if out["written"] else [],
                      suggestion_ids=out["suggestion_ids"])


def handle_extract_characters(ctx) -> dict:
    db, job = ctx.db, ctx.job
    project = _owned(db, Project, job.payload.get("project_id"), job, "Project")
    scenes = [s for s in ordered_scenes(db, project.id) if s.script_text.strip()]
    if not scenes:
        raise RuntimeError("There's no script to read yet.")
    script = "\n\n".join(f"{s.heading}\n{s.script_text}" for s in scenes)
    known = [c.name for c in _characters(db, project.id)]

    run = AiRun(ctx)
    looks = run.call("Reading the script for characters", 0.1, "creative", P.extract_messages(project, script, known),
                     schema=P.CastLooks, temperature=0.4, max_tokens=2000).data
    created, updated, suggestions = [], [], []
    for look in looks.characters:
        c, outcome = upsert_character(db, project, look.name, look.description, action="extract", job_id=job.id)
        if c is None:
            continue
        if outcome == "created":
            created.append(c.id)
        elif outcome == "updated":
            updated.append(c.id)
        elif outcome not in ("unchanged", "skipped"):
            suggestions.append(outcome)
    return run.result(character_ids=created + updated, created_ids=created, updated_ids=updated,
                      suggestion_ids=suggestions)


def handle_portrait_prompt(ctx) -> dict:
    db, job = ctx.db, ctx.job
    character = _owned(db, Character, job.payload.get("character_id"), job, "Character")
    project = db.get(Project, character.project_id)
    run = AiRun(ctx)
    res = run.call(f"Writing a portrait prompt for {character.name}", 0.1, "creative",
                   P.portrait_messages(project, character), temperature=0.6, max_tokens=400)
    return run.result(character_id=character.id, prompt=P.clean_line(res.content))


def handle_summarize(ctx) -> dict:
    db, job = ctx.db, ctx.job
    scene = _owned(db, Scene, job.payload.get("scene_id"), job, "Scene")
    started = time.monotonic()
    # wait for the typing to settle so we summarise the final text, not every keystroke
    while utcnow() - scene.updated_at < SUMMARY_QUIET and time.monotonic() - started < SUMMARY_MAX_WAIT:
        ctx.progress(0.05, "Waiting for edits to settle")
        time.sleep(2.0)
        db.refresh(scene)
    if not scene.script_text.strip():
        scene.summary = ""
        return {"scene_ids": [scene.id], "summary": ""}
    run = AiRun(ctx)
    res = run.call("Updating the scene summary", 0.3, "creative", P.summary_messages(scene), temperature=0.3, max_tokens=200)
    scene.summary = P.clean_line(res.content)
    return run.result(scene_ids=[scene.id], summary=scene.summary)


AI_HANDLERS = {
    "ai_outline": handle_outline,
    "ai_write_missing": handle_write_missing,
    "ai_continue": handle_continue,
    "ai_assist": handle_assist,
    "ai_extract_characters": handle_extract_characters,
    "ai_portrait_prompt": handle_portrait_prompt,
    "ai_summarize": handle_summarize,
}


# ---------------------------------------------------------------- regenerate with note

def rewrite_prompt_from_note(prompt: str, note: str, timeout: float = 60.0) -> tuple[str, str | None]:
    """Creative model folds the note into the prompt. Falls back to appending, with a reason to show."""
    try:
        res = chat_sync("creative", P.rewrite_prompt_messages(prompt, note), temperature=0.4, max_tokens=500,
                        timeout=timeout)
        new = P.clean_line(res.content)
        if len(new) >= 10:
            return new, None
        reason = "the AI's rewrite came back empty"
    except LLMError as e:
        reason = str(e)
    log.warning("prompt rewrite failed, appending the note instead: %s", reason)
    return f"{prompt.rstrip()}\n\nNote: {note}", reason
