"""Media library, Image studio, Prompt templates and the Home dashboard (contract v5).

Registered before app.api.media: GET /media/{id} here takes one path segment, while stored files are
always served as /media/workspaces/..., so the two never compete for a URL.
"""
import json
import re
from functools import lru_cache
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app import brand
from app import library as lib
from app import mentions as mn
from app import models_catalog as mc
from app import organise as org
from app import prompt_enhance, uploads
from app.ai_jobs import rewrite_prompt_from_note
from app.db import get_db
from app.models import Generation, Job, MediaItem, Project, new_id
from app.schemas import (
    DashboardOut, ImageBatchOut, ImageEditIn, ImageGenerateIn, Img2ImgIn, JobOut, MediaDetailOut, MediaItemOut,
    MediaPage,
    MediaPatch, RegenerateIn, TemplateOut, TemplateStartOut, UpscalePage,
)
from app.security import CurrentUser, get_current_user, require_editor
from app.services import enqueue_generation, job_out, new_seed, project_out

router = APIRouter(tags=["library"])

TEMPLATE_DIR = Path(__file__).resolve().parents[1] / "templates"
_UUID = re.compile(r"^[0-9a-fA-F-]{36}$")


def _owned_item(db: Session, media_id: str, workspace_id: str) -> MediaItem:
    item = db.get(MediaItem, media_id) if _UUID.match(media_id) else None
    if item is None or item.workspace_id != workspace_id:
        if _UUID.match(media_id) and lib.project_row(db, workspace_id, media_id) is not None:
            raise HTTPException(409, "This is a project result; change it inside its project")
        raise HTTPException(404, "Media not found")
    return item


# ---------------------------------------------------------------- library

@router.get("/media", response_model=MediaPage)
def list_media(
    kind: Literal["image", "video", "audio"] | None = None,
    origin: Literal["generated", "upload", "project"] | None = None,
    q: str | None = Query(None, max_length=200),
    tag: str | None = Query(None, max_length=40),
    project_id: str | None = None,
    include: str | None = None,
    folder_id: str | None = None,
    favourite: bool = False,
    limit: int = Query(40, ge=1, le=lib.MAX_LIMIT),
    cursor: str | None = None,
    db: Session = Depends(get_db),
    cur: CurrentUser = Depends(get_current_user),
):
    if folder_id:
        _folder(db, cur.workspace_id, folder_id)
    sc = org.scope(db, cur.workspace_id, cur.id, folder_id, favourite)
    items, nxt = lib.list_media(db, cur.workspace_id, kind=kind, origin=origin, q=q, tag=tag, project_id=project_id,
                                include_project="project" in (include or "").split(","), limit=limit, cursor=cursor,
                                scope=sc)
    return MediaPage(items=org.annotate(db, cur.workspace_id, cur.id, items), next_cursor=nxt)


def _folder(db: Session, workspace_id: str, folder_id: str | None):
    try:
        return org.owned_folder(db, workspace_id, folder_id)
    except org.OrganiseError as e:
        raise HTTPException(404, str(e)) from None


@router.post("/media/upload", response_model=MediaItemOut, status_code=201)
async def upload_media(request: Request, response: Response, db: Session = Depends(get_db),
                       cur: CurrentUser = Depends(require_editor)):
    from app.catalogue import importer

    folder, rel_folder = lib.media_dir(cur.workspace_id)
    got = await uploads.receive(request, folder)
    try:
        item, dup = await run_in_threadpool(importer.store, db, cur.workspace_id, cur.id, got, folder, rel_folder)
    except BaseException:
        got.path.unlink(missing_ok=True)
        raise
    out = await run_in_threadpool(lib.item_out, db, item)
    if dup:
        # already in the catalogue: nothing new was stored
        response.status_code = 200
        out.duplicate = True
    return out


@router.get("/media/{media_id}", response_model=MediaDetailOut)
def get_media_item(media_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(get_current_user)):
    out = lib.detail(db, cur.workspace_id, media_id) if _UUID.match(media_id) else None
    if out is None:
        raise HTTPException(404, "Media not found")
    return org.annotate(db, cur.workspace_id, cur.id, [out])[0]


@router.patch("/media/{media_id}", response_model=MediaItemOut)
def patch_media(media_id: str, body: MediaPatch, db: Session = Depends(get_db),
                cur: CurrentUser = Depends(require_editor)):
    item = _owned_item(db, media_id, cur.workspace_id)
    if body.title is not None:
        if not body.title.strip():
            raise HTTPException(422, "The title can't be blank")
        item.title = body.title.strip()
    if body.tags is not None:
        item.tags = lib.clean_tags(body.tags)
    lib.touch(item)
    db.commit()
    return lib.item_out(db, item)


@router.delete("/media/{media_id}", status_code=204)
def delete_media(media_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    item = _owned_item(db, media_id, cur.workspace_id)
    lib.delete_item(db, item)
    org.forget(db, cur.workspace_id, [media_id])
    db.commit()
    return Response(status_code=204)


@router.post("/media/{media_id}/regenerate", response_model=JobOut, status_code=202)
def regenerate_media(media_id: str, body: RegenerateIn, db: Session = Depends(get_db),
                     cur: CurrentUser = Depends(require_editor)):
    item = _owned_item(db, media_id, cur.workspace_id)
    if item.origin == "upload" or item.kind != "image":
        raise HTTPException(422, "Only generated images can be regenerated; use Edit or Upscale instead")
    # newest generated picture (not an upscale) is the recipe to re-roll
    base = db.scalars(select(Generation).where(
        Generation.target_type == "media", Generation.target_id == item.id, Generation.kind == "image",
    ).order_by(Generation.version.desc())).first()
    if base is None:
        raise HTTPException(409, "Nothing to regenerate yet")
    params = {k: v for k, v in (base.params or {}).items() if k not in ("comfy", "upscale", "size")}
    prompt, seed, note, rewrite_failed = base.prompt, new_seed(), None, None
    if body.mode == "note":
        if not (body.note and body.note.strip()):
            raise HTTPException(422, "A note is required for mode=note")
        note = body.note.strip()
        prompt, rewrite_failed = rewrite_prompt_from_note(base.prompt, note)
    elif body.mode == "edit":
        if body.prompt is not None:
            if not body.prompt.strip():
                raise HTTPException(422, "Prompt can't be empty")
            prompt = body.prompt.strip()
        if body.params:
            params.update({k: v for k, v in body.params.items() if k in ("negative", "steps", "seed")})
        if "seed" in params:
            seed = int(params.pop("seed"))
    params["created_by"] = {"user_id": cur.id, "flow": f"regenerate:{body.mode}"}
    g = enqueue_generation(db, workspace_id=cur.workspace_id, project_id=None, target_type="media",
                           target_id=item.id, kind="image", prompt=prompt, params=params, seed=seed,
                           parent_id=base.id, note=note)
    job = db.get(Job, g.job_id)
    if rewrite_failed:
        job.message = f"Waiting for a worker · note appended, AI rewrite unavailable ({rewrite_failed})"[:500]
    lib.touch(item)
    db.commit()
    return job_out(job)


# ---------------------------------------------------------------- image studio

def _new_image_item(db: Session, cur: CurrentUser, title: str, prompt: str, params: dict, seed: int | None,
                    folder_id: str | None = None):
    item = MediaItem(id=new_id(), workspace_id=cur.workspace_id, kind="image", origin="generated", title=title,
                     tags=[], width=params.get("width"), height=params.get("height"), folder_id=folder_id)
    db.add(item)
    db.flush()
    g = enqueue_generation(db, workspace_id=cur.workspace_id, project_id=None, target_type="media",
                           target_id=item.id, kind="image", prompt=prompt, params=params, seed=seed)
    item.generation_id = g.id
    return item, db.get(Job, g.job_id)


@router.get("/images/options")
def image_options():
    return {"aspects": [{"id": a, "width": w, "height": h} for a, (w, h) in
                        ((a, lib.size_for_aspect(a)) for a in lib.ASPECTS)],
            "styles": [{"id": k, "label": v[0], "suffix": v[1]} for k, v in lib.STYLES.items()],
            "count": {"min": 1, "max": 4}, "edit_sources": {"min": 1, "max": 3}}


@router.post("/images/generate", response_model=ImageBatchOut, status_code=202)
def generate_images(body: ImageGenerateIn, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    if body.style and body.style not in lib.STYLES:
        raise HTTPException(422, f"Unknown style '{body.style}' (expected {', '.join(lib.STYLES)})")
    if not body.prompt.strip():
        raise HTTPException(422, "A prompt is required")
    into = generate_into(db, cur.workspace_id, body.folder_id, "image")
    model, chosen = mc.choose(body.model, "image", mn.plain(body.prompt), count=body.count)
    speed = _speed(model, body)
    magic = prompt_enhance.marker(body.magic_prompt, body.prompt_enhanced, "image",
                                  style=lib.STYLES[body.style][0] if body.style else None,
                                  brand_kit_id=body.brand_kit_id)
    w, h = lib.size_for_aspect(body.aspect)
    # mentioned pictures turn the run into a reference-guided composition on the edit model
    editor = mc.default_for("edit")
    mentioned = mn.resolve(db, cur.workspace_id, body.prompt.strip(), budget=editor.max_refs or 3,
                           model_label=editor.label)
    prompt = lib.styled_prompt(mn.ref_preamble(mentioned.ref_labels) + mentioned.prompt, body.style)
    title = (body.title or "").strip() or lib.short_title(mn.plain(body.prompt))
    items, jobs = [], []
    for i in range(body.count):
        params = {"aspect": body.aspect, "width": w, "height": h, "style": body.style,
                  "user_prompt": mn.plain(body.prompt).strip(),
                  "created_by": {"user_id": cur.id, "flow": "image_generate"}, "magic_prompt": magic, **chosen}
        if mentioned.mentions:
            params["mentions"] = mentioned.mentions
        if mentioned.ref_ids:
            params["reference_ids"], params["reference_labels"] = list(mentioned.ref_ids), list(mentioned.ref_labels)
        if body.negative:
            params["negative"] = body.negative.strip()
        if body.steps:
            params["steps"] = body.steps
        if body.template_id:
            params["template_id"] = body.template_id
        params["model"] = model.id
        if speed:
            params["speed"] = speed.id
        seed = (body.seed + i) % 2**31 if body.seed is not None else None
        item, job = _new_image_item(db, cur, title, *brand.apply_to_request(
            db, cur.workspace_id, body.brand_kit_id, prompt, params), seed, into)
        items.append(item)
        jobs.append(job)
    db.commit()
    return ImageBatchOut(items=lib.items_out(db, items), jobs=[job_out(j) for j in jobs],
                         model_resolved=model.id, magic_prompt=magic)


def generate_into(db: Session, workspace_id: str, folder_id: str | None, kind: str) -> str | None:
    f = _folder(db, workspace_id, folder_id)
    if f is not None and f.kind not in ("any", kind):
        raise HTTPException(422, f"“{f.name}” only holds {f.kind}s")
    return f.id if f else None


def _speed(model: mc.Model, body) -> mc.Speed | None:
    # a speed picked for some other model shouldn't sink an auto pick that has no speeds
    if body.model == mc.AUTO and not model.speeds:
        return None
    return mc.speed_of(model, body.speed)


def _edit_source(db: Session, workspace_id: str, sid: str) -> tuple[str | None, Generation]:
    item = db.get(MediaItem, sid)
    if item is not None and item.workspace_id == workspace_id:
        g = db.get(Generation, item.generation_id) if item.generation_id else None
        media_id = item.id
    else:
        g = db.get(Generation, sid)
        if g is not None and g.workspace_id != workspace_id:
            g = None
        media_id = None
    if g is None:
        raise HTTPException(404, f"Source {sid} not found")
    if not (g.media_type or "").startswith("image/") or g.status not in lib.FINISHED or not g.file_path:
        raise HTTPException(422, f"Source {sid} isn't a finished image")
    return media_id, g


@router.post("/images/edit", response_model=ImageBatchOut, status_code=202)
def edit_images(body: ImageEditIn, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    if not body.instruction.strip():
        raise HTTPException(422, "Say what to change")
    into = generate_into(db, cur.workspace_id, body.folder_id, "image")
    model, chosen = mc.choose(body.model, "edit", mn.plain(body.instruction), refs=len(body.source_ids))
    mc.check_refs(model, len(body.source_ids))
    sources = [_edit_source(db, cur.workspace_id, sid) for sid in body.source_ids]
    mentioned = mn.resolve(db, cur.workspace_id, body.instruction.strip(), budget=model.max_refs or 3,
                           used=len(sources), model_label=model.label)
    if body.aspect:
        w, h = lib.size_for_aspect(body.aspect)
    else:
        # keep the first picture's shape at ~1 MP
        sw, sh = lib._image_dims(sources[0][1])
        w, h = lib.size_for_ratio(sw, sh) if sw and sh else lib.size_for_aspect("1:1")
    instruction = mn.ref_preamble(mentioned.ref_labels, len(sources) + 1) + mentioned.prompt
    title = (body.title or "").strip() or f"Edit · {lib.short_title(mn.plain(body.instruction).strip(), 5)}"
    edit_of = [{"media_id": m, "generation_id": g.id} for m, g in sources]
    items, jobs = [], []
    for i in range(body.count):
        params = {"width": w, "height": h, "aspect": body.aspect, "instruction": instruction, "edit_of": edit_of,
                  "reference_ids": [g.id for _, g in sources] + mentioned.ref_ids, "model": model.id,
                  "created_by": {"user_id": cur.id, "flow": "image_edit"}, **chosen}
        if mentioned.mentions:
            params["mentions"] = mentioned.mentions
        seed = (body.seed + i) % 2**31 if body.seed is not None else None
        item, job = _new_image_item(db, cur, title, *brand.apply_to_request(
            db, cur.workspace_id, body.brand_kit_id, instruction, params, edit=True, max_refs=model.max_refs or 3), seed,
            into)
        items.append(item)
        jobs.append(job)
    db.commit()
    return ImageBatchOut(items=lib.items_out(db, items), jobs=[job_out(j) for j in jobs], model_resolved=model.id)


@router.post("/images/img2img", response_model=ImageBatchOut, status_code=202)
def img2img(body: Img2ImgIn, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    if not body.prompt.strip():
        raise HTTPException(422, "Describe the picture you want")
    into = generate_into(db, cur.workspace_id, body.folder_id, "image")
    model, chosen = mc.choose(body.model, "image", body.prompt, count=body.count)
    reason = mc.capability_unavailable(model, "i2i")
    if reason:
        raise HTTPException(422, f"Image to image with {model.label} isn't available: {reason}")
    speed = _speed(model, body)
    magic = prompt_enhance.marker(body.magic_prompt, body.prompt_enhanced, "image", brand_kit_id=body.brand_kit_id)
    media_id, src = _edit_source(db, cur.workspace_id, body.source_id)
    # the redraw graph has one image input, so mentions stay words
    mentioned = mn.resolve(db, cur.workspace_id, body.prompt.strip(), budget=0)
    if body.aspect == "source":
        sw, sh = lib._image_dims(src)
        w, h = lib.size_for_ratio(sw, sh) if sw and sh else lib.size_for_aspect("1:1")
    else:
        w, h = lib.size_for_aspect(body.aspect)
    prompt = mentioned.prompt
    title = (body.title or "").strip() or f"Restyle · {lib.short_title(mn.plain(body.prompt).strip(), 5)}"
    items, jobs = [], []
    for i in range(body.count):
        params = {"width": w, "height": h, "aspect": body.aspect, "model": model.id,
                  "user_prompt": mn.plain(body.prompt).strip(),
                  "img2img_of": {"media_id": media_id, "generation_id": src.id, "strength": body.strength},
                  "created_by": {"user_id": cur.id, "flow": "image_img2img"}, "magic_prompt": magic, **chosen}
        if speed:
            params["speed"] = speed.id
        if body.negative:
            params["negative"] = body.negative.strip()
        if mentioned.mentions:
            params["mentions"] = mentioned.mentions
        seed = (body.seed + i) % 2**31 if body.seed is not None else None
        item, job = _new_image_item(db, cur, title, *brand.apply_to_request(
            db, cur.workspace_id, body.brand_kit_id, prompt, params), seed, into)
        items.append(item)
        jobs.append(job)
    db.commit()
    return ImageBatchOut(items=lib.items_out(db, items), jobs=[job_out(j) for j in jobs],
                         model_resolved=model.id, magic_prompt=magic)


# ---------------------------------------------------------------- prompt templates
# Shown to users as "Prompt templates"; /templates stays as the old name for the same thing.

PREVIEW_DIR = TEMPLATE_DIR / "previews"


@lru_cache
def categories() -> dict[str, list[str]]:
    return {kind: json.loads((TEMPLATE_DIR / f"{kind}.json").read_text(encoding="utf-8")).get("categories", [])
            for kind in ("video", "image", "audio")}


@lru_cache
def templates() -> dict[str, dict]:
    out: dict[str, dict] = {}
    for kind in ("video", "image", "audio"):
        data = json.loads((TEMPLATE_DIR / f"{kind}.json").read_text(encoding="utf-8"))
        for t in data["templates"]:
            out[t["id"]] = {**t, "type": kind}
    return out


def preview_file(template_id: str) -> Path | None:
    if template_id not in templates():
        return None
    root = PREVIEW_DIR.resolve()
    target = (root / f"{template_id}.webp").resolve()
    if not target.is_relative_to(root) or not target.is_file():
        return None
    return target


def _template_out(t: dict) -> TemplateOut:
    f = preview_file(t["id"])
    # mtime in the URL so a re-rendered preview isn't stuck behind the cache
    url = f"/api/prompt-templates/{t['id']}/preview?v={int(f.stat().st_mtime)}" if f else None
    return TemplateOut(**{k: t.get(k) for k in ("id", "type", "title", "description", "thumb", "defaults", "category")},
                       tags=t.get("tags") or [], examples=t.get("examples") or {}, preview_url=url,
                       requires_brand=bool(t.get("requires_brand")))


@router.get("/templates", response_model=list[TemplateOut])
@router.get("/prompt-templates", response_model=list[TemplateOut])
def list_templates(type: Literal["video", "image", "audio"] | None = None, cur: CurrentUser = Depends(get_current_user)):
    rows = [t for t in templates().values() if type in (None, t["type"])]
    order = categories()

    def rank(t: dict) -> int:
        cats = order.get(t["type"], [])
        return cats.index(t["category"]) if t.get("category") in cats else len(cats)

    kinds = ("video", "image", "audio")
    return [_template_out(t) for t in sorted(rows, key=lambda t: (kinds.index(t["type"]), rank(t)))]


@router.get("/templates/{template_id}/preview")
@router.get("/prompt-templates/{template_id}/preview")
def template_preview(template_id: str, cur: CurrentUser = Depends(get_current_user)):
    f = preview_file(template_id)
    if f is None:
        raise HTTPException(404, "No preview for this prompt template")
    return FileResponse(f, media_type="image/webp", headers={"Cache-Control": "private, max-age=86400"})


def placeholders(text: str) -> list[str]:
    return list(dict.fromkeys(re.findall(r"\[([^\[\]]{1,60})\]", text)))


@router.post("/templates/{template_id}/start", response_model=TemplateStartOut)
@router.post("/prompt-templates/{template_id}/start", response_model=TemplateStartOut)
def start_template(template_id: str, cur: CurrentUser = Depends(get_current_user)):
    t = templates().get(template_id)
    if t is None:
        raise HTTPException(404, "Prompt template not found")
    d = dict(t["defaults"])
    scaffold = d.pop("prompt_scaffold", "")
    if t["type"] == "image":
        prefill = {"prompt": scaffold, "aspect": d.get("aspect", "1:1"), "count": d.get("count", 1),
                   "style": d.get("style"), "negative": d.get("negative"), "template_id": t["id"]}
        if d.get("model"):
            prefill["model"] = d["model"]
        target = "image"
    elif t["type"] == "audio":
        prefill = {k: d.get(k) for k in ("kind", "lyrics", "language", "vocal", "bpm", "category", "duration_s")
                   if d.get(k) is not None}
        prefill.update(prompt=scaffold, template_id=t["id"])
        target = "audio"
    elif d.get("authoring_mode"):
        prefill = {"title": "", "authoring_mode": d["authoring_mode"], "logline": "",
                   "logline_hint": d.get("logline_hint", scaffold), "target_runtime_s": d.get("target_runtime_s"),
                   "aspect_ratio": d.get("aspect_ratio", "16:9"), "brief": scaffold, "template_id": t["id"]}
        target = "studio"
    else:
        prefill = {"prompt": scaffold, "duration_s": d.get("duration_s"), "aspect_ratio": d.get("aspect_ratio"),
                   "style": d.get("style"), "dialogue": d.get("dialogue"), "template_id": t["id"]}
        target = "quick"
    prefill["placeholders"] = placeholders(scaffold)
    if t.get("examples"):
        prefill["examples"] = t["examples"]
    if t.get("requires_brand"):
        prefill["requires_brand"] = True
    return TemplateStartOut(target=target, prefill=prefill)


# ---------------------------------------------------------------- dashboard

@router.get("/dashboard", response_model=DashboardOut)
def dashboard(db: Session = Depends(get_db), cur: CurrentUser = Depends(get_current_user)):
    from app.api.quick import recent

    ws = cur.workspace_id
    projects = db.scalars(select(Project).where(Project.workspace_id == ws)
                          .order_by(Project.updated_at.desc()).limit(6)).all()
    videos, _ = lib.list_media(db, ws, kind="video", include_project=True, limit=6)
    images, _ = lib.list_media(db, ws, kind="image", limit=8)
    org.annotate(db, ws, cur.id, videos + images)
    running = db.scalars(select(Job).where(Job.workspace_id == ws, Job.status.in_(("queued", "running")))
                         .order_by(Job.created_at.desc()).limit(20)).all()
    quick = [r.model_dump(mode="json") for r in recent(db, cur)[:4]]
    return DashboardOut(recent_projects=[project_out(db, p) for p in projects], recent_videos=videos,
                        recent_images=images, running_jobs=[job_out(j) for j in running], quick_recent=quick)


# ---------------------------------------------------------------- upscales (P5)

@router.get("/upscales", response_model=UpscalePage)
def list_upscales(kind: Literal["image", "video"] | None = None, limit: int = Query(20, ge=1, le=lib.MAX_LIMIT),
                  cursor: str | None = None, db: Session = Depends(get_db),
                  cur: CurrentUser = Depends(get_current_user)):
    rows, nxt = lib.list_upscales(db, cur.workspace_id, kind=kind, limit=limit, cursor=cursor)
    return UpscalePage(items=rows, next_cursor=nxt)


@router.delete("/upscales/{gen_id}", status_code=204)
def delete_upscale(gen_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    g = db.get(Generation, gen_id)
    if g is None or g.workspace_id != cur.workspace_id or not isinstance((g.params or {}).get("upscale"), dict):
        raise HTTPException(404, "Upscale not found")
    if g.status == "approved":
        raise HTTPException(409, "This upscale is the approved version in its project; pick another there first")
    lib.delete_upscale(db, g)
    db.commit()
    return Response(status_code=204)
