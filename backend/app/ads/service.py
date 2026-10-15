"""Ad Studio campaign records (contract v36): the brief, concepts, photos, ads, their layer specs, and the
shape the API hands back.

A concept's photos are ordinary image generations that belong to it (target_type "ad_photo", target_id the
concept's id), one per orientation the campaign needs: portrait (4:5 and 9:16 share it), square, wide. Each
finished advert is a Library image; every re-render is a new version of it. The campaign's layer specs are
also written to workspaces/<ws>/ads/<campaign id>/ad.json.
"""
import asyncio
import json
import logging
import re
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
from app.llm import LLMError
from app.llm.client import list_models
from app.models import AdCampaign, BrandKit, Generation, Job, MediaItem, new_id, utcnow
from app.services import gen_out, generation_file, job_out, media_url, next_version

log = logging.getLogger("mixai.ads")

JOB = "ad_campaign"
STAGES = (("concepts", "Concepts"), ("photos", "Photos"), ("layout", "Layout"))
STAGE_KEYS = tuple(k for k, _ in STAGES)
LIVE = ("queued", "generating")
FINISHED = ("ready", "approved")
ATTEMPTS = 2
IMAGE_MODELS = ("zimage_turbo", "qwen_image_2512", "hidream_o1")
DEFAULT_MODEL = "zimage_turbo"
# the brief's default: each concept picks one of the photoreal engines (prompts.AD_PHOTO_MODELS) itself
AUTO_MODEL = "auto"
RTL_LANGS = ("he", "yi")  # plus every Arabic-script language aerab knows

GROUPS = {"4:5": "portrait", "9:16": "portrait", "2:3": "portrait", "1:1": "square", "16:9": "wide",
          "1.91:1": "wide", "yt": "wide"}
PHOTO_NEGATIVE = ("text, letters, words, numbers, captions, watermark, logo, signage, label text, name badge, "
                  "colour swatches, hex codes, blurry, distorted")

DEFAULTS = {"subject": "", "description": "", "brief": "", "occasion": "", "market": "", "tone": "",
            "must_say": "", "offers": [], "formats": ["4:5"], "variants": 3, "image_model": AUTO_MODEL,
            "product_media_ids": [], "review": True, "logo_on_surface": True, "font_preset": None,
            "footer_items": None, "quality": "final", "candidates": 3, "quotes": [], "use_style": True}
QUALITIES = ("draft", "final")

TEXT_KEYS = ("kicker", "headline", "body", "cta")
SPEC_TEXTS = ("kicker", "headline", "body", "offers", "cta", "badge_big", "badge_small", "highlight", "quote",
              "quote_by")


class AdError(RuntimeError):
    pass


def _size_b(name: str) -> float:
    """Parameters in billions from an Ollama tag: gemma4:26b -> 26, qwen2.5:14b-instruct -> 14, gemma4:e4b -> 4
    (the "e" is gemma's effective size). 0 when the tag doesn't say."""
    tag = name.split(":", 1)[1] if ":" in name else name
    m = re.search(r"(?<![\d.])e?(\d+(?:\.\d+)?)b(?![a-z])", tag.lower())
    return float(m.group(1)) if m else 0.0


def _bare_tag(name: str) -> str:
    return name.strip().lower().removesuffix(":latest")


def pick_writer(candidates: list[str], installed: list[str]) -> str | None:
    """The largest candidate that is installed; the list order breaks a tie."""
    have = {_bare_tag(n) for n in installed}
    ok = [(i, c) for i, c in enumerate(candidates) if c and _bare_tag(c) in have]
    if not ok:
        return None
    return min(ok, key=lambda t: (-_size_b(t[1]), t[0]))[1]


def writer_model() -> str | None:
    """The copywriter's model: ADS_LLM_MODEL when set, else the largest installed of ADS_LLM_MODELS (plus the
    creative model). None leaves it to the creative role, e.g. when the server can't be asked."""
    s = get_settings()
    if s.ads_llm_model.strip():
        return s.ads_llm_model.strip()
    candidates = list(dict.fromkeys([*s.ads_llm_models, s.llm_model_creative]))
    try:
        installed = asyncio.run(list_models())
    except LLMError as e:
        log.info("couldn't list the LLM models (%s); the creative model writes the ads", e)
        return None
    return pick_writer(candidates, installed)


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
                                               "photo_prompt", "photo_model", "placement", "logo_surface",
                                               "key_word")},
            "offers": list(data.get("offers") or []), "guard": guard, "copy_check": list(data.get("copy_check") or []),
            "headline_options": list(data.get("headline_options") or []), "quote": data.get("quote"),
            "photos": {}, "error": None}


def style_rules(kit: BrandKit | None) -> dict | None:
    st = (kit.ad_style or {}) if kit is not None else {}
    return st.get("rules") if st.get("status") == "ready" else None


def campaign_rules(c: AdCampaign, kit: BrandKit | None) -> dict | None:
    return style_rules(kit) if brief_of(c).get("use_style", True) else None


def layouts_for(b: dict, rules: dict | None) -> tuple[list[str], bool]:
    """(the layouts this brief can fill, best first; whether the brand's own ads pin them)."""
    has_number = any(lay.split_price(o)[1] for o in b.get("offers") or [])
    allowed = [x for x in lay.STYLES if not (
        (lay.STYLE_NEEDS.get(x) == "offer_number" and not has_number) or (x == "quote" and not b.get("quotes")))]
    if rules and rules.get("layouts"):
        pref = [x for x in rules["layouts"] if x in allowed]
        if pref and rules.get("pinned"):
            return pref, True
        allowed = pref + [x for x in allowed if x not in pref]
    return allowed, False


def spread(rows: list[dict], allowed: list[str], pinned: bool) -> None:
    """Concepts spread across layouts: a repeat (or a layout the brief can't fill) moves to the next unused
    one. A before/after is only ever the writer's own choice."""
    pool = [x for x in allowed if x != "before_after"] or list(allowed)
    used: list[str] = []
    for r in rows:
        want = r.get("layout")
        if want not in allowed or (want in used and len(used) < len(pool)):
            want = next((x for x in pool if x not in used), pool[len(used) % len(pool)])
        r["layout"] = want
        used.append(want)


def concept_seed(con: dict) -> int:
    return sum(ord(ch) * (i + 1) for i, ch in enumerate(con.get("id") or "")) % 10000


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


def photo_rec(con: dict, group: str) -> dict:
    return dict((con.get("photos") or {}).get(group) or {})


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


def quote_of(b: dict, con: dict) -> dict:
    """The client's own quote this concept uses, word for word; nothing when it has none."""
    quotes = [q for q in b.get("quotes") or [] if (q.get("text") or "").strip()]
    i = con.get("quote")
    if not quotes:
        return {}
    q = quotes[i - 1] if isinstance(i, int) and 1 <= i <= len(quotes) else quotes[0]
    return {"quote": q["text"].strip(), "quote_by": (q.get("by") or "").strip()}


def preset_for(b: dict, o: dict, kit: BrandKit | None, style: str, rules: dict | None) -> str:
    if o.get("font_preset") or b.get("font_preset"):
        return o.get("font_preset") or b.get("font_preset")
    if kit is not None and kit.font_files:
        return fz.BRAND
    if rules and rules.get("serif") and style not in lay.LAYOUT_FONTS:
        return "elegant"
    return lay.LAYOUT_FONTS.get(style, fz.DEFAULT_PRESET)


def spec_for(c: AdCampaign, con: dict, rec: dict, kit: BrandKit | None) -> dict:
    """The effective layer spec: concept copy and kit defaults, with the ad's own edits on top."""
    o = rec.get("overrides") or {}
    b = brief_of(c)
    contact, socials = footer_choice(b, o, kit)
    follow = {"show": rec["format"] == "9:16", "text": "", **(o.get("follow") or {})}
    auto = rec.get("auto") or {}
    style = o.get("style") or auto.get("style") or con.get("layout") or "frosted"
    style = style if style in lay.STYLES else "frosted"
    rules = campaign_rules(c, kit)
    group = GROUPS[rec["format"]]
    prec = photo_rec(con, group)
    shape_o = o.get("shape") or {}
    mask = shape_o.get("mask") or ((rules or {}).get("mask") if style == "arch_mask" else None)
    placement = {"flip": (o.get("placement") or {}).get("flip", auto.get("flip"))}
    texts = {**texts_of(con), "highlight": con.get("key_word") or "", **quote_of(b, con)}
    return {
        "format": rec["format"], "style": style,
        "font_preset": preset_for(b, o, kit, style, rules),
        "language": c.language, "rtl": is_rtl(c.language),
        "texts": {**texts, **{k: v for k, v in (o.get("texts") or {}).items() if k in SPEC_TEXTS}},
        "shape": {"mask": mask, "colour": shape_o.get("colour") or None,
                  "seed": int(shape_o["seed"]) if shape_o.get("seed") is not None else concept_seed(con)},
        "placement": placement,
        "subject": prec.get("subject"),
        "style_ref": {k: rules.get(k) for k in ("headline_weight", "headline_case", "density", "serif", "mask")}
        if rules else None,
        "assets": {"cutout": bool(prec.get("mask")), "before": bool(prec.get("before_final"))},
        "mask_file": prec.get("mask"), "before_id": prec.get("before_final"),
        "colours": dict(o.get("colours") or {}),
        "palette": list(kit.palette or []) if kit is not None else [],
        "logo": {"position": (o.get("logo") or {}).get("position") or lay.LOGO_DEFAULT.get(style, "tl"),
                 "variant": (o.get("logo") or {}).get("variant") or "auto"},
        # a thumbnail has no footer unless asked for: it's a picture to click, not an advert to call from
        "footer": bool(o["footer"]) if "footer" in o else bool(contact or socials) and rec["format"] != "yt",
        "contact": contact,
        "socials": socials,
        "follow": follow,
        "footer_items": {"contact": list(contact), "socials": [social_key(x) for x in socials]},
        # auto: the layout engine places the subject; a focus the user dragged is kept as it is
        "focus": dict(o.get("focus") or {"x": 0.5, "y": 0.5, "auto": True}),
        "photo_id": photo_id(con, GROUPS[rec["format"]]),
    }


def _open(path: Path | None) -> Image.Image | None:
    if path is None or not path.is_file():
        return None
    with Image.open(path) as im:
        return ImageOps.exif_transpose(im).convert("RGB")


def _mask(rel: str | None) -> Image.Image | None:
    path = get_settings().data_dir / rel if rel else None
    if path is None or not path.is_file():
        return None
    with Image.open(path) as im:
        return im.convert("L")


def assets_for(db: Session, kit: BrandKit | None, photo_gen_id: str | None, mask_file: str | None = None,
               before_id: str | None = None) -> lay.AdAssets:
    g = db.get(Generation, photo_gen_id) if photo_gen_id else None
    photo = _open(generation_file(g)) if g is not None and g.status in FINISHED else None
    bg = db.get(Generation, before_id) if before_id else None
    before = _open(generation_file(bg)) if bg is not None and bg.status in FINISHED else None
    mask = _mask(mask_file) if photo is not None else None
    if kit is None:
        return lay.AdAssets(photo=photo, mask=mask, before=before)
    ws = kit.workspace_id
    return lay.AdAssets(photo=photo, mask=mask, before=before,
                        logo=br.media_file(db, ws, br.logo_ref(kit).get("media_id")),
                        logo_light=br.media_file(db, ws, br.logo_ref(kit, "light").get("media_id")),
                        logo_dark=br.media_file(db, ws, br.logo_ref(kit, "dark").get("media_id")),
                        brand_fonts=[p for p in (br.media_file(db, ws, m) for m in kit.font_files or []) if p])


def kit_of(db: Session, c: AdCampaign) -> BrandKit | None:
    k = db.get(BrandKit, c.brand_kit_id) if c.brand_kit_id else None
    return k if k is not None and k.workspace_id == c.workspace_id else None


def render_spec(db: Session, c: AdCampaign, spec: dict, kit: BrandKit | None):
    return lay.render(spec, assets_for(db, kit, spec.get("photo_id"), spec.get("mask_file"), spec.get("before_id")))


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
    slim = {k: report.get(k) for k in ("contrast", "treatment", "fonts", "fit", "logo", "footer", "footer_dropped",
                                       "buttons", "placement", "highlight", "fallback", "layout", "price", "shape")}
    slim["quality"] = quality_of(report, con)
    if rec.get("qa"):
        slim["quality"]["qa"] = rec["qa"]
    rec.update(media_id=item.id, generation_id=g.id, status="ready", error=None, dirty=False,
               photo_id=spec.get("photo_id"), report=slim)
    put_ad(c, rec)
    return rec


def quality_of(report: dict, con: dict) -> dict:
    """The art director's checklist for one ad: every contrast check against its WCAG target, everything the
    guard, the fitter or the footer had to leave out, and what the copy self-check said."""
    def check(r: float, need: float) -> dict:
        # the ratios are rounded to two places, so 4.499 shows as 4.5 and passes
        return {"ratio": r, "need": need, "pass": r >= need - 0.005}

    contrast = {role: check(r, lay.NEED.get(role, lay.AA_TEXT))
                for role, r in (report.get("contrast") or {}).items() if isinstance(r, (int, float))}
    logo = report.get("logo") or {}
    if logo.get("contrast") is not None:
        contrast["logo"] = check(logo["contrast"], lay.AA_LARGE)
    g = con.get("guard") or {}
    dropped = {"offers": list(g.get("offers_dropped") or []), "numbers": list(g.get("numbers_removed") or []),
               "channels": list(g.get("channels_removed") or []),
               "copy_trimmed": list((report.get("fit") or {}).get("trimmed") or []),
               "footer": list((report.get("footer") or {}).get("dropped") or [])}
    notes = [n for n in con.get("copy_check") or [] if isinstance(n, dict)]
    return {"contrast": contrast, "all_pass": all(v["pass"] for v in contrast.values()),
            "dropped": {k: v for k, v in dropped.items() if v}, "copy_check": notes,
            "treatment": list(report.get("treatment") or [])}


def render_report(db: Session, c: AdCampaign, con: dict, rec: dict, kit: BrandKit | None):
    """(image, the report write_ad would store) without saving anything: the QA pass tries layouts with it."""
    img, report = render_spec(db, c, spec_for(c, con, rec, kit), kit)
    report["quality"] = quality_of(report, con)
    return img, report


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


def kit_out(kit: BrandKit | None, use_style: bool = True) -> dict | None:
    if kit is None:
        return None
    return {"id": kit.id, "name": kit.name, "palette": list(kit.palette or []), "contact": br.contact_of(kit),
            "socials": br.socials_of(kit),
            "claims": list(kit.claims or []), "has_fonts": bool(kit.font_files),
            "has_logo": bool((kit.logos or {}).get("primary") or (kit.logos or {}).get("light")),
            "missing_contact": missing_contact(kit), "ad_style": style_out(kit, use_style)}


def style_out(kit: BrandKit | None, use_style: bool = True) -> dict:
    from app.ads import vision as eye

    rules = style_rules(kit)
    return {"active": bool(rules and use_style), "has_rules": bool(rules),
            "layouts": list((rules or {}).get("layouts") or []), "summary": eye.summary(rules)}


def concept_out(db: Session, con: dict) -> dict:
    photos = {}
    for grp, rec in (con.get("photos") or {}).items():
        scores = rec.get("scores") or {}
        cands = []
        for gid in rec.get("candidates") or []:
            g = _gen(db, gid)
            if g is not None:
                sc = scores.get(gid) or {}
                cands.append({**g, "score": sc.get("score"), "issues": sc.get("issues") or [],
                              "picked": gid == rec.get("base")})
        photos[grp] = {"base": _gen(db, rec.get("base")), "logo": _gen(db, rec.get("logo")),
                       "final": rec.get("final"), "note": rec.get("note"), "candidates": cands,
                       "pick": rec.get("pick"), "before": _gen(db, rec.get("before_final")),
                       "upscaled": bool(rec.get("upscale") and rec.get("final") == rec.get("upscale")),
                       "cutout": bool(rec.get("mask")), "subject": rec.get("subject")}
    return {**{k: con.get(k) for k in ("id", "n", "approved", "edited", "insight", "kicker", "headline", "body", "cta",
                                       "layout", "photo_prompt", "photo_model", "placement", "logo_surface", "error")},
            "key_word": con.get("key_word") or "", "headline_options": list(con.get("headline_options") or []),
            "quote": con.get("quote"),
            "offers": list(con.get("offers") or []), "guard": con.get("guard") or {},
            "copy_check": list(con.get("copy_check") or []), "photos": photos}


def ad_out(db: Session, c: AdCampaign, rec: dict, con: dict | None, kit: BrandKit | None) -> dict:
    g = db.get(Generation, rec.get("generation_id") or "")
    o = gen_out(g) if g is not None else None
    return {"id": rec["id"], "concept_id": rec["concept_id"], "format": rec["format"],
            "status": rec.get("status") or "pending", "error": rec.get("error"), "media_id": rec.get("media_id"),
            "generation_id": rec.get("generation_id"), "version": g.version if g is not None else None,
            "auto": rec.get("auto") or {},
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
        "brief": brief_of(c), "brand_kit": kit_out(kit, brief_of(c).get("use_style", True)),
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
