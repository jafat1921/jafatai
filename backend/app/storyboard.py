"""Shots, locations and the rules that tie frames together (PLAN 2c).

The routers, the worker and the AI jobs all go through here so seam linking,
reference picking and staleness behave the same no matter who triggers them.
"""
import re

from fastapi import HTTPException
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app import models_catalog
from app.config import get_settings
from app.models import Character, Generation, Location, Project, Scene, Shot, utcnow
from app.schemas import LocationOut, ShotOut
from app.services import gen_out
from app.workflows import frames_for, snap_multiple

KEYFRAME_KINDS = ("keyframe_start", "keyframe_end", "keyframe_mid")
SHOT_KINDS = (*KEYFRAME_KINDS, "take")
LOCATION_KINDS = ("establishing",)
SHOT_TYPES = ("wide", "medium", "close_up", "extreme_close_up", "over_shoulder", "pov", "insert", "establishing",
              "long_take")

FPS = 24.0
# contract sizes before the /32 snap; LTX latents need multiples of 32
DRAFT_VIDEO = {"16:9": (768, 432), "9:16": (432, 768), "1:1": (576, 576), "2.39:1": (1024, 428), "4:3": (640, 480)}
MAX_TAKE_FRAMES = 257  # single-segment LTX; longer shots wait for the long-take templates
MAX_REFS = 3


# ---------------------------------------------------------------- ordering

def scene_shots(db: Session, scene_id: str) -> list[Shot]:
    return list(db.scalars(select(Shot).where(Shot.scene_id == scene_id).order_by(Shot.order, Shot.created_at)).all())


def project_shots(db: Session, project_id: str) -> list[Shot]:
    q = (
        select(Shot)
        .join(Scene, Scene.id == Shot.scene_id)
        .where(Shot.project_id == project_id)
        .order_by(Scene.order, Scene.created_at, Shot.order, Shot.created_at)
    )
    return list(db.scalars(q).all())


def renumber(shots: list[Shot]) -> None:
    for i, s in enumerate(shots, start=1):
        s.order = i


def neighbours(db: Session, shot: Shot) -> tuple[Shot | None, Shot | None]:
    """Previous and next shot in film order; seams cross scene boundaries."""
    shots = project_shots(db, shot.project_id)
    idx = next((i for i, s in enumerate(shots) if s.id == shot.id), None)
    if idx is None:
        return None, None
    return (shots[idx - 1] if idx > 0 else None), (shots[idx + 1] if idx + 1 < len(shots) else None)


def is_linked(shot: Shot, prev: Shot | None) -> bool:
    # a Continue seam on the very first shot has nothing to continue from, so it acts as a cut
    return shot.seam_in == "continue" and prev is not None


# ---------------------------------------------------------------- generations

def _gens_for(db: Session, target_type: str, ids: list[str], kinds) -> dict[str, list[Generation]]:
    out: dict[str, list[Generation]] = {i: [] for i in ids}
    if not ids:
        return out
    rows = db.scalars(
        select(Generation)
        .where(Generation.target_type == target_type, Generation.target_id.in_(ids), Generation.kind.in_(kinds))
        .order_by(Generation.created_at.desc())
    ).all()
    for g in rows:
        out[g.target_id].append(g)
    return out


def current(gens: list[Generation], kind: str) -> Generation | None:
    """Approved version, else the newest finished one (gens newest first)."""
    mine = [g for g in gens if g.kind == kind]
    return next((g for g in mine if g.status == "approved"), None) or next(
        (g for g in mine if g.status == "ready"), None
    )


def approved(db: Session, target_type: str, target_id: str, kind: str) -> Generation | None:
    return db.scalars(
        select(Generation).where(
            Generation.target_type == target_type, Generation.target_id == target_id,
            Generation.kind == kind, Generation.status == "approved",
        )
    ).first()


def derive_status(start_ok: bool, end_ok: bool, takes: list[Generation]) -> str:
    if any(t.status == "approved" for t in takes):
        return "approved"
    if any(t.status in ("queued", "generating") for t in takes):
        return "rendering"
    if any(t.status == "ready" for t in takes):
        return "take_ready"
    if start_ok and end_ok:
        return "frames_ready"
    return "draft"


def shots_out(db: Session, shots: list[Shot]) -> list[ShotOut]:
    if not shots:
        return []
    order: dict[str, list[Shot]] = {}
    prev_of: dict[str, Shot | None] = {}
    for pid in {s.project_id for s in shots}:
        order[pid] = project_shots(db, pid)
        for i, s in enumerate(order[pid]):
            prev_of[s.id] = order[pid][i - 1] if i > 0 else None
    wanted = {s.id for s in shots} | {p.id for p in prev_of.values() if p is not None}
    gens = _gens_for(db, "shot", list(wanted), SHOT_KINDS)
    closing = {}
    for pid in order:
        rec = ((_project(db, pid).settings or {}).get("brand_closing_shot") or {})
        if rec.get("shot_id"):
            closing[rec["shot_id"]] = rec.get("mode")

    out = []
    for s in shots:
        mine = gens.get(s.id, [])
        prev = prev_of.get(s.id)
        o = ShotOut.model_validate(s)
        o.character_ids = list(s.character_ids or [])
        o.brand_closing = o.closing = closing.get(s.id)
        o.brand_placements_locked = any(p.get("source") == "user" for p in s.brand_placements or [])
        end = current(mine, "keyframe_end")
        if is_linked(s, prev):
            linked = current(gens.get(prev.id, []), "keyframe_end")
            o.start_frame = gen_out(linked) if linked else None
            o.start_linked = True
            start_ok = bool(linked and linked.status == "approved")
        else:
            start = current(mine, "keyframe_start")
            o.start_frame = gen_out(start) if start else None
            start_ok = bool(start and start.status == "approved")
        o.end_frame = gen_out(end) if end else None
        takes = [g for g in mine if g.kind == "take" and g.status != "rejected"]
        take = next((t for t in takes if t.status == "approved"), None)
        o.approved_take = gen_out(take) if take else None
        o.takes_count = len(takes)
        o.status = derive_status(start_ok, bool(end and end.status == "approved"), takes)
        out.append(o)
    return out


def shot_out(db: Session, shot: Shot) -> ShotOut:
    return shots_out(db, [shot])[0]


def location_out(db: Session, loc: Location) -> LocationOut:
    o = LocationOut.model_validate(loc)
    o.time_of_day_variants = list(loc.time_of_day_variants or [])
    g = approved(db, "location", loc.id, "establishing")
    o.approved_establishing = gen_out(g) if g else None
    return o


def shot_count(db: Session, project_id: str) -> int:
    return db.scalar(select(func.count()).select_from(Shot).where(Shot.project_id == project_id)) or 0


def delete_shots(db: Session, shots: list[Shot]) -> None:
    ids = [s.id for s in shots]
    if not ids:
        return
    db.execute(delete(Generation).where(Generation.target_type == "shot", Generation.target_id.in_(ids)))
    for s in shots:
        db.delete(s)


def has_approved_work(db: Session, shot: Shot) -> bool:
    """Approved frames or takes count as the user's work, same as a lock."""
    return bool(db.scalar(
        select(func.count()).select_from(Generation).where(
            Generation.target_type == "shot", Generation.target_id == shot.id, Generation.status == "approved"
        )
    ))


# ---------------------------------------------------------------- staleness

def has_gens(db: Session, shot_id: str, kinds) -> bool:
    return bool(db.scalar(
        select(func.count()).select_from(Generation).where(
            Generation.target_type == "shot", Generation.target_id == shot_id,
            Generation.kind.in_(kinds), Generation.status != "rejected",
        )
    ))


def mark_scene_shots_stale(db: Session, scene_id: str) -> int:
    shots = scene_shots(db, scene_id)
    for s in shots:
        s.stale = True
    return len(shots)


def after_approve(db: Session, g: Generation) -> None:
    if g.target_type != "shot" or g.kind not in ("keyframe_start", "keyframe_end"):
        return
    shot = db.get(Shot, g.target_id)
    if shot is None:
        return
    now = utcnow()
    if has_gens(db, shot.id, ("take",)):
        shot.stale = True
    shot.updated_at = now
    if g.kind == "keyframe_end":
        _, nxt = neighbours(db, shot)
        if nxt is not None and nxt.seam_in == "continue":
            # its START frame just changed under it
            if has_gens(db, nxt.id, SHOT_KINDS):
                nxt.stale = True
            nxt.updated_at = now


# ---------------------------------------------------------------- generation inputs

def _project(db: Session, project_id: str) -> Project:
    return db.get(Project, project_id)


def with_style(project: Project, text: str) -> str:
    style = (project.style_bible or "").strip()
    text = text.strip()
    if style and style not in text:
        return f"{text}\n{style}" if text else style
    return text


def references_for(db: Session, shot: Shot) -> tuple[list[str], list[str]]:
    """Approved character portraits (or sheet view), then the location's establishing frame."""
    ids, labels = [], []
    for cid in shot.character_ids or []:
        c = db.get(Character, cid)
        if c is None:
            continue
        g = approved(db, "character", cid, "portrait") or approved(db, "character", cid, "sheet_view")
        if g and g.file_path:
            ids.append(g.id)
            labels.append(c.name)
    loc_id = shot.location_id or (db.get(Scene, shot.scene_id).location_id if shot.scene_id else None)
    if loc_id:
        loc = db.get(Location, loc_id)
        g = approved(db, "location", loc_id, "establishing") if loc else None
        if g and g.file_path:
            ids.append(g.id)
            labels.append(f"the location ({loc.name})")
    return ids[:MAX_REFS], labels[:MAX_REFS]


def draft_size(aspect: str) -> tuple[int, int]:
    w, h = DRAFT_VIDEO.get(aspect, DRAFT_VIDEO["16:9"])
    return snap_multiple(w, 32), snap_multiple(h, 32)


def take_frames(db: Session, shot: Shot) -> tuple[Generation | None, Generation | None]:
    prev, _ = neighbours(db, shot)
    if is_linked(shot, prev):
        start = approved(db, "shot", prev.id, "keyframe_end")
    else:
        start = approved(db, "shot", shot.id, "keyframe_start")
    return start, approved(db, "shot", shot.id, "keyframe_end")


def world_anchors(db: Session, shot: Shot) -> str:
    scene = db.get(Scene, shot.scene_id)
    parts = []
    loc_id = shot.location_id or (scene.location_id if scene else None)
    loc = db.get(Location, loc_id) if loc_id else None
    if loc:
        parts.append(f"Setting: {loc.name}. {loc.description}".strip())
    if scene:
        light = ", ".join(x for x in ((scene.time_of_day or "").replace("_", " "), scene.lighting, scene.mood) if x)
        if light:
            parts.append(f"Light and mood: {light}.")
    return " ".join(parts)


def frame_prompt(db: Session, shot: Shot, kind: str) -> str:
    project = _project(db, shot.project_id)
    if kind == "take":
        base = shot.motion_prompt.strip()
        if not base:
            return ""
        anchors = world_anchors(db, shot)
        return with_style(project, f"{base}\n{anchors}" if anchors and anchors not in base else base)
    base = (shot.start_prompt if kind == "keyframe_start" else shot.end_prompt).strip()
    return with_style(project, base) if base else ""


LINKED_DETAIL = "linked to previous shot's end frame"


def prepare_shot_generation(db: Session, shot: Shot, kind: str, prompt: str, params: dict) -> tuple[str, dict]:
    """Fill server-side defaults for a shot generation. Raises HTTPException (also fine inside jobs)."""
    if kind not in SHOT_KINDS:
        raise HTTPException(422, f"A shot can't have a '{kind}' generation")
    project = _project(db, shot.project_id)
    params = dict(params or {})
    params.setdefault("aspect_ratio", project.aspect_ratio)
    prev, _ = neighbours(db, shot)
    from app import brand_moments as bm  # imports this module

    if bm.is_reveal(db, shot):
        raise HTTPException(409, "This is the advert's exact logo reveal: it has no frames, and its take is "
                                 "made from the brand kit's logo file")

    if kind in KEYFRAME_KINDS:
        if kind == "keyframe_start" and is_linked(shot, prev):
            raise HTTPException(409, LINKED_DETAIL)
        if "reference_ids" not in params:
            ids, labels = references_for(db, shot)
            # a shot with brand placements uses the edit model with the logo/product as references
            if not bm.keyframe_refs(db, shot, project, params, ids, labels) and ids:
                params["reference_ids"], params["reference_labels"] = ids, labels
        prompt = bm.with_fragment(prompt.strip() or frame_prompt(db, shot, kind), params.get("brand_prompt"))
        models_catalog.apply_image_choice(params, project.settings)
    else:
        start, end = take_frames(db, shot)
        if start is None:
            raise HTTPException(409, "Approve a START frame first" + (
                " (this shot continues from the previous shot's END frame, which isn't approved yet)"
                if is_linked(shot, prev) else ""))
        duration = float(params.get("duration_s") or shot.duration_s or 4)
        w, h = draft_size(params["aspect_ratio"])
        params.update(
            first_frame_id=start.id,
            last_frame_id=end.id if end else None,
            duration_s=duration,
            fps=FPS,
            num_frames=min(frames_for(duration, FPS), MAX_TAKE_FRAMES),
        )
        params.setdefault("width", w)
        params.setdefault("height", h)
        from app import longtake  # imports this module

        if not 1 <= duration <= get_settings().longtake_max_s:
            raise HTTPException(422, f"duration_s must be between 1 and {get_settings().longtake_max_s:g} seconds")
        if longtake.is_long(duration):
            longtake.init_params(params)
        else:
            for k in ("longtake", "chunks", "assembly", "continuity", "context_frames", "longtake_stats"):
                params.pop(k, None)
        models_catalog.apply_take_quality(params, project.settings, long_take=longtake.is_long(duration))
        steady = bm.hero_motion(db, shot, project)
        if steady:
            params["brand_prompt"] = steady
        else:
            params.pop("brand_prompt", None)
        prompt = bm.with_fragment(prompt.strip() or frame_prompt(db, shot, "take"), steady)

    if not prompt:
        # the worker compiles start/end/motion prompts before rendering
        params["compile_first"] = True
    else:
        params.pop("compile_first", None)
    return prompt, params


def prepare_location_generation(db: Session, loc: Location, kind: str, prompt: str, params: dict) -> tuple[str, dict]:
    if kind not in LOCATION_KINDS:
        raise HTTPException(422, f"A location can't have a '{kind}' generation")
    project = _project(db, loc.project_id)
    params = dict(params or {})
    params.setdefault("aspect_ratio", project.aspect_ratio)
    models_catalog.apply_image_choice(params, project.settings)
    prompt = prompt.strip() or (
        f"Establishing shot of {loc.name}. {loc.description}".strip() + " No people, wide angle, cinematic."
    )
    return with_style(project, prompt), params


# ---------------------------------------------------------------- script timing

_CUE = re.compile(r"^[A-Z][A-Z0-9 .'\-]{1,40}(\s*\([^)]*\))?$")


def script_duration(text: str, lo: float = 2.0, hi: float = 20.0) -> float:
    """Screen time from a flush-left script: dialogue at ~150 wpm, action lines a bit faster."""
    dialogue = action = 0
    in_dialogue = False
    for raw in (text or "").split("\n"):
        line = raw.strip()
        if not line:
            in_dialogue = False
            continue
        if _CUE.match(line) and len(line.split()) <= 5:
            in_dialogue = True
            continue
        if line.startswith("(") and line.endswith(")"):
            continue
        n = len(line.split())
        if in_dialogue:
            dialogue += n
        else:
            action += n
    seconds = dialogue / 2.5 + action / 3.5
    return max(lo, min(hi, round(seconds * 2) / 2))
