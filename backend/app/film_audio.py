"""Feature films voice first (contract v4a addendum).

Every line of a scene is spoken in its character's voice before any picture is made, the lines are laid on
one dialogue track with their pauses, and the track is cut into shots the way the AI video podcast cuts an
episode (podcast.vplan): the speaker on camera while they talk, the listener now and then, the room at the
top. Each take then renders against its exact slice of the track (lip-synced when its camera is the one
talking), so the stitched scene plays the dialogue straight through. The planner used to guess shot lengths
and the speech was fitted inside them: one 2.3 s line in a 60 s shot.
"""
import hashlib
import logging
import math
import re
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app import audio_analysis as aa
from app import audio_edit as ae
from app import shot_speech as ss
from app import storyboard as sb
from app.config import get_settings
from app.film_language import _HEADING
from app import voices as vc
from app.models import Generation, Project, Scene, Shot
from app.podcast import vplan

log = logging.getLogger("mixai.film_audio")

PIECE_S = 10.0  # one LTX pass; a longer cut becomes consecutive shots
SILENT_S = (2.0, 4.0)
LONG_LINE_S = 9.0
_BREAK = re.compile(r"(?<=[.!?۔؟])\s+|(?<=[,،;])\s+")
_ANGLES = ("close_up", "medium")


# ---------------------------------------------------------------- the scene as beats

def _split_line(text: str) -> list[str]:
    """A speech too long for one shot, at the sentence (else clause) break nearest its middle."""
    words = text.split()
    if len(words) / ss.WORDS_PER_S <= LONG_LINE_S:
        return [text]
    marks = [m.end() for m in _BREAK.finditer(text)]
    if not marks:
        mid = len(words) // 2
        parts = [" ".join(words[:mid]), " ".join(words[mid:])]
    else:
        at = min(marks, key=lambda i: abs(i - len(text) / 2))
        parts = [text[:at].strip(), text[at:].strip()]
    return [p for half in parts if half for p in _split_line(half)]


def beats(script: str, cast_ids_by_cue) -> list[dict]:
    """The scene in order: {"kind": "line", character_id, text, visual} or {"kind": "silent", visual,
    seconds}. An action line just before a speech is what we see while it's said, not a pause of its own."""
    raw: list[dict] = []
    cur = None
    for kind, cue, line in sb.screenplay_lines(script or ""):
        if kind == "action":
            if not _HEADING.match(line):
                raw.append({"kind": "action", "text": line})
            cur = None
        elif kind == "dialogue" and cue and not _HEADING.match(cue):
            cid = cast_ids_by_cue(cue)
            if cid is None:
                cur = None
                continue
            if cur is not None and cur["character_id"] == cid:
                cur["text"] = f"{cur['text']} {line}"
            else:
                cur = {"kind": "line", "character_id": cid, "text": line}
                raw.append(cur)
        elif kind in ("cue", "break"):
            cur = None
    out: list[dict] = []
    visual = ""
    for i, b in enumerate(raw):
        if b["kind"] == "action":
            visual = b["text"]
            if i + 1 < len(raw) and raw[i + 1]["kind"] == "line":
                continue
            secs = min(SILENT_S[1], max(SILENT_S[0], len(visual.split()) / 3))
            out.append({"kind": "silent", "visual": visual, "seconds": round(secs, 2)})
        else:
            out += [{"kind": "line", "character_id": b["character_id"], "text": t, "visual": visual}
                    for t in _split_line(b["text"])]
    return out


# ---------------------------------------------------------------- the dialogue track

def timeline(bts: list[dict], seconds: list[float]) -> tuple[list[dict], float]:
    """Start / end on every beat (in place) and the podcast-style timeline of the lines; returns (items,
    total). `seconds` is each line's spoken length, in order."""
    t, items, it = ss.LEAD_S, [], iter(seconds)
    last_line = False
    for i, b in enumerate(bts):
        if b["kind"] == "silent":
            b["start"], b["end"] = round(t, 4), round(t + b["seconds"], 4)
            t += b["seconds"]
            last_line = False
            continue
        d = float(next(it))
        b["start"], b["end"] = round(t, 4), round(t + d, 4)
        items.append({"line_id": f"l{i}", "speaker_id": b["character_id"], "kind": "speech",
                      "start": b["start"], "end": b["end"], "text": b["text"]})
        t += d + ss.GAP_S
        last_line = True
    total = t - (ss.GAP_S if last_line else 0.0) + ss.TAIL_S
    return items, vplan.snap(total)


def track_graph(starts: list[float], total: float) -> str:
    parts = [f"[{i}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=mono,"
             f"adelay=delays={round(s * 1000)}:all=1[d{i}]" for i, s in enumerate(starts)]
    mix = "".join(f"[d{i}]" for i in range(len(starts)))
    mix += f"amix=inputs={len(starts)}:normalize=0:dropout_transition=0" if len(starts) > 1 else "anull"
    return ";".join([*parts, f"{mix},apad=whole_dur={total:.4f},atrim=end={total:.4f}[out]"])


def render_track(files: list[Path], starts: list[float], total: float, dst: Path, tick=None) -> None:
    args: list[str] = []
    for f in files:
        args += ["-i", str(f)]
    dst.parent.mkdir(parents=True, exist_ok=True)
    part = dst.with_name(dst.stem + ".part.wav")
    ae.run([*args, "-filter_complex", track_graph(starts, total), "-map", "[out]", "-ar", "48000", "-ac", "1",
            "-c:a", "pcm_s16le", str(part)], tick=tick)
    part.replace(dst)


def slice_audio(track: Path, start: float, end: float, dst: Path) -> Path:
    dst.parent.mkdir(parents=True, exist_ok=True)
    ae.run(["-i", str(track), "-af", f"atrim=start={start:.4f}:end={end:.4f},asetpts=PTS-STARTPTS,"
            f"apad=whole_dur={end - start:.4f}", "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", str(dst)])
    return dst


def mux(video: Path, audio: Path) -> None:
    """The take keeps its pictures and gets its slice of the scene's dialogue as its sound."""
    dur = aa.stream_info(video).duration
    tmp = video.with_name(video.stem + ".mux" + video.suffix)
    ae.run(["-i", str(video), "-i", str(audio), "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac",
            "-b:a", "192k", "-ar", "48000", "-ac", "2", *(["-t", f"{dur:.4f}"] if dur else ["-shortest"]),
            "-movflags", "+faststart", str(tmp)])
    tmp.replace(video)


# Urdu with its long words is spoken a little slower than English
WORDS_PER_S = {"ur": 2.3}
SPOKEN_SHARE = 0.6  # of a talking scene's running time


def words_per_s(language: str | None) -> float:
    return WORDS_PER_S.get((language or "en").split("-")[0], ss.WORDS_PER_S)


def spoken_words(script: str) -> int:
    return sum(len(line.split()) for kind, cue, line in sb.screenplay_lines(script or "")
               if kind == "dialogue" and not _HEADING.match(cue or ""))


def spoken_target(seconds: float, language: str | None) -> int:
    return round(seconds * SPOKEN_SHARE * words_per_s(language))


def content_seconds(script: str, language: str | None) -> float | None:
    """How long a scene runs from what's in it: its lines at the language's pace with a breath between them,
    its silent actions, the lead-in and tail. None when nobody speaks (the plan's length stands)."""
    bts = beats(script, lambda cue: cue)
    lines = [b for b in bts if b["kind"] == "line"]
    if not lines:
        return None
    wps = words_per_s(language)
    talk = sum(len(b["text"].split()) / wps for b in lines) + ss.GAP_S * (len(lines) - 1)
    return round(ss.LEAD_S + talk + sum(b["seconds"] for b in bts if b["kind"] == "silent") + ss.TAIL_S, 1)


def measured(files: list[Path]) -> list[float]:
    return [float(aa.stream_info(f).duration or 0.0) for f in files]


# ---------------------------------------------------------------- the cut, as shots

def pieces(cuts: list[dict], max_s: float = PIECE_S) -> list[dict]:
    """Cuts longer than one LTX pass split into equal consecutive pieces on the same camera."""
    out = []
    for c in cuts:
        n = max(1, math.ceil((c["end"] - c["start"]) / max_s - 1e-9))
        edges = [vplan.snap(c["start"] + k * (c["end"] - c["start"]) / n) for k in range(n)] + [c["end"]]
        for k, (a, b) in enumerate(zip(edges, edges[1:])):
            out.append({**c, "start": a, "end": b, "duration": round(b - a, 4), "piece": k})
    return out


def beat_at(bts: list[dict], t: float) -> dict | None:
    best = None
    for b in bts:
        if b.get("start", 0) <= t + 1e-6:
            best = b
    return best


def _speaks(bts: list[dict], who: str, a: float, b: float) -> bool:
    return any(x["kind"] == "line" and x["character_id"] == who and x.get("start", 0) < b - 1e-6
               and x.get("end", 0) > a + 1e-6 for x in bts)


def cut_plans(bts: list[dict], cuts: list[dict], names: dict[str, str], cast: list[str],
              location_id: str | None) -> list[dict]:
    """A shot plan per piece of the cut (ai_jobs.replace_shots fields) plus its stretch of the track."""
    plans = []
    for c in pieces(cuts):
        mid = (c["start"] + c["end"]) / 2
        b = beat_at(bts, mid) or {}
        visual = (b.get("visual") or "").strip()
        cam = c["camera"]
        talking = bool(c.get("speaker_id")) and cam == c.get("speaker_id")
        if not talking and len(cast) == 1 and cast[0] in names and _speaks(bts, cast[0], c["start"], c["end"]):
            # a lone presenter: the podcast's room shot at the top showed him with his voice running and his
            # mouth still (Ruslan's explainer, 23 Oct); while he speaks he is filmed speaking
            cam, talking = cast[0], True
        other = next((x for x in cast if x != cam), None)
        if talking and c.get("piece", 0) % 2 == 1 and other in names:
            # a long speech cut in pieces: every other piece looks at the listener, the voice carrying on
            cam, talking = other, False
        if cam in names:
            name = names[cam]
            if talking:
                shot_type = _ANGLES[c.get("piece", 0) // 2 % len(_ANGLES)]
                frame = "Close-up" if shot_type == "close_up" else "Medium shot"
                desc = f"{name} speaks. {visual}".strip()
                motion = (f"{name} speaks on camera, the mouth moving with every word, natural small head "
                          "movements.")
            else:
                shot_type, frame = "over_shoulder", "Reaction shot"
                desc = f"{name} listens. {visual}".strip()
                motion = f"{name} listens without speaking, mouth closed, small natural reactions."
            chars = [cam]
            subject = f"{frame} of {name}"
        else:
            shot_type, chars = "wide", list(cast)
            subject = "Wide shot of the scene" + (f" with {', '.join(names[x] for x in cast if x in names)}"
                                                  if cast else "")
            desc = visual or "The scene, wide."
            motion = "The camera holds wide; slow natural movement." + ("" if c.get("speaker_id") else
                                                                          " Nobody speaks.")
        lines = [{"character_id": x["character_id"], "text": x["text"], "language": x.get("language")}
                 for x in bts if x["kind"] == "line" and talking and x["character_id"] == cam
                 and c["start"] - 1e-6 <= x["start"] < c["end"] - 1e-6]
        plans.append({
            "shot_type": shot_type, "duration_s": round(c["end"] - c["start"], 3), "description": desc[:2000],
            "camera": subject, "location_id": location_id, "seam_in": "cut", "handoff_text": "",
            "start_prompt": f"{subject}. {visual}".strip(), "end_prompt": f"{subject}, a moment later. {visual}".strip(),
            "motion_prompt": motion, "brand_placements": [], "dialogue": [{k: v for k, v in ln.items() if v}
                                                                        for ln in lines],
            "character_ids": chars,
            "audio": {"start": c["start"], "end": c["end"], "lipsync": talking, "speaker_id": c.get("speaker_id"),
                      "camera": cam, "piece": c.get("piece", 0)},
        })
    return plans


def scene_dir(project) -> tuple[Path, str]:
    rel = Path("workspaces") / project.workspace_id / "projects" / project.id / "film_audio"
    return get_settings().data_dir / rel, rel.as_posix()


def cut(items: list[dict], total: float, salt: str) -> list[dict]:
    """The podcast's cut list for one scene: the speaker, listener cutaways, the room at the top."""
    hosts = list(dict.fromkeys(it["speaker_id"] for it in items))
    return vplan.build(items, None, total, hosts, salt=salt)["cuts"]


# ---------------------------------------------------------------- per scene (the editor and the autopilot)
#
# Each scene owns its dialogue: project.settings.scene_audio[scene_id] holds its beats (with line ids), the
# speech plan (a hidden take per line, reused while text and voice are unchanged), its track, and for every
# shot cut from it the lines it was cut from. Steps run per scene, so a scene added or edited by hand is built
# the same way, and an edited line re-voices that line and invalidates only the shots it is in.

class NotReady(HTTPException):
    def __init__(self, detail: str):
        super().__init__(409, detail)


def _state(project: Project) -> dict:
    return dict((project.settings or {}).get("scene_audio") or {})


def record(project: Project, scene_id: str) -> dict:
    return dict(_state(project).get(scene_id) or {})


def put_record(project: Project, scene_id: str, rec: dict | None) -> None:
    st = _state(project)
    if rec is None:
        st.pop(scene_id, None)
    else:
        st[scene_id] = rec
    project.settings = {**(project.settings or {}), "scene_audio": st}
    flag_modified(project, "settings")


def _line_ids(scene_id: str, bts: list[dict]) -> None:
    seen: dict[tuple, int] = {}
    for b in bts:
        if b["kind"] != "line":
            continue
        key = (b["character_id"], " ".join(b["text"].split()))
        n = seen[key] = seen.get(key, 0) + 1
        b["line_id"] = hashlib.sha1(f"{scene_id}|{key[0]}|{key[1]}|{n}".encode()).hexdigest()[:16]


def scene_beats(db: Session, scene: Scene, language: str | None) -> list[dict]:
    from app import ai_jobs
    from app import cast as film_cast

    chars = film_cast.project_cast(db, scene.project_id)

    def who(cue: str) -> str | None:
        ids = ai_jobs._char_ids([cue], chars)
        return ids[0] if ids else None

    bts = beats(scene.script_text, who)
    for b in bts:
        if b["kind"] == "line" and language:
            b["language"] = language
    _line_ids(scene.id, bts)
    return bts


def _language(project: Project) -> str | None:
    from app.llm import prompts as P

    lang = P.film_language(project)
    return lang if lang and lang != "en" else None


def voice_scene(db: Session, scene: Scene, user_id: str | None = None, tick=None) -> dict:
    """Speaks the scene's lines (the unchanged ones keep their takes). {"status": "voiced" | "voicing" |
    "silent" | "no_voice", "job_ids": [...], "generations": [...], "lines": n}."""
    from app import film_language as fl

    project = db.get(Project, scene.project_id)
    lang = _language(project)
    bts = scene_beats(db, scene, lang)
    lines = [b for b in bts if b["kind"] == "line"]
    if not lines:
        return {"status": "silent", "job_ids": [], "generations": [], "lines": 0}
    # the last guard before speech: a line still in English for an Urdu film is translated now
    for b, text in zip(lines, fl.localise([b["text"] for b in lines], lang, tick=tick)):
        b["text"] = text
    rows = [{"character_id": b["character_id"], "text": b["text"], **({"language": lang} if lang else {})}
            for b in lines]
    d = ss.plan(db, project.workspace_id, rows, stand_ins=True)
    if not d or d["mode"] != "lipsync":
        return {"status": "no_voice", "job_ids": [], "generations": [], "lines": len(lines)}
    d["tag"] = ss.shot_tag(scene.id)
    gens = ss.ensure_takes(db, project.workspace_id, user_id, d)
    for b, row in zip(lines, d["lines"]):
        b["fp"], b["take_id"] = row["fp"], row["take_id"]
    rec = record(project, scene.id)
    rec.update(beats=bts, plan=d)
    put_record(project, scene.id, rec)
    live = [g for g in gens if g.status in ("queued", "generating")]
    bad = [g for g in gens if g.status not in ("queued", "generating", "ready", "approved")]
    if bad:
        raise HTTPException(422, f"{len(bad)} line(s) of {scene.heading or 'the scene'} couldn't be spoken")
    return {"status": "voicing" if live else "voiced", "job_ids": [g.job_id for g in live if g.job_id],
            "generations": gens, "lines": len(lines)}


def _overlaps(items: list[dict], bts: list[dict], a: float, b: float) -> list[list]:
    by_id = {f"l{i}": x for i, x in enumerate(bts)}
    out = []
    for it in items:
        if it["start"] < b - 1e-6 and it["end"] > a + 1e-6:
            x = by_id[it["line_id"]]
            out.append([x.get("line_id"), x.get("fp"), round(it["start"] - a, 3)])
    return out


def _same(old: dict, new: dict) -> bool:
    """A shot cut from the same lines the same way: its pictures and take still fit (times may have moved)."""
    if any(old.get(k) != new.get(k) for k in ("camera", "lipsync", "speaker_id", "piece", "shot_type")):
        return False
    if abs(float(old.get("duration", 0)) - float(new["duration"])) > 0.1:
        return False
    a, b = old.get("lines") or [], new["lines"]
    return len(a) == len(b) and all(x[0] == y[0] and x[1] == y[1] and abs(x[2] - y[2]) <= 0.1
                                    for x, y in zip(a, b))


def plan_scene(db: Session, scene: Scene, tick=None) -> dict:
    """Cuts the scene into shots from its measured dialogue. Shots cut from unchanged lines are kept (with
    their frames and takes, re-timed to where their lines now fall); the rest are new. {"shot_ids",
    "new_shot_ids", "removed_shot_ids", "seconds"}."""
    from app import ai_jobs
    from app import cast as film_cast

    project = db.get(Project, scene.project_id)
    rec = record(project, scene.id)
    d = rec.get("plan")
    if not d:
        raise NotReady("Voice the scene's lines first")
    gens = [db.get(Generation, r.get("take_id") or "") for r in d["lines"]]
    if any(g is None or g.status not in ("ready", "approved") for g in gens):
        raise NotReady("Some of the scene's lines are still being spoken")
    try:
        files = ss._files(gens, d["lines"])
    except ss.SpeechError as e:
        raise NotReady(str(e)) from e
    bts = rec["beats"]
    items, total = timeline(bts, measured(files))
    folder, rel = scene_dir(project)
    render_track(files, [it["start"] for it in items], total, folder / f"{scene.id}.wav", tick=tick)
    names = {c.id: c.name for c in film_cast.project_cast(db, project.id)}
    cast = list(dict.fromkeys(b["character_id"] for b in bts if b["kind"] == "line"))
    plans = cut_plans(bts, cut(items, total, scene.id), names, cast, scene.location_id)

    old_shots = {s.id: s for s in sb.scene_shots(db, scene.id)}
    old = {sid: a for sid, a in (rec.get("shots") or {}).items() if sid in old_shots}
    keep_closing = ai_jobs._closing_id(db, project.id)
    shots, new_ids, used, shots_rec = [], [], set(), {}
    for pl in plans:
        a = pl["audio"]
        info = {**a, "duration": round(a["end"] - a["start"], 3), "shot_type": pl["shot_type"],
                "lines": _overlaps(items, bts, a["start"], a["end"])}
        hit = next((sid for sid, o in old.items() if sid not in used and _same(o, info)), None)
        if hit is not None:
            shot = old_shots[hit]
            used.add(hit)
            shot.duration_s = pl["duration_s"]
        else:
            shot = Shot(workspace_id=scene.workspace_id, project_id=scene.project_id, scene_id=scene.id,
                        source="ai", prompt_mode="auto",
                        **{k: pl[k] for k in ai_jobs.PLAN_FIELDS if pl.get(k) is not None})
            shot.character_ids = list(pl["character_ids"])
            shot.brand_placements = []
            shot.dialogue = list(pl["dialogue"])
            db.add(shot)
            db.flush()
            new_ids.append(shot.id)
        shots.append(shot)
        shots_rec[shot.id] = info
    gone = [s for sid, s in old_shots.items() if sid not in used and sid != keep_closing]
    sb.delete_shots(db, gone)
    db.flush()
    sb.renumber(shots + [s for sid, s in old_shots.items() if sid == keep_closing])
    rec.update(track=f"{rel}/{scene.id}.wav", seconds=total, shots=shots_rec, planned=signature(bts))
    put_record(project, scene.id, rec)
    return {"shot_ids": [s.id for s in shots], "new_shot_ids": new_ids, "removed_shot_ids": [s.id for s in gone],
            "seconds": total}


def signature(bts: list[dict]) -> str:
    rows = [[b.get("line_id"), b.get("fp") or b.get("text")] for b in bts if b["kind"] == "line"]
    return hashlib.sha1(repr(rows).encode()).hexdigest()[:16]


def status(db: Session, scene: Scene) -> dict:
    """Whether the scene's shots still match its dialogue (a line edited, added or removed, or a new voice)."""
    project = db.get(Project, scene.project_id)
    rec = record(project, scene.id)
    if not rec.get("shots"):
        return {"planned": False, "stale": False, "message": None, "seconds": None}
    bts = scene_beats(db, scene, _language(project))
    d = ss.plan(db, project.workspace_id, [{"character_id": b["character_id"], "text": b["text"],
                                             **({"language": b["language"]} if b.get("language") else {})}
                                            for b in bts if b["kind"] == "line"], stand_ins=True) or {"lines": []}
    for b, row in zip([b for b in bts if b["kind"] == "line"], d["lines"]):
        voice = vc.find_voice(db, project.workspace_id, row.get("voice_id"))
        b["fp"] = ss._fp(row["text"], row.get("voice_id"), ss._language(row["text"], voice, row.get("language")))
    stale = signature(bts) != rec.get("planned")
    return {"planned": True, "stale": stale, "seconds": rec.get("seconds"),
            "message": "Dialogue changed — re-time shots" if stale else None}


def attach(db: Session, shot: Shot, params: dict) -> bool:
    """A take of a shot cut from its scene's dialogue renders against its exact slice of the track (lip-synced
    when its camera is the speaker) and keeps that slice as its sound. False for any other shot."""
    project = db.get(Project, shot.project_id)
    rec = record(project, shot.scene_id) if project is not None else {}
    a = (rec.get("shots") or {}).get(shot.id)
    if not a or not rec.get("track"):
        return False
    params.pop("dialogue", None)
    track = get_settings().data_dir / rec["track"]
    clip = slice_audio(track, a["start"], a["end"], track.parent / "slices" / f"{shot.id}.wav")
    params["mux_audio"] = str(clip)
    if a["lipsync"]:
        params.update(lipsync=True, speech_audio=str(clip), audio_start_s=0.0)
    else:
        for k in ("lipsync", "speech_audio", "audio_start_s"):
            params.pop(k, None)
    return True
