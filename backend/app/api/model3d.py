"""3D Studio (contract v40): POST /3d/make turns a picture, a prompt, a character or a few views of one object
into a textured GLB in the Library. The turntable and thumbnail routes take what the browser's viewer made."""
from fastapi import APIRouter, Depends, HTTPException, Request
from PIL import Image
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app import brand, prompt_enhance, thumbs, uploads
from app import library as lib
from app import model3d as m3
from app import models_catalog as mc
from app.api.library import _edit_source, _new_image_item, generate_into
from app.config import get_settings
from app.db import get_db
from app.models import Character, Generation, Job, MediaItem, new_id
from app.openapi import multipart
from app.schemas import MediaItemOut, Model3DIn, Model3DOut, Turntable3DOut
from app.security import CurrentUser, get_current_user, require_editor
from app.services import READY_STATES, enqueue_generation, get_owned, job_out

router = APIRouter(tags=["3d"])

NO_ALPHA = "The picture has no transparent background, so the background was removed anyway."
NO_ALPHA_VIEWS = "Not every view has a transparent background, so the backgrounds were removed anyway."
VIEWS_PIXAL = "Several views only work with Pixal3D, so Pixal3D made this one."


@router.get("/3d/options")
def options(cur: CurrentUser = Depends(get_current_user)):
    pixal = mc.MODELS["pixal3d"]
    why = mc.capability_unavailable(pixal, "multiview")
    return {
        "engines": [{"id": m.id, "label": m.label, "description": m.description, "default": m.default,
                     "best_for": list(m.best_for)} for m in mc.MODELS.values() if m.type == "model3d"],
        "qualities": [{"id": q, "label": m3.QUALITY_LABELS[q]} for q in m3.QUALITY],
        "default_quality": "final",
        "views": {"ids": list(m3.VIEWS), "required": ["front"], "min": 2, "engine": "pixal3d",
                  "available": why is None, "reason": why},
    }


def _see_through(paths, wanted: bool) -> bool:
    # without an alpha channel the template's "keep" branch crops to an empty mask
    return wanted or not all(m3.has_transparency(p) for p in paths)


def _picked_views(db: Session, workspace_id: str, body: Model3DIn) -> dict[str, tuple[str | None, Generation]]:
    asked = {v: getattr(body.views, v) for v in m3.VIEWS if getattr(body.views, v)}
    out = {v: _edit_source(db, workspace_id, sid) for v, sid in asked.items()}
    gens = [g.id for _, g in out.values()]
    if len(set(gens)) != len(gens):
        raise HTTPException(422, "Each view needs its own picture")
    if len(out) < 2:
        raise HTTPException(422, "Add at least one more view (left, back or right), or start from one picture")
    return out


@router.post("/3d/make", response_model=Model3DOut, status_code=202,
             summary="Make a 3D model",
             description="Queues one job on the image GPU (two for a text start: the picture, then the model). The "
                         "result is a Library item of kind `model` whose file is a binary glTF "
                         "(`model/gltf-binary`); list them with `GET /api/media?kind=model`.")
def make_3d(body: Model3DIn, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    ws = cur.workspace_id
    into = generate_into(db, ws, body.folder_id, m3.MEDIA_KIND)
    root = get_settings().data_dir
    rec: dict = {"quality": body.quality}
    extra: dict = {}
    out: dict = {"start": "picture"}
    views: dict[str, tuple[str | None, Generation]] | None = None
    title = (body.title or "").strip()
    prompt = ""

    if body.views:
        if body.engine == "trellis2":
            raise HTTPException(422, "TRELLIS.2 takes one picture. Use Pixal3D for several views.")
        views = _picked_views(db, ws, body)
        out["start"] = "views"
        rec["measure_fov"] = True  # most people's views are photos
        front = db.get(MediaItem, views["front"][0]) if views["front"][0] else None
        title = title or (f"{front.title} · 3D" if front and front.title else "3D model")
    elif body.character_id:
        c = get_owned(db, Character, body.character_id, ws, "Character")
        turn, single = m3.character_views(db, c.id)
        if turn is None and single is None:
            raise HTTPException(422, f"{c.name} has no picture yet. Make the portrait first.")
        out["start"] = "character"
        extra["character_id"] = c.id
        rec["character_id"] = c.id
        title = title or f"{c.name} · 3D"
        if turn is not None:
            views = {v: (None, g) for v, g in turn.items()}
            rec["measure_fov"] = False  # turnaround panels are framed like a render, not a photo
        else:
            rec.update(source_id=single.id, source_media_id=None)
            prompt = single.prompt or ""
    elif body.prompt:
        out["start"] = "text"
        prompt = m3.object_prompt(body.prompt)
        title = title or f"{lib.short_title(body.prompt)} · 3D"
    else:
        media_id, src = _edit_source(db, ws, body.source_id)
        source_item = db.get(MediaItem, media_id) if media_id else None
        title = title or (f"{source_item.title} · 3D" if source_item and source_item.title else "3D model")
        rec.update(source_id=src.id, source_media_id=media_id)
        prompt = src.prompt or ""

    engine_id = body.engine
    if views is not None:
        if engine_id != "pixal3d":
            out["engine_note"] = VIEWS_PIXAL
        engine_id = "pixal3d"
        why = mc.capability_unavailable(mc.MODELS["pixal3d"], "multiview")
        if why:
            raise HTTPException(422, f"Pixal3D multi-view isn't available right now: {why}")
    engine, chosen = mc.choose(engine_id, "model3d")

    remove_bg = body.remove_background
    if views is not None:
        remove_bg = _see_through([root / g.file_path for _, g in views.values()], remove_bg)
        if remove_bg and not body.remove_background:
            out["background_note"] = NO_ALPHA_VIEWS
        rec.update(views={v: g.id for v, (_, g) in views.items()},
                   view_media={v: mid for v, (mid, _) in views.items() if mid},
                   source_id=views["front"][1].id, source_media_id=views["front"][0])
        out["views_used"] = list(views)
        prompt = prompt or views["front"][1].prompt or ""
    elif out["start"] != "text":
        src = db.get(Generation, rec["source_id"])
        remove_bg = _see_through([root / src.file_path], remove_bg)
        if remove_bg and not body.remove_background:
            out["background_note"] = NO_ALPHA
    # a text start's picture is made on a plain background, so it always needs cutting out
    rec = {"engine": engine.id, **rec, "remove_background": remove_bg or out["start"] == "text"}

    if out["start"] == "text":
        pic, pic_job = _queue_picture(db, cur, body, prompt)
        rec.update(picture={"generation_id": pic.generation_id, "media_id": pic.id, "status": "pending"},
                   source_media_id=pic.id)
        out.update(picture=pic, picture_job=pic_job)
    if out["start"] != "picture":
        rec["start"] = out["start"]

    params = {"model3d": rec, "model": engine.id, **chosen, **extra,
              "created_by": {"user_id": cur.id, "flow": "make_3d" if out["start"] == "picture" else
                             f"make_3d:{out['start']}"}}
    item = MediaItem(id=new_id(), workspace_id=ws, kind=m3.MEDIA_KIND, origin="generated",
                     title=title[:300], tags=[], folder_id=into, home=lib.home_of(body.part_of))
    db.add(item)
    db.flush()
    g = enqueue_generation(db, workspace_id=ws, project_id=None, target_type="media",
                           target_id=item.id, kind=m3.GEN_KIND, prompt=prompt[:4000], params=params,
                           seed=body.seed, parent_id=None)
    item.generation_id = g.id
    job = db.get(Job, g.job_id)
    db.commit()
    if out.get("picture") is not None:
        out["picture"] = lib.item_out(db, out["picture"])
        out["picture_job"] = job_out(out["picture_job"])
    return Model3DOut(item=lib.item_out(db, item), job=job_out(job), model_resolved=engine.id, **out)


def _queue_picture(db: Session, cur: CurrentUser, body: Model3DIn, prompt: str):
    """The picture a text start is made from: an ordinary image generation on the default (or chosen) image
    model, kept as a working part of the 3D Studio. Package gates and quota see it like any other image."""
    model, chosen = mc.choose(body.image_model, "image", body.prompt or "")
    speed = mc.speed_of(model, None) if model.speeds else None
    w, h = lib.size_for_aspect("1:1")
    # off unless asked: an enhanced prompt likes to add a scene around the object
    mode = body.magic_prompt or ("on" if body.prompt_enhanced else "off")
    magic = prompt_enhance.marker(mode, body.prompt_enhanced, "image", brand_kit_id=body.brand_kit_id)
    params = {"aspect": "1:1", "width": w, "height": h, "style": None, "user_prompt": m3.object_head(body.prompt or ""),
              "negative": m3.OBJECT_NEGATIVE, "model": model.id, "magic_prompt": magic,
              "created_by": {"user_id": cur.id, "flow": "make_3d:text"}, **chosen}
    if speed:
        params["speed"] = speed.id
    prompt, params = brand.apply_to_request(db, cur.workspace_id, body.brand_kit_id, prompt, params)
    if params.get("brand"):
        # the kit's palette and look, but no logo pass: a logo would end up baked into the texture
        params["brand"] = {**params["brand"], "auto": False}
    return _new_image_item(db, cur, lib.short_title(body.prompt or ""), prompt, params, body.seed, None,
                           m3.PART_HOME)


# ---------------------------------------------------------------- turntable and thumbnail (part 3)

TURNTABLE_MAX = 60 * uploads.MB
SNAPSHOT_MAX = 10 * uploads.MB


def _sniff_turntable(head: bytes) -> str | None:
    t = uploads.sniff(head)
    return t if t in ("video/webm", "video/mp4") else None


def _sniff_snapshot(head: bytes) -> str | None:
    t = uploads.sniff(head)
    return t if t in ("image/png", "image/jpeg", "image/webp") else None


TURNTABLE = uploads.Profile(_sniff_turntable, lambda _t: TURNTABLE_MAX,
                            lambda _t: HTTPException(413, "A turntable can be at most 60 MB"),
                            "a WebM or MP4 video up to 60 MB", TURNTABLE_MAX)
SNAPSHOT = uploads.Profile(_sniff_snapshot, lambda _t: SNAPSHOT_MAX,
                           lambda _t: HTTPException(413, "A thumbnail can be at most 10 MB"),
                           "a PNG, JPEG or WebP picture up to 10 MB", SNAPSHOT_MAX)


def _ready_model(db: Session, workspace_id: str, media_id: str) -> tuple[MediaItem, Generation]:
    item = get_owned(db, MediaItem, media_id, workspace_id, "Model")
    if item.kind != m3.MEDIA_KIND:
        raise HTTPException(404, "Model not found")
    g = db.get(Generation, item.generation_id) if item.generation_id else None
    if g is None or g.status not in READY_STATES or not g.file_path:
        raise HTTPException(409, "The model isn't finished yet")
    return item, g


def _thumb_from(db: Session, g: Generation, im: Image.Image, source: str) -> None:
    thumbs.set_model_thumb(get_settings().data_dir / g.file_path, im)
    g.params = {**(g.params or {}), "thumb_from": source, "thumb_v": new_id()[:8]}
    db.commit()


def _store_turntable(db: Session, cur: CurrentUser, model: MediaItem, mg: Generation, got: uploads.Received,
                     folder, rel_folder: str) -> tuple[MediaItem, bool]:
    from app.catalogue import importer

    mp4 = got.media_type == "video/webm" and m3.webm_to_mp4(got)
    got.title = f"{model.title or '3D model'} · turntable"
    got.fields = {}
    item, _ = importer.store(db, cur.workspace_id, cur.id, got, folder, rel_folder)
    # made in the studio, not brought in: it belongs with the generated work
    item.origin = "generated"
    tg = db.get(Generation, item.generation_id)
    tg.params = {**tg.params, "model3d_of": model.id,
                 "created_by": {"user_id": cur.id, "flow": "make_3d:turntable"}}
    # every turntable, so deleting the model can offer to take them with it
    done = [t for t in (mg.params or {}).get("turntables") or [] if t != item.id]
    mg.params = {**(mg.params or {}), "turntable_id": item.id, "turntables": [*done, item.id]}
    db.commit()
    # the first frame takes over from the source picture, unless someone picked a view by hand
    if (mg.params or {}).get("thumb_from") != "snapshot":
        im = thumbs.first_frame(get_settings().data_dir / tg.file_path)
        if im is not None:
            with im:
                _thumb_from(db, mg, im, "turntable")
    return item, mp4


@router.post("/3d/{media_id}/turntable", response_model=Turntable3DOut, status_code=201,
             openapi_extra=multipart(file_help="The turntable the viewer recorded: WebM or MP4, at most 60 MB"),
             summary="Save a model's turntable",
             description="Stores the video as a new Library item (kind `video`, a final output) linked to the "
                         "model by `params.model3d_of`. A WebM is converted to H.264 MP4 when ffmpeg can. Its "
                         "first frame becomes the model's thumbnail unless one was chosen from the viewer.")
async def save_turntable(media_id: str, request: Request, db: Session = Depends(get_db),
                         cur: CurrentUser = Depends(require_editor)):
    model, mg = await run_in_threadpool(_ready_model, db, cur.workspace_id, media_id)
    folder, rel_folder = lib.media_dir(cur.workspace_id)
    got = await uploads.receive(request, folder, TURNTABLE)
    try:
        item, mp4 = await run_in_threadpool(_store_turntable, db, cur, model, mg, got, folder, rel_folder)
    except BaseException:
        got.path.unlink(missing_ok=True)
        raise
    out = await run_in_threadpool(lambda: (lib.item_out(db, item), lib.item_out(db, model)))
    return Turntable3DOut(item=out[0], model=out[1], transcoded=mp4)


@router.post("/3d/{media_id}/thumbnail", response_model=MediaItemOut,
             openapi_extra=multipart(file_help="A snapshot of the viewer: PNG, JPEG or WebP, at most 10 MB"),
             summary="Set a model's thumbnail",
             description="Replaces the model's Library thumbnail with a picture of it, usually the viewer's "
                         "current view. Answers with the model and its new `thumb_url`.")
async def set_thumbnail(media_id: str, request: Request, db: Session = Depends(get_db),
                        cur: CurrentUser = Depends(require_editor)):
    model, mg = await run_in_threadpool(_ready_model, db, cur.workspace_id, media_id)
    folder, _ = lib.media_dir(cur.workspace_id)
    got = await uploads.receive(request, folder, SNAPSHOT)
    try:
        await run_in_threadpool(_snapshot, db, mg, got)
    finally:
        got.path.unlink(missing_ok=True)
    return await run_in_threadpool(lib.item_out, db, model)


def _snapshot(db: Session, mg: Generation, got: uploads.Received) -> None:
    uploads.probe_image(got.path, got.media_type)
    with Image.open(got.path) as im:
        im.load()
        _thumb_from(db, mg, im, "snapshot")
