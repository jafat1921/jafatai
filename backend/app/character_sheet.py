"""Character sheets (M12a): queueing the panels, the colour palette, and the board laid out from them.

Panels are Generation(target_type="character", kind="sheet_view") with params.panel naming the catalogue
entry (app.character_panels). Each panel has its own approved version (services.approve). Panels drawn
from the full-body hero wait in sheet["pending"] until a hero is ready; on_job_finished queues them then.

The board is a CPU job on the general lane: a Library image item whose versions are the recomposes.

character.sheet holds: preset, counts (custom), lists {outfits, details, props, accessories}, extras
{panel key: item name}, keys, pending, backdrop, titles {section: text}, labels {panel key: text},
footer {team, number}, ruler, palette, board {media_id, layout, job_id, uploaded, made_media_id},
own_sheet {media_id}.

Own images (contract v25): a portrait, a panel or crops cut from an uploaded sheet are stored as PNG
generations with params.source "upload". An uploaded sheet is the board itself, and nothing recomposes over
it until the user lays out a new board from the panels.
"""
import io
import logging
import math
import re
from pathlib import Path

from fastapi import HTTPException
from PIL import Image, ImageDraw, ImageOps
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import brand_render as br
from app import character_panels as cp
from app import models_catalog, subtitles
from app.config import get_settings
from app.library import touch
from app.models import Character, Generation, Job, MediaItem, Project, new_id, utcnow
from app.services import approve, enqueue_generation, gen_out, generation_file, new_seed, next_version

log = logging.getLogger("mixai.sheet")

BOARD_JOB = "character_board"
LIVE = ("queued", "generating")
FINISHED = ("ready", "approved")
PROFILE_FIELDS = ("role", "affiliation", "nationality", "height", "age", "gender", "languages", "personality",
                  "accent", "wardrobe")
PROFILE_LABELS = {"role": "Role", "affiliation": "Affiliation", "nationality": "Nationality", "height": "Height",
                  "age": "Age", "gender": "Gender", "languages": "Languages", "personality": "Personality",
                  "accent": "Accent", "wardrobe": "Wardrobe"}
# sheet export styles; the app itself stays Antique Atelier
LAYOUTS = {"dossier": (3840, 2160), "studio": (4096, 4096)}
KEEP_BOARD_VERSIONS = 2
TEXT_MAX = 80


def clean_profile(old: dict | None, new: dict | None) -> dict:
    """Merge profile fields; a blank value clears that field."""
    out = dict(old or {})
    for k, v in (new or {}).items():
        if k not in PROFILE_FIELDS:
            raise HTTPException(422, f"Unknown profile field '{k}' (expected {', '.join(PROFILE_FIELDS)})")
        v = " ".join(str(v or "").split())[:300]
        if v:
            out[k] = v
        else:
            out.pop(k, None)
    return out


# ---------------------------------------------------------------- reading the sheet

def portrait(db: Session, character_id: str) -> Generation | None:
    """The approved portrait, else the newest finished one (what sheet panels are edited from)."""
    rows = db.scalars(select(Generation).where(
        Generation.target_type == "character", Generation.target_id == character_id, Generation.kind == "portrait",
        Generation.status.in_(FINISHED), Generation.file_path.is_not(None),
    ).order_by(Generation.created_at.desc())).all()
    return next((g for g in rows if g.status == "approved"), None) or next(iter(rows), None)


def panel_gens(db: Session, character_id: str) -> dict[str, list[Generation]]:
    """Panel key -> its generations, newest first. The podcast's plain sheet views aren't panels."""
    out: dict[str, list[Generation]] = {}
    rows = db.scalars(select(Generation).where(
        Generation.target_type == "character", Generation.target_id == character_id,
        Generation.kind == "sheet_view").order_by(Generation.created_at.desc())).all()
    for g in rows:
        if (g.params or {}).get("panel"):
            out.setdefault(g.params["panel"], []).append(g)
    return out


def current(gens: list[Generation]) -> Generation | None:
    usable = [g for g in gens if g.status in FINISHED and g.file_path]
    return next((g for g in usable if g.status == "approved"), None) or next(iter(usable), None)


def panel_generation(db: Session, character_id: str, key: str) -> Generation | None:
    return current(panel_gens(db, character_id).get(key, []))


def hero(db: Session, character_id: str) -> Generation | None:
    return panel_generation(db, character_id, "hero")


def extras(c: Character) -> dict:
    return dict((c.sheet or {}).get("extras") or {})


def put(c: Character, **changes) -> None:
    # a new dict, so the JSON column notices
    c.sheet = {**(c.sheet or {}), **changes}


def wanted_keys(c: Character, gens: dict[str, list[Generation]]) -> list[str]:
    """The panels this sheet shows: its preset's, plus any panel made outside it, in catalogue order."""
    keys = list((c.sheet or {}).get("keys") or [])
    extra = [k for k in gens if k not in keys and cp.panel(k, extras(c)) is not None]
    order = list(cp.CATALOGUE)
    extra.sort(key=lambda k: (order.index(k) if k in order else len(order), k))
    return keys + extra


def status_of(gens: list[Generation]) -> str:
    if gens and gens[0].status in LIVE:
        return gens[0].status
    cur = current(gens)
    if cur is not None:
        return cur.status
    if gens and gens[0].status == "failed":
        return "failed"
    return "none"


def section_title(c: Character, section: str) -> str:
    return ((c.sheet or {}).get("titles") or {}).get(section) or cp.SECTIONS[section]


def panel_label(c: Character, p: cp.Panel) -> str:
    return ((c.sheet or {}).get("labels") or {}).get(p.key) or p.label


def sheet_out(db: Session, c: Character) -> dict:
    gens = panel_gens(db, c.id)
    s = c.sheet or {}
    pending = set(s.get("pending") or [])
    src = {"portrait": portrait(db, c.id), "hero": current(gens.get("hero", []))}
    panels = []
    for key in wanted_keys(c, gens):
        p = cp.panel(key, extras(c))
        if p is None:
            continue
        mine = gens.get(key, [])
        cur = current(mine)
        live = next((g for g in mine if g.status in LIVE), None)
        source = src.get(p.source)
        panels.append({
            "key": key, "section": p.section, "section_title": section_title(c, p.section),
            "label": panel_label(c, p), "default_label": p.label, "source": p.source,
            "status": "waiting" if key in pending and not mine else status_of(mine),
            "current": gen_out(cur) if cur else None, "live_job_id": live.job_id if live else None,
            "versions": len(mine),
            # made from an older portrait / hero than the one in use now
            "stale": bool(cur and source and (cur.params or {}).get("source_id") not in (None, source.id)),
        })
    board = s.get("board") or {}
    item = db.get(MediaItem, board.get("media_id") or "")
    bg = db.get(Generation, item.generation_id) if item is not None and item.generation_id else None
    job = db.get(Job, board.get("job_id") or "")
    to_make = sum(1 for x in panels if x["status"] in ("none", "waiting", "queued", "generating", "failed"))
    own = db.get(MediaItem, (s.get("own_sheet") or {}).get("media_id") or "")
    og = db.get(Generation, own.generation_id) if own is not None and own.generation_id else None
    return {
        "character_id": c.id, "preset": s.get("preset"), "counts": s.get("counts") or {},
        "lists": s.get("lists") or {}, "backdrop": s.get("backdrop") or "grey",
        "titles": s.get("titles") or {}, "footer": s.get("footer") or {}, "ruler": bool(s.get("ruler")),
        "panels": panels, "palette": s.get("palette") or [], "estimate": cp.estimate(to_make),
        "has_portrait": src["portrait"] is not None,
        "board": {
            "media_id": item.id if item else None, "layout": board.get("layout") or "dossier",
            "generation": gen_out(bg) if bg else None,
            "status": job.status if job is not None and job.status in ("queued", "running") else (
                "ready" if bg is not None and bg.status in FINISHED else "none"),
            "uploaded": bool(board.get("uploaded")),
        },
        # the sheet the user brought, for cutting panels from (it stays after a new board is laid out)
        "own_sheet": {"media_id": own.id, "generation": gen_out(og), "width": own.width, "height": own.height}
        if og is not None and og.file_path else None,
    }


# ---------------------------------------------------------------- queueing

def _source(db: Session, c: Character, p: cp.Panel) -> Generation | None:
    return portrait(db, c.id) if p.source == "portrait" else hero(db, c.id)


def queue_panel(db: Session, c: Character, key: str, *, note: str = "", parent_id: str | None = None) -> Generation:
    p = cp.panel(key, extras(c))
    if p is None:
        raise HTTPException(404, f"This sheet has no panel '{key}'")
    w, h = p.size
    params: dict = {"panel": key, "view": p.view or key, "source": p.source, "width": w, "height": h}
    if p.source == "none":
        project = db.get(Project, c.project_id) if c.project_id else None
        params["object"] = True
        models_catalog.apply_image_choice(params, project.settings if project else None)
    else:
        src = _source(db, c, p)
        if src is None:
            raise HTTPException(409, "Make and approve a portrait first; every panel is drawn from it"
                                if p.source == "portrait" else "This panel is drawn from the full-body hero. Make it first.")
        params.update(reference_ids=[src.id], source_id=src.id)
        if p.lora:
            params["angles_lora"] = 1.0
    prompt = cp.instruction(p, (c.sheet or {}).get("backdrop") or "grey", note)
    return enqueue_generation(db, workspace_id=c.workspace_id, project_id=c.project_id, target_type="character",
                              target_id=c.id, kind="sheet_view", prompt=prompt, params=params, parent_id=parent_id)


def clean_lists(lists: dict | None) -> dict[str, list[str]]:
    out = {}
    for section, top in cp.LISTS.items():
        items = [" ".join(str(x).split())[:120] for x in (lists or {}).get(section) or []]
        out[section] = [x for x in items if x][:top]
    return out


def start(db: Session, c: Character, preset: str, *, counts: dict | None = None, lists: dict | None = None,
          backdrop: str | None = None) -> list[Generation]:
    """Queue every panel of the preset that has nothing yet. Panels that already have a picture are kept;
    regenerate those one by one."""
    if preset not in (*cp.PRESETS, "custom"):
        raise HTTPException(422, "preset must be essential, full or custom")
    if portrait(db, c.id) is None:
        raise HTTPException(409, "Make and approve a portrait first; every panel is drawn from it")
    lists = clean_lists(lists)
    ex = {}
    for section, items in lists.items():
        prefix = {"outfits": "outfit", "details": "detail", "props": "prop", "accessories": "accessory"}[section]
        ex.update({f"{prefix}_{i}": x for i, x in enumerate(items, 1)})
    keys = cp.panel_keys(preset, counts, lists)
    put(c, preset=preset, counts=cp.counts_for(preset, counts), lists=lists, extras=ex, keys=keys,
        backdrop=backdrop if backdrop in cp.BACKDROPS else (c.sheet or {}).get("backdrop") or "grey")

    gens = panel_gens(db, c.id)
    hero_ready = current(gens.get("hero", [])) is not None
    queued, pending = [], []
    for key in keys:
        if any(g.status in LIVE + FINISHED for g in gens.get(key, [])):
            continue
        if cp.panel(key, ex).source == "hero" and not hero_ready:
            pending.append(key)
            continue
        queued.append(queue_panel(db, c, key))
    put(c, pending=sorted(set((c.sheet or {}).get("pending") or []) | set(pending)))
    return queued


def regenerate(db: Session, c: Character, key: str, note: str = "") -> Generation:
    # panels drawn from an older hero show as stale; nothing is redone behind the user's back
    mine = panel_gens(db, c.id).get(key, [])
    return queue_panel(db, c, key, note=note, parent_id=mine[0].id if mine else None)


def _release_pending(db: Session, c: Character) -> list[Generation]:
    pending = list((c.sheet or {}).get("pending") or [])
    if not pending or hero(db, c.id) is None:
        return []
    out = []
    gens = panel_gens(db, c.id)
    for key in pending:
        if cp.panel(key, extras(c)) is None or any(g.status in LIVE for g in gens.get(key, [])):
            continue
        out.append(queue_panel(db, c, key))
    put(c, pending=[])
    return out


def is_idle(db: Session, character_id: str) -> bool:
    return not any(g.status in LIVE for gens in panel_gens(db, character_id).values() for g in gens)


def _is_panel(g: Generation | None) -> bool:
    return g is not None and g.target_type == "character" and g.kind == "sheet_view" and bool((g.params or {}).get("panel"))


def on_job_finished(db: Session, job: Job) -> None:
    """Worker hook: a panel finished. The hero frees the panels waiting on it; an idle sheet recomposes."""
    g = db.get(Generation, job.generation_id) if job.generation_id else None
    if not _is_panel(g):
        return
    c = db.get(Character, g.target_id)
    if c is None:
        return
    if g.params["panel"] == "hero" and g.status in FINISHED:
        _release_pending(db, c)
        refresh_palette(db, c)
    if is_idle(db, c.id) and any(current(v) for v in panel_gens(db, c.id).values()):
        queue_board(db, c)


def panel_changed(db: Session, g: Generation) -> None:
    """Approve / unapprove / reject of a panel from the review UI."""
    if not _is_panel(g):
        return
    c = db.get(Character, g.target_id)
    if c is None:
        return
    if g.params["panel"] == "hero":
        refresh_palette(db, c)
    if (c.sheet or {}).get("board") or is_idle(db, c.id):
        queue_board(db, c)


def update_text(c: Character, *, titles: dict | None = None, labels: dict | None = None, footer: dict | None = None,
                ruler: bool | None = None, backdrop: str | None = None) -> None:
    """Section titles and panel labels in any language; blank puts the default back."""
    def clean(d: dict, known) -> dict:
        return {k: " ".join(str(v).split())[:TEXT_MAX] for k, v in d.items() if known(k) and str(v or "").strip()}

    s = c.sheet or {}
    if titles is not None:
        put(c, titles=clean({**(s.get("titles") or {}), **titles}, lambda k: k in cp.SECTIONS))
    if labels is not None:
        put(c, labels=clean({**(s.get("labels") or {}), **labels},
                            lambda k: cp.panel(k, extras(c)) is not None))
    if footer is not None:
        put(c, footer=clean(footer, lambda k: k in ("team", "number")))
    if ruler is not None:
        put(c, ruler=bool(ruler))
    if backdrop is not None:
        if backdrop not in cp.BACKDROPS:
            raise HTTPException(422, f"backdrop must be one of {', '.join(cp.BACKDROPS)}")
        put(c, backdrop=backdrop)


# ---------------------------------------------------------------- own images

UPLOAD_PROMPT = "Your own picture (uploaded)"
MIN_CROP = 16


def uploaded_image(db: Session, workspace_id: str, media_id: str, what: str = "picture") -> tuple[MediaItem, Generation]:
    """A finished Library image (an upload from /media/upload, usually) and its current version."""
    item = db.get(MediaItem, media_id or "")
    if item is None or item.workspace_id != workspace_id:
        raise HTTPException(404, f"That {what} isn't in the Library")
    if item.kind != "image":
        raise HTTPException(422, f"The {what} has to be an image")
    g = db.get(Generation, item.generation_id or "")
    if g is None or g.status not in FINISHED or not g.file_path:
        raise HTTPException(409, f"That {what} isn't finished yet")
    return item, g


def open_picture(g: Generation) -> Image.Image:
    try:
        with Image.open(generation_file(g)) as im:
            # the browser shows a phone photo upright, so crops are measured upright too
            return ImageOps.exif_transpose(im).convert("RGB")
    except (OSError, TypeError) as e:
        raise HTTPException(422, f"That picture can't be read ({e})") from None


def store_picture(c: Character, pic: Image.Image, kind: str, *, prompt: str = "", status: str = "ready",
                  params: dict | None = None, version: int = 1) -> Generation:
    """Saves the pixels as a PNG generation of the character. The caller adds it to the session."""
    gid = new_id()
    rel = (Path("workspaces") / c.workspace_id / "projects" / (c.project_id or "_unassigned") / "generations"
           / f"{gid}.png")
    dest = get_settings().data_dir / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    pic.save(dest, "PNG")
    return Generation(id=gid, workspace_id=c.workspace_id, project_id=c.project_id, target_type="character",
                      target_id=c.id, kind=kind, version=version, status=status, prompt=prompt or "", seed=0,
                      file_path=rel.as_posix(), media_type="image/png",
                      params={**(params or {}), "size": [pic.width, pic.height]},
                      approved_at=utcnow() if status == "approved" else None)


def add_own(db: Session, c: Character, pic: Image.Image, *, panel: str = "portrait", params: dict | None = None,
            approved: bool = True) -> Generation:
    """The user's own picture as a new version of the portrait or of a sheet panel, used as it is."""
    params = {**(params or {}), "source": "upload"}
    kind = "portrait"
    if panel != "portrait":
        p = cp.panel(panel, extras(c))
        if p is None:
            raise HTTPException(422, f"This sheet has no panel '{panel}'")
        kind = "sheet_view"
        params.update(panel=panel, view=p.view or panel)
    g = store_picture(c, pic, kind, prompt=UPLOAD_PROMPT, params=params,
                      version=next_version(db, "character", c.id, kind))
    db.add(g)
    db.flush()
    if approved:
        approve(db, g)
    if panel == "hero":
        _release_pending(db, c)
    return g


def use_own_sheet(db: Session, c: Character, item: MediaItem) -> None:
    """An uploaded sheet becomes the board. The panels' own board item is remembered for a later re-layout."""
    board = dict((c.sheet or {}).get("board") or {})
    made = board.get("made_media_id") if board.get("uploaded") else board.get("media_id")
    put(c, own_sheet={"media_id": item.id, "at": utcnow().isoformat() + "Z"},
        board={"media_id": item.id, "layout": board.get("layout") or "dossier", "uploaded": True, "made_media_id": made})


def cut_panels(db: Session, c: Character, crops: list[dict]) -> list[Generation]:
    """Crops of the uploaded sheet, in its own pixels, each saved as that slot's approved version.
    Every box is checked before anything is saved."""
    item_id = ((c.sheet or {}).get("own_sheet") or {}).get("media_id")
    if not item_id:
        raise HTTPException(409, "Upload your own sheet first")
    item, src = uploaded_image(db, c.workspace_id, item_id, "sheet")
    pic = open_picture(src)
    W, H = pic.size
    boxes = []
    for n, cr in enumerate(crops, 1):
        key = str(cr.get("panel") or "")
        x, y, w, h = (int(cr.get(k) or 0) for k in ("x", "y", "w", "h"))
        if key != "portrait" and cp.panel(key, extras(c)) is None:
            raise HTTPException(422, f"Crop {n}: this sheet has no panel '{key}'")
        if w < MIN_CROP or h < MIN_CROP:
            raise HTTPException(422, f"Crop {n} is too small; make it at least {MIN_CROP} × {MIN_CROP} pixels")
        if x < 0 or y < 0 or x + w > W or y + h > H:
            raise HTTPException(422, f"Crop {n} runs off the sheet, which is {W} × {H} pixels")
        boxes.append((key, (x, y, w, h)))
    return [add_own(db, c, pic.crop((x, y, x + w, y + h)), panel=key,
                    params={"crop": [x, y, w, h], "from_media": item.id})
            for key, (x, y, w, h) in boxes]


# ---------------------------------------------------------------- palette

def palette_of(path: Path, n: int = 6) -> list[str]:
    """The n strongest colours of a picture, leaving out its studio backdrop (sampled at the corners)."""
    with Image.open(path) as im:
        small = im.convert("RGB")
        small.thumbnail((160, 160))
    w, h = small.size
    corners = [small.getpixel((x, y)) for x, y in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1))]
    bg = tuple(sum(c[i] for c in corners) // 4 for i in range(3))
    q = small.quantize(colors=n + 4, method=Image.Quantize.MEDIANCUT)
    pal = q.getpalette() or []
    out: list[str] = []
    for _count, idx in sorted(q.getcolors() or [], reverse=True):
        rgb = tuple(pal[idx * 3: idx * 3 + 3])
        if math.dist(rgb, bg) < 36 or any(math.dist(rgb, _rgb(o)) < 18 for o in out):
            continue
        out.append("#%02x%02x%02x" % rgb)
        if len(out) == n:
            break
    return out


def _rgb(hex_: str) -> tuple[int, int, int]:
    return tuple(int(hex_[i:i + 2], 16) for i in (1, 3, 5))


def refresh_palette(db: Session, c: Character) -> list[str]:
    g = hero(db, c.id) or portrait(db, c.id)
    path = generation_file(g) if g is not None else None
    if path is None or not path.is_file():
        return []
    try:
        colours = palette_of(path)
    except OSError:
        log.exception("couldn't read %s for the palette", path)
        return []
    put(c, palette=colours, palette_from=g.id)
    return colours


# ---------------------------------------------------------------- the board

def queue_board(db: Session, c: Character, layout: str | None = None, *, replace_upload: bool = False) -> Job | None:
    """One recompose at a time: a board job still waiting just picks up the new layout. An uploaded board
    is left alone (None) unless the user asked for a new one from the panels."""
    board = dict((c.sheet or {}).get("board") or {})
    layout = layout or board.get("layout") or "dossier"
    if layout not in LAYOUTS:
        raise HTTPException(422, f"layout must be one of {', '.join(LAYOUTS)}")
    if board.get("uploaded"):
        if not replace_upload:
            return None
        # back to the board item the recomposes live on; the user's own sheet stays in the Library
        board = {"media_id": board.get("made_media_id"), "layout": layout}
    waiting = db.get(Job, board.get("job_id") or "")
    if waiting is not None and waiting.status == "queued":
        waiting.payload = {**(waiting.payload or {}), "layout": layout}
        board["layout"] = layout
        put(c, board=board)
        return waiting
    item = db.get(MediaItem, board.get("media_id") or "")
    if item is None or item.workspace_id != c.workspace_id:
        item = MediaItem(id=new_id(), workspace_id=c.workspace_id, kind="image", origin="generated",
                         title=f"{c.name} · character sheet"[:300], tags=["character sheet"], project_id=c.project_id,
                         home="character")
        db.add(item)
        db.flush()
    g = Generation(id=new_id(), workspace_id=c.workspace_id, project_id=None, target_type="media", target_id=item.id,
                   kind="image", version=next_version(db, "media", item.id, "image"), status="queued",
                   prompt=f"Character sheet of {c.name}", seed=new_seed(), parent_id=item.generation_id,
                   params={"board": True, "layout": layout, "character_id": c.id})
    db.add(g)
    db.flush()
    if item.generation_id is None:
        item.generation_id = g.id
    job = Job(workspace_id=c.workspace_id, type=BOARD_JOB, generation_id=g.id, project_id=c.project_id,
              message=f"Waiting for a worker · {c.name}'s sheet", payload={"character_id": c.id, "layout": layout})
    db.add(job)
    db.flush()
    g.job_id = job.id
    board.update(media_id=item.id, layout=layout, job_id=job.id)
    put(c, board=board)
    touch(item)
    return job


Tiles = list[tuple[str, Path]]


def board_sections(db: Session, c: Character) -> tuple[Path | None, list[tuple[str, str, Tiles]]]:
    """The hero's file and, per section in catalogue order, (section key, title, [(label, file)])."""
    gens = panel_gens(db, c.id)
    hero_path = None
    found: dict[str, Tiles] = {}
    for key in wanted_keys(c, gens):
        p = cp.panel(key, extras(c))
        g = current(gens.get(key, []))
        path = generation_file(g) if g is not None else None
        if p is None or path is None or not path.is_file():
            continue
        if key == "hero":
            hero_path = path
            continue
        found.setdefault(p.section, []).append((panel_label(c, p), path))
    if hero_path is None:
        g = portrait(db, c.id)
        path = generation_file(g) if g is not None else None
        hero_path = path if path is not None and path.is_file() else None
    return hero_path, [(s, section_title(c, s), found[s]) for s in cp.SECTIONS if s in found]


def handle_board(ctx) -> dict:
    db, job = ctx.db, ctx.job
    c = db.get(Character, (job.payload or {}).get("character_id"))
    g = db.get(Generation, job.generation_id) if job.generation_id else None
    if c is None or c.workspace_id != job.workspace_id or g is None:
        raise RuntimeError("That character no longer exists")
    layout = (job.payload or {}).get("layout") or "dossier"
    ctx.progress(0.1, "Laying out the sheet")
    if not (c.sheet or {}).get("palette"):
        refresh_palette(db, c)
    s = c.sheet or {}
    hero_path, sections = board_sections(db, c)
    img = compose_board(c.name, c.profile or {}, s.get("palette") or [], hero_path, sections, layout,
                        footer=s.get("footer") or {}, ruler=bool(s.get("ruler")))
    ctx.progress(0.8, "Saving the sheet")
    rel = Path("workspaces") / c.workspace_id / "media" / f"{g.id}.png"
    dest = get_settings().data_dir / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    img.save(dest, "PNG", compress_level=3)
    g.file_path, g.media_type, g.status = rel.as_posix(), "image/png", "ready"
    g.params = {**(g.params or {}), "size": [img.width, img.height]}
    _prune(db, g)
    return {"file_path": g.file_path, "media_type": "image/png", "width": img.width, "height": img.height}


def _prune(db: Session, newest: Generation) -> None:
    # every panel change makes a recompose; older composes are only stale copies of the same panels
    from app import thumbs

    old = db.scalars(select(Generation).where(
        Generation.target_type == "media", Generation.target_id == newest.target_id, Generation.id != newest.id,
        Generation.status.in_(FINISHED)).order_by(Generation.version.desc())).all()
    for g in [o for o in old if (o.params or {}).get("board")][KEEP_BOARD_VERSIONS - 1:]:
        path = generation_file(g)
        if path is not None:
            thumbs.remove_for(path)
            path.unlink(missing_ok=True)
        db.delete(g)
    db.flush()


def board_pdf(png: Path) -> bytes:
    buf = io.BytesIO()
    with Image.open(png) as im:
        im.convert("RGB").save(buf, "PDF", resolution=300.0)
    return buf.getvalue()


# ---------------------------------------------------------------- drawing

STYLES = {
    "dossier": {"bg": (15, 17, 20), "card": (26, 29, 34), "line": (48, 52, 60), "text": (236, 230, 218),
                "muted": (154, 149, 139), "accent": (201, 164, 92), "kicker": "CHARACTER DOSSIER"},
    "studio": {"bg": (243, 239, 231), "card": (255, 255, 255), "line": (221, 213, 198), "text": (31, 28, 24),
               "muted": (111, 103, 91), "accent": (155, 117, 54), "kicker": "Character reference sheet"},
}
# tiles per row; the head grid keeps its five turns in a row so the three tilts line up
ROW_OF = {"head": 5, "expressions": 4, "accessories": 3}


def height_cm(text: str) -> float | None:
    """'178 cm', '1.78 m' or 5'10" -> centimetres. Anything else draws no ruler."""
    t = (text or "").lower().replace("”", '"').replace("’", "'")
    if m := re.search(r"(\d+(?:\.\d+)?)\s*cm", t):
        return float(m[1])
    if m := re.search(r"(\d(?:\.\d+)?)\s*m\b", t):
        return float(m[1]) * 100
    if m := re.search(r"(\d)\s*(?:'|ft|feet)\s*(\d{1,2})?", t):
        return int(m[1]) * 30.48 + int(m[2] or 0) * 2.54
    return None


def _font(text: str, px: int):
    return br.load_font(subtitles.font_file(subtitles.font_for(None, text)), px)


def _write(d: ImageDraw.ImageDraw, x: float, y: float, w: float, text: str, font, fill) -> None:
    """One line; right-to-left text sits against the right edge of its box."""
    if br.is_rtl(text):
        x = x + w - br.text_width(d, text, font)
    s, kw = br.shaped(text)
    try:
        d.text((x, y), s, font=font, fill=fill, **kw)
    except (KeyError, ValueError, OSError):
        d.text((x, y), s, font=font, fill=fill)


def _label(d: ImageDraw.ImageDraw, x: float, y: float, w: float, text: str, px: int, fill) -> None:
    """A tile caption: shrunk a little to fit, then cut short, so neighbours never overlap."""
    font = _font(text, px)
    for _ in range(4):
        if br.text_width(d, text, font) <= w:
            break
        px = round(px * 0.88)
        font = _font(text, px)
    while len(text) > 2 and br.text_width(d, text, font) > w:
        text = text[:-2].rstrip() + "…"
    _write(d, x, y, w, text, font, fill)


def _line_h(font) -> int:
    asc, desc = font.getmetrics()
    return asc + desc


def _caps(text: str, layout: str) -> str:
    # the dossier sets its headings in capitals; Urdu and Arabic have none, so they pass through
    return text.upper() if layout == "dossier" else text


def _paste(canvas: Image.Image, path: Path, box: tuple[int, int, int, int], fill) -> None:
    x, y, w, h = box
    ImageDraw.Draw(canvas).rectangle((x, y, x + w, y + h), fill=fill)
    try:
        with Image.open(path) as im:
            pic = ImageOps.contain(im.convert("RGB"), (max(1, w), max(1, h)), Image.LANCZOS)
    except OSError:
        log.warning("panel file unreadable: %s", path)
        return
    canvas.paste(pic, (x + (w - pic.width) // 2, y + (h - pic.height) // 2))


def _ruler(d: ImageDraw.ImageDraw, x: int, top: int, h: int, cm: float, font, st: dict) -> None:
    """A height scale beside full-body figures: the figure fills the tile, so the tile is the height."""
    d.line((x, top, x, top + h), fill=st["muted"], width=3)
    step = 10 if cm <= 250 else 50
    for mark in range(0, int(cm) + 1, step):
        y = top + h - round(h * mark / cm)
        long = mark % 50 == 0
        d.line((x - (24 if long else 12), y, x, y), fill=st["muted"], width=2)
        if long and h * (cm - mark) / cm > _line_h(font) * 2:
            label = f"{mark}"
            d.text((x - 30 - br.text_width(d, label, font), y - _line_h(font) // 2), label, font=font, fill=st["muted"])
    top_label = f"{cm:.0f} cm"
    d.text((x - 30 - br.text_width(d, top_label, font), top), top_label, font=font, fill=st["accent"])


def compose_board(name: str, profile: dict, palette: list[str], hero_path: Path | None,
                  sections: list[tuple[str, str, Tiles]], layout: str = "dossier", *, footer: dict | None = None,
                  ruler: bool = False) -> Image.Image:
    st = STYLES.get(layout, STYLES["dossier"])
    W, H = LAYOUTS.get(layout, LAYOUTS["dossier"])
    canvas = Image.new("RGB", (W, H), st["bg"])
    d = ImageDraw.Draw(canvas)
    m = round(W * 0.025)
    gap = round(W * 0.008)
    unit = min(W, H)
    small = _font("A", round(unit * 0.012))

    # header: kicker, name, one line of who they are
    kicker = _font("A", round(unit * 0.016))
    _write(d, m, m, W - 2 * m, st["kicker"], kicker, st["accent"])
    shown = _caps(name, layout)
    name_font = _font(shown, round(unit * 0.055))
    y = m + _line_h(kicker) + gap // 2
    _write(d, m, y, br.text_width(d, shown, name_font), shown, name_font, st["text"])
    y += _line_h(name_font)
    tagline = " · ".join(" ".join(str(profile.get(k) or "").split()) for k in ("role", "affiliation", "nationality")
                         if str(profile.get(k) or "").strip())
    if tagline:
        tf = _font(tagline, round(unit * 0.02))
        _write(d, m, y, W * 0.6, tagline, tf, st["muted"])
        y += _line_h(tf)
    top = y + gap * 2
    d.line((m, top - gap, W - m, top - gap), fill=st["line"], width=max(2, unit // 900))

    foot = " · ".join(x for x in ((footer or {}).get("team"), (footer or {}).get("number")) if x)
    bottom = H - m - (_line_h(small) + gap if foot else 0)
    if foot:
        d.line((m, bottom + gap // 2, W - m, bottom + gap // 2), fill=st["line"], width=max(2, unit // 900))
        _write(d, m, bottom + gap, W - 2 * m, _caps(foot, layout), _font(foot, round(unit * 0.012)), st["muted"])

    # left column: hero, palette, identity block
    lw = round(W * (0.24 if W > H else 0.27))
    hero_h = round((bottom - top) * 0.52)
    if hero_path is not None:
        _paste(canvas, hero_path, (m, top, lw, hero_h), st["card"])
    else:
        d.rectangle((m, top, m + lw, top + hero_h), fill=st["card"])
    y = top + hero_h + gap * 2
    if palette:
        _write(d, m, y, lw, _caps("Palette", layout), small, st["accent"])
        y += _line_h(small) + gap // 2
        sw = (lw - gap * (len(palette) - 1)) // len(palette)
        for i, hx in enumerate(palette):
            x = m + i * (sw + gap)
            d.rectangle((x, y, x + sw, y + round(sw * 0.7)), fill=_rgb(hx), outline=st["line"])
            _label(d, x, y + round(sw * 0.7) + gap // 3, sw, hx.upper(), round(unit * 0.012), st["muted"])
        y += round(sw * 0.7) + _line_h(small) + gap * 2
    # the identity block runs down two columns, so a full profile fits under the palette
    value_px = round(unit * 0.0135)
    cw = (lw - gap * 2) // 2
    col, col_top = 0, y
    for key in PROFILE_FIELDS:
        val = " ".join(str(profile.get(key) or "").split())
        if not val:
            continue
        vf = _font(val, value_px)
        lines = br.wrap(d, val, vf, cw)[:3]
        need = _line_h(small) + len(lines) * _line_h(vf) + gap
        if y + need > bottom:
            if col == 1:
                break
            col, y = 1, col_top
        cx = m + col * (cw + gap * 2)
        _write(d, cx, y, cw, _caps(PROFILE_LABELS[key], layout), small, st["accent"])
        y += _line_h(small)
        for ln in lines:
            _write(d, cx, y, cw, ln, vf, st["text"])
            y += _line_h(vf)
        y += gap

    # right area: section blocks packed onto shelves, the tile size the largest that fits everything
    cm = height_cm(str(profile.get("height") or "")) if ruler else None
    x0 = m + lw + gap * 3
    if sections:
        _blocks(canvas, d, sections, (x0, top, W - x0 - m, bottom - top), layout, st, unit, gap, cm)
    return canvas


def _block_size(key: str, n: int, th: float, gap: int, title_h: int, label_h: int, lead: int):
    per = min(n, ROW_OF.get(key, 6))
    rows = math.ceil(n / per)
    tile_h = th * (1.5 if key in cp.TALL else 1.0)
    tile_w = tile_h * (2 / 3 if key in cp.TALL else 1.0 if key in ("props", "accessories") else 3 / 4)
    return per, tile_w, tile_h, lead + per * tile_w + (per - 1) * gap, title_h + rows * (tile_h + label_h + gap)


def _pack(sections, th, area_w, gap, title_h, label_h, lead_for):
    """Shelf packing: blocks left to right, a new shelf when one won't fit. None if a block is too wide."""
    shelves, x, y, shelf_h, out = [], 0.0, 0.0, 0.0, []
    for key, title, tiles in sections:
        per, tw, th_, bw, bh = _block_size(key, len(tiles), th, gap, title_h, label_h, lead_for(key))
        if bw > area_w:
            return None
        if x and x + bw > area_w:
            y += shelf_h + gap
            x, shelf_h = 0.0, 0.0
        out.append((key, title, tiles, x, y, per, tw, th_, bw))
        x += bw + gap * 3
        shelf_h = max(shelf_h, bh)
    return out, y + shelf_h


def _blocks(canvas, d, sections, area, layout, st, unit, gap, cm) -> None:
    ax, ay, aw, ah = area
    small = _font("A", round(unit * 0.012))
    title_h = _line_h(small) + gap // 2
    label_h = _line_h(small) + gap // 3
    ruler_w = round(unit * 0.045) if cm else 0
    lead_for = lambda key: ruler_w if key == "turnaround" else 0  # noqa: E731
    th = ah
    while th > 24:
        packed = _pack(sections, th, aw, gap, title_h, label_h, lead_for)
        if packed is not None and packed[1] <= ah:
            break
        th *= 0.95
    else:
        packed = _pack(sections, 24, aw, gap, title_h, label_h, lead_for)
        if packed is None:
            return
    for key, title, tiles, bx, by, per, tw, tile_h, bw in packed[0]:
        x, y = round(ax + bx), round(ay + by)
        _write(d, x, y, bw, _caps(title, layout), _font(title, round(unit * 0.012)), st["accent"])
        y += title_h
        lead = lead_for(key)
        tw, tile_h = round(tw), round(tile_h)
        if lead:
            rows = math.ceil(len(tiles) / per)
            for r in range(rows):
                _ruler(d, x + lead - gap, y + r * (tile_h + label_h + gap), tile_h, cm, small, st)
        for i, (label, path) in enumerate(tiles):
            r, col = divmod(i, per)
            tx, ty = x + lead + col * (tw + gap), y + r * (tile_h + label_h + gap)
            _paste(canvas, path, (tx, ty, tw, tile_h), st["card"])
            _label(d, tx, ty + tile_h + gap // 3, tw, label, round(unit * 0.012), st["muted"])
