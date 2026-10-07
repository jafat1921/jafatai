"""Quick Create (contract v4): one prompt, one autopilot job."""
import re
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import autopilot, brand, models_catalog
from app.config import get_settings
from app.db import get_db
from app.models import Generation, Job, Project
from app.reel import render_out
from app.schemas import JobOut, ProjectOut, RenderOut
from app.security import CurrentUser, get_current_user, require_editor
from app.services import job_out, project_out

router = APIRouter(prefix="/quick", tags=["quick"])

MIN_S = 5
RECENT = 12


class UpscaleIn(BaseModel):
    engine: Literal["best", "fast", "quick"] = "best"
    target: Literal["1080p", "1440p", "4k"] = "1080p"


class QuickIn(BaseModel):
    prompt: str = Field(min_length=3, max_length=4000)
    duration_s: float = 30
    aspect_ratio: Literal["16:9", "9:16", "1:1"] = "16:9"
    style: Literal["cinematic", "documentary", "animated", "commercial"] = "cinematic"
    dialogue: bool = True
    upscale: UpscaleIn | None = None
    # contract v6 advanced options; stored on the project so every stage of the autopilot uses them
    image_model: str | None = None
    image_speed: str | None = None
    video_quality: Literal["standard", "hq"] | None = None
    smooth_motion: bool | None = None
    brand_kit_id: str | None = None  # contract v7: saved as project.settings.brand_kit_id
    template_id: str | None = Field(None, max_length=80)  # its planner notes steer the outline
    brand_closing: Literal["auto", "ai_packshot", "logo_reveal", "none"] | None = None


class QuickOut(BaseModel):
    project: ProjectOut
    job: JobOut


class QuickRecentOut(BaseModel):
    project: ProjectOut
    job: JobOut | None = None
    final_render: RenderOut | None = None


def placeholder_title(prompt: str) -> str:
    words = re.sub(r"\s+", " ", prompt).strip().split(" ")
    title = " ".join(words[:6])
    return (title[:60].rstrip(" ,.;:") + ("…" if len(words) > 6 else "")) or "Quick video"


@router.post("", response_model=QuickOut, status_code=201)
def quick_create(body: QuickIn, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    longest = get_settings().longtake_max_s * 4
    if not MIN_S <= body.duration_s <= longest:
        raise HTTPException(422, f"duration_s must be between {MIN_S} and {longest:g} seconds")
    prompt = body.prompt.strip()
    choice = {k: getattr(body, k) for k in ("image_model", "image_speed", "video_quality", "smooth_motion")
              if getattr(body, k) is not None}
    settings = models_catalog.clean_project_settings({}, choice)
    p = Project(workspace_id=cur.workspace_id, title=placeholder_title(prompt), authoring_mode="quick", brief=prompt,
                aspect_ratio=body.aspect_ratio, target_runtime_s=max(1, round(body.duration_s)), takes_per_shot=1,
                status="in_progress", style_bible=autopilot.STYLE_PRESETS[body.style][0], settings=settings)
    tpl = None
    if body.template_id:
        from app.api.library import templates

        tpl = templates().get(body.template_id)
        if tpl is None or tpl["type"] != "video":
            raise HTTPException(404, "Template not found")
    if body.brand_kit_id:
        brand.project_kit_id(db, p, body.brand_kit_id)
        if body.brand_closing:
            p.settings = {**(p.settings or {}), "brand_closing": body.brand_closing}
    db.add(p)
    db.flush()
    job = Job(workspace_id=cur.workspace_id, type=autopilot.JOB_TYPE, project_id=p.id, message="Waiting for a worker",
              payload={"project_id": p.id, "prompt": prompt, "duration_s": body.duration_s,
                       "aspect_ratio": body.aspect_ratio, "style": body.style, "dialogue": body.dialogue,
                       "upscale": body.upscale.model_dump() if body.upscale else None, "title_auto": True,
                       "models": settings, "template_id": body.template_id,
                       "planner": (tpl or {}).get("planner") or ""},
              result=autopilot.initial_result(body.upscale is not None))
    db.add(job)
    db.commit()
    return QuickOut(project=project_out(db, p), job=job_out(job))


@router.get("/recent", response_model=list[QuickRecentOut])
def recent(db: Session = Depends(get_db), cur: CurrentUser = Depends(get_current_user)):
    projects = db.scalars(select(Project).where(Project.workspace_id == cur.workspace_id,
                                                Project.authoring_mode == "quick")
                          .order_by(Project.created_at.desc()).limit(RECENT)).all()
    out = []
    for p in projects:
        job = db.scalars(select(Job).where(Job.project_id == p.id, Job.type == autopilot.JOB_TYPE)
                         .order_by(Job.created_at.desc()).limit(1)).first()
        final = None
        fid = (job.result or {}).get("final_render_id") if job else None
        g = db.get(Generation, fid) if fid else None
        if g is not None and g.status in ("ready", "approved"):
            final = render_out(g)
        out.append(QuickRecentOut(project=project_out(db, p), job=job_out(job) if job else None, final_render=final))
    return out
