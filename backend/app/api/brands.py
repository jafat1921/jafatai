"""Brand kits (contract v7): CRUD, asset uploads, previews, logo reveal, "Apply brand"."""
import io
import tempfile
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from PIL import Image
from pydantic import BaseModel
from sqlalchemy import select, update
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app import brand as br
from app import brand_render as rnd
from app import library as lib
from app import uploads
from app.brand_schemas import (
    AssetOut, BrandApplyIn, BrandKitIn, BrandKitOut, BrandKitPatch, BrandPreviewIn, LogoRevealIn, LogoRevealOut,
    ProjectBrandIn, merged_settings,
)
from app.db import get_db
from app.models import BrandKit, Generation, MediaItem, Project, utcnow
from app.schemas import JobOut, MediaItemOut
from app.security import CurrentUser, get_current_user, require_editor
from app.services import generation_file, get_owned, job_out, media_url, owned_source

router = APIRouter(tags=["brand"])
PREVIEW_MAX = 1280


class BrandUploadOut(BaseModel):
    item: MediaItemOut
    warnings: list[str] = []


def _kit(db: Session, kit_id: str, workspace_id: str) -> BrandKit:
    return get_owned(db, BrandKit, kit_id, workspace_id, "Brand kit")


def _asset_ids(kit: BrandKit) -> list[str]:
    ids = [v.get("media_id") for v in (kit.logos or {}).values() if isinstance(v, dict)]
    ids += [p.get("media_id") for p in kit.products or []]
    ids += list(kit.font_files or []) + list(kit.reference_media_ids or [])
    return [i for i in dict.fromkeys(ids) if i]


def kit_out(db: Session, kit: BrandKit) -> BrandKitOut:
    assets = {}
    for mid in _asset_ids(kit):
        g = br.media_generation(db, kit.workspace_id, mid)
        item = db.get(MediaItem, mid)
        assets[mid] = AssetOut(media_id=mid, kind=item.kind if item else None,
                               media_url=media_url(g.file_path) if g else None, missing=g is None)
    return BrandKitOut(
        id=kit.id, workspace_id=kit.workspace_id, name=kit.name, is_default=kit.is_default,
        palette=list(kit.palette or []), style_text=kit.style_text or "", voice_text=kit.voice_text or "",
        tagline=kit.tagline or "", logos=dict(kit.logos or {}), products=list(kit.products or []),
        font_files=list(kit.font_files or []), reference_media_ids=list(kit.reference_media_ids or []),
        settings=merged_settings(kit.settings), assets=assets, prompt_context=br.prompt_context(kit),
        created_at=kit.created_at, updated_at=kit.updated_at,
    )


def _check_media(db: Session, ws: str, mid: str, what: str, kind: Literal["image", "font"]) -> None:
    g = br.media_generation(db, ws, mid)
    if g is None:
        raise HTTPException(422, f"{what} {mid} wasn't found in your library")
    is_font = (g.media_type or "").startswith("font/")
    if kind == "font" and not is_font:
        raise HTTPException(422, f"{what} {mid} isn't a font file")
    if kind == "image" and not (g.media_type or "").startswith("image/"):
        raise HTTPException(422, f"{what} {mid} isn't an image")


def _apply_fields(db: Session, kit: BrandKit, data: dict) -> None:
    ws = kit.workspace_id
    if data.get("logos") is not None:
        for variant, ref in data["logos"].items():
            if ref:
                _check_media(db, ws, ref["media_id"], f"Logo ({variant})", "image")
        kit.logos = {k: v for k, v in data["logos"].items() if v}
    if data.get("products") is not None:
        for p in data["products"]:
            _check_media(db, ws, p["media_id"], f"Product '{p['name']}'", "image")
        kit.products = data["products"]
    if data.get("font_files") is not None:
        for f in data["font_files"]:
            _check_media(db, ws, f, "Font", "font")
        kit.font_files = list(dict.fromkeys(data["font_files"]))
    if data.get("reference_media_ids") is not None:
        for r in data["reference_media_ids"]:
            _check_media(db, ws, r, "Reference", "image")
        kit.reference_media_ids = list(dict.fromkeys(data["reference_media_ids"]))
    if data.get("settings") is not None:
        try:
            kit.settings = merged_settings(kit.settings, data["settings"]).model_dump()
        except ValueError as e:
            raise HTTPException(422, f"Invalid settings: {e}") from None
    for k in ("name", "style_text", "voice_text", "tagline"):
        if data.get(k) is not None:
            setattr(kit, k, data[k].strip() if k == "name" else data[k])
    if data.get("palette") is not None:
        kit.palette = data["palette"]


def _make_default(db: Session, kit: BrandKit) -> None:
    db.execute(update(BrandKit).where(BrandKit.workspace_id == kit.workspace_id, BrandKit.id != kit.id)
               .values(is_default=False))
    kit.is_default = True


# ---------------------------------------------------------------- CRUD

@router.get("/brand-kits", response_model=list[BrandKitOut])
def list_kits(db: Session = Depends(get_db), cur: CurrentUser = Depends(get_current_user)):
    kits = db.scalars(select(BrandKit).where(BrandKit.workspace_id == cur.workspace_id)
                      .order_by(BrandKit.is_default.desc(), BrandKit.updated_at.desc())).all()
    return [kit_out(db, k) for k in kits]


@router.post("/brand-kits", response_model=BrandKitOut, status_code=201)
def create_kit(body: BrandKitIn, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    kit = BrandKit(workspace_id=cur.workspace_id, name=body.name.strip(), settings=merged_settings(None).model_dump())
    _apply_fields(db, kit, body.model_dump())
    db.add(kit)
    db.flush()
    first = db.scalar(select(BrandKit.id).where(BrandKit.workspace_id == cur.workspace_id, BrandKit.id != kit.id)
                      .limit(1)) is None
    if body.is_default or first:
        _make_default(db, kit)
    db.commit()
    return kit_out(db, kit)


@router.get("/brand-kits/{kit_id}", response_model=BrandKitOut)
def get_kit(kit_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(get_current_user)):
    return kit_out(db, _kit(db, kit_id, cur.workspace_id))


@router.patch("/brand-kits/{kit_id}", response_model=BrandKitOut)
def patch_kit(kit_id: str, body: BrandKitPatch, db: Session = Depends(get_db),
              cur: CurrentUser = Depends(require_editor)):
    kit = _kit(db, kit_id, cur.workspace_id)
    _apply_fields(db, kit, body.model_dump(exclude_unset=True))
    kit.updated_at = utcnow()
    db.commit()
    return kit_out(db, kit)


@router.delete("/brand-kits/{kit_id}", status_code=204)
def delete_kit(kit_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    kit = _kit(db, kit_id, cur.workspace_id)
    # uploaded assets stay in the Library; projects pointing here simply fall back to "no kit"
    db.delete(kit)
    db.commit()
    return Response(status_code=204)


@router.post("/brand-kits/{kit_id}/default", response_model=BrandKitOut)
def set_default(kit_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    kit = _kit(db, kit_id, cur.workspace_id)
    _make_default(db, kit)
    db.commit()
    return kit_out(db, kit)


# ---------------------------------------------------------------- assets

@router.post("/brand-kits/assets", response_model=BrandUploadOut, status_code=201)
async def upload_asset(request: Request, purpose: Literal["logo", "font", "product", "reference"],
                       db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    folder, rel_folder = lib.media_dir(cur.workspace_id)
    got = await uploads.receive(request, folder, br.PROFILES[purpose])
    try:
        item, warnings = await run_in_threadpool(br.store_brand_upload, db, cur.workspace_id, cur.id, got, folder,
                                                 rel_folder, purpose)
    except BaseException:
        got.path.unlink(missing_ok=True)
        raise
    return BrandUploadOut(item=await run_in_threadpool(lib.item_out, db, item), warnings=warnings)


# ---------------------------------------------------------------- preview

def _sample(db: Session, ws: str, media_id: str | None, assets: rnd.KitAssets) -> Image.Image:
    if not media_id:
        return rnd.sample_frame(assets)
    g = br.media_generation(db, ws, media_id)
    path = generation_file(g) if g else None
    if not path or not path.is_file():
        raise HTTPException(404, "Sample not found")
    if (g.media_type or "").startswith("video/"):
        with tempfile.TemporaryDirectory() as tmp:
            info = rnd.video_info(path)
            frame = rnd.grab_frame(path, min(1.0, info.duration / 2), Path(tmp) / "f.png")
        if frame is None:
            raise HTTPException(422, "Couldn't read a frame from that video")
        img = frame
    elif (g.media_type or "").startswith("image/"):
        with Image.open(path) as im:
            img = im.convert("RGB")
    else:
        raise HTTPException(422, "The sample must be an image or a video")
    img.thumbnail((PREVIEW_MAX, PREVIEW_MAX))
    return img


@router.post("/brand-kits/{kit_id}/preview", responses={200: {"content": {"image/png": {}}}},
             response_class=Response)
def preview(kit_id: str, body: BrandPreviewIn, db: Session = Depends(get_db),
            cur: CurrentUser = Depends(get_current_user)):
    kit = _kit(db, kit_id, cur.workspace_id)
    try:
        st = merged_settings(kit.settings, body.settings)
    except ValueError as e:
        raise HTTPException(422, f"Invalid settings: {e}") from None
    assets = br.kit_assets(db, kit, st)
    sample = _sample(db, cur.workspace_id, body.sample_media_id, assets)
    size = sample.size
    try:
        if body.kind == "image":
            img = sample
            if st.grade.enabled:
                img = rnd.grade_image(img, assets.palette, st.grade.strength)
            # the preview always shows where the logo would sit, even while the watermark is off
            if assets.logo or assets.logo_light or assets.logo_dark:
                img = rnd.watermark_image(img, assets, st.watermark)
        elif body.kind == "lower_third":
            img = sample.convert("RGBA")
            img.alpha_composite(rnd.render_lower_third(size, assets, st.lower_third))
        else:
            card = st.end_card if body.kind == "end_card" else st.intro_card
            img = rnd.render_card(size, assets, card, body.kind)
    except rnd.BrandRenderError as e:
        raise HTTPException(422, str(e)) from None
    buf = io.BytesIO()
    img.convert("RGB").save(buf, "PNG", optimize=False, compress_level=3)
    return Response(buf.getvalue(), media_type="image/png", headers={"Cache-Control": "no-store"})


# ---------------------------------------------------------------- logo reveal, apply

@router.post("/brand-kits/{kit_id}/logo-reveal", response_model=LogoRevealOut, status_code=202)
def logo_reveal(kit_id: str, body: LogoRevealIn, db: Session = Depends(get_db),
                cur: CurrentUser = Depends(require_editor)):
    kit = _kit(db, kit_id, cur.workspace_id)
    try:
        item, job = br.queue_logo_reveal(db, kit, duration_s=body.duration_s, aspect=body.aspect,
                                         background=body.background.model_dump(), show_tagline=body.show_tagline,
                                         title=body.title, user_id=cur.id)
    except br.BrandError as e:
        raise HTTPException(422, str(e)) from None
    db.commit()
    return LogoRevealOut(item=lib.item_out(db, item), job=job_out(job))


@router.post("/generations/{gen_id}/brand", response_model=JobOut, status_code=202)
def apply_brand(gen_id: str, body: BrandApplyIn, db: Session = Depends(get_db),
                cur: CurrentUser = Depends(require_editor)):
    g = owned_source(db, cur.workspace_id, gen_id)
    kit = br.get_kit(db, cur.workspace_id, body.kit_id or None, g.project_id) or br.get_kit(db, cur.workspace_id, "default")
    if kit is None:
        raise HTTPException(404 if body.kit_id else 422,
                            "Brand kit not found" if body.kit_id else "No brand kit: pick one or create a default kit")
    try:
        job = br.queue_brand_apply(db, g, kit, body.options, user_id=cur.id)
    except br.BrandError as e:
        raise HTTPException(422, str(e)) from None
    db.commit()
    return job_out(job)


@router.put("/projects/{project_id}/brand-kit")
def set_project_kit(project_id: str, body: ProjectBrandIn, db: Session = Depends(get_db),
                    cur: CurrentUser = Depends(require_editor)):
    p = get_owned(db, Project, project_id, cur.workspace_id, "Project")
    br.project_kit_id(db, p, body.kit_id)
    db.commit()
    return {"project_id": p.id, "brand_kit_id": (p.settings or {}).get("brand_kit_id")}
