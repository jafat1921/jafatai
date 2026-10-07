import time

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import ai_jobs
from app import brand_moments as bm
from app.config import get_settings
from app.db import get_db
from app.llm import LLMError, chat
from app.llm.client import list_models, model_for, server_root
from app.models import Character, Project, Scene, Shot, Suggestion, utcnow
from app.schemas import (
    AssistIn,
    ContinueIn,
    JobOut,
    SceneOut,
    StoryboardIn,
    SuggestShotsIn,
    SuggestionOut,
    SuggestionResult,
    WriteMissingIn,
)
from app.security import CurrentUser, get_current_user, require_editor
from app.services import character_out, get_owned, job_out
from app.storyboard import location_out, shot_out

router = APIRouter(tags=["ai"])


def _queue(db: Session, cur: CurrentUser, type: str, payload: dict, project_id: str) -> JobOut:
    job = ai_jobs.enqueue_ai(db, workspace_id=cur.workspace_id, type=type, payload=payload, project_id=project_id)
    db.commit()
    return job_out(job)


@router.post("/projects/{project_id}/ai/outline", response_model=JobOut, status_code=202)
def outline(project_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    p = get_owned(db, Project, project_id, cur.workspace_id, "Project")
    running = ai_jobs.active_job(db, "ai_outline", p.id)
    if running:
        return job_out(running)
    if any((s.script_text or s.heading or s.logline).strip() for s in ai_jobs.ordered_scenes(db, p.id)):
        raise HTTPException(409, "This project already has scenes. Use Write missing scenes or Continue story instead.")
    if not (p.brief or p.logline).strip():
        raise HTTPException(422, "Give the project a brief or logline first; the AI Director works from it.")
    return _queue(db, cur, "ai_outline", {"project_id": p.id}, p.id)


@router.post("/projects/{project_id}/ai/write-missing", response_model=JobOut, status_code=202)
def write_missing(
    project_id: str, body: WriteMissingIn | None = None, db: Session = Depends(get_db),
    cur: CurrentUser = Depends(require_editor),
):
    body = body or WriteMissingIn()
    p = get_owned(db, Project, project_id, cur.workspace_id, "Project")
    scenes = ai_jobs.ordered_scenes(db, p.id)
    ids = {s.id for s in scenes}
    if body.scene_ids and not set(body.scene_ids) <= ids:
        raise HTTPException(422, "scene_ids must be scenes of this project")
    if body.after_scene_id and body.after_scene_id not in ids:
        raise HTTPException(422, "after_scene_id is not a scene of this project")
    empty = [s for s in scenes if not s.script_text.strip() and (not body.scene_ids or s.id in body.scene_ids)]
    if not empty and not body.after_scene_id:
        raise HTTPException(409, "Every scene already has a script. Add an empty scene where the gap is, then try again.")
    if not any(s.script_text.strip() for s in scenes) and not (p.brief or p.logline).strip():
        raise HTTPException(422, "There's nothing to work from yet: write a scene or give the project a logline.")
    return _queue(db, cur, "ai_write_missing", {"project_id": p.id, **body.model_dump()}, p.id)


@router.post("/projects/{project_id}/ai/continue", response_model=JobOut, status_code=202)
def continue_story(
    project_id: str, body: ContinueIn | None = None, db: Session = Depends(get_db),
    cur: CurrentUser = Depends(require_editor),
):
    p = get_owned(db, Project, project_id, cur.workspace_id, "Project")
    if not any(s.script_text.strip() for s in ai_jobs.ordered_scenes(db, p.id)):
        raise HTTPException(409, "There's no story to continue yet.")
    return _queue(db, cur, "ai_continue", {"project_id": p.id, "count": (body or ContinueIn()).count}, p.id)


@router.post("/projects/{project_id}/ai/extract-characters", response_model=JobOut, status_code=202)
def extract_characters(project_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    p = get_owned(db, Project, project_id, cur.workspace_id, "Project")
    if not any(s.script_text.strip() for s in ai_jobs.ordered_scenes(db, p.id)):
        raise HTTPException(409, "There's no script to read characters from yet.")
    running = ai_jobs.active_job(db, "ai_extract_characters", p.id)
    return job_out(running) if running else _queue(db, cur, "ai_extract_characters", {"project_id": p.id}, p.id)


@router.post("/projects/{project_id}/ai/extract-locations", response_model=JobOut, status_code=202)
def extract_locations(project_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    p = get_owned(db, Project, project_id, cur.workspace_id, "Project")
    if not any((s.heading or s.script_text).strip() for s in ai_jobs.ordered_scenes(db, p.id)):
        raise HTTPException(409, "There's no script to read locations from yet.")
    running = ai_jobs.active_job(db, "ai_extract_locations", p.id)
    return job_out(running) if running else _queue(db, cur, "ai_extract_locations", {"project_id": p.id}, p.id)


@router.post("/scenes/{scene_id}/ai/suggest-shots", response_model=JobOut, status_code=202)
def suggest_shots(scene_id: str, body: SuggestShotsIn | None = None, db: Session = Depends(get_db),
                  cur: CurrentUser = Depends(require_editor)):
    scene = get_owned(db, Scene, scene_id, cur.workspace_id, "Scene")
    if not scene.script_text.strip():
        raise HTTPException(409, "This scene has no script yet; shots are planned from the script.")
    running = ai_jobs.active_job(db, "ai_suggest_shots", scene.project_id, scene_id=scene.id)
    if running:
        return job_out(running)
    payload = {"scene_id": scene.id, "max_shots": (body or SuggestShotsIn()).max_shots}
    return _queue(db, cur, "ai_suggest_shots", payload, scene.project_id)


@router.post("/shots/{shot_id}/ai/compile-prompts", response_model=JobOut, status_code=202)
def compile_prompts(shot_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    shot = get_owned(db, Shot, shot_id, cur.workspace_id, "Shot")
    running = ai_jobs.active_job(db, "ai_compile_prompts", shot.project_id, shot_id=shot.id)
    return job_out(running) if running else _queue(db, cur, "ai_compile_prompts", {"shot_id": shot.id}, shot.project_id)


@router.post("/projects/{project_id}/storyboard", response_model=JobOut, status_code=202)
def build_storyboard(project_id: str, body: StoryboardIn | None = None, db: Session = Depends(get_db),
                     cur: CurrentUser = Depends(require_editor)):
    body = body or StoryboardIn()
    p = get_owned(db, Project, project_id, cur.workspace_id, "Project")
    running = ai_jobs.active_job(db, "ai_storyboard", p.id)
    if running:
        return job_out(running)
    scenes = ai_jobs.ordered_scenes(db, p.id)
    if body.scene_ids and not set(body.scene_ids) <= {s.id for s in scenes}:
        raise HTTPException(422, "scene_ids must be scenes of this project")
    if not any(s.script_text.strip() for s in scenes if not body.scene_ids or s.id in body.scene_ids):
        raise HTTPException(409, "There's no script to storyboard yet.")
    payload = {"project_id": p.id, "mode": body.mode, "scene_ids": body.scene_ids,
               "generate_frames": body.generate_frames, "overwrite": body.overwrite,
               "chain": body.continuity in (True, "chain"), "max_shots": body.max_shots}
    return _queue(db, cur, "ai_storyboard", payload, p.id)


@router.post("/projects/{project_id}/ai/brand-moments", response_model=JobOut, status_code=202)
def brand_moments(project_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    """Re-plan where the logo and products appear across the existing shots (contract v7, as built)."""
    p = get_owned(db, Project, project_id, cur.workspace_id, "Project")
    if bm.project_kit(db, p) is None:
        raise HTTPException(422, "This project has no brand kit. Pick one in the project settings first.")
    if not db.scalar(select(Shot.id).where(Shot.project_id == p.id).limit(1)):
        raise HTTPException(409, "There are no shots yet. Storyboard the film first.")
    running = ai_jobs.active_job(db, "ai_brand_moments", p.id)
    return job_out(running) if running else _queue(db, cur, "ai_brand_moments", {"project_id": p.id}, p.id)


@router.post("/scenes/{scene_id}/ai/assist", response_model=JobOut, status_code=202)
def assist(scene_id: str, body: AssistIn, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    scene = get_owned(db, Scene, scene_id, cur.workspace_id, "Scene")
    if body.action == "draft_from_idea" and not (body.idea or "").strip():
        raise HTTPException(422, "Give the AI a one-line idea to draft from")
    if body.action == "rewrite_tone" and not (body.tone or "").strip():
        raise HTTPException(422, "Pick a tone to rewrite in")
    if body.action not in ("draft_from_idea",) and not scene.script_text.strip():
        raise HTTPException(409, "This scene has no script yet. Use Let AI draft first.")
    payload = {"scene_id": scene.id, **body.model_dump()}
    return _queue(db, cur, "ai_assist", payload, scene.project_id)


@router.post("/characters/{character_id}/ai/portrait-prompt", response_model=JobOut, status_code=202)
def portrait_prompt(character_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    c = get_owned(db, Character, character_id, cur.workspace_id, "Character")
    return _queue(db, cur, "ai_portrait_prompt", {"character_id": c.id}, c.project_id)


@router.get("/projects/{project_id}/suggestions", response_model=list[SuggestionOut])
def list_suggestions(
    project_id: str, status: str | None = "pending", target_id: str | None = None,
    db: Session = Depends(get_db), cur: CurrentUser = Depends(get_current_user),
):
    get_owned(db, Project, project_id, cur.workspace_id, "Project")
    q = select(Suggestion).where(Suggestion.project_id == project_id)
    if status:
        q = q.where(Suggestion.status.in_([s.strip() for s in status.split(",") if s.strip()]))
    if target_id:
        q = q.where(Suggestion.target_id == target_id)
    return db.scalars(q.order_by(Suggestion.created_at.desc()).limit(200)).all()


def _pending(db: Session, suggestion_id: str, cur: CurrentUser) -> Suggestion:
    s = get_owned(db, Suggestion, suggestion_id, cur.workspace_id, "Suggestion")
    if s.status != "pending":
        raise HTTPException(409, f"This suggestion was already {s.status}")
    return s


@router.post("/suggestions/{suggestion_id}/accept", response_model=SuggestionResult)
def accept_suggestion(suggestion_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    s = _pending(db, suggestion_id, cur)
    try:
        target = ai_jobs.accept(db, s, cur.id)
    except LookupError as e:
        raise HTTPException(404, str(e)) from e
    db.commit()
    out = SuggestionResult(suggestion=SuggestionOut.model_validate(s))
    if s.target_type == "scene":
        out.scene = SceneOut.model_validate(target)
    elif s.target_type == "location":
        out.location = location_out(db, target)
    elif s.target_type == "shot":
        out.shot = shot_out(db, target)
    else:
        out.character = character_out(db, target)
    return out


@router.post("/suggestions/{suggestion_id}/reject", response_model=SuggestionResult)
def reject_suggestion(suggestion_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    s = _pending(db, suggestion_id, cur)
    s.status = "rejected"
    s.resolved_at = utcnow()
    db.commit()
    return SuggestionResult(suggestion=SuggestionOut.model_validate(s))


async def _ping(role: str, present: set[str]) -> dict:
    try:
        model = model_for(role)  # type: ignore[arg-type]
    except LLMError as e:
        return {"model": None, "present": False, "error": str(e)}
    out: dict = {"model": model, "present": model in present or f"{model}:latest" in present}
    if not out["present"]:
        out["error"] = f"Not installed on the LLM server (ollama pull {model})"
        return out
    t0 = time.monotonic()
    try:
        # an empty 1-token answer is fine here; we only want "loaded and answering"
        await chat(role, [{"role": "user", "content": "Reply with: ok"}], max_tokens=1, think=False,  # type: ignore[arg-type]
                   timeout=300, retry_empty=False)
        out["latency_ms"] = int((time.monotonic() - t0) * 1000)
    except LLMError as e:
        out["error"] = str(e)
    return out


@router.get("/system/llm-check")
async def llm_check(ping: bool = True, _=Depends(get_current_user)):
    s = get_settings()
    report: dict = {"url": server_root(), "reasoning_format": s.llm_reasoning_format, "roles": {}}
    try:
        models = await list_models()
    except LLMError as e:
        report.update(ok=False, error=str(e))
        return report
    present = set(models)
    roles = ("reasoning", "creative", "vision")
    if ping:
        # one at a time: a small box can't hold three models loading at once
        # TODO: ping concurrently once the GPU box keeps all role models resident
        for r in roles:
            report["roles"][r] = await _ping(r, present)
    else:
        for r in roles:
            try:
                m = model_for(r)  # type: ignore[arg-type]
                report["roles"][r] = {"model": m, "present": m in present or f"{m}:latest" in present}
            except LLMError as e:
                report["roles"][r] = {"model": None, "present": False, "error": str(e)}
    report["ok"] = all(v.get("present") and not v.get("error") for v in report["roles"].values())
    return report

