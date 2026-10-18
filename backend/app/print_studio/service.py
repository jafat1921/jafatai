"""Print Studio records (contract v41).

A print job is an AdCampaign with kind "print": the brief holds the print settings (job, size, dpi, bleed,
viewing distance, the owner's lines), each concept is one design option, and c.ads holds one design record per
option. The option's working preview is a Library image with home "print" (so it stays out of every general
list), a new version per re-render; its print files (PDF, PNG, JPG, SVG, layers ZIP) are generations of their
own (target_type "print_file") so a signed link can hand them out, and they carry the hash of the spec they
were made from, which is how the editor knows they went stale.
"""
import hashlib
import json
import logging
import re
from pathlib import Path

from fastapi import HTTPException
from PIL import Image, ImageOps
from sqlalchemy.orm import Session

from app import brand as br
from app import library as lib
from app.ads import layout as lay
from app.ads import service as ads
from app.config import get_settings
from app.models import AdCampaign, BrandKit, Generation, Job, MediaItem, new_id, utcnow
from app.print_studio import export as ex
from app.print_studio import layout as pl
from app.print_studio import raster
from app.print_studio import sizes as sz
from app.services import gen_out, generation_file, job_out, next_version

log = logging.getLogger("mixai.print")

KIND = "print"
HOME = "print"
FILE_TARGET = "print_file"
STAGES = (("concepts", "Concepts"), ("pictures", "Pictures"), ("layout", "Layout"), ("files", "Print files"))
STAGE_KEYS = tuple(k for k, _ in STAGES)
PREVIEW_LONG = 2400
LINE_KEYS = ("name", "tagline", "offers", "opening_hours", "phone", "address", "website")

DEFAULTS = {"job": "sign", "width_cm": 25.0, "height_cm": 70.0, "dpi": 150, "bleed_mm": sz.DEFAULT_BLEED_MM,
            "shape": "rect", "viewing_distance": "street", "business_type": "", "style": "", "brief": "",
            "lines": {}, "variants": 3, "product_media_ids": [], "photo_media_ids": [], "image_model": "auto",
            "quality": "final", "candidates": 2, "review": False, "export_all": False, "print_safe": False,
            "font_preset": None, "families": None}
# plain-sounding families per job, best first: signs lean typographic, boards on a photo
FAMILY_PLAN = {"sign": ("typographic", "illustration", "typographic", "photo", "illustration", "typographic"),
               "board": ("photo", "typographic", "photo", "illustration", "photo", "typographic"),
               "flyer": ("photo", "typographic", "illustration", "photo", "typographic", "illustration"),
               "sticker": ("typographic", "illustration", "typographic", "illustration", "photo", "typographic")}
MARKETS = {"sv": "Sweden", "en": "the United Kingdom", "ur": "Pakistan", "ar": "the Arab world", "de": "Germany",
           "no": "Norway", "da": "Denmark", "fi": "Finland"}


class PrintError(RuntimeError):
    pass


# ---------------------------------------------------------------- the brief

def lines_of(b: dict) -> dict:
    raw = b.get("lines") or {}
    out = {k: " ".join(str(raw.get(k) or "").split()) for k in LINE_KEYS if k != "offers"}
    out["offers"] = [" ".join(str(o).split()) for o in raw.get("offers") or [] if str(o).strip()]
    return out


def brief_of(c: AdCampaign) -> dict:
    b = {**DEFAULTS, **(c.brief or {})}
    lines = lines_of(b)
    # what Ad Studio's helpers expect to find (the copy check, the photo pick)
    b.update(lines=lines, subject=b.get("business_type") or lines["name"] or "a local shop",
             market=MARKETS.get((c.language or "").split("-")[0], ""), offers=lines["offers"], must_say="",
             description="", formats=[])
    return b


def canvas_of(b: dict) -> sz.Canvas:
    return sz.canvas(b["width_cm"], b["height_cm"], int(b["dpi"]), float(b["bleed_mm"]))


def shape_family(b: dict) -> str:
    return "square" if b.get("shape") == "round" else sz.family(b["job"], b["width_cm"], b["height_cm"])


def families_for(b: dict, count: int) -> list[str]:
    asked = [f for f in b.get("families") or [] if f in pl.DESIGN_FAMILIES]
    plan = asked or list(FAMILY_PLAN.get(b["job"], FAMILY_PLAN["sign"]))
    return [plan[i % len(plan)] for i in range(count)]


def layouts_for(b: dict, family: str) -> list[str]:
    allowed = pl.LAYOUTS[shape_family(b)]
    if family == "photo":
        return [x for x in allowed if x in pl.PHOTO_LAYOUTS] or list(allowed)
    return [x for x in allowed if x not in pl.PHOTO_LAYOUTS] or list(allowed)


def spread(rows: list[dict], b: dict) -> None:
    """Each design gets a layout of its family, the repeats spread across what the shape offers."""
    used: dict[str, list[str]] = {}
    for r in rows:
        pool = layouts_for(b, r["family"])
        seen = used.setdefault(r["family"], [])
        want = r.get("layout")
        if want not in pool or (want in seen and len(seen) < len(pool)):
            want = next((x for x in pool if x not in seen), pool[len(seen) % len(pool)])
        r["layout"] = want
        seen.append(want)


def create(db: Session, cur, body: dict, kit: BrandKit | None) -> AdCampaign:
    b = {k: body[k] for k in DEFAULTS if k in body and body[k] is not None}
    lines = b.get("lines") or {}
    name = (lines.get("name") or "").strip()
    title = (body.get("title") or "").strip() or f"{name or 'Print job'} · {sz.cm(float(b.get('width_cm', 25)) * 10)}" \
        f" × {sz.cm(float(b.get('height_cm', 70)) * 10)} cm"
    c = AdCampaign(id=new_id(), workspace_id=cur.workspace_id, kind=KIND, title=title[:200],
                   brand_kit_id=kit.id if kit is not None else None,
                   language=(body.get("language") or "en").lower(), stage="concepts", stages={}, brief=b,
                   concepts=[], ads=[], created_by=cur.id)
    db.add(c)
    db.flush()
    return c


# ---------------------------------------------------------------- stages and the job

def stage(c: AdCampaign, key: str) -> dict:
    return ads.stage(c, key)


def put_stage(c: AdCampaign, key: str, rec: dict) -> None:
    ads.put_stage(c, key, rec)


def reset_from(c: AdCampaign, key: str) -> None:
    for k in STAGE_KEYS[STAGE_KEYS.index(key):]:
        rec = stage(c, k)
        rec.update(status="pending", detail=None)
        put_stage(c, k, rec)
    if c.stage not in STAGE_KEYS or STAGE_KEYS.index(c.stage) > STAGE_KEYS.index(key):
        c.stage = key


def done(c: AdCampaign, key: str) -> bool:
    return stage(c, key).get("status") in ("done", "skipped")


def queue(db: Session, c: AdCampaign) -> Job:
    ads.ensure_idle(db, c)
    job = Job(workspace_id=c.workspace_id, type=ads.JOB, message="Waiting for a worker · Print job",
              payload={"ad_campaign_id": c.id, "print": True})
    db.add(job)
    db.flush()
    c.job_id = job.id
    return job


def queue_files(db: Session, c: AdCampaign, design_ids: list[str]) -> Job:
    """Make the print files of these designs: the files stage runs again for just them."""
    rec = stage(c, "files")
    rec.update(status="pending", detail=None, want=list(dict.fromkeys(design_ids)))
    put_stage(c, "files", rec)
    if c.stage == "done":
        c.stage = "files"
    return queue(db, c)


def status_of(db: Session, c: AdCampaign) -> tuple[str, str | None]:
    if ads.busy(db, c) is not None:
        return "running", None
    for k in STAGE_KEYS:
        if stage(c, k).get("status") == "review":
            return "review", k
    if any(stage(c, k).get("status") == "failed" for k in STAGE_KEYS):
        return "failed", None
    return ("done" if done(c, "layout") else "idle"), None


# ---------------------------------------------------------------- concepts and designs

def new_concept(n: int, data: dict, guard: dict) -> dict:
    return {"id": new_id(), "n": n, "approved": True, "edited": False, "copy_dirty": False,
            **{k: data.get(k) or "" for k in ("insight", "family", "layout", "decor", "hero", "headline", "cta",
                                               "font", "photo_prompt", "art_prompt")},
            "caps": bool(data.get("caps", True)), "offers": list(data.get("offers") or []),
            "colours": {k: data.get(k) or "" for k in ("ground", "ink", "accent")},
            "guard": guard, "copy_check": list(data.get("copy_check") or []), "photos": {}, "error": None}


def groups_of(con: dict) -> list[str]:
    fam = con.get("family")
    return ["photo"] if fam == "photo" else (["art"] if fam == "illustration" else [])


def design(c: AdCampaign, design_id: str) -> dict:
    return ads.ad(c, design_id)


def designs_of(c: AdCampaign, concept_id: str) -> list[dict]:
    return ads.ads_of(c, concept_id)


def new_design(con: dict) -> dict:
    return {"id": new_id(), "concept_id": con["id"], "format": "print", "media_id": None, "generation_id": None,
            "overrides": {}, "status": "pending", "error": None, "dirty": True, "report": {}, "files": {}}


def _website(v: str) -> str:
    return re.sub(r"^https?://", "", (v or "").strip()).rstrip("/")


def spec_for(c: AdCampaign, con: dict, rec: dict, kit: BrandKit | None) -> dict:
    """The design's effective spec: the owner's lines, the concept's copy and look, the editor's changes."""
    b = brief_of(c)
    o = rec.get("overrides") or {}
    lines = b["lines"]
    many = b["job"] in ("board", "flyer")
    texts = {"name": lines["name"], "tagline": lines["tagline"], "headline": con.get("headline") or "",
             "offers": list(lines["offers"]) if many else list(con.get("offers") or []),
             "hours": lines["opening_hours"], "phone": lines["phone"], "address": lines["address"],
             "website": _website(lines["website"]), "cta": con.get("cta") or ""}
    texts.update({k: v for k, v in (o.get("texts") or {}).items() if k in pl.TEXT_KEYS and v is not None})
    photos = con.get("photos") or {}
    pic, art = photos.get("photo") or {}, photos.get("art") or {}
    layout = o.get("layout") or con.get("layout")
    return {
        "job": b["job"], "design": con.get("family") or "typographic", "layout": layout,
        "decor": o.get("decor") or con.get("decor") or "none", "hero": o.get("hero") or con.get("hero") or "name",
        "caps": o["caps"] if o.get("caps") is not None else con.get("caps", True),
        "size": {"width_mm": float(b["width_cm"]) * 10, "height_mm": float(b["height_cm"]) * 10,
                 "bleed_mm": float(b["bleed_mm"]), "dpi": int(b["dpi"]), "shape": b.get("shape") or "rect"},
        "language": c.language, "rtl": ads.is_rtl(c.language), "distance": b["viewing_distance"],
        "texts": texts,
        "colours": {**(con.get("colours") or {}), **{k: v for k, v in (o.get("colours") or {}).items() if v}},
        "palette": list(kit.palette or []) if kit is not None else [],
        "font_preset": o.get("font_preset") or b.get("font_preset") or con.get("font") or "bold",
        "logo": {"position": (o.get("logo") or {}).get("position") or "auto",
                 "variant": (o.get("logo") or {}).get("variant") or "auto"},
        "focus": dict(o.get("focus") or {"x": 0.5, "y": 0.5}),
        "print_safe": bool(o["print_safe"]) if o.get("print_safe") is not None else bool(b.get("print_safe")),
        "photo_id": pic.get("final"), "photo_preview_id": pic.get("base"),
        "art_id": art.get("final"), "art_preview_id": art.get("base"),
    }


def spec_hash(spec: dict) -> str:
    keep = {k: v for k, v in spec.items() if k not in ("photo_preview_id", "art_preview_id")}
    return hashlib.sha1(json.dumps(keep, sort_keys=True, default=str, ensure_ascii=False).encode()).hexdigest()[:16]


def _open(db: Session, gid: str | None, mode: str = "RGB") -> Image.Image | None:
    g = db.get(Generation, gid) if gid else None
    path = generation_file(g) if g is not None and g.status in ads.FINISHED else None
    if path is None or not path.is_file():
        return None
    with raster.big_images(), Image.open(path) as im:
        return ImageOps.exif_transpose(im).convert(mode)


def _art(db: Session, gid: str | None) -> Image.Image | None:
    g = db.get(Generation, gid) if gid else None
    path = generation_file(g) if g is not None and g.status in ads.FINISHED else None
    with raster.big_images():
        # made on plain white: Ad Studio's logo keying takes the white away and crops to the drawing
        return lay.prepare_logo(path) if path is not None else None


def _logo(db: Session, kit: BrandKit | None, spec: dict) -> Image.Image | None:
    if kit is None or (spec.get("logo") or {}).get("position") == "none":
        return None
    ws = kit.workspace_id
    a = lay.AdAssets(logo=br.media_file(db, ws, br.logo_ref(kit).get("media_id")),
                     logo_light=br.media_file(db, ws, br.logo_ref(kit, "light").get("media_id")),
                     logo_dark=br.media_file(db, ws, br.logo_ref(kit, "dark").get("media_id")))
    ground = pl.colours_of(spec)["ground"]
    logo, _ = lay._logo_pick(a, (spec.get("logo") or {}).get("variant") or "auto", lay.lum(ground))
    return logo


def assets_for(db: Session, spec: dict, kit: BrandKit | None, final: bool) -> pl.Assets:
    """The pictures: the upscaled ones for print, the originals (a megapixel, quick to open) for previews."""
    pid = spec.get("photo_id") if final else (spec.get("photo_preview_id") or spec.get("photo_id"))
    aid = spec.get("art_id") if final else (spec.get("art_preview_id") or spec.get("art_id"))
    return pl.Assets(photo=_open(db, pid), art=_art(db, aid), logo=_logo(db, kit, spec))


def brand_fonts(db: Session, kit: BrandKit | None) -> list[Path]:
    if kit is None:
        return []
    return [p for p in (br.media_file(db, kit.workspace_id, m) for m in kit.font_files or []) if p]


def scene_for(db: Session, spec: dict, kit: BrandKit | None, final: bool = False) -> tuple[pl.Scene, pl.Assets]:
    assets = assets_for(db, spec, kit, final)
    scene = pl.build({**spec, "brand_fonts": brand_fonts(db, kit)}, assets)
    return scene, assets


def preview_k(scene: pl.Scene) -> float:
    return min(scene.canvas.k, raster.k_for(scene, PREVIEW_LONG))


def render_preview(db: Session, spec: dict, kit: BrandKit | None) -> tuple[Image.Image, dict]:
    scene, assets = scene_for(db, spec, kit)
    return raster.render(scene, assets, preview_k(scene)), scene.report


def write_design(db: Session, c: AdCampaign, con: dict, rec: dict, kit: BrandKit | None) -> dict:
    """Render the option's preview and store it as the next version of its Library image (home "print")."""
    spec = spec_for(c, con, rec, kit)
    img, report = render_preview(db, spec, kit)
    item = db.get(MediaItem, rec.get("media_id") or "")
    if item is None or item.workspace_id != c.workspace_id:
        item = MediaItem(id=new_id(), workspace_id=c.workspace_id, kind="image", origin="generated",
                         title=f"{c.title or 'Print'} · option {con.get('n', 1)}"[:300],
                         tags=["print", "print-studio", spec["job"]], width=img.width, height=img.height, home=HOME)
        db.add(item)
        db.flush()
    folder, rel_folder = lib.media_dir(c.workspace_id)
    folder.mkdir(parents=True, exist_ok=True)
    g = Generation(id=new_id(), workspace_id=c.workspace_id, project_id=None, target_type="media",
                   target_id=item.id, kind="image", version=next_version(db, "media", item.id, "image"),
                   status="ready", prompt=(spec["texts"].get("name") or "Print design")[:2000], seed=0,
                   parent_id=item.generation_id, media_type="image/png", file_path=f"{rel_folder}/{new_id()}.png",
                   params={"print_job_id": c.id, "design_id": rec["id"], "concept_id": con["id"],
                           "width": img.width, "height": img.height, "size": [img.width, img.height],
                           "print_spec": spec, "created_by": {"user_id": c.created_by, "flow": "print_studio"}})
    img.save(get_settings().data_dir / g.file_path, "PNG", compress_level=6)
    db.add(g)
    db.flush()
    item.generation_id = g.id
    item.width, item.height = img.width, img.height
    lib.touch(item)
    from app import thumbs

    try:
        thumbs.for_generation(g)
    except Exception:  # made on first view anyway
        pass
    rec.update(media_id=item.id, generation_id=g.id, status="ready", error=None, dirty=False, report=report,
               hash=spec_hash(spec))
    ads.put_ad(c, rec)
    return rec


def render_concept(db: Session, c: AdCampaign, con: dict, kit: BrandKit | None, *, only_dirty: bool = True) -> int:
    have = designs_of(c, con["id"])
    rec = have[0] if have else new_design(con)
    if only_dirty and rec.get("status") == "ready" and not rec.get("dirty"):
        if rec.get("hash") == spec_hash(spec_for(c, con, rec, kit)):
            return 0
    write_design(db, c, con, rec, kit)
    return 1


def files_dir(c: AdCampaign, design_id: str) -> tuple[Path, str]:
    rel = Path("workspaces") / c.workspace_id / "print" / c.id / design_id
    return get_settings().data_dir / rel, rel.as_posix()


def file_stem(c: AdCampaign, con: dict) -> str:
    b = brief_of(c)
    name = b["lines"]["name"] or c.title or "print"
    safe = re.sub(r"[^a-z0-9]+", "-", name.lower().translate(str.maketrans("åäöéüæø", "aaoeuao"))).strip("-")[:40]
    return f"{safe or 'print'}-option-{con.get('n', 1)}-{sz.cm(float(b['width_cm']) * 10)}x" \
           f"{sz.cm(float(b['height_cm']) * 10)}cm".replace(".", "_")


def make_files(db: Session, c: AdCampaign, con: dict, rec: dict, kit: BrandKit | None) -> dict:
    """Every print file of one design at print size, each a generation of its own."""
    spec = spec_for(c, con, rec, kit)
    scene, assets = scene_for(db, spec, kit, final=True)
    preview = raster.render(scene, assets, preview_k(scene))
    folder, rel = files_dir(c, rec["id"])
    stem = file_stem(c, con)
    title = f"{brief_of(c)['lines']['name'] or c.title} · option {con.get('n', 1)}"
    res = ex.make_all(scene, assets, folder, stem, title, spec, preview)
    h = spec_hash(spec)
    files = {}
    for fmt, path in res["files"].items():
        g = Generation(id=new_id(), workspace_id=c.workspace_id, project_id=None, target_type=FILE_TARGET,
                       target_id=rec["id"], kind="print", version=next_version(db, FILE_TARGET, rec["id"], "print"),
                       status="ready", prompt=title[:2000], seed=0, media_type=ex.MEDIA[fmt],
                       file_path=f"{rel}/{path.name}",
                       params={"print_job_id": c.id, "design_id": rec["id"], "format": fmt, "hash": h,
                               "title": path.stem, "bytes": path.stat().st_size,
                               "created_by": {"user_id": c.created_by, "flow": "print_studio"}})
        db.add(g)
        files[fmt] = g.id
    db.flush()
    rec["files"] = {"hash": h, "ids": files, "timing": res["timing"], "made_at": utcnow().isoformat() + "Z"}
    ads.put_ad(c, rec)
    return rec


# ---------------------------------------------------------------- output

def _gen_short(db: Session, gid: str | None) -> dict | None:
    g = db.get(Generation, gid) if gid else None
    if g is None:
        return None
    o = gen_out(g)
    return {"id": g.id, "status": g.status, "media_url": o.media_url, "thumb_url": o.thumb_url}


def concept_out(db: Session, con: dict) -> dict:
    pics = {}
    for grp, rec in (con.get("photos") or {}).items():
        pics[grp] = {"base": _gen_short(db, rec.get("base")), "final": rec.get("final"),
                     "upscaled": bool(rec.get("upscale") and rec.get("final") == rec.get("upscale")),
                     "owner": bool(rec.get("owner")), "pick": rec.get("pick"), "note": rec.get("note")}
    return {**{k: con.get(k) for k in ("id", "n", "approved", "edited", "insight", "family", "layout", "decor",
                                       "hero", "headline", "cta", "font", "caps", "photo_prompt", "art_prompt",
                                       "error")},
            "offers": list(con.get("offers") or []), "colours": con.get("colours") or {},
            "guard": con.get("guard") or {}, "copy_check": list(con.get("copy_check") or []), "pictures": pics}


def files_out(c: AdCampaign, rec: dict, spec: dict | None, db: Session) -> dict:
    f = rec.get("files") or {}
    ids = f.get("ids") or {}
    fresh = bool(ids) and spec is not None and f.get("hash") == spec_hash(spec)
    out = {}
    for fmt in ex.FORMATS:
        g = db.get(Generation, ids.get(fmt) or "")
        if g is None:
            continue
        out[fmt] = {"url": f"/api/print/{c.id}/designs/{rec['id']}/files/{fmt}", "media_type": g.media_type,
                    "bytes": (g.params or {}).get("bytes"), "generation_id": g.id}
    return {"status": ("ready" if fresh else "stale") if out else "none", "files": out,
            "made_at": f.get("made_at"), "timing": f.get("timing")}


def design_out(db: Session, c: AdCampaign, rec: dict, con: dict | None, kit: BrandKit | None) -> dict:
    g = db.get(Generation, rec.get("generation_id") or "")
    o = gen_out(g) if g is not None else None
    spec = spec_for(c, con, rec, kit) if con else None
    return {"id": rec["id"], "concept_id": rec["concept_id"], "n": (con or {}).get("n"),
            "status": rec.get("status") or "pending", "error": rec.get("error"), "media_id": rec.get("media_id"),
            "generation_id": rec.get("generation_id"), "version": g.version if g is not None else None,
            "image_url": o.media_url if o else None, "thumb_url": o.thumb_url if o else None,
            "width": (g.params or {}).get("width") if g is not None else None,
            "height": (g.params or {}).get("height") if g is not None else None,
            "overrides": rec.get("overrides") or {}, "report": rec.get("report") or {}, "spec": spec,
            "files": files_out(c, rec, spec, db), "stale": bool(rec.get("dirty"))}


def size_out(b: dict) -> dict:
    cv = canvas_of(b)
    return {"width_cm": float(b["width_cm"]), "height_cm": float(b["height_cm"]), "dpi": cv.dpi,
            "bleed_mm": cv.bleed_mm, "shape": b.get("shape") or "rect", "px": list(cv.size_px),
            "trim_px": list(cv.trim_px), "mp": round(cv.megapixels, 1), "label": cv.label(),
            "family": shape_family(b), "min_cap_mm": sz.min_cap_mm(b["viewing_distance"])}


def campaign_out(db: Session, c: AdCampaign) -> dict:
    status, review = status_of(db, c)
    kit = ads.kit_of(db, c)
    cons = {x["id"]: x for x in c.concepts or []}
    job = db.get(Job, c.job_id) if c.job_id else None
    b = brief_of(c)
    brief = {k: b[k] for k in DEFAULTS}
    return {"id": c.id, "kind": KIND, "title": c.title, "language": c.language, "rtl": ads.is_rtl(c.language),
            "stage": c.stage, "status": status, "review": review,
            "stages": [{"key": k, "label": label, "status": stage(c, k).get("status", "pending"),
                        "detail": stage(c, k).get("detail")} for k, label in STAGES],
            "brief": brief, "size": size_out(b), "brand_kit": ads.kit_out(kit),
            "concepts": [concept_out(db, x) for x in c.concepts or []],
            "designs": [design_out(db, c, a, cons.get(a["concept_id"]), kit) for a in c.ads or []
                        if a["concept_id"] in cons],
            "job": job_out(job).model_dump(mode="json") if job is not None else None,
            "created_at": c.created_at, "updated_at": c.updated_at}


def summary_out(db: Session, c: AdCampaign) -> dict:
    status, review = status_of(db, c)
    first = next((a for a in c.ads or [] if a.get("generation_id")), None)
    g = db.get(Generation, first["generation_id"]) if first else None
    b = brief_of(c)
    return {"id": c.id, "title": c.title, "language": c.language, "status": status, "review": review,
            "job": b["job"], "size": size_out(b), "designs": sum(1 for a in c.ads or [] if a.get("status") == "ready"),
            "thumb_url": gen_out(g).thumb_url if g is not None else None, "updated_at": c.updated_at}


def touch(c: AdCampaign) -> None:
    c.updated_at = utcnow()


def ensure_print(c: AdCampaign) -> AdCampaign:
    if c.kind != KIND:
        raise HTTPException(404, "Print job not found")
    return c
