"""AI video podcast (contract v24): the record, its hidden project (hosts as Characters, the set as a Location,
the angle library and one Shot per planned shot), take signatures and the shapes the API returns. The stage
machine that fills it in is app.podcast.video_stages."""
import hashlib
import json
import math
import shutil
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app import audio_analysis as aa
from app import dialogue as dl
from app import estimate as est
from app import library as lib
from app import reel as rl
from app import storyboard as sb
from app.config import get_settings
from app.drivers.comfy import HQ_SIZES, MAX_FRAMES, VIDEO_SIZES
from app.models import (Character, Generation, Job, Location, MediaItem, PodcastEpisode, Project, Scene, Shot,
                        VideoPodcast, new_id, utcnow)
from app.podcast import service as sv
from app.podcast import vplan
from app.services import approve, gen_out, generation_file, job_out, media_url, new_seed, next_version
from app.workflows import frames_for

JOB = "video_podcast"
ASSEMBLE_JOB = "video_podcast_assemble"
STAGES = (("cast", "Hosts"), ("set", "Set"), ("keyframes", "Look"), ("plan", "Shots"), ("render", "Render"),
          ("assemble", "Assemble"))
CONTINUE_STAGES = ("cast", "set", "keyframes", "plan")
QUALITIES = ("draft", "final")
ASPECTS = ("16:9", "9:16", "1:1")
FINISHED = ("ready", "approved")
LIVE = ("queued", "generating")
CONSENT = "I have the right to use this person's likeness, and they agreed to it being animated."

# the hidden project's style bible rides on every angle frame
STYLE = ("Photorealistic podcast studio footage, natural skin texture, soft key light with a warm rim light, "
         "shallow depth of field, true-to-life colour.")
SET_PRESETS = {
    "modern_studio": ("Modern studio", "a modern podcast studio with acoustic foam panels, warm LED strip lights, "
                                       "a round wooden table and boom-arm microphones"),
    "cosy_room": ("Cosy room", "a cosy living-room podcast set with bookshelves, warm table lamps, armchairs, a rug "
                               "and plants, microphones on stands"),
    "news_desk": ("News desk", "a television news desk set with a long glossy desk, a city skyline screen behind, "
                               "bright even studio lighting and desk microphones"),
    "rooftop": ("Rooftop", "a rooftop podcast set at golden hour with the city skyline behind, string lights, "
                           "lounge chairs and microphones on stands"),
    "desi_baithak": ("Desi baithak", "a traditional South Asian baithak with low floor seating, gao takiya bolsters, "
                                     "a hand-woven rug, a carved wooden jharokha, brass lamps and warm light, "
                                     "microphones on low stands"),
}
DEFAULT_SETTINGS = {"aspect": "16:9", "style": "realistic studio", "subtitles": "burn", "set_preset": "modern_studio",
                    "set_prompt": "", "cover_intro": False, "cover_outro": False, "cover_media_id": None}
ANGLE_LABELS = {"close": "Close-up", "three_quarter": "3/4 close-up", "listen": "Listening", "wide": "Wide",
                "medium": "Two-shot"}
SHOT_TYPES = {"lipsync": "close_up", "medium": "medium", "reaction": "close_up", "wide": "wide", "cover": "insert"}
# rough extra GPU time per take on top of the per-second rate: text encode, audio encode, VAE decode
TAKE_OVERHEAD_S = 8.0
IA2V_FACTOR = 1.15


class VideoPodcastError(RuntimeError):
    pass


# ---------------------------------------------------------------- record basics

def settings_of(vp: VideoPodcast) -> dict:
    return {**DEFAULT_SETTINGS, **(vp.settings or {})}


def initial_stages() -> dict:
    return {k: {"status": "pending"} for k, _ in STAGES}


def stage(vp: VideoPodcast, key: str) -> dict:
    return dict((vp.stages or {}).get(key) or {"status": "pending"})


def put_stage(vp: VideoPodcast, key: str, rec: dict) -> None:
    vp.stages = {**(vp.stages or {}), key: rec}
    flag_modified(vp, "stages")


def refs(vp: VideoPodcast) -> dict:
    return dict((vp.stages or {}).get("refs") or {})


def put_refs(vp: VideoPodcast, rec: dict) -> None:
    vp.stages = {**(vp.stages or {}), "refs": rec}
    flag_modified(vp, "stages")


def put_host(vp: VideoPodcast, host_id: str, entry: dict) -> None:
    vp.hosts = {**(vp.hosts or {}), host_id: entry}
    flag_modified(vp, "hosts")


def reset_from(vp: VideoPodcast, key: str) -> None:
    """Back to `key`: it and every later stage are pending again (their generations stay)."""
    keys = [k for k, _ in STAGES]
    for k in keys[keys.index(key):]:
        rec = stage(vp, k)
        rec.update(status="pending", detail=None)
        put_stage(vp, k, rec)
    if vp.stage not in keys or keys.index(vp.stage) > keys.index(key):
        vp.stage = key


def busy(db: Session, vp: VideoPodcast) -> Job | None:
    j = db.get(Job, vp.job_id) if vp.job_id else None
    return j if j is not None and j.status in ("queued", "running") else None


def ensure_idle(db: Session, vp: VideoPodcast) -> None:
    if busy(db, vp) is not None:
        raise HTTPException(409, "The AI video is working; wait for it, or cancel the job")


def episode_of(db: Session, vp: VideoPodcast) -> PodcastEpisode:
    ep = db.get(PodcastEpisode, vp.episode_id)
    if ep is None:
        raise VideoPodcastError("The episode for this AI video no longer exists")
    return ep


def check_consent(consent: dict | None, user_id: str) -> dict:
    c = consent or {}
    name = " ".join(str(c.get("name") or "").split())[:120]
    if not name:
        raise HTTPException(422, "Using a photo of a real person needs a consent record: the person's name")
    if " ".join(str(c.get("statement") or "").split()) != CONSENT:
        raise HTTPException(422, f"The consent statement must read exactly: “{CONSENT}”")
    return {"name": name, "statement": CONSENT, "at": utcnow().isoformat() + "Z", "user_id": user_id}


# ---------------------------------------------------------------- creating it

def find(db: Session, ep: PodcastEpisode) -> VideoPodcast | None:
    return db.scalars(select(VideoPodcast).where(VideoPodcast.episode_id == ep.id)).first()


def create(db: Session, ep: PodcastEpisode, aspect: str | None) -> tuple[VideoPodcast, bool]:
    vp = find(db, ep)
    if vp is not None:
        return vp, False
    if not ep.hosts:
        raise HTTPException(409, "Add the episode's hosts first")
    aspect = aspect if aspect in ASPECTS else "16:9"
    mix = (ep.outputs or {}).get("mix") or {}
    project = Project(workspace_id=ep.workspace_id, title=f"{ep.title} · AI video"[:300], authoring_mode="podcast",
                      aspect_ratio=aspect, style_bible=STYLE, brief="",
                      target_runtime_s=max(1, int(math.ceil(mix.get("duration_s") or 60))), quality="draft",
                      takes_per_shot=1, settings={"podcast_episode_id": ep.id})
    db.add(project)
    db.flush()
    vp = VideoPodcast(workspace_id=ep.workspace_id, episode_id=ep.id, project_id=project.id, stage="cast",
                      stages=initial_stages(), settings={**DEFAULT_SETTINGS, "aspect": aspect}, hosts={}, plan=[],
                      outputs={})
    db.add(vp)
    db.flush()
    sync_hosts(db, vp, ep)
    return vp, True


def sync_hosts(db: Session, vp: VideoPodcast, ep: PodcastEpisode) -> None:
    """One Character per episode host; a host added to the episode later gets one, a removed host loses its."""
    cur = dict(vp.hosts or {})
    wanted = {h["id"]: h for h in ep.hosts or []}
    for hid, h in wanted.items():
        entry = cur.get(hid)
        c = db.get(Character, entry["character_id"]) if entry else None
        if c is None:
            c = Character(workspace_id=vp.workspace_id, project_id=vp.project_id, name=h["name"][:200],
                          description="", source="podcast")
            db.add(c)
            db.flush()
            cur[hid] = {"character_id": c.id, "source": "persona", "rev": (entry or {}).get("rev", 0) + 1}
        elif c.name != h["name"]:
            c.name = h["name"][:200]
    for hid in [k for k in cur if k not in wanted]:
        del cur[hid]
    if cur != (vp.hosts or {}):
        vp.hosts = cur
        flag_modified(vp, "hosts")


def hosts_in_order(vp: VideoPodcast, ep: PodcastEpisode) -> list[dict]:
    return [h for h in ep.hosts or [] if h["id"] in (vp.hosts or {})]


# ---------------------------------------------------------------- hosts

def portraits(db: Session, character_id: str) -> list[Generation]:
    return list(db.scalars(select(Generation).where(
        Generation.target_type == "character", Generation.target_id == character_id, Generation.kind == "portrait",
    ).order_by(Generation.created_at.desc())).all())


def fresh(gens: list[Generation], key: str, value) -> list[Generation]:
    return [g for g in gens if (g.params or {}).get(key) == value]


def current_portrait(db: Session, entry: dict) -> Generation | None:
    """The approved portrait of this host choice, else its newest one (any status)."""
    gens = fresh(portraits(db, entry["character_id"]), "vp_rev", entry.get("rev"))
    return next((g for g in gens if g.status == "approved"), None) or next(iter(gens), None)


def usable_portrait(db: Session, entry: dict) -> Generation | None:
    gens = fresh(portraits(db, entry["character_id"]), "vp_rev", entry.get("rev"))
    return next((g for g in gens if g.status == "approved"), None) or \
        next((g for g in gens if g.status == "ready"), None)


def _copy_file(g: Generation, project_id: str, gen_id: str) -> str:
    src = generation_file(g)
    if src is None or not src.is_file():
        raise HTTPException(409, "That character's portrait file is missing")
    rel = Path("workspaces") / g.workspace_id / "projects" / project_id / "generations" / f"{gen_id}{src.suffix}"
    dst = get_settings().data_dir / rel
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src, dst)
    return rel.as_posix()


def choose_host(db: Session, cur, vp: VideoPodcast, ep: PodcastEpisode, host_id: str, choice: dict) -> None:
    entry = dict((vp.hosts or {}).get(host_id) or {})
    if not entry:
        raise HTTPException(422, f"This episode has no host '{host_id}'")
    c = db.get(Character, entry["character_id"])
    host = next(h for h in ep.hosts if h["id"] == host_id)
    src = choice.get("source")
    rev = int(entry.get("rev") or 0) + 1
    new = {"character_id": c.id, "source": src, "rev": rev}
    if src == "persona":
        c.description = ""
    elif src == "photo":
        item = db.get(MediaItem, choice.get("media_id") or "")
        if item is None or item.workspace_id != vp.workspace_id:
            raise HTTPException(404, "That photo isn't in the Library")
        if item.kind != "image":
            raise HTTPException(422, "The photo has to be an image")
        g = db.get(Generation, item.generation_id or "")
        if g is None or g.status not in FINISHED or not g.file_path:
            raise HTTPException(409, "That photo isn't finished yet")
        # consent first, as for a voice clone: nothing is made from a real person without it
        new.update(photo_media_id=item.id, photo_generation_id=g.id,
                   consent=check_consent(choice.get("consent"), cur.id))
        c.description = c.description or f"{host['name']}, from the uploaded photo"
    elif src == "existing":
        other = db.get(Character, choice.get("character_id") or "")
        if other is None or other.workspace_id != vp.workspace_id:
            raise HTTPException(404, "That character doesn't exist")
        if other.project_id == vp.project_id:
            raise HTTPException(422, "Pick a character from another project")
        og = sb.approved(db, "character", other.id, "portrait") or next(
            (g for g in portraits(db, other.id) if g.status == "ready" and g.file_path), None)
        if og is None:
            raise HTTPException(409, f"{other.name} has no portrait yet")
        c.description = other.description
        gid = new_id()
        copy = Generation(id=gid, workspace_id=vp.workspace_id, project_id=vp.project_id, target_type="character",
                          target_id=c.id, kind="portrait", version=next_version(db, "character", c.id, "portrait"),
                          status="ready", prompt=og.prompt, seed=og.seed, media_type=og.media_type,
                          file_path=_copy_file(og, vp.project_id, gid),
                          params={**(og.params or {}), "copied_from": og.id, "vp": vp.id, "vp_rev": rev})
        db.add(copy)
        db.flush()
        approve(db, copy)
        new["from_character_id"] = other.id
    else:
        raise HTTPException(422, "A host is made from its persona, a photo or an existing character")
    put_host(vp, host_id, new)


# ---------------------------------------------------------------- the set and the angle library

def set_description(vp: VideoPodcast) -> str:
    st = settings_of(vp)
    base = SET_PRESETS.get(st["set_preset"], SET_PRESETS["modern_studio"])[1]
    extra = " ".join(str(st.get("set_prompt") or "").split())
    return f"{base}. {extra}".strip() if extra else base


def set_prompt(vp: VideoPodcast, n_hosts: int) -> str:
    seats = {1: "one seat", 2: "two seats facing each other", 3: "three seats in a gentle arc"}.get(
        n_hosts, f"{n_hosts} seats in a gentle arc")
    return (f"Establishing wide shot of {set_description(vp)}. {seats.capitalize()}, each with its own microphone, "
            "set up for a conversation; nobody in the shot. Photorealistic, eye-level camera, clean composition.")


def set_key(vp: VideoPodcast, n_hosts: int) -> str:
    st = settings_of(vp)
    return hashlib.sha1(json.dumps([set_prompt(vp, n_hosts), st["aspect"]]).encode()).hexdigest()[:16]


def ensure_location(db: Session, vp: VideoPodcast) -> Location:
    loc = db.get(Location, vp.set_location_id or "")
    st = settings_of(vp)
    name = SET_PRESETS.get(st["set_preset"], SET_PRESETS["modern_studio"])[0]
    if loc is None:
        loc = Location(workspace_id=vp.workspace_id, project_id=vp.project_id, name=name, source="podcast",
                       description=set_description(vp))
        db.add(loc)
        db.flush()
        vp.set_location_id = loc.id
    else:
        loc.name, loc.description = name, set_description(vp)
    return loc


def establishing(db: Session, vp: VideoPodcast, fresh_only: bool = True) -> Generation | None:
    if not vp.set_location_id:
        return None
    gens = list(db.scalars(select(Generation).where(
        Generation.target_type == "location", Generation.target_id == vp.set_location_id,
        Generation.kind == "establishing").order_by(Generation.created_at.desc())).all())
    if fresh_only:
        ep_hosts = len(vp.hosts or {})
        gens = fresh(gens, "vp_set", set_key(vp, ep_hosts))
    return next((g for g in gens if g.status == "approved"), None) or next(iter(gens), None)


def angle_keys(vp: VideoPodcast, ep: PodcastEpisode) -> list[tuple[str, str | None, str]]:
    """(key, host_id, angle) for the whole library, hosts in episode order then the shared shots."""
    out = []
    for h in hosts_in_order(vp, ep):
        out += [(vplan.angle_key(h["id"], a), h["id"], a) for a in vplan.HOST_ANGLES]
    out += [(a, None, a) for a in vplan.SHARED_ANGLES]
    return out


def ensure_scenes(db: Session, vp: VideoPodcast) -> dict:
    r = refs(vp)
    for key, heading, order in (("angles_scene", "ANGLE LIBRARY", 1), ("episode_scene", "EPISODE", 2)):
        if not r.get(key) or db.get(Scene, r[key]) is None:
            sc = Scene(workspace_id=vp.workspace_id, project_id=vp.project_id, order=order, heading=heading,
                       source="podcast", locked=True)
            db.add(sc)
            db.flush()
            r[key] = sc.id
    put_refs(vp, r)
    return r


def host_names(db: Session, vp: VideoPodcast, ep: PodcastEpisode) -> dict[str, str]:
    return {h["id"]: h["name"] for h in hosts_in_order(vp, ep)}


def _desc(db: Session, vp: VideoPodcast, host_id: str) -> str:
    c = db.get(Character, ((vp.hosts or {}).get(host_id) or {}).get("character_id") or "")
    return " ".join((c.description if c else "").split())[:300]


def angle_prompt(db: Session, vp: VideoPodcast, ep: PodcastEpisode, host_id: str | None, angle: str) -> str:
    names = host_names(db, vp, ep)
    place = set_description(vp)
    if host_id:
        who = names.get(host_id, "The host")
        look = _desc(db, vp, host_id)
        lead = f"{who} ({look})" if look else who
        frame = {"close": "Close-up, head and shoulders, of", "three_quarter": "Three-quarter close-up of",
                 "listen": "Close-up of"}[angle]
        act = ("listening to the co-host, attentive, slight nod, mouth closed" if angle == "listen" else
               "speaking into a podcast microphone, mid-sentence, natural expression, looking towards the co-host")
        return f"{frame} {lead} seated in {place}, {act}. Shallow depth of field, the set softly blurred behind."
    who = " and ".join(names.values()) or "the hosts"
    if angle == "wide":
        return (f"Wide shot of {place} with {who} seated at their microphones in conversation, everyone in frame, "
                "eye-level camera.")
    return (f"Medium two-shot of {who} at their microphones in {place}, talking with each other, both faces "
            "clearly visible.")


def angle_refs(db: Session, vp: VideoPodcast, ep: PodcastEpisode, host_id: str | None,
               angle: str) -> tuple[list[str], list[str]]:
    names = host_names(db, vp, ep)
    ids, labels = [], []
    hosts = [host_id] if host_id else list(names)[:2]
    for hid in hosts:
        entry = (vp.hosts or {}).get(hid) or {}
        g = usable_portrait(db, entry)
        if angle == "three_quarter":
            sheet = db.get(Generation, ((entry.get("sheets") or {}).get("three_quarter")) or "")
            if sheet is not None and sheet.status in FINISHED:
                g = sheet
        if g is not None:
            ids.append(g.id)
            labels.append(names.get(hid, "the host"))
    est_g = establishing(db, vp)
    if est_g is not None and est_g.status in FINISHED:
        ids.append(est_g.id)
        labels.append("the podcast set")
    return ids[:sb.MAX_REFS], labels[:sb.MAX_REFS]


def ensure_angle_shots(db: Session, vp: VideoPodcast, ep: PodcastEpisode) -> dict[str, Shot]:
    r = ensure_scenes(db, vp)
    have = dict(r.get("angle_shots") or {})
    out: dict[str, Shot] = {}
    chars = {hid: e["character_id"] for hid, e in (vp.hosts or {}).items()}
    for n, (key, host_id, angle) in enumerate(angle_keys(vp, ep), start=1):
        shot = db.get(Shot, have.get(key) or "")
        if shot is None:
            shot = Shot(workspace_id=vp.workspace_id, project_id=vp.project_id, scene_id=r["angles_scene"],
                        source="podcast", locked=True)
            db.add(shot)
        shot.order = n
        shot.shot_type = "wide" if angle == "wide" else ("medium" if angle == "medium" else "close_up")
        shot.description = ANGLE_LABELS[angle]
        shot.start_prompt = angle_prompt(db, vp, ep, host_id, angle)
        shot.character_ids = [chars[host_id]] if host_id else list(chars.values())
        shot.location_id = vp.set_location_id
        shot.duration_s = 4.0
        db.flush()
        out[key] = shot
    gone = [db.get(Shot, sid) for k, sid in have.items() if k not in out]
    sb.delete_shots(db, [s for s in gone if s is not None])
    put_refs(vp, {**r, "angle_shots": {k: s.id for k, s in out.items()}})
    return out


def angle_tag(ids: list[str], prompt: str) -> str:
    return hashlib.sha1(json.dumps([ids, prompt]).encode()).hexdigest()[:16]


def frame_of(db: Session, shot_id: str | None) -> Generation | None:
    """An angle's frame: approved, else the newest one."""
    if not shot_id:
        return None
    gens = list(db.scalars(select(Generation).where(
        Generation.target_type == "shot", Generation.target_id == shot_id, Generation.kind == "keyframe_start",
    ).order_by(Generation.created_at.desc())).all())
    return next((g for g in gens if g.status == "approved"), None) or next(iter(gens), None)


def angle_frames(db: Session, vp: VideoPodcast) -> dict[str, Generation]:
    out = {}
    for key, sid in (refs(vp).get("angle_shots") or {}).items():
        g = frame_of(db, sid)
        if g is not None and g.status in FINISHED:
            out[key] = g
    return out


# ---------------------------------------------------------------- the mix and the plan

def mix_of(ep: PodcastEpisode) -> dict | None:
    mix = (ep.outputs or {}).get("mix") or {}
    return mix if mix.get("generation_id") and mix.get("timeline") is not None else None


def line_takes(db: Session, ep: PodcastEpisode) -> dict[str, str]:
    """line id -> the take the mix was built from (the mix job's own list), else the script's current take."""
    mix = mix_of(ep) or {}
    job = db.get(Job, (((ep.outputs or {}).get("jobs") or {}).get("mix")) or "")
    if job is not None and job.generation_id == mix.get("generation_id"):
        items = (job.payload or {}).get("items") or []
        if items:
            return {it["line_id"]: it.get("take_id") for it in items if it.get("take_id")}
    from app.models import VoiceScript

    s = db.get(VoiceScript, ep.script_id or "")
    return {ln["id"]: ln.get("take_id") for ln in (dl.refresh(db, s) if s else []) if ln.get("take_id")}


def build_plan(db: Session, vp: VideoPodcast, ep: PodcastEpisode) -> list[dict]:
    mix = mix_of(ep)
    if mix is None:
        raise HTTPException(409, "Mix the episode first: the video follows the mix")
    st = settings_of(vp)
    host_ids = [h["id"] for h in hosts_in_order(vp, ep)]
    plan = vplan.build(mix["timeline"], float(mix["duration_s"]), host_ids, cover_intro=bool(st["cover_intro"]),
                       cover_outro=bool(st["cover_outro"]))
    # an unchanged shot keeps its id, so its takes survive a replan
    old = {(s["type"], s["angle"], s["start"], s["end"]): s["id"] for s in vp.plan or []}
    used = set()
    for sh in plan:
        sid = old.get((sh["type"], sh["angle"], sh["start"], sh["end"]))
        if sid and sid not in used:
            sh["id"] = sid
            used.add(sid)
    return plan


def set_plan(db: Session, vp: VideoPodcast, plan: list[dict]) -> None:
    vp.plan = plan
    flag_modified(vp, "plan")
    sync_plan_shots(db, vp)


def sync_plan_shots(db: Session, vp: VideoPodcast) -> None:
    """One Shot row per planned shot (same id), in the hidden project's EPISODE scene."""
    r = ensure_scenes(db, vp)
    have = {s.id: s for s in sb.scene_shots(db, r["episode_scene"])}
    chars = {hid: e["character_id"] for hid, e in (vp.hosts or {}).items()}
    for n, sh in enumerate(vp.plan or [], start=1):
        shot = have.pop(sh["id"], None) or db.get(Shot, sh["id"])
        if shot is None:
            shot = Shot(id=sh["id"], workspace_id=vp.workspace_id, project_id=vp.project_id,
                        scene_id=r["episode_scene"], source="podcast", locked=True)
            db.add(shot)
        host = vplan.angle_host(sh.get("angle") or "") or sh.get("speaker_id")
        shot.order = n
        shot.shot_type = SHOT_TYPES.get(sh["type"], "medium")
        shot.duration_s = round(sh["end"] - sh["start"], 4)
        shot.description = (sh.get("text") or ANGLE_LABELS.get(sh["type"], sh["type"]))[:2000]
        shot.character_ids = [chars[host]] if host in chars else list(chars.values())
        shot.location_id = vp.set_location_id
    db.flush()
    sb.delete_shots(db, list(have.values()))


def fill_plan(db: Session, vp: VideoPodcast, ep: PodcastEpisode, rows: list[dict]) -> list[dict]:
    """An edited plan from the client: normalised, checked and re-linked to the mix's lines."""
    mix = mix_of(ep)
    if mix is None:
        raise HTTPException(409, "Mix the episode first: the video follows the mix")
    host_ids = [h["id"] for h in hosts_in_order(vp, ep)]
    keys = {k for k, _, _ in angle_keys(vp, ep)}
    old = {s["id"]: s for s in vp.plan or []}
    out = []
    for row in sorted(rows, key=lambda r: float(r.get("start") or 0)):
        kind = row.get("type")
        if kind not in vplan.TYPES:
            raise HTTPException(422, f"Unknown shot type '{kind}'")
        sid = row.get("id") if row.get("id") in old else vplan.new_id()
        angle = row.get("angle") or ""
        sh = {**old.get(sid, {}), "id": sid, "type": kind, "start": vplan.snap(row["start"]),
              "end": vplan.snap(row["end"]), "marked": bool(row.get("marked", old.get(sid, {}).get("marked")))}
        sh = vplan.refill(sh, mix["timeline"], host_ids)
        sh["angle"] = fit_angle(sh, angle, keys)
        out.append(sh)
    why = vplan.check(out, float(mix["duration_s"]))
    if why:
        raise HTTPException(422, why)
    return out


def fit_angle(sh: dict, angle: str, keys: set[str]) -> str:
    kind = sh["type"]
    if kind == "cover":
        return ""
    if kind in vplan.SHARED_ANGLES:
        return kind
    host = vplan.angle_host(angle)
    _, _, a = angle.rpartition(":")
    if angle in keys and host and (kind == "reaction") == (a == "listen"):
        return angle
    return vplan.default_angle(kind, sh.get("speaker_id") if kind == "lipsync" else host or sh.get("speaker_id"))


def apply_cover(plan: list[dict], cover_intro: bool, cover_outro: bool) -> list[dict]:
    """The intro / outro shots (no line) switch between the wide shot and the cover in place."""
    out = [dict(sh) for sh in plan]
    for seq, on in ((out, cover_intro), (out[::-1], cover_outro)):
        for sh in seq:
            if sh.get("line_id"):
                break
            if sh["type"] in ("wide", "cover"):
                sh["type"], sh["angle"] = ("cover", "") if on else ("wide", "wide")
    return out


def stale_from(db: Session, vp: VideoPodcast, ep: PodcastEpisode) -> str | None:
    """The first finished stage whose inputs changed under it (a newly approved portrait, a new set, a
    new mix), so "continue" knows where to pick up again."""
    for h in hosts_in_order(vp, ep):
        entry = vp.hosts[h["id"]]
        g = usable_portrait(db, entry)
        if g is None or (entry.get("sheets") or {}).get("from") != g.id:
            return "cast"
    n = len(hosts_in_order(vp, ep))
    g = establishing(db, vp)
    if g is None or g.status != "approved" or (g.params or {}).get("vp_set") != set_key(vp, n):
        return "set"
    shots = refs(vp).get("angle_shots") or {}
    for key, host_id, angle in angle_keys(vp, ep):
        f = frame_of(db, shots.get(key))
        ids, _ = angle_refs(db, vp, ep, host_id, angle)
        if f is None or (f.params or {}).get("vp_refs") != angle_tag(ids, angle_prompt(db, vp, ep, host_id, angle)):
            return "keyframes"
    mix = mix_of(ep)
    if mix is not None and stage(vp, "plan").get("basis") != mix["generation_id"]:
        return "plan"
    return None


# ---------------------------------------------------------------- takes

def takes_for(db: Session, shot_ids: list[str]) -> dict[str, dict[str, list[Generation]]]:
    """shot id -> quality -> takes, newest first."""
    out: dict[str, dict[str, list[Generation]]] = {sid: {q: [] for q in QUALITIES} for sid in shot_ids}
    if not shot_ids:
        return out
    rows = db.scalars(select(Generation).where(
        Generation.target_type == "shot", Generation.target_id.in_(shot_ids), Generation.kind == "take",
    ).order_by(Generation.created_at.desc())).all()
    for g in rows:
        q = (g.params or {}).get("vp_quality")
        if q in QUALITIES:
            out[g.target_id][q].append(g)
    return out


def signature(sh: dict, quality: str, aspect: str, frames: dict[str, Generation], takes: dict[str, str]) -> str:
    lip = sh["type"] in vplan.LIPSYNC_TYPES
    frame = frames.get(sh.get("angle") or "")
    blob = [sh["type"], sh.get("angle"), sh["start"], sh["end"], frame.id if frame else None,
            takes.get(sh.get("line_id") or "") if lip else None, sh.get("line_start") if lip else None, aspect, quality]
    return hashlib.sha1(json.dumps(blob).encode()).hexdigest()[:16]


def needs(sh: dict, newest: Generation | None, sig: str) -> bool:
    if sh["type"] == "cover":
        return False
    if newest is None or newest.status in ("failed", "rejected"):
        return True
    if newest.status in LIVE:
        return False
    return bool(sh.get("marked")) or (newest.params or {}).get("sig") != sig


def targets(db: Session, vp: VideoPodcast, ep: PodcastEpisode, quality: str,
            shot_ids: list[str] | None = None) -> list[dict]:
    plan = [sh for sh in vp.plan or [] if sh["type"] != "cover"]
    if shot_ids:
        wanted = set(shot_ids)
        return [sh for sh in plan if sh["id"] in wanted]
    frames, takes = angle_frames(db, vp), line_takes(db, ep)
    aspect = settings_of(vp)["aspect"]
    have = takes_for(db, [sh["id"] for sh in plan])
    return [sh for sh in plan if needs(sh, next(iter(have[sh["id"]][quality]), None),
                                       signature(sh, quality, aspect, frames, takes))]


def take_prompt(db: Session, vp: VideoPodcast, ep: PodcastEpisode, sh: dict) -> str:
    names = host_names(db, vp, ep)
    who = names.get(sh.get("speaker_id") or "", "The host")
    others = [n for hid, n in names.items() if hid != sh.get("speaker_id")]
    to = f"to {' and '.join(others)}" if others else "to camera"
    still = "Static camera, realistic podcast studio, natural light."
    if sh["type"] == "lipsync":
        return f"{who} talking {to}, natural hand gestures, small head movements, blinking. {still}"
    if sh["type"] == "medium":
        return f"{who} talking {to}, the others listening and reacting, natural gestures. {still}"
    if sh["type"] == "reaction":
        listener = names.get(vplan.angle_host(sh.get("angle") or "") or "", "The co-host")
        return (f"{listener} listening, nodding slightly, attentive, small smile, mouth closed, not speaking. "
                f"{still}")
    together = " and ".join(names.values()) or "The hosts"
    return f"{together} in conversation at their microphones, natural gestures. Slow, steady camera. {still}"


def speech_file(db: Session, vp: VideoPodcast, take_id: str, need_s: float, lead_ms: int = 0) -> Path:
    """The line's dry voice padded with silence past its end: a shot runs on into the gap before the next
    line, and the ia2v graph trims [audio_start_s, +duration] out of this file."""
    g = db.get(Generation, take_id or "")
    src = generation_file(g) if g is not None else None
    if src is None or not src.is_file():
        raise VideoPodcastError("A line's voice take is gone; render the episode's lines and mix again")
    pad = int(math.ceil(max(0.0, need_s - aa.stream_info(src).duration) + 1.0))
    folder = get_settings().data_dir / "workspaces" / vp.workspace_id / "projects" / vp.project_id / "podcast"
    dst = folder / f"speech_{take_id}_{pad}_{lead_ms}.wav"
    if not dst.is_file():
        folder.mkdir(parents=True, exist_ok=True)
        part = dst.with_suffix(".part.wav")
        lead = f"adelay=delays={lead_ms}:all=1," if lead_ms else ""
        rl.run_ff(["-i", str(src), "-af", f"aresample=48000,{lead}apad=pad_dur={pad}", "-c:a", "pcm_s16le", str(part)])
        part.replace(dst)
    return dst


def enqueue_take(db: Session, vp: VideoPodcast, ep: PodcastEpisode, sh: dict, quality: str,
                 frames: dict[str, Generation], takes: dict[str, str], parent_job_id: str | None) -> Generation:
    from app.services import enqueue_generation

    frame = frames.get(sh.get("angle") or "")
    if frame is None:
        raise VideoPodcastError(f"The {sh.get('angle') or sh['type']} angle has no frame yet")
    aspect = settings_of(vp)["aspect"]
    dur = round(sh["end"] - sh["start"], 4)
    params = {"aspect_ratio": aspect, "duration_s": dur, "fps": 24.0,
              "num_frames": min(frames_for(dur, 24.0), MAX_FRAMES), "first_frame_id": frame.id,
              "vp": vp.id, "vp_shot": sh["id"], "vp_quality": quality,
              "sig": signature(sh, quality, aspect, frames, takes), "created_by": {"flow": "video_podcast"}}
    if quality == "final":
        params["quality"] = "hq"
    if sh["type"] in vplan.LIPSYNC_TYPES:
        take_id = takes.get(sh.get("line_id") or "")
        if not take_id:
            raise VideoPodcastError("A spoken line has no voice take; render the episode's lines first")
        line_start = float(sh.get("line_start") or sh["start"])
        # a shot that opens a hair before its line (frame snapping, the first shot pulled to 0) gets silence
        # in front rather than a voice that starts early
        lead_ms = int(math.ceil(max(0.0, line_start - sh["start"]) * 1000))
        params.update(lipsync=True, take_id=take_id, audio_start_s=round(sh["start"] - line_start + lead_ms / 1000, 4),
                      speech_audio=str(speech_file(db, vp, take_id, sh["end"] - line_start, lead_ms)))
    g = enqueue_generation(db, workspace_id=vp.workspace_id, project_id=vp.project_id, target_type="shot",
                           target_id=sh["id"], kind="take", prompt=take_prompt(db, vp, ep, sh), params=params)
    if parent_job_id:
        job = db.get(Job, g.job_id)
        job.payload = {**(job.payload or {}), "parent_job_id": parent_job_id}
    return g


def take_to_cut(gens: dict[str, list[Generation]], quality: str) -> tuple[Generation | None, bool]:
    """The take a cut at this quality uses: its newest finished one, else (final) the draft's. (take, fallback)"""
    mine = next((g for g in gens[quality] if g.status in FINISHED and g.file_path), None)
    if mine is not None or quality == "draft":
        return mine, False
    draft = next((g for g in gens["draft"] if g.status in FINISHED and g.file_path), None)
    return draft, draft is not None


# ---------------------------------------------------------------- estimate

def estimate(db: Session, vp: VideoPodcast, ep: PodcastEpisode, quality: str,
             shot_ids: list[str] | None = None) -> dict:
    todo = targets(db, vp, ep, quality, shot_ids)
    aspect = settings_of(vp)["aspect"]
    model = "ltx23_hq" if quality == "final" else "ltx23_distilled"
    w, h = (HQ_SIZES if quality == "final" else VIDEO_SIZES).get(aspect, (1280, 704))
    low = high = 0.0
    basis = "rough"
    for lip in (True, False):
        secs = sum(sh["end"] - sh["start"] for sh in todo if (sh["type"] in vplan.LIPSYNC_TYPES) == lip)
        if secs <= 0:
            continue
        e = est.estimate(db, vp.workspace_id, kind="take", model=model, duration_s=secs, width=w, height=h)
        k = IA2V_FACTOR if lip else 1.0
        low, high = low + e["low_s"] * k, high + e["high_s"] * k
        if e["basis"] == "measured":
            basis = "measured"
    over = TAKE_OVERHEAD_S * len(todo)
    low, high = int(low + over), int(math.ceil(high + over))
    return {"quality": quality, "shots": len(todo), "seconds": round(sum(sh["end"] - sh["start"] for sh in todo), 2),
            "low_s": low, "high_s": high, "basis": basis, "label": gpu_label(low, high)}


def gpu_label(low: float, high: float) -> str:
    mid = (low + high) / 2
    if mid <= 0:
        return "Nothing to render"
    if mid < 3600:
        return f"≈ {max(1, round(mid / 60))} min on the video GPU"
    hours = mid / 3600
    return f"≈ {hours:.1f} h on the video GPU" if hours < 10 else f"≈ {round(hours)} h on the video GPU"


# ---------------------------------------------------------------- Library output

def library_version(db: Session, vp: VideoPodcast, ep: PodcastEpisode, quality: str) -> tuple[MediaItem, Generation]:
    rec = (vp.outputs or {}).get(quality) or {}
    item = db.get(MediaItem, rec.get("media_id") or "")
    if item is None or item.workspace_id != vp.workspace_id:
        item = MediaItem(id=new_id(), workspace_id=vp.workspace_id, kind="video", origin="generated",
                         title=f"{ep.title} (AI video, {quality})"[:300], tags=["podcast", "ai-video"])
        db.add(item)
        db.flush()
    g = Generation(id=new_id(), workspace_id=vp.workspace_id, project_id=None, target_type="media",
                   target_id=item.id, kind="video", version=next_version(db, "media", item.id, "video"),
                   status="queued", prompt=ep.title, seed=new_seed(), parent_id=item.generation_id,
                   params={"episode_id": ep.id, "video_podcast_id": vp.id, "quality": quality, "has_audio": True,
                           "created_by": {"flow": "video_podcast"}})
    db.add(g)
    db.flush()
    if item.generation_id is None:
        item.generation_id = g.id
    lib.touch(item)
    return item, g


# ---------------------------------------------------------------- output shapes

def _gen(g: Generation | None) -> dict | None:
    return gen_out(g).model_dump(mode="json") if g is not None else None


def status_of(db: Session, vp: VideoPodcast) -> tuple[str, str | None]:
    if busy(db, vp) is not None:
        return "running", None
    for key, _ in STAGES:
        rec = stage(vp, key)
        if rec.get("status") == "review":
            return "review", {"cast": "hosts", "keyframes": "look"}.get(key, key)
    if any(stage(vp, k).get("status") == "failed" for k, _ in STAGES):
        return "failed", None
    return "idle", None


def hosts_out(db: Session, vp: VideoPodcast, ep: PodcastEpisode) -> list[dict]:
    out = []
    for h in hosts_in_order(vp, ep):
        entry = vp.hosts[h["id"]]
        sheets = {}
        for view in ("front", "three_quarter"):
            g = db.get(Generation, ((entry.get("sheets") or {}).get(view)) or "")
            if g is not None:
                sheets[view] = _gen(g)
        photo = db.get(MediaItem, entry.get("photo_media_id") or "") if entry.get("photo_media_id") else None
        out.append({"host_id": h["id"], "name": h["name"], "role": h.get("role"), "persona": h.get("persona") or "",
                    "source": entry.get("source") or "persona", "character_id": entry["character_id"],
                    "photo_media_id": entry.get("photo_media_id"),
                    "photo_url": sv.item_url(db, photo.id) if photo else None,
                    "from_character_id": entry.get("from_character_id"), "consent": entry.get("consent"),
                    "portrait": _gen(current_portrait(db, entry)), "sheet_views": sheets})
    return out


def plan_out(db: Session, vp: VideoPodcast, ep: PodcastEpisode) -> list[dict]:
    plan = vp.plan or []
    frames, takes = angle_frames(db, vp), line_takes(db, ep)
    aspect = settings_of(vp)["aspect"]
    have = takes_for(db, [sh["id"] for sh in plan])
    out = []
    for sh in plan:
        gens = have.get(sh["id"]) or {q: [] for q in QUALITIES}
        newest = {q: next(iter(gens[q]), None) for q in QUALITIES}
        frame = frames.get(sh.get("angle") or "")
        out.append({**{k: sh.get(k) for k in ("id", "type", "angle", "speaker_id", "line_id", "start", "end",
                                               "chapter_id", "text")},
                    "duration": round(sh["end"] - sh["start"], 3), "marked": bool(sh.get("marked")),
                    "lipsync": sh["type"] in vplan.LIPSYNC_TYPES,
                    "takes": {q: _gen(newest[q]) for q in QUALITIES},
                    "needs": {q: needs(sh, newest[q], signature(sh, q, aspect, frames, takes)) for q in QUALITIES},
                    "thumb_url": gen_out(frame).thumb_url if frame is not None else None})
    return out


def output_out(db: Session, rec: dict | None) -> dict | None:
    if not rec or not rec.get("generation_id"):
        return None
    g = db.get(Generation, rec["generation_id"])
    if g is None or g.status not in FINISHED or not g.file_path:
        return None
    return {**rec, "url": media_url(g.file_path)}


def vp_out(db: Session, vp: VideoPodcast) -> dict:
    ep = episode_of(db, vp)
    status, review = status_of(db, vp)
    mix = mix_of(ep)
    st = settings_of(vp)
    loc = db.get(Location, vp.set_location_id or "")
    shots = refs(vp).get("angle_shots") or {}
    angles = []
    names = host_names(db, vp, ep)
    for key, host_id, angle in angle_keys(vp, ep):
        label = ANGLE_LABELS[angle]
        angles.append({"key": key, "label": f"{names.get(host_id, '')} · {label}" if host_id else label,
                       "host_id": host_id, "angle": angle, "shot_id": shots.get(key),
                       "frame": _gen(frame_of(db, shots.get(key)))})
    job = db.get(Job, vp.job_id) if vp.job_id else None
    return {
        "id": vp.id, "episode_id": vp.episode_id, "project_id": vp.project_id, "title": ep.title,
        "language": ep.language, "stage": vp.stage, "status": status, "review": review,
        "stages": [{"key": k, "label": label, "status": stage(vp, k).get("status", "pending"),
                    "detail": stage(vp, k).get("detail"), "started_at": stage(vp, k).get("started_at"),
                    "finished_at": stage(vp, k).get("finished_at")} for k, label in STAGES],
        "settings": st, "hosts": hosts_out(db, vp, ep),
        "set": {"location_id": vp.set_location_id, "preset": st["set_preset"], "prompt": st["set_prompt"],
                "description": loc.description if loc else set_description(vp),
                "establishing": _gen(establishing(db, vp, fresh_only=False))},
        "angles": angles, "plan": plan_out(db, vp, ep), "plan_stats": vplan.stats(vp.plan or []),
        "duration_s": mix["duration_s"] if mix else None,
        "mix_stale": bool(mix and vp.plan and stage(vp, "plan").get("basis") not in (None, mix["generation_id"])),
        "outputs": {q: output_out(db, (vp.outputs or {}).get(q)) for q in QUALITIES},
        "job": job_out(job).model_dump(mode="json") if job is not None else None,
        "eta_s": ((job.result or {}).get("eta_s") if job is not None and job.status in ("queued", "running") else None),
        "created_at": vp.created_at, "updated_at": vp.updated_at,
    }


def other_characters(db: Session, vp: VideoPodcast) -> list[dict]:
    rows = db.execute(select(Character, Project).join(Project, Project.id == Character.project_id).where(
        Character.workspace_id == vp.workspace_id, Character.project_id != vp.project_id,
    ).order_by(Character.updated_at.desc()).limit(200)).all()
    out = []
    for c, p in rows:
        g = sb.approved(db, "character", c.id, "portrait") or next(
            (x for x in portraits(db, c.id) if x.status == "ready" and x.file_path), None)
        out.append({"id": c.id, "name": c.name, "description": c.description, "project_id": p.id,
                    "project_title": p.title, "portrait_url": media_url(g.file_path) if g is not None else None,
                    "thumb_url": gen_out(g).thumb_url if g is not None else None})
    return out
