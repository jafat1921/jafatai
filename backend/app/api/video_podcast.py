"""AI video podcast (contract v24): an episode cut as a multi-camera, lip-synced video."""
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.ai_jobs import rewrite_prompt_from_note
from app.db import get_db
from app.models import PodcastEpisode, Project, VideoPodcast
from app.podcast import video as vd
from app.podcast import video_stages as vs
from app.podcast import vplan
from app.schemas import GenerationOut, JobOut
from app.security import CurrentUser, get_current_user, require_editor
from app.services import enqueue_generation, gen_out, get_owned, job_out, new_seed

router = APIRouter(prefix="/podcast", tags=["podcast"])

Aspect = Literal["16:9", "9:16", "1:1"]
Quality = Literal["draft", "final"]


class CreateIn(BaseModel):
    aspect: Aspect | None = None


class Consent(BaseModel):
    name: str = Field("", max_length=120)
    statement: str = Field("", max_length=400)


class HostChoice(BaseModel):
    source: Literal["persona", "photo", "existing"]
    media_id: str | None = None
    character_id: str | None = None
    consent: Consent | None = None


class SettingsIn(BaseModel):
    aspect: Aspect | None = None
    subtitles: Literal["none", "soft", "burn"] | None = None
    set_preset: Literal["modern_studio", "cosy_room", "news_desk", "rooftop", "desi_baithak"] | None = None
    set_prompt: str | None = Field(None, max_length=600)
    cover_intro: bool | None = None
    cover_outro: bool | None = None
    cover_media_id: str | None = None


class PlanRow(BaseModel):
    id: str | None = None
    type: Literal["lipsync", "medium", "reaction", "wide", "cover"]
    angle: str = ""
    start: float = Field(ge=0)
    end: float = Field(gt=0)
    marked: bool = False


class PatchIn(BaseModel):
    hosts: dict[str, HostChoice] | None = None
    settings: SettingsIn | None = None
    plan: list[PlanRow] | None = Field(None, max_length=5000)


class RegenerateIn(BaseModel):
    what: Literal["portrait", "set", "angle"]
    key: str | None = None
    note: str | None = Field(None, max_length=1000)


class ShotPatch(BaseModel):
    type: Literal["lipsync", "medium", "reaction", "wide", "cover"] | None = None
    angle: str | None = None
    marked: bool | None = None


class SplitIn(BaseModel):
    at: float | None = None


class MergeIn(BaseModel):
    shot_ids: list[str] = Field(min_length=2, max_length=20)


class RenderIn(BaseModel):
    quality: Quality = "draft"
    shot_ids: list[str] | None = Field(None, max_length=5000)


class AssembleIn(BaseModel):
    quality: Quality = "draft"


def _vp(db: Session, cur: CurrentUser, vp_id: str) -> VideoPodcast:
    return get_owned(db, VideoPodcast, vp_id, cur.workspace_id, "AI video")


def _out(db: Session, vp: VideoPodcast) -> dict[str, Any]:
    return vd.vp_out(db, vp)


@router.get("/episodes/{episode_id}/ai-video")
def get_for_episode(episode_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(get_current_user)):
    ep = get_owned(db, PodcastEpisode, episode_id, cur.workspace_id, "Episode")
    vp = vd.find(db, ep)
    if vp is None:
        raise HTTPException(404, "This episode has no AI video yet")
    return _out(db, vp)


@router.post("/episodes/{episode_id}/ai-video")
def create_for_episode(episode_id: str, body: CreateIn, response: Response, db: Session = Depends(get_db),
                       cur: CurrentUser = Depends(require_editor)):
    ep = get_owned(db, PodcastEpisode, episode_id, cur.workspace_id, "Episode")
    vp, made = vd.create(db, ep, body.aspect)
    db.commit()
    response.status_code = 201 if made else 200
    return _out(db, vp)


@router.get("/ai-video/{vp_id}")
def get_ai_video(vp_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(get_current_user)):
    vp = _vp(db, cur, vp_id)
    vd.sync_hosts(db, vp, vd.episode_of(db, vp))
    db.commit()
    return _out(db, vp)


@router.patch("/ai-video/{vp_id}")
def patch_ai_video(vp_id: str, body: PatchIn, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    vp = _vp(db, cur, vp_id)
    ep = vd.episode_of(db, vp)
    data = body.model_dump(exclude_unset=True)
    resets = []
    if body.hosts or data.get("settings") or body.plan is not None:
        vd.ensure_idle(db, vp)
    if body.hosts:
        vd.sync_hosts(db, vp, ep)
        for hid, choice in body.hosts.items():
            vd.choose_host(db, cur, vp, ep, hid, choice.model_dump())
        resets.append("cast")
    if data.get("settings"):
        st = vd.settings_of(vp)
        new = {**st, **{k: v for k, v in data["settings"].items() if k in vd.DEFAULT_SETTINGS}}
        if new.get("cover_media_id"):
            from app.podcast import service as sv

            sv.image_item(db, vp.workspace_id, new["cover_media_id"])
        if any(new[k] != st[k] for k in ("aspect", "set_preset", "set_prompt")):
            resets.append("set")
        if new["aspect"] != st["aspect"]:
            db.get(Project, vp.project_id).aspect_ratio = new["aspect"]
        vp.settings = new
        if vp.plan and (new["cover_intro"], new["cover_outro"]) != (st["cover_intro"], st["cover_outro"]):
            vd.set_plan(db, vp, vd.apply_cover(vp.plan, new["cover_intro"], new["cover_outro"]))
    if body.plan is not None:
        vd.set_plan(db, vp, vd.fill_plan(db, vp, ep, [r.model_dump() for r in body.plan]))
    keys = [k for k, _ in vd.STAGES]
    if resets:
        vd.reset_from(vp, min(resets, key=keys.index))
    db.commit()
    return _out(db, vp)


@router.delete("/ai-video/{vp_id}", status_code=204)
def delete_ai_video(vp_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    import shutil

    from app.config import get_settings

    vp = _vp(db, cur, vp_id)
    vd.ensure_idle(db, vp)
    project = db.get(Project, vp.project_id)
    db.delete(vp)
    if project is not None:
        db.delete(project)
    db.commit()
    shutil.rmtree(get_settings().data_dir / "workspaces" / cur.workspace_id / "projects" / vp.project_id,
                  ignore_errors=True)
    return Response(status_code=204)


@router.post("/ai-video/{vp_id}/continue", response_model=JobOut, status_code=202)
def continue_ai_video(vp_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    vp = _vp(db, cur, vp_id)
    ep = vd.episode_of(db, vp)
    vd.ensure_idle(db, vp)
    vd.sync_hosts(db, vp, ep)
    if all(vd.stage(vp, k).get("status") == "done" for k in vd.CONTINUE_STAGES):
        key = vd.stale_from(db, vp, ep)
        if key is None:
            raise HTTPException(409, "The hosts, set, look and shots are up to date: render next")
        vd.reset_from(vp, key)
    if vd.stage(vp, "plan").get("status") != "done" and vd.mix_of(ep) is None and \
            all(vd.stage(vp, k).get("status") == "done" for k in ("cast", "set", "keyframes")):
        raise HTTPException(409, "Mix the episode first: the video follows the mix")
    for k in vd.CONTINUE_STAGES:
        rec = vd.stage(vp, k)
        if rec.get("status") == "failed":
            rec.update(status="pending", detail=None)
            vd.put_stage(vp, k, rec)
    job = vs.queue(db, vp, "continue")
    db.commit()
    return job_out(job)


@router.post("/ai-video/{vp_id}/regenerate", response_model=GenerationOut, status_code=202)
def regenerate(vp_id: str, body: RegenerateIn, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    vp = _vp(db, cur, vp_id)
    if body.what == "portrait":
        entry = (vp.hosts or {}).get(body.key or "")
        if not entry:
            raise HTTPException(404, "No such host")
        if entry.get("source") == "existing":
            raise HTTPException(409, "This host is a copied character; pick another source to make a new portrait")
        base = vd.current_portrait(db, entry)
    elif body.what == "set":
        base = vd.establishing(db, vp, fresh_only=False)
    else:
        sid = (vd.refs(vp).get("angle_shots") or {}).get(body.key or "")
        if not sid:
            raise HTTPException(404, "No such angle")
        base = vd.frame_of(db, sid)
    if base is None:
        raise HTTPException(409, "There's nothing to regenerate yet: continue to make it first")
    prompt, note = base.prompt, None
    if body.note and body.note.strip():
        note = body.note.strip()
        prompt, _ = rewrite_prompt_from_note(base.prompt, note)
    params = {k: v for k, v in (base.params or {}).items() if k not in ("comfy", "approved_by", "auto_check")}
    g = enqueue_generation(db, workspace_id=vp.workspace_id, project_id=vp.project_id, target_type=base.target_type,
                           target_id=base.target_id, kind=base.kind, prompt=prompt, params=params, seed=new_seed(),
                           parent_id=base.id, note=note)
    db.commit()
    return gen_out(g)


@router.get("/ai-video/{vp_id}/characters")
def characters(vp_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(get_current_user)):
    return vd.other_characters(db, _vp(db, cur, vp_id))


@router.post("/ai-video/{vp_id}/replan")
def replan(vp_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    vp = _vp(db, cur, vp_id)
    ep = vd.episode_of(db, vp)
    vd.ensure_idle(db, vp)
    vd.set_plan(db, vp, vd.build_plan(db, vp, ep))
    rec = vd.stage(vp, "plan")
    rec.update(status="done", basis=vd.mix_of(ep)["generation_id"], detail=None)
    vd.put_stage(vp, "plan", rec)
    db.commit()
    return _out(db, vp)


def _rows(vp: VideoPodcast) -> list[dict]:
    return [{k: sh.get(k) for k in ("id", "type", "angle", "start", "end", "marked")} for sh in vp.plan or []]


def _index(vp: VideoPodcast, shot_id: str) -> int:
    i = next((i for i, sh in enumerate(vp.plan or []) if sh["id"] == shot_id), None)
    if i is None:
        raise HTTPException(404, "That shot isn't in the plan")
    return i


def _save_rows(db: Session, vp: VideoPodcast, rows: list[dict]) -> dict:
    vd.ensure_idle(db, vp)
    vd.set_plan(db, vp, vd.fill_plan(db, vp, vd.episode_of(db, vp), rows))
    db.commit()
    return _out(db, vp)


@router.patch("/ai-video/{vp_id}/shots/{shot_id}")
def patch_shot(vp_id: str, shot_id: str, body: ShotPatch, db: Session = Depends(get_db),
               cur: CurrentUser = Depends(require_editor)):
    vp = _vp(db, cur, vp_id)
    rows = _rows(vp)
    row = rows[_index(vp, shot_id)]
    data = body.model_dump(exclude_unset=True)
    if "type" in data and data["type"] != row["type"]:
        row["type"] = data["type"]
        row["angle"] = data.get("angle") or ""
    elif "angle" in data:
        row["angle"] = data["angle"] or ""
    if "marked" in data:
        row["marked"] = bool(data["marked"])
    return _save_rows(db, vp, rows)


@router.post("/ai-video/{vp_id}/shots/{shot_id}/split")
def split_shot(vp_id: str, shot_id: str, body: SplitIn, db: Session = Depends(get_db),
               cur: CurrentUser = Depends(require_editor)):
    vp = _vp(db, cur, vp_id)
    rows = _rows(vp)
    i = _index(vp, shot_id)
    row = rows[i]
    at = vplan.snap(body.at if body.at is not None else (row["start"] + row["end"]) / 2)
    if at - row["start"] < vplan.MIN_SHOT_S or row["end"] - at < vplan.MIN_SHOT_S:
        raise HTTPException(422, f"Both halves need at least {vplan.MIN_SHOT_S:g} s")
    rows[i:i + 1] = [{**row, "end": at}, {**row, "id": None, "start": at, "marked": False}]
    return _save_rows(db, vp, rows)


@router.post("/ai-video/{vp_id}/shots/merge")
def merge_shots(vp_id: str, body: MergeIn, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    vp = _vp(db, cur, vp_id)
    rows = _rows(vp)
    idx = sorted(_index(vp, sid) for sid in dict.fromkeys(body.shot_ids))
    if idx != list(range(idx[0], idx[0] + len(idx))):
        raise HTTPException(422, "Only neighbouring shots can be merged")
    first, last = rows[idx[0]], rows[idx[-1]]
    rows[idx[0]:idx[-1] + 1] = [{**first, "end": last["end"]}]
    return _save_rows(db, vp, rows)


@router.get("/ai-video/{vp_id}/estimate")
def estimate(vp_id: str, quality: Quality = "draft", shot_ids: str | None = Query(None),
             db: Session = Depends(get_db), cur: CurrentUser = Depends(get_current_user)):
    vp = _vp(db, cur, vp_id)
    ids = [s for s in (shot_ids or "").split(",") if s] or None
    return vd.estimate(db, vp, vd.episode_of(db, vp), quality, ids)


def _ready_to_render(db: Session, vp: VideoPodcast) -> None:
    if vd.stage(vp, "plan").get("status") != "done" or not vp.plan:
        raise HTTPException(409, "Plan the shots first: continue through the hosts, set and look")
    frames = vd.angle_frames(db, vp)
    missing = {sh["angle"] for sh in vp.plan if sh["type"] != "cover" and sh["angle"] not in frames}
    if missing:
        raise HTTPException(409, f"Some camera angles have no frame yet ({', '.join(sorted(missing)[:4])})")


@router.post("/ai-video/{vp_id}/render", response_model=JobOut, status_code=202)
def render(vp_id: str, body: RenderIn, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    vp = _vp(db, cur, vp_id)
    vd.ensure_idle(db, vp)
    _ready_to_render(db, vp)
    known = {sh["id"] for sh in vp.plan}
    if body.shot_ids and not set(body.shot_ids) <= known:
        raise HTTPException(404, "Some of those shots aren't in the plan")
    for k in ("render", "assemble"):
        vd.put_stage(vp, k, {"status": "pending"})
    job = vs.queue(db, vp, "render", quality=body.quality, shot_ids=body.shot_ids)
    db.commit()
    return job_out(job)


@router.post("/ai-video/{vp_id}/assemble", response_model=JobOut, status_code=202)
def assemble(vp_id: str, body: AssembleIn, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    vp = _vp(db, cur, vp_id)
    vd.ensure_idle(db, vp)
    _ready_to_render(db, vp)
    vd.put_stage(vp, "assemble", {"status": "pending"})
    job = vs.queue(db, vp, "assemble", quality=body.quality)
    db.commit()
    return job_out(job)

