"""Brand templates (contract v35): prompt-template cards that put the workspace's own logo on things.

A card names the kit assets it needs (`brand_refs`: "logo", optionally "product"); they ride along as extra
reference pictures after the user's photo, so the edit model sees picture 1 = the photo or scene, picture 2 =
the logo, picture 3 = the product. The kit's name, colours and tagline are written into the wording through
{tokens}, filled here at submit time, never by the browser.

"Make the scene for me" is a two-step chain on one Library item: v1 is the scene (a deliberately blank
surface), and when it lands on_job_finished queues v2, the logo edit, with the scene as picture 1.
"""
import logging
import re
from dataclasses import dataclass

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app import brand
from app.models import BrandKit, Generation, Job, MediaItem
from app.services import enqueue_generation

log = logging.getLogger("mixai.brand_templates")

TARGET = "image-brand"
SURFACES = ("light", "dark")
TOKEN = re.compile(r"\{([a-z_]{2,30})\}")
NO_KIT = "No brand kit yet. Make one in Brand Kits and add your logo, then come back to this card."
PICK_KIT = "There are several brand kits and none is the default; pick one."
DARK_LUM = 0.18  # below this a palette colour reads as the dark ink, above it as an accent


def is_brand(t: dict | None) -> bool:
    return bool(t) and t.get("target") == TARGET


# ---------------------------------------------------------------- the kit

def pick_kit(db: Session, workspace_id: str, kit_id: str | None) -> BrandKit:
    """The kit asked for, else the default, else the only one. 409 with a clear message when there is none."""
    if kit_id:
        kit = brand.get_kit(db, workspace_id, kit_id)
        if kit is None:
            raise HTTPException(404, "Brand kit not found")
        return kit
    kits = list(db.scalars(select(BrandKit).where(BrandKit.workspace_id == workspace_id)))
    if not kits:
        raise HTTPException(409, NO_KIT)
    default = next((k for k in kits if k.is_default), None)
    if default is not None:
        return default
    if len(kits) == 1:
        return kits[0]
    raise HTTPException(409, PICK_KIT)


@dataclass
class LogoPick:
    variant: str
    generation_id: str
    # True when the logo is drawn for the other kind of background, so the wording has to re-ink it
    recolour: bool


def pick_logo(db: Session, kit: BrandKit, surface: str) -> LogoPick:
    # light = made for dark backgrounds (contract v7), dark = for light ones
    order = ("light", "primary", "dark") if surface == "dark" else ("dark", "primary", "light")
    for v in order:
        g = brand.media_generation(db, kit.workspace_id, brand.logo_ref(kit, v).get("media_id"))
        if g is not None and (g.media_type or "").startswith("image/"):
            return LogoPick(v, g.id, recolour=surface == "dark" and v != "light")
    raise HTTPException(409, f"“{kit.name}” has no logo yet. Add one in Brand Kits, then come back to this card.")


def pick_product(db: Session, kit: BrandKit, product_id: str | None, wanted: bool) -> tuple[dict, str] | None:
    if not product_id:
        return None
    if not wanted:
        raise HTTPException(422, "This card doesn't use a product picture")
    prod = next((p for p in kit.products or [] if p.get("media_id") == product_id), None)
    g = brand.media_generation(db, kit.workspace_id, product_id) if prod else None
    if g is None:
        raise HTTPException(422, f"That product isn't in “{kit.name}”")
    return prod, g.id


# ---------------------------------------------------------------- wording

def _luminance(hex_: str) -> float:
    h = hex_.lstrip("#")
    try:
        r, g, b = (int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
    except ValueError:
        return 0.5

    def lin(c):
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)


def _named(p: dict) -> str:
    name = (p.get("name") or "").strip()
    return f"{name} {p['hex'].upper()}" if name else p["hex"].upper()


def _and(words: list[str]) -> str:
    return "".join(words) if len(words) < 2 else f"{', '.join(words[:-1])} and {words[-1]}"


def colours(kit: BrandKit) -> str:
    return _and([_named(p) for p in kit.palette or [] if p.get("hex")])


def logo_rule(kit: BrandKit, logo: LogoPick, light_ink: str) -> str:
    if not logo.recolour:
        if logo.variant == "light":
            return ("Picture 2 is the light version of the logo, made for dark backgrounds: keep its exact letters, "
                    "shapes and colours.")
        return "Keep the logo's exact letters, shapes and colours."
    accents = [_named(p) for p in kit.palette or [] if p.get("hex") and _luminance(p["hex"]) >= DARK_LUM]
    keep = f"keep the accent colours ({_and(accents)}) exactly as they are" if accents else \
        "keep any accent colours exactly as they are"
    return (f"The surface is dark, so render the logo's dark letters and outlines in {light_ink} for contrast, "
            f"{keep}, and keep the exact letter shapes.")


def tokens(kit: BrandKit, logo: LogoPick, product: tuple[dict, str] | None, t: dict) -> dict[str, str]:
    desc = (brand.logo_ref(kit, logo.variant).get("description") or "").strip()
    cols = colours(kit)
    tag = (kit.tagline or "").strip()
    prod = product[0] if product else None
    return {
        "brand": kit.name,
        "logo": f"the {kit.name} logo" + (f" ({desc})" if desc else ""),
        "logo_colours": logo_rule(kit, logo, t.get("light_ink") or "white"),
        "colours": cols or "clean neutral tones",
        "palette": f"in the brand colours {cols}" if cols else "in calm neutral colours",
        "tagline": tag,
        "tagline_clause": f' with the tagline "{tag}"' if tag else "",
        "product_clause": (f" Picture 3 is the {prod['name']}: match its shape, colours and label layout."
                           if prod else ""),
    }


def fill(text: str, values: dict[str, str]) -> str:
    out = TOKEN.sub(lambda m: values.get(m.group(1), m.group(0)), text or "")
    # an empty clause can leave doubled spaces or a space before a full stop
    return re.sub(r"\s+([.,;])", r"\1", re.sub(r"[ \t]{2,}", " ", out)).strip()


def surface_of(t: dict, asked: str | None) -> str:
    if asked:
        return asked
    s = t.get("surface") or "light"
    return s if s in SURFACES else "light"


# ---------------------------------------------------------------- the chain

CHAIN = "brand_chain"


def chain_spec(*, instruction: str, model_id: str, chosen: dict, refs: list[str], size: tuple[int, int],
               aspect: str | None, seed: int | None, template_id: str, record: dict, user_id: str) -> dict:
    w, h = size
    return {"state": "waiting", "instruction": instruction, "model": model_id, "chosen": chosen, "refs": refs,
            "width": w, "height": h, "aspect": aspect, "seed": seed, "template_id": template_id,
            "brand_template": record, "user_id": user_id}


def edit_params(spec: dict, item_id: str, scene_id: str) -> dict:
    return {"width": spec["width"], "height": spec["height"], "aspect": spec.get("aspect"),
            "instruction": spec["instruction"], "edit_of": [{"media_id": item_id, "generation_id": scene_id}],
            "reference_ids": [scene_id, *spec["refs"]], "model": spec["model"], **(spec.get("chosen") or {}),
            "template_id": spec["template_id"], "brand": {"kit_id": spec["brand_template"]["kit_id"]},
            "brand_template": {**spec["brand_template"], "scene_id": scene_id},
            "created_by": {"user_id": spec.get("user_id"), "flow": "brand_template:scene"}}


def on_job_finished(db: Session, job: Job) -> None:
    """Worker hook: a brand scene finished, so its logo edit goes on as the next version of the same item."""
    if job.type != "generate" or job.status != "done" or not job.generation_id:
        return
    g = db.get(Generation, job.generation_id)
    spec = (g.params or {}).get(CHAIN) if g is not None else None
    if not spec or spec.get("state") != "waiting" or g.target_type != "media":
        return
    item = db.get(MediaItem, g.target_id)
    if item is None or g.status not in brand.FINISHED or not g.file_path:
        return
    edit = enqueue_generation(db, workspace_id=g.workspace_id, project_id=None, target_type="media",
                              target_id=item.id, kind="image", prompt=spec["instruction"],
                              params=edit_params(spec, item.id, g.id), seed=spec.get("seed"), parent_id=g.id)
    child = db.get(Job, edit.job_id)
    # the worker session already stamps API rows; say it outright so the chain never leaks into the app
    edit.via_api = child.via_api = bool(job.via_api or g.via_api)
    child.payload = {**(child.payload or {}), "chain_of": job.id}
    g.params = {**g.params, CHAIN: {**spec, "state": "queued", "edit_generation_id": edit.id}}
    flag_modified(g, "params")
    # the tile keeps showing "working" until the logo is on; the scene stays one version back
    item.generation_id = edit.id
    from app.library import touch

    touch(item)
    log.info("brand scene %s done, logo edit %s queued", g.id, edit.id)
