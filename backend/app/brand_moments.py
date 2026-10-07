"""Brand moments inside the advert (PLAN-m8 B2): the planner places the logo and products on real
surfaces, keyframes carry them as edit references, the vision model checks the logo, and the film
ends on a packshot or the exact logo reveal.

The pieces in app.brand are the building blocks; this module wires them into storyboard,
ai_jobs and the autopilot so those modules only make one call each.
"""
import json
import logging

from sqlalchemy import select
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app import brand
from app.brand_schemas import merged_settings
from app.llm import prompts as P
from app.models import BrandKit, Generation, Job, Project, Scene, Shot, Suggestion, utcnow
from app.services import approve, generation_file, next_version

log = logging.getLogger("mixai.brand_moments")

CLOSING_SHOT = "brand_closing_shot"  # project.settings: {"shot_id", "mode"}
CLOSING_MODES = ("auto", "ai_packshot", "logo_reveal", "none")
REVEAL_S = 3.0
PACKSHOT_S = 4.0
MAX_PER_SHOT = 3
KEYFRAMES = ("keyframe_start", "keyframe_end", "keyframe_mid")
HERO_MOTION = ("Slow, steady camera move, no shake, no whip pans or fast zooms; {subject} stays sharp, "
               "front-facing and undistorted for the whole shot.")


def project_kit(db: Session, project: Project) -> BrandKit | None:
    return brand.get_kit(db, project.workspace_id, project_id=project.id)


def _logo_id(kit: BrandKit) -> str | None:
    for v in ("primary", "light", "dark"):
        mid = brand.logo_ref(kit, v).get("media_id")
        if mid:
            return mid
    return None


def closing_mode(kit: BrandKit, project: Project | None = None) -> str | None:
    """ai_packshot / logo_reveal / None. The project setting wins over the kit's; auto means a
    packshot when the kit has products, else the exact reveal. Falls back to whatever the kit can do."""
    want = ((project.settings or {}).get("brand_closing") if project is not None else None) \
        or merged_settings(kit.settings).closing
    has_logo = bool(_logo_id(kit))
    has_product = any(p.get("media_id") for p in kit.products or [])
    if want == "none":
        return None
    if want not in ("ai_packshot", "logo_reveal"):
        want = "ai_packshot" if has_product else "logo_reveal"
    if want == "logo_reveal" and not has_logo:
        want = "ai_packshot" if has_product else None
    if want == "ai_packshot" and not has_product:
        want = "logo_reveal" if has_logo else None
    return want


# ---------------------------------------------------------------- planner side

def asset_handles(kit: BrandKit) -> list[tuple[str, dict]]:
    """Short ids the LLM can copy reliably ("logo", "product1") instead of UUIDs."""
    out = []
    lid = _logo_id(kit)
    if lid:
        desc = (brand.logo_ref(kit).get("description") or "").strip()
        out.append(("logo", {"asset_id": lid, "asset_type": "logo",
                             "what": f"the {kit.name} logo" + (f" ({desc})" if desc else "")}))
    for i, p in enumerate([p for p in kit.products or [] if p.get("media_id")], start=1):
        desc = (p.get("description") or "").strip()
        out.append((f"product{i}", {"asset_id": p["media_id"], "asset_type": "product",
                                    "what": p["name"] + (f" ({desc})" if desc else "")}))
    return out


def planner_brief(kit: BrandKit) -> str:
    return P.brand_brief(brand.prompt_context(kit), [(h, a["what"]) for h, a in asset_handles(kit)])


def placements_from(kit: BrandKit, ideas) -> list[dict]:
    """The planner's ideas -> shot.brand_placements. Unknown assets drop out; at most MAX_PER_SHOT."""
    handles = dict(asset_handles(kit))
    by_id = {a["asset_id"]: a for a in handles.values()}
    by_name = {(p.get("name") or "").casefold(): by_id.get(p.get("media_id")) for p in kit.products or []}
    out, seen = [], set()
    for idea in ideas or []:
        raw = idea.asset_id if hasattr(idea, "asset_id") else str((idea or {}).get("asset_id") or "")
        key = raw.strip().lower().replace(" ", "").replace("_", "")
        a = handles.get(key) or by_id.get(raw.strip()) or by_name.get(raw.strip().casefold())
        if a is None:
            continue
        surface = (getattr(idea, "surface", None) or "").strip()[:200]
        prominence = getattr(idea, "prominence", "background")
        if (a["asset_id"], surface.casefold()) in seen:
            continue
        seen.add((a["asset_id"], surface.casefold()))
        out.append({"asset_id": a["asset_id"], "asset_type": a["asset_type"], "surface": surface,
                    "prominence": prominence, "source": "ai"})
    return out[:MAX_PER_SHOT]


def user_placed(shot: Shot) -> bool:
    """Placements the user edited are theirs: the AI only suggests changes to them. An empty list is
    an empty field, which the AI may fill (same rule as ai_jobs.ai_may_write)."""
    return any(p.get("source") == "user" for p in shot.brand_placements or [])


# ---------------------------------------------------------------- closing shot

def closing_record(project: Project) -> dict:
    return dict((project.settings or {}).get(CLOSING_SHOT) or {})


def closing_of(db: Session, shot: Shot) -> str | None:
    """'ai_packshot' / 'logo_reveal' when this shot is the advert's closing shot."""
    p = db.get(Project, shot.project_id)
    rec = closing_record(p) if p is not None else {}
    return rec.get("mode") if rec.get("shot_id") == shot.id else None


def is_reveal(db: Session, shot: Shot) -> bool:
    return closing_of(db, shot) == "logo_reveal"


def _set_record(project: Project, rec: dict | None) -> None:
    s = dict(project.settings or {})
    if rec:
        s[CLOSING_SHOT] = rec
    else:
        s.pop(CLOSING_SHOT, None)
    project.settings = s
    flag_modified(project, "settings")


def _packshot(kit: BrandKit) -> dict:
    prod = next(p for p in kit.products or [] if p.get("media_id"))
    desc = (prod.get("description") or "").strip()
    what = prod["name"] + (f" ({desc})" if desc else "")
    look = brand.image_prompt_suffix(kit)
    logo = _logo_id(kit)
    logo_bit = f", the {kit.name} logo on the front of the packaging, facing the camera" if logo else ""
    placements = [{"asset_id": prod["media_id"], "asset_type": "product", "surface": "a clean surface in the centre "
                   "of the frame", "prominence": "hero", "source": "ai"}]
    if logo:
        placements.append({"asset_id": logo, "asset_type": "logo", "surface": f"{prod['name']} packaging",
                           "prominence": "hero", "source": "ai"})
    return {
        "shot_type": "insert", "duration_s": PACKSHOT_S,
        "description": f"Closing packshot: the {prod['name']} with the {kit.name} logo, slow push-in.",
        "camera": "slow, steady push-in",
        "start_prompt": f"Commercial packshot of the {what} standing alone in the centre of the frame on a clean "
                        f"surface{logo_bit}, soft studio key light, gentle reflections, uncluttered background"
                        + (f", {look}" if look else "") + ".",
        "end_prompt": f"Closer framing of the same packshot: the {what} fills the middle of the frame{logo_bit}, "
                      "crisp detail, soft studio light, the logo sharp and legible.",
        "motion_prompt": f"Slow, steady push-in toward the {prod['name']}; a smooth dolly with no shake, light "
                         "glinting across the packaging; the logo stays sharp and undistorted.",
        "brand_placements": placements,
    }


def _reveal(kit: BrandKit) -> dict:
    return {"shot_type": "insert", "duration_s": REVEAL_S,
            "description": f"Closing logo reveal: the exact {kit.name} logo from the brand kit.",
            "camera": "locked off", "start_prompt": "", "end_prompt": "", "motion_prompt": "", "brand_placements": []}


def _film_tail(db: Session, project: Project, skip: str | None) -> tuple[Scene | None, list[Shot]]:
    scenes = list(db.scalars(select(Scene).where(Scene.project_id == project.id)
                             .order_by(Scene.order, Scene.created_at)).all())
    from app import storyboard as sb

    for sc in reversed(scenes):
        shots = [s for s in sb.scene_shots(db, sc.id) if s.id != skip]
        if shots:
            return sc, shots
    return None, []


def ensure_closing(db: Session, project: Project, kit: BrandKit | None = None) -> Shot | None:
    """Make sure an advert ends on its closing shot (appended to the last storyboarded scene). Idempotent:
    an existing closing shot of the right kind is moved back to the end, one of the wrong kind is replaced."""
    kit = kit or project_kit(db, project)
    if kit is None:
        return None
    mode = closing_mode(kit, project)
    rec = closing_record(project)
    existing = db.get(Shot, rec["shot_id"]) if rec.get("shot_id") else None
    if existing is not None and existing.project_id != project.id:
        existing = None
    if mode is None:
        return existing
    scene, shots = _film_tail(db, project, existing.id if existing else None)
    if scene is None:
        return None  # nothing storyboarded yet; the storyboard job calls back
    from app import storyboard as sb

    if existing is not None and rec.get("mode") == mode:
        if existing.scene_id != scene.id or existing.order <= max(s.order for s in shots):
            existing.scene_id = scene.id
            sb.renumber(shots + [existing])
        if mode == "logo_reveal":
            queue_reveal_take(db, existing, kit)  # no-op while this kit's reveal is there
        return existing
    if existing is not None:
        sb.delete_shots(db, [existing])
        db.flush()
    plan = _packshot(kit) if mode == "ai_packshot" else _reveal(kit)
    shot = Shot(workspace_id=project.workspace_id, project_id=project.id, scene_id=scene.id,
                order=len(shots) + 1, source="ai", locked=False, prompt_mode="manual", seam_in="cut",
                handoff_text="", location_id=None, **{k: v for k, v in plan.items() if k != "brand_placements"})
    shot.character_ids = []
    shot.brand_placements = plan["brand_placements"]
    db.add(shot)
    db.flush()
    sb.renumber(shots + [shot])
    _set_record(project, {"shot_id": shot.id, "mode": mode, "kit_id": kit.id})
    if mode == "logo_reveal":
        queue_reveal_take(db, shot, kit)
    return shot


def queue_reveal_take(db: Session, shot: Shot, kit: BrandKit, *, autopilot: str | None = None) -> Generation:
    """The exact reveal as this shot's take: a CPU job (brand_reveal) at the reel's draft size and 24 fps
    with a silent 48 kHz stereo track, approved when it lands (on_job_finished) so the Reel picks it up."""
    for g in db.scalars(select(Generation).where(Generation.target_type == "shot", Generation.target_id == shot.id,
                                                 Generation.kind == "take")):
        p = g.params or {}
        if p.get("source") == "logo_reveal" and g.status in ("queued", "generating", "ready", "approved") \
                and (p.get("brand_reveal") or {}).get("kit_id") == kit.id:
            return g
    from app import storyboard as sb

    project = db.get(Project, shot.project_id)
    # TODO: an upscaled film upscales this draft-size clip too; render it at the target size instead
    w, h = sb.draft_size(project.aspect_ratio)
    dur = float(shot.duration_s or REVEAL_S)
    params = {"source": "logo_reveal", "aspect_ratio": project.aspect_ratio,
              "brand_reveal": {"kit_id": kit.id, "aspect": project.aspect_ratio,
                               "background": {"kind": "color", "color": None}, "show_tagline": True},
              "brand": {"kit_id": kit.id, "kit_name": kit.name, "applied": ["logo_reveal"]},
              "size": [w, h], "duration_s": dur, "fps": 24, "created_by": {"flow": "brand_closing"}}
    if autopilot:
        params["autopilot"] = autopilot
    g = Generation(workspace_id=shot.workspace_id, project_id=shot.project_id, target_type="shot",
                   target_id=shot.id, kind="take", version=next_version(db, "shot", shot.id, "take"),
                   status="queued", prompt=f"{kit.name} logo reveal", params=params, seed=0)
    db.add(g)
    db.flush()
    payload = {"generation_id": g.id, "kit_id": kit.id}
    if autopilot:
        payload["parent_job_id"] = autopilot
    job = Job(workspace_id=shot.workspace_id, type=brand.REVEAL_JOB, project_id=shot.project_id, generation_id=g.id,
              message="Waiting for a worker · logo reveal", payload=payload)
    db.add(job)
    db.flush()
    g.job_id = job.id
    return g


# ---------------------------------------------------------------- keyframes and takes

def keyframe_refs(db: Session, shot: Shot, project: Project, params: dict, base_ids: list[str],
                  base_labels: list[str]) -> bool:
    """Brand references for a keyframe with placements: hero placements, then characters/location, then
    background placements, within the edit model's max_refs. Fills reference_ids/labels, edit_model and
    brand_prompt (the surface fragment). Returns False when there's nothing to do."""
    placements = shot.brand_placements or []
    kit = project_kit(db, project) if placements else None
    if kit is None:
        return False
    from app import models_catalog as mc

    em = mc.get(params.get("edit_model") or (project.settings or {}).get("edit_model"), "edit")
    rs = brand.brand_reference_set(kit, placements, em.max_refs or brand.EDIT_MAX_REFS, base_ids)
    names = dict(zip(base_ids, base_labels))
    ids, labels = [], []
    for mid, label in zip(rs.media_ids, rs.labels):
        got = brand.resolve_reference_ids(db, shot.workspace_id, [mid])
        if got and got[0] not in ids:
            ids.append(got[0])
            labels.append(names.get(mid, label))
    if ids:
        params["reference_ids"], params["reference_labels"] = ids, labels
        params["edit_model"] = em.id
    if rs.prompt:
        params["brand_prompt"] = rs.prompt
    hero = next((p for p in placements if p.get("prominence") == "hero" and p.get("asset_type") == "logo"), None)
    if hero is not None:
        params["brand_check"] = {"kit_id": kit.id, "logo_media_id": hero.get("asset_id") or _logo_id(kit),
                                 "surface": hero.get("surface") or ""}
    params["brand"] = {"kit_id": kit.id, "placements": len(placements), "dropped": rs.dropped}
    return True


def hero_motion(db: Session, shot: Shot, project: Project) -> str:
    """Motion prompt tail for hero brand shots: slow, stable camera keeps the logo from warping."""
    hero = [p for p in shot.brand_placements or [] if p.get("prominence") == "hero"]
    if not hero:
        return ""
    kit = project_kit(db, project)
    if kit is None:
        return ""
    subject = "the logo" if any(p.get("asset_type") == "logo" for p in hero) else "the product"
    return HERO_MOTION.format(subject=subject)


def with_fragment(prompt: str, fragment: str | None) -> str:
    if not fragment or not prompt.strip() or fragment in prompt:
        return prompt
    return f"{prompt.rstrip().rstrip('.')}. {fragment}"


# ---------------------------------------------------------------- logo check

def logo_verdict(db: Session, g: Generation) -> dict | None:
    """params.logo_check for a keyframe that carries a hero logo, running the vision check once.
    None when the frame has no hero logo to check."""
    p = g.params or {}
    bc = p.get("brand_check")
    if not bc:
        return None
    if p.get("logo_check"):
        return p["logo_check"]
    logo = brand.media_file(db, g.workspace_id, bc.get("logo_media_id"))
    frame = generation_file(g)
    if logo is None or frame is None or not frame.is_file():
        res = {"checked": False, "reason": "the logo or frame file is missing"}
    else:
        res = brand.check_logo(frame, logo, bc.get("surface") or None)
    keep = {k: res.get(k) for k in ("checked", "passed", "present", "legible", "distorted", "score", "issues", "reason")
            if k in res}
    # the UI shows "check the logo" on frames that failed; a frame we couldn't check isn't flagged
    keep["needs_review"] = bool(res.get("checked") and not res.get("passed"))
    g.params = {**p, "logo_check": keep}
    return keep


def logo_ok(g: Generation) -> bool:
    lc = (g.params or {}).get("logo_check")
    return not lc or not lc.get("checked") or bool(lc.get("passed"))


def on_job_finished(db: Session, job: Job) -> None:
    """Worker hook: approve a closing reveal take; logo-check a studio keyframe with a hero logo."""
    if job.status != "done" or not job.generation_id:
        return
    g = db.get(Generation, job.generation_id)
    if g is None or g.target_type != "shot":
        return
    if job.type == brand.REVEAL_JOB and g.kind == "take" and g.status == "ready":
        approve(db, g)
        g.params = {**(g.params or {}), "approved_by": "brand_closing"}
        return
    if job.type == "generate" and g.kind in KEYFRAMES and g.status in ("ready", "approved"):
        try:
            logo_verdict(db, g)
        except Exception:  # the frame is fine either way; the check is advice
            log.exception("logo check failed for %s", g.id)


# ---------------------------------------------------------------- re-plan brand moments (studio)

def plan_existing(run, db: Session, project: Project, job_id: str | None, frac: float = 0.1) -> dict:
    """One reasoning call over the whole shot list. Shots whose placements the user edited get a
    Suggestion; the rest are written. Ends with ensure_closing."""
    from app import storyboard as sb

    kit = project_kit(db, project)
    if kit is None:
        raise RuntimeError("This project has no brand kit. Pick one in the project settings first.")
    rec = closing_record(project)
    shots = [s for s in sb.project_shots(db, project.id) if s.id != rec.get("shot_id")]
    if not shots:
        raise RuntimeError("There are no shots yet. Storyboard the film first.")
    listing = [(i, f"{s.shot_type.replace('_', ' ')}, {s.duration_s:g} s. {s.description or s.start_prompt[:200]}")
               for i, s in enumerate(shots, start=1)]
    res = run.call("Planning brand moments", frac, "reasoning", P.brand_moments_messages(project, listing,
                                                                                       planner_brief(kit)),
                   schema=P.BrandMoments, temperature=0.4, max_tokens=3000)
    plans = {sp.shot: placements_from(kit, sp.brand_placements) for sp in res.data.shots}
    written, suggestions = [], []
    for i, s in enumerate(shots, start=1):
        new = plans.get(i, [])
        old = list(s.brand_placements or [])
        if [_core(p) for p in new] == [_core(p) for p in old]:
            continue
        if user_placed(s):
            sug = Suggestion(workspace_id=s.workspace_id, project_id=s.project_id, target_type="shot", target_id=s.id,
                             field="brand_placements", action="brand_moments", job_id=job_id,
                             current_text=json.dumps(old), proposed_text=json.dumps(new))
            db.add(sug)
            db.flush()
            suggestions.append(sug.id)
        else:
            s.brand_placements = new
            s.updated_at = utcnow()
            written.append(s.id)
    closing = ensure_closing(db, project, kit)
    return {"shot_ids": written, "suggestion_ids": suggestions, "closing_shot_id": closing.id if closing else None}


def _core(p: dict) -> tuple:
    return p.get("asset_id"), p.get("surface"), p.get("prominence")
