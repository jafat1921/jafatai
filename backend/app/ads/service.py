"""Ad Studio campaign records (contract v36): the brief, concepts, photos, ads, their layer specs, and the
shape the API hands back.

A concept's photos are ordinary image generations that belong to it (target_type "ad_photo", target_id the
concept's id), one per orientation the campaign needs: portrait (4:5 and 9:16 share it), square, wide. Each
finished advert is a Library image; every re-render is a new version of it. The campaign's layer specs are
also written to workspaces/<ws>/ads/<campaign id>/ad.json.
"""
import json
from pathlib import Path

from fastapi import HTTPException
from PIL import Image, ImageOps
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app import aerab
from app import brand as br
from app import library as lib
from app.ads import copy as cp
from app.ads import fonts as fz
from app.ads import footer as ft
from app.ads import layout as lay
from app.brand_schemas import social_key
from app.config import get_settings
from app.models import AdCampaign, BrandKit, Generation, Job, MediaItem, new_id, utcnow
from app.services import gen_out, generation_file, job_out, media_url, next_version

JOB = "ad_campaign"
STAGES = (("concepts", "Concepts"), ("photos", "Photos"), ("layout", "Layout"))
STAGE_KEYS = tuple(k for k, _ in STAGES)
LIVE = ("queued", "generating")
FINISHED = ("ready", "approved")
ATTEMPTS = 2
IMAGE_MODELS = ("zimage_turbo", "qwen_image_2512", "hidream_o1")
DEFAULT_MODEL = "zimage_turbo"
RTL_LANGS = ("he", "yi")  # plus every Arabic-script language aerab knows

GROUPS = {"4:5": "portrait", "9:16": "portrait", "2:3": "portrait", "1:1": "square", "16:9": "wide",
          "1.91:1": "wide", "yt": "wide"}
PHOTO_NEGATIVE = "text, letters, words, captions, watermark, logo, signage, label text, blurry, distorted"

DEFAULTS = {"subject": "", "description": "", "brief": "", "occasion": "", "market": "", "tone": "",
            "must_say": "", "offers": [], "formats": ["4:5"], "variants": 3, "image_model": DEFAULT_MODEL,
            "product_media_ids": [], "review": True, "logo_on_surface": True, "font_preset": None,
            "footer_items": None}

TEXT_KEYS = ("kicker", "headline", "body", "cta")
SPEC_TEXTS = ("kicker", "headline", "body", "offers", "cta", "badge_big", "badge_small")


class AdError(RuntimeError):
    pass


def brief_of(c: AdCampaign) -> dict:
    return {**DEFAULTS, **(c.brief or {})}


def is_rtl(language: str | None) -> bool:
    lang = (language or "").lower().split("-")[0]
    return lang in RTL_LANGS or aerab.resolve(language) in aerab.ARABIC_SCRIPT_LANGS


def wants_aerab(c: AdCampaign, text: str) -> bool:
    return get_settings().urdu_aerab and aerab.applies(c.language, text)


# ---------------------------------------------------------------- stages (the Poetry Short pattern)

def stage(c: AdCampaign, key: str) -> dict:
    return dict((c.stages or {}).get(key) or {"status": "pending"})


def put_stage(c: AdCampaign, key: str, rec: dict) -> None:
    c.stages = {**(c.stages or {}), key: rec}
    flag_modified(c, "stages")


def reset_from(c: AdCampaign, key: str) -> None:
    for k in STAGE_KEYS[STAGE_KEYS.index(key):]:
        rec = stage(c, k)
        rec.update(status="pending", detail=None)
        put_stage(c, k, rec)
    if c.stage not in STAGE_KEYS or STAGE_KEYS.index(c.stage) > STAGE_KEYS.index(key):
        c.stage = key


def done(c: AdCampaign, key: str) -> bool:
    return stage(c, key).get("status") in ("done", "skipped")


def busy(db: Session, c: AdCampaign) -> Job | None:
    j = db.get(Job, c.job_id) if c.job_id else None
    return j if j is not None and j.status in ("queued", "running") else None


def ensure_idle(db: Session, c: AdCampaign) -> None:
    if busy(db, c) is not None:
        raise HTTPException(409, "The campaign is working; wait for it, or cancel the job")


def queue(db: Session, c: AdCampaign) -> Job:
    ensure_idle(db, c)
    job = Job(workspace_id=c.workspace_id, type=JOB, message="Waiting for a worker · Ad campaign",
              payload={"ad_campaign_id": c.id})
    db.add(job)
    db.flush()
    c.job_id = job.id
    return job


# ---------------------------------------------------------------- concepts, ads

def concept(c: AdCampaign, concept_id: str) -> dict:
    found = next((x for x in c.concepts or [] if x["id"] == concept_id), None)
    if found is None:
        raise HTTPException(404, "Concept not found")
    return dict(found)


def put_concept(c: AdCampaign, rec: dict) -> None:
    c.concepts = [rec if x["id"] == rec["id"] else x for x in c.concepts or []]
    flag_modified(c, "concepts")


def ad(c: AdCampaign, ad_id: str) -> dict:
    found = next((x for x in c.ads or [] if x["id"] == ad_id), None)
    if found is None:
        raise HTTPException(404, "Ad not found")
    return dict(found)


def put_ad(c: AdCampaign, rec: dict) -> None:
    ads = list(c.ads or [])
    for i, x in enumerate(ads):
        if x["id"] == rec["id"]:
            ads[i] = rec
            break
    else:
        ads.append(rec)
    c.ads = ads
    flag_modified(c, "ads")


def ads_of(c: AdCampaign, concept_id: str) -> list[dict]:
    return [dict(a) for a in c.ads or [] if a["concept_id"] == concept_id]


def mark_dirty(c: AdCampaign, concept_id: str) -> None:
    for a in ads_of(c, concept_id):
        a["dirty"] = True
        put_ad(c, a)


def new_concept(n: int, data: dict, guard: dict) -> dict:
    return {"id": new_id(), "n": n, "approved": True, "edited": False, "copy_dirty": False,
            **{k: data.get(k) or "" for k in ("insight", "kicker", "headline", "body", "cta", "layout",
                                               "photo_prompt", "placement", "logo_surface")},
            "offers": list(data.get("offers") or []), "guard": guard, "photos": {}, "error": None}


def groups(formats: list[str]) -> list[str]:
    return list(dict.fromkeys(GROUPS[f] for f in formats if f in GROUPS))


def group_aspect(group: str, formats: list[str]) -> str:
    if group == "portrait":
        # a story crops its sides off a 9:16 picture less than a 4:5 crop loses off a 9:16 one
        return "9:16" if "9:16" in formats else "4:5"
    return {"square": "1:1", "wide": "16:9"}[group]


def photo_id(con: dict, group: str) -> str | None:
    """The concept's finished photo for a group: the logo-on-surface version when it came, else the plain one."""
    rec = (con.get("photos") or {}).get(group) or {}
    return rec.get("final") or None


# ---------------------------------------------------------------- the layer spec

def default_preset(kit: BrandKit | None) -> str:
    return fz.BRAND if kit is not None and kit.font_files else fz.DEFAULT_PRESET


def texts_of(con: dict) -> dict:
    big, small = cp.badge_from(con.get("offers") or [])
    return {**{k: con.get(k) or "" for k in TEXT_KEYS}, "offers": list(con.get("offers") or []),
            "badge_big": big, "badge_small": small}


def footer_choice(b: dict, o: dict, kit: BrandKit | None) -> tuple[dict, list[dict]]:
    """(contact, socials) the footer shows: the ad's own pick, else the campaign's, else the defaults (the
    digital ones: website, booking link, phone and WhatsApp, and the socials flagged for ads)."""
    pick = {**(b.get("footer_items") or {}), **(o.get("footer_items") or {})}
    have, socials = br.contact_of(kit), br.socials_of(kit)
    keys = pick.get("contact")
    keys = ft.DEFAULT_CONTACT if keys is None else keys
    contact = {k: have[k] for k in ft.CONTACT_KEYS if k in keys and have.get(k)}
    sk = pick.get("socials")
    chosen = [x for x in socials if (social_key(x) in sk if sk is not None else x.get("show_in_ads", True))]
    return contact, chosen


def spec_for(c: AdCampaign, con: dict, rec: dict, kit: BrandKit | None) -> dict:
    """The effective layer spec: concept copy and kit defaults, with the ad's own edits on top."""
    o = rec.get("overrides") or {}
    b = brief_of(c)
    contact, socials = footer_choice(b, o, kit)
    follow = {"show": rec["format"] == "9:16", "text": "", **(o.get("follow") or {})}
    style = o.get("style") or con.get("layout") or "frosted"
    logo_default = "tc" if style == "minimal" else "tl"
    return {
        "format": rec["format"], "style": style if style in lay.STYLES else "frosted",
        "font_preset": o.get("font_preset") or b.get("font_preset") or default_preset(kit),
        "language": c.language, "rtl": is_rtl(c.language),
        "texts": {**texts_of(con), **{k: v for k, v in (o.get("texts") or {}).items() if k in SPEC_TEXTS}},
        "colours": dict(o.get("colours") or {}),
        "palette": list(kit.palette or []) if kit is not None else [],
        "logo": {"position": (o.get("logo") or {}).get("position") or logo_default,
                 "variant": (o.get("logo") or {}).get("variant") or "auto"},
        # a thumbnail has no footer unless asked for: it's a picture to click, not an advert to call from
        "footer": bool(o["footer"]) if "footer" in o else bool(contact or socials) and rec["format"] != "yt",
        "contact": contact,
        "socials": socials,
        "follow": follow,
        "footer_items": {"contact": list(contact), "socials": [social_key(x) for x in socials]},
        "focus": dict(o.get("focus") or {"x": 0.5, "y": 0.5}),
        "photo_id": photo_id(con, GROUPS[rec["format"]]),
    }


def _open(path: Path | None) -> Image.Image | None:
    if path is None or not path.is_file():
        return None
    with Image.open(path) as im:
        return ImageOps.exif_transpose(im).convert("RGB")


def assets_for(db: Session, kit: BrandKit | None, photo_gen_id: str | None) -> lay.AdAssets:
    g = db.get(Generation, photo_gen_id) if photo_gen_id else None
    photo = _open(generation_file(g)) if g is not None and g.status in FINISHED else None
    if kit is None:
        return lay.AdAssets(photo=photo)
    ws = kit.workspace_id
    return lay.AdAssets(photo=photo, logo=br.media_file(db, ws, br.logo_ref(kit).get("media_id")),
                        logo_light=br.media_file(db, ws, br.logo_ref(kit, "light").get("media_id")),
                        logo_dark=br.media_file(db, ws, br.logo_ref(kit, "dark").get("media_id")),
                        brand_fonts=[p for p in (br.media_file(db, ws, m) for m in kit.font_files or []) if p])


def kit_of(db: Session, c: AdCampaign) -> BrandKit | None:
    k = db.get(BrandKit, c.brand_kit_id) if c.brand_kit_id else None
    return k if k is not None and k.workspace_id == c.workspace_id else None


def render_spec(db: Session, c: AdCampaign, spec: dict, kit: BrandKit | None):
    return lay.render(spec, assets_for(db, kit, spec.get("photo_id")))


def write_ad(db: Session, c: AdCampaign, con: dict, rec: dict, kit: BrandKit | None) -> dict:
    """Render one ad from its spec and store it as the next version of its Library image."""
    spec = spec_for(c, con, rec, kit)
    img, report = render_spec(db, c, spec, kit)
    item = db.get(MediaItem, rec.get("media_id") or "")
    if item is None or item.workspace_id != c.workspace_id:
        title = f"{c.title or 'Ad'} · {lay.FORMAT_LABELS[rec['format']]}"
        item = MediaItem(id=new_id(), workspace_id=c.workspace_id, kind="image", origin="generated",
                         title=title[:300], tags=["ad", "ad-studio", rec["format"]], width=img.width,
                         height=img.height)
        db.add(item)
        db.flush()
    folder, rel_folder = lib.media_dir(c.workspace_id)
    folder.mkdir(parents=True, exist_ok=True)
    g = Generation(id=new_id(), workspace_id=c.workspace_id, project_id=None, target_type="media",
                   target_id=item.id, kind="image", version=next_version(db, "media", item.id, "image"),
                   status="ready", prompt=" ".join((spec["texts"].get("headline") or "").split())[:2000] or "Ad",
                   seed=0, parent_id=item.generation_id, media_type="image/png",
                   file_path=f"{rel_folder}/{new_id()}.png",
                   params={"ad_campaign_id": c.id, "ad_id": rec["id"], "concept_id": con["id"], "format": rec["format"],
                           "width": img.width, "height": img.height, "size": [img.width, img.height],
                           "ad_spec": spec, "photo_id": spec.get("photo_id"),
                           "created_by": {"user_id": c.created_by, "flow": "ad_studio"}})
    img.save(get_settings().data_dir / g.file_path, "PNG", optimize=False, compress_level=6)
    db.add(g)
    db.flush()
    item.generation_id = g.id
    item.width, item.height = img.width, img.height
    lib.touch(item)
    from app import thumbs

    try:
        thumbs.for_generation(g)
    except Exception:  # a missing thumb is made on first view anyway
        pass
    slim = {k: report.get(k) for k in ("contrast", "treatment", "fonts", "fit", "logo", "footer", "footer_dropped")}
    rec.update(media_id=item.id, generation_id=g.id, status="ready", error=None, dirty=False,
               photo_id=spec.get("photo_id"), report=slim)
    put_ad(c, rec)
    return rec


def new_ad(con: dict, fmt: str) -> dict:
    return {"id": new_id(), "concept_id": con["id"], "format": fmt, "media_id": None, "generation_id": None,
            "overrides": {}, "status": "pending", "error": None, "dirty": True, "photo_id": None, "report": {}}


def render_concept(db: Session, c: AdCampaign, con: dict, kit: BrandKit | None, *, only_dirty: bool = True) -> int:
    """Every format of one concept that needs it, on the CPU. Returns how many were made."""
    made = 0
    have = {a["format"]: a for a in ads_of(c, con["id"])}
    for fmt in brief_of(c)["formats"]:
        rec = have.get(fmt) or new_ad(con, fmt)
        pid = photo_id(con, GROUPS[fmt])
        if only_dirty and rec.get("status") == "ready" and not rec.get("dirty") and rec.get("photo_id") == pid:
            continue
        if pid is None:
            rec.update(status="failed", error=con.get("error") or "No photo for this format")
            put_ad(c, rec)
            continue
        write_ad(db, c, con, rec, kit)
        made += 1
    return made


# ---------------------------------------------------------------- files

def files_dir(c: AdCampaign) -> tuple[Path, str]:
    rel = Path("workspaces") / c.workspace_id / "ads" / c.id
    return get_settings().data_dir / rel, rel.as_posix()


def ad_json(db: Session, c: AdCampaign) -> dict:
    kit = kit_of(db, c)
    cons = {x["id"]: x for x in c.concepts or []}
    return {"campaign_id": c.id, "title": c.title, "language": c.language, "brand_kit_id": c.brand_kit_id,
            "ads": [{"id": a["id"], "concept_id": a["concept_id"], "format": a["format"], "media_id": a.get("media_id"),
                     "generation_id": a.get("generation_id"), "overrides": a.get("overrides") or {},
                     "spec": spec_for(c, cons[a["concept_id"]], a, kit)}
                    for a in c.ads or [] if a["concept_id"] in cons]}


def write_ad_json(db: Session, c: AdCampaign) -> None:
    folder, _ = files_dir(c)
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "ad.json").write_text(json.dumps(ad_json(db, c), ensure_ascii=False, indent=2), encoding="utf-8")


# ---------------------------------------------------------------- output

def _gen(db: Session, gid: str | None) -> dict | None:
    g = db.get(Generation, gid) if gid else None
    if g is None:
        return None
    o = gen_out(g)
    return {"id": g.id, "status": g.status, "media_url": o.media_url, "thumb_url": o.thumb_url,
            "version": g.version}


def status_of(db: Session, c: AdCampaign) -> tuple[str, str | None]:
    if busy(db, c) is not None:
        return "running", None
    for k in STAGE_KEYS:
        if stage(c, k).get("status") == "review":
            return "review", k
    if any(stage(c, k).get("status") == "failed" for k in STAGE_KEYS):
        return "failed", None
    return ("done" if done(c, "layout") else "idle"), None


def missing_contact(kit: BrandKit | None) -> list[str]:
    """What a digital ad usually wants and the kit hasn't got: a link and somewhere to follow."""
    if kit is None:
        return []
    have = br.contact_of(kit)
    out = [] if have.get("website") or have.get("booking_url") else ["website"]
    return out + ([] if br.socials_of(kit) else ["socials"])


def kit_out(kit: BrandKit | None) -> dict | None:
    if kit is None:
        return None
    return {"id": kit.id, "name": kit.name, "palette": list(kit.palette or []), "contact": br.contact_of(kit),
            "socials": br.socials_of(kit),
            "claims": list(kit.claims or []), "has_fonts": bool(kit.font_files),
            "has_logo": bool((kit.logos or {}).get("primary") or (kit.logos or {}).get("light")),
            "missing_contact": missing_contact(kit)}


def concept_out(db: Session, con: dict) -> dict:
    photos = {}
    for grp, rec in (con.get("photos") or {}).items():
        photos[grp] = {"base": _gen(db, rec.get("base")), "logo": _gen(db, rec.get("logo")),
                       "final": rec.get("final"), "note": rec.get("note")}
    return {**{k: con.get(k) for k in ("id", "n", "approved", "edited", "insight", "kicker", "headline", "body", "cta",
                                       "layout", "photo_prompt", "placement", "logo_surface", "error")},
            "offers": list(con.get("offers") or []), "guard": con.get("guard") or {}, "photos": photos}


def ad_out(db: Session, c: AdCampaign, rec: dict, con: dict | None, kit: BrandKit | None) -> dict:
    g = db.get(Generation, rec.get("generation_id") or "")
    o = gen_out(g) if g is not None else None
    return {"id": rec["id"], "concept_id": rec["concept_id"], "format": rec["format"],
            "status": rec.get("status") or "pending", "error": rec.get("error"), "media_id": rec.get("media_id"),
            "generation_id": rec.get("generation_id"), "version": g.version if g is not None else None,
            "image_url": o.media_url if o else None, "thumb_url": o.thumb_url if o else None,
            "width": lay.FORMATS[rec["format"]][0], "height": lay.FORMATS[rec["format"]][1],
            "overrides": rec.get("overrides") or {}, "report": rec.get("report") or {},
            "spec": spec_for(c, con, rec, kit) if con else None, "stale": bool(rec.get("dirty"))}


def campaign_out(db: Session, c: AdCampaign) -> dict:
    status, review = status_of(db, c)
    kit = kit_of(db, c)
    cons = {x["id"]: x for x in c.concepts or []}
    job = db.get(Job, c.job_id) if c.job_id else None
    _, rel = files_dir(c)
    has_json = (files_dir(c)[0] / "ad.json").is_file()
    return {
        "id": c.id, "title": c.title, "language": c.language, "rtl": is_rtl(c.language), "stage": c.stage,
        "status": status, "review": review,
        "stages": [{"key": k, "label": label, "status": stage(c, k).get("status", "pending"),
                    "detail": stage(c, k).get("detail")} for k, label in STAGES],
        "brief": brief_of(c), "brand_kit": kit_out(kit),
        "concepts": [concept_out(db, x) for x in c.concepts or []],
        "ads": [ad_out(db, c, a, cons.get(a["concept_id"]), kit) for a in c.ads or []],
        "ad_json_url": media_url(f"{rel}/ad.json") if has_json else None,
        "zip_url": f"/api/ads/{c.id}/zip" if any(a.get("generation_id") for a in c.ads or []) else None,
        "job": job_out(job).model_dump(mode="json") if job is not None else None,
        "created_at": c.created_at, "updated_at": c.updated_at,
    }


def summary_out(db: Session, c: AdCampaign) -> dict:
    status, review = status_of(db, c)
    first = next((a for a in c.ads or [] if a.get("generation_id")), None)
    g = db.get(Generation, first["generation_id"]) if first else None
    b = brief_of(c)
    return {"id": c.id, "title": c.title, "language": c.language, "status": status, "review": review,
            "formats": b["formats"], "concepts": len(c.concepts or []),
            "ads": sum(1 for a in c.ads or [] if a.get("status") == "ready"),
            "thumb_url": gen_out(g).thumb_url if g is not None else None, "updated_at": c.updated_at}


# ---------------------------------------------------------------- making one

def create(db: Session, cur, body: dict, kit: BrandKit | None) -> AdCampaign:
    b = {k: body[k] for k in DEFAULTS if k in body and body[k] is not None}
    b["formats"] = [f for f in dict.fromkeys(b.get("formats") or ["4:5"]) if f in lay.FORMATS] or ["4:5"]
    title = (body.get("title") or "").strip() or lib.short_title(body.get("subject") or "Ad campaign", 6)
    c = AdCampaign(id=new_id(), workspace_id=cur.workspace_id, title=title[:200],
                   brand_kit_id=kit.id if kit is not None else None,
                   language=(body.get("language") or "en").lower(), stage="concepts", stages={}, brief=b,
                   concepts=[], ads=[], created_by=cur.id)
    db.add(c)
    db.flush()
    return c


def touch(c: AdCampaign) -> None:
    c.updated_at = utcnow()
