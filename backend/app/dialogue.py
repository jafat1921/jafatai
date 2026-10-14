"""Dialogue & narration (contract v17): a cast, a list of lines, one speech take per line, one mix.

Every line carries a fingerprint of what it would sound like (text, resolved voice, engine, language,
speed, emotion). The take remembers the fingerprint it was rendered from, so "render changed" only
redoes lines whose fingerprint moved. Takes are ordinary speech generations from voices.queue_speech,
each on its own Library item tagged script:<id>; the Library hides that tag (app.library.TAKE_TAG).
The mix is one Library audio item per script, a new version each time, like an editor render.
"""
import hashlib
import json
import re
import shutil
import time
import uuid
import zipfile

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import audio_analysis as aa
from app import audio_edit as ae
from app import library as lib
from app import voices as vc
from app.mixdown import safe_stem
from app.models import Character, Generation, Job, MediaItem, Scene, VoiceProfile, VoiceScript, new_id, utcnow
from app.services import generation_file, job_out, media_url, new_seed, next_version
from app.storyboard import screenplay_lines

MIX_JOB = "script_mix"
STEMS_JOB = "script_stems"
NARRATOR = "narrator"
FINISHED = ("ready", "approved")
RUNNING = ("queued", "generating")
DEFAULT_SETTINGS = {"gap_s": 0.35, "paragraph_gap_s": 0.8, "loudness": "podcast", "aerab": True}
SR = 48000

# line kinds (contract v20); a line without one is speech. Clip kinds play a Library clip as their take.
KINDS = ("speech", "recording", "break", "ad", "music")
CLIP_KINDS = ("recording", "ad", "music")
BREAK_S = 1.0

NARRATOR_COLOR = "#5B4630"
# dark, earthy inks: each one holds 4.5:1 against the parchment panels, so a name can be set in it
PALETTE = ("#2F5D62", "#8B2E2E", "#4A5D23", "#5B3A6B", "#8A4F0E", "#2C4A7A", "#7D3C5A", "#3D6B4F",
           "#6B4F2A", "#4E4A8C", "#7A3B1E", "#36546E")


class ScriptError(RuntimeError):
    pass


def _short(prefix: str) -> str:
    return f"{prefix}{uuid.uuid4().hex[:10]}"


def take_tag(script_id: str) -> str:
    # Library tags stop at 40 characters (library.clean_tags), so the uuid goes in without its dashes
    return f"{lib.TAKE_TAG}{script_id.replace('-', '')}"


def _norm(text: str) -> str:
    return " ".join((text or "").split())


# ---------------------------------------------------------------- cast

def color_for(name: str, used: set[str]) -> str:
    # hashed so the same name gets the same ink in every script; probing keeps two names apart
    start = int(hashlib.sha1(name.casefold().encode()).hexdigest(), 16) % len(PALETTE)
    for i in range(len(PALETTE)):
        c = PALETTE[(start + i) % len(PALETTE)]
        if c not in used:
            return c
    return PALETTE[start]


def clean_cast(cast: list[dict] | None) -> list[dict]:
    out, seen = [], set()
    narrator = None
    for c in cast or []:
        cid = str(c.get("id") or "").strip() or _short("c_")
        if cid in seen:
            continue
        seen.add(cid)
        row = {"id": cid, "name": _norm(c.get("name") or "")[:80] or "Unnamed", "voice_id": c.get("voice_id") or None,
               "color": c.get("color") or None}
        if c.get("character_id"):
            # imported from a film (contract v26): the cast row stays tied to its character
            row["character_id"] = str(c["character_id"])[:36]
        if cid == NARRATOR:
            narrator = row
        else:
            out.append(row)
    narrator = narrator or {"id": NARRATOR, "name": "Narrator", "voice_id": None, "color": None}
    narrator["color"] = narrator["color"] or NARRATOR_COLOR
    used = {narrator["color"], *(c["color"] for c in out if c["color"])}
    for c in out:
        if not c["color"]:
            c["color"] = color_for(c["name"], used)
            used.add(c["color"])
    return [narrator, *out]


def speaker_for(cast: list[dict], name: str, aliases: dict[str, str] | None = None) -> str:
    """The cast id for a name from a cue or a NAME: prefix, adding the character when it's new."""
    key = _norm(name).casefold()
    if key in ("narrator", "narration", "v.o.", "vo"):
        return NARRATOR
    if aliases and key in aliases:
        return aliases[key]
    for c in cast:
        if c["name"].casefold() == key:
            return c["id"]
    display = _norm(name)
    # screenplay cues are in capitals; the cast panel reads better in title case
    if display.isupper():
        display = display.title()
    used = {c["color"] for c in cast if c.get("color")}
    c = {"id": _short("c_"), "name": display[:80], "voice_id": None, "color": color_for(display, used)}
    cast.append(c)
    return c["id"]


# ---------------------------------------------------------------- splitting

_PREFIX = re.compile(r"^\s*([^\W\d_][\w .'\-]{0,39}?)\s*:\s+(\S.*)$")
_SENTENCE = re.compile(r"[^.!?…۔؟।]+(?:[.!?…۔؟।]+[\"'”’)\]]*|$)")
_ABBR = re.compile(r"(?:\b(?:Mr|Mrs|Ms|Dr|St|Prof|Sr|Jr|vs|etc|e\.g|i\.e)\.)$", re.I)


def sentences(text: str) -> list[str]:
    parts = [p.strip() for p in _SENTENCE.findall(text) if p.strip()]
    out: list[str] = []
    for p in parts:
        if out and _ABBR.search(out[-1]):
            out[-1] = f"{out[-1]} {p}"
        else:
            out.append(p)
    return out or ([text.strip()] if text.strip() else [])


def _prefix(line: str) -> tuple[str, str] | None:
    m = _PREFIX.match(line)
    if not m or len(m[1].split()) > 4:
        return None
    return m[1], m[2].strip()


def is_screenplay(text: str) -> bool:
    prev = None
    for kind, _, _ in screenplay_lines(text):
        if kind in ("dialogue", "paren") and prev in ("cue", "paren"):
            return True
        prev = kind
    return False


def _line(speaker_id: str, text: str, *, emotion: str | None = None, para: bool = False) -> dict:
    return {"id": _short("l_"), "speaker_id": speaker_id, "text": text, "voice_id": None, "speed": None,
            "emotion": emotion, "pause_after_s": None, "para": para}


def _utterances_screenplay(text: str, cast: list[dict], include_action: bool, default: str,
                           aliases: dict[str, str] | None = None) -> list[dict]:
    """(speaker, text, emotion, para) from a flush-left screenplay: one utterance per dialogue block or
    action paragraph."""
    out: list[dict] = []
    buf: list[str] = []
    who, emotion, kind_now = None, None, None

    def flush():
        nonlocal buf
        if buf:
            out.append({"speaker_id": who, "text": " ".join(buf), "emotion": emotion, "para": False})
        buf = []

    for kind, cue, line in screenplay_lines(text):
        if kind == "break":
            flush()
            if out:
                out[-1]["para"] = True
            kind_now, emotion = None, None
            continue
        if kind == "cue":
            flush()
            who, emotion, kind_now = speaker_for(cast, cue, aliases), None, "dialogue"
            continue
        if kind == "paren":
            if kind_now == "dialogue":
                flush()
                emotion = line.strip("() ") or None
            continue
        if kind == "action":
            if not include_action:
                continue
            if kind_now != "action":
                flush()
                who, emotion, kind_now = default, None, "action"
        buf.append(line)
    flush()
    return out


def _utterances_plain(text: str, cast: list[dict], mode: str, default: str) -> list[dict]:
    out: list[dict] = []
    for block in re.split(r"\n\s*\n", text.replace("\r\n", "\n")):
        rows = [r.strip() for r in block.split("\n") if r.strip()]
        if not rows:
            continue
        who = default
        start = len(out)
        for row in rows:
            pre = _prefix(row)
            if pre is not None:
                who = speaker_for(cast, pre[0])
                out.append({"speaker_id": who, "text": pre[1], "emotion": None, "para": False})
            elif mode != "lines" and len(out) > start and out[-1]["speaker_id"] == who:
                # a wrapped line of the same speech, as pasted from a document
                out[-1]["text"] += " " + row
            else:
                out.append({"speaker_id": who, "text": row, "emotion": None, "para": False})
        if len(out) > start:
            out[-1]["para"] = True
    return out


def split(text: str, mode: str, cast: list[dict], speaker_id: str | None = None,
          include_action: bool = True) -> list[dict]:
    """New lines from pasted text. Adds unknown speakers to `cast` in place."""
    default = speaker_id if speaker_id and any(c["id"] == speaker_id for c in cast) else NARRATOR
    if is_screenplay(text):
        utts = _utterances_screenplay(text, cast, include_action, default)
    else:
        utts = _utterances_plain(text, cast, mode, default)
    lines: list[dict] = []
    for u in utts:
        pieces = sentences(u["text"]) if mode == "sentences" else [_norm(u["text"])]
        for i, p in enumerate(pieces):
            last = i == len(pieces) - 1
            lines.append(_line(u["speaker_id"], p, emotion=u["emotion"], para=u["para"] and last))
    return lines


def _film_character(cue: str, characters: list[Character]) -> Character | None:
    # cues are usually a first name in capitals: MAYA is Maya Khan
    key = _norm(cue).casefold()
    return next((c for c in characters if _norm(c.name).casefold() == key), None) or next(
        (c for c in characters if key in _norm(c.name).casefold().split()), None)


def bind_characters(scenes: list[Scene], cast: list[dict], characters: list[Character]) -> dict[str, str]:
    """Ties the scenes' speakers to the film's characters (contract v26): their cast row is found by
    character_id (a rename in either place doesn't split them) and takes the character's voice when it has
    none of its own. Returns cue -> cast id."""
    aliases: dict[str, str] = {}
    for sc in scenes:
        for kind, cue, _ in screenplay_lines(sc.script_text or ""):
            if kind != "cue" or cue.casefold() in aliases:
                continue
            c = _film_character(cue, characters)
            if c is None:
                continue
            row = next((r for r in cast if r.get("character_id") == c.id), None) or next(
                (r for r in cast if not r.get("character_id") and r["name"].casefold() in (cue.casefold(), c.name.casefold())),
                None)
            if row is None:
                used = {r["color"] for r in cast if r.get("color")}
                row = {"id": _short("c_"), "name": c.name[:80], "voice_id": None, "color": color_for(c.name, used)}
                cast.append(row)
            row["character_id"] = c.id
            row["voice_id"] = row.get("voice_id") or c.voice_id
            aliases[cue.casefold()] = row["id"]
    return aliases


def import_scenes(scenes: list[Scene], cast: list[dict], include_action: bool,
                  characters: list[Character] | None = None) -> list[dict]:
    aliases = bind_characters(scenes, cast, characters) if characters else None
    lines: list[dict] = []
    for sc in scenes:
        utts = _utterances_screenplay(sc.script_text or "", cast, include_action, NARRATOR, aliases)
        for u in utts:
            lines.append(_line(u["speaker_id"], _norm(u["text"]), emotion=u["emotion"], para=u["para"]))
        if lines:
            # a scene change always gets the longer breath
            lines[-1]["para"] = True
    return lines


# ---------------------------------------------------------------- fingerprints and status

def _voices(db: Session, s: VoiceScript) -> dict[str, VoiceProfile]:
    # gallery:<id> voices come back as unsaved profiles (contract v19)
    ids = {c.get("voice_id") for c in s.cast or []} | {ln.get("voice_id") for ln in s.lines or []}
    return vc.find_voices(db, s.workspace_id, ids)


def resolved_voice(s: VoiceScript, line: dict) -> str | None:
    if line.get("voice_id"):
        return line["voice_id"]
    c = next((c for c in s.cast or [] if c["id"] == line.get("speaker_id")), None)
    return (c or {}).get("voice_id")


def resolved_engine(s: VoiceScript, voice: VoiceProfile | None) -> str:
    try:
        return vc.resolve_engine(s.engine, voice, None).id
    except vc.VoiceError:
        # left for the render to refuse with its readable message
        return s.engine or "auto"


def kind_of(line: dict) -> str:
    k = line.get("kind")
    return k if k in KINDS else "speech"


def has_clip(line: dict) -> bool:
    return kind_of(line) in CLIP_KINDS and bool(line.get("media_id"))


def needs_tts(line: dict) -> bool:
    # a sponsor read is an ad line nobody recorded yet: a host voices it
    k = kind_of(line)
    return k == "speech" or (k == "ad" and not line.get("media_id"))


def fingerprint(s: VoiceScript, line: dict, voices: dict[str, VoiceProfile]) -> str:
    if not needs_tts(line):
        blob = json.dumps([kind_of(line), line.get("media_id"), line.get("pause_after_s")])
        return hashlib.sha1(blob.encode()).hexdigest()
    vid = resolved_voice(s, line)
    blob = json.dumps([_norm(line.get("text") or ""), vid, resolved_engine(s, voices.get(vid or "")),
                       (s.language or "en").lower(), round(float(line.get("speed") or 1.0), 3),
                       _norm(line.get("emotion") or "")], ensure_ascii=False)
    return hashlib.sha1(blob.encode()).hexdigest()


def _status(line: dict, fp: str, gen: Generation | None) -> str:
    if not _norm(line.get("text") or ""):
        return "empty"
    if gen is not None and gen.status in RUNNING:
        return "rendering"
    if gen is not None and line.get("take_fp") == fp:
        if gen.status in FINISHED and gen.file_path:
            return "ready"
        if gen.status == "failed":
            return "failed"
    if line.get("error") and line.get("error_fp") == fp:
        return "failed"
    return "stale" if gen is not None else "empty"


def _takes(db: Session, lines: list[dict]) -> dict[str, Generation]:
    ids = [ln["take_id"] for ln in lines if ln.get("take_id")]
    if not ids:
        return {}
    return {g.id: g for g in db.scalars(select(Generation).where(Generation.id.in_(ids)))}


def _sync_clips(db: Session, s: VoiceScript, lines: list[dict]) -> list[dict]:
    """A clip line's take is its clip's current version, whatever was stored before."""
    if not any(kind_of(ln) in CLIP_KINDS for ln in lines):
        return lines
    ids = [ln["media_id"] for ln in lines if has_clip(ln)]
    items = {i.id: i for i in db.scalars(select(MediaItem).where(MediaItem.id.in_(ids or [""]),
                                                                 MediaItem.workspace_id == s.workspace_id))}
    out = []
    for ln in lines:
        if kind_of(ln) in CLIP_KINDS and not needs_tts(ln):
            ln = dict(ln)
            item = items.get(ln.get("media_id") or "")
            if item is not None and item.generation_id:
                ln.update(take_id=item.generation_id, take_media_id=item.id, duration_s=item.duration_s)
            else:
                for key in ("take_id", "take_media_id", "take_fp", "duration_s"):
                    ln.pop(key, None)
        out.append(ln)
    return out


def refresh(db: Session, s: VoiceScript) -> list[dict]:
    """Recompute every line's fingerprint and status and store them; returns the lines."""
    voices = _voices(db, s)
    lines = _sync_clips(db, s, s.lines or [])
    gens = _takes(db, lines)
    out = []
    for ln in lines:
        ln = dict(ln)
        fp = fingerprint(s, ln, voices)
        ln["fingerprint"] = fp
        if kind_of(ln) == "break":
            ln["status"] = "ready"
        elif not needs_tts(ln):
            if ln.get("take_id"):
                ln["take_fp"] = fp
            ln["status"] = _status({**ln, "text": ln.get("text") or "clip"}, fp, gens.get(ln.get("take_id") or ""))
        else:
            ln["status"] = _status(ln, fp, gens.get(ln.get("take_id") or ""))
        if ln["status"] != "failed":
            ln.pop("error", None)
        out.append(ln)
    s.lines = out
    return out


def merge_lines(s: VoiceScript, incoming: list[dict]) -> list[dict]:
    """A PATCH sends the whole array. What the client may set comes from it; the take bookkeeping comes
    from what the server already has, so a stale tab can't point a line at someone else's take."""
    old = {ln["id"]: ln for ln in s.lines or []}
    speakers = {c["id"] for c in s.cast or []}
    out, seen = [], set()
    for ln in incoming:
        lid = ln.get("id") or _short("l_")
        if lid in seen:
            lid = _short("l_")
        seen.add(lid)
        prev = old.get(lid, {})
        row = {"id": lid, "speaker_id": ln.get("speaker_id") if ln.get("speaker_id") in speakers else NARRATOR,
               "text": (ln.get("text") or "").strip(), "voice_id": ln.get("voice_id") or None,
               "speed": ln.get("speed"), "emotion": _norm(ln.get("emotion") or "") or None,
               "pause_after_s": ln.get("pause_after_s"), "para": bool(ln.get("para"))}
        if kind_of(ln) != "speech":
            row["kind"] = kind_of(ln)
        for key in ("media_id", "chapter_id"):
            if ln.get(key):
                row[key] = ln[key]
        for key in ("take_id", "take_media_id", "take_fp", "error", "error_fp", "duration_s"):
            if prev.get(key) is not None:
                row[key] = prev[key]
        out.append(row)
    return out


def reassign_removed(s: VoiceScript) -> None:
    speakers = {c["id"] for c in s.cast or []}
    s.lines = [{**ln, "speaker_id": ln["speaker_id"] if ln.get("speaker_id") in speakers else NARRATOR}
               for ln in s.lines or []]


# ---------------------------------------------------------------- output

def settings_of(s: VoiceScript) -> dict:
    return {**DEFAULT_SETTINGS, **(s.settings or {})}


def gap_after(line: dict, settings: dict) -> float:
    if line.get("pause_after_s") is not None:
        return float(line["pause_after_s"])
    return float(settings["paragraph_gap_s"] if line.get("para") else settings["gap_s"])


def spoken(lines: list[dict]) -> list[dict]:
    """The lines that play something: speech with words, and clip lines (recordings, ads, music)."""
    out = []
    for ln in lines:
        if kind_of(ln) == "break":
            continue
        if needs_tts(ln) and _norm(ln.get("text") or ""):
            out.append(ln)
        elif not needs_tts(ln) and (ln.get("media_id") or kind_of(ln) == "recording"):
            # a recording nobody made yet still counts, so the mix waits for it
            out.append(ln)
    return out


def break_s(line: dict) -> float:
    return float(line["pause_after_s"]) if line.get("pause_after_s") is not None else BREAK_S


def mix_plan(s: VoiceScript, lines: list[dict]) -> tuple[list[str], list[float], list[str], str]:
    """(take ids, gap after each, speaker ids, basis hash) in script order; the last gap is 0. A break
    adds its length to the gap before it."""
    st = settings_of(s)
    keep = {id(ln) for ln in spoken(lines)}
    rows, gaps = [], []
    for ln in lines:
        if id(ln) in keep:
            rows.append(ln)
            gaps.append(round(gap_after(ln, st), 3))
        elif kind_of(ln) == "break" and gaps:
            gaps[-1] = round(gaps[-1] + break_s(ln), 3)
    takes = [ln.get("take_id") for ln in rows]
    if gaps:
        gaps[-1] = 0.0
    speakers = [ln["speaker_id"] for ln in rows]
    basis = hashlib.sha1(json.dumps([takes, gaps, st["loudness"]]).encode()).hexdigest()
    return takes, gaps, speakers, basis


def not_ready(lines: list[dict]) -> list[dict]:
    return [ln for ln in spoken(lines) if ln.get("status") != "ready"]


def counts(lines: list[dict]) -> dict:
    c = {"lines": len(lines), "ready": 0, "stale": 0, "empty": 0, "rendering": 0, "failed": 0}
    for ln in lines:
        c[ln.get("status") or "empty"] += 1
    return c


def _job(db: Session, job_id: str | None):
    j = db.get(Job, job_id) if job_id else None
    return job_out(j) if j is not None else None


def script_out(db: Session, s: VoiceScript) -> dict:
    lines = refresh(db, s)
    gens = _takes(db, lines)
    media = {i.id: i for i in db.scalars(select(MediaItem).where(
        MediaItem.id.in_([ln["take_media_id"] for ln in lines if ln.get("take_media_id")] or [""])))}
    errors = {}
    failed = [g.job_id for g in gens.values() if g.status == "failed" and g.job_id]
    if failed:
        errors = {j.id: j.error for j in db.scalars(select(Job).where(Job.id.in_(failed)))}
    out_lines = []
    for ln in lines:
        g = gens.get(ln.get("take_id") or "")
        item = media.get(ln.get("take_media_id") or "")
        err = ln.get("error")
        if ln["status"] == "failed" and not err and g is not None:
            err = errors.get(g.job_id or "") or "The take failed"
        ready = g is not None and g.status in FINISHED and g.file_path
        out_lines.append({**ln, "take_url": media_url(g.file_path) if ready else None,
                          "duration_s": ln.get("duration_s") or (item.duration_s if item else None),
                          "error": err if ln["status"] == "failed" else None})
    mix = None
    m = s.mix or {}
    if m.get("generation_id"):
        g = db.get(Generation, m["generation_id"])
        item = db.get(MediaItem, m.get("media_id") or "")
        if g is not None and item is not None:
            mix = {"media_id": item.id, "generation_id": g.id, "url": media_url(g.file_path),
                   "duration_s": (g.params or {}).get("duration_s"), "built_at": m.get("built_at"),
                   "stale": m.get("basis") != mix_plan(s, lines)[3] or bool(not_ready(lines))}
    return {"id": s.id, "title": s.title, "language": s.language, "engine": s.engine, "project_id": s.project_id,
            "cast": s.cast, "lines": out_lines, "settings": settings_of(s), "mix": mix,
            "mix_job": _job(db, m.get("job_id")), "stems_job": _job(db, m.get("stems_job_id")),
            "counts": counts(lines), "created_at": s.created_at, "updated_at": s.updated_at}


def summary_out(db: Session, s: VoiceScript) -> dict:
    lines = refresh(db, s)
    return {"id": s.id, "title": s.title, "language": s.language, "project_id": s.project_id,
            "counts": counts(lines), "has_mix": bool((s.mix or {}).get("generation_id")),
            "created_at": s.created_at, "updated_at": s.updated_at}


# ---------------------------------------------------------------- rendering lines

def _exaggeration(emotion: str) -> float:
    # Chatterbox has one emotion knob, its intensity; map the common words onto it
    e = emotion.lower()
    if any(w in e for w in ("whisper", "calm", "soft", "flat", "tired", "quiet", "sad")):
        return 0.3
    if any(w in e for w in ("shout", "angry", "excited", "furious", "scream", "panic", "laugh")):
        return 1.2
    return 0.8


def queue_render(db: Session, cur, s: VoiceScript, line_ids: list[str] | None) -> tuple[list, int]:
    from app.schemas import SpeakIn

    lines = refresh(db, s)
    if line_ids is not None:
        wanted = set(line_ids)
        todo = [ln for ln in lines if ln["id"] in wanted and ln["status"] != "rendering"]
    else:
        todo = [ln for ln in lines if ln["status"] in ("stale", "empty", "failed")]
    # recordings, breaks and clips never go to TTS
    todo = [ln for ln in todo if needs_tts(ln) and _norm(ln.get("text") or "")]
    voices = _voices(db, s)
    st = settings_of(s)
    names = {c["id"]: c["name"] for c in s.cast or []}
    by_id = {ln["id"]: ln for ln in lines}
    jobs, failed = [], 0
    for n, ln in enumerate(todo, start=1):
        vid = resolved_voice(s, ln)
        engine = resolved_engine(s, voices.get(vid or ""))
        emotion = _norm(ln.get("emotion") or "")
        extra = {}
        if emotion and engine == "chatterbox":
            extra["exaggeration"] = _exaggeration(emotion)
        title = f"{s.title} · {names.get(ln['speaker_id'], 'Narrator')} {lines.index(ln) + 1}"
        try:
            body = SpeakIn(text=ln["text"], voice_id=vid, engine=s.engine or "auto", language=s.language,
                           aerab=st["aerab"], speed=float(ln.get("speed") or 1.0), count=1, title=title[:200],
                           **extra)
            res = vc.queue_speech(db, cur, body, flow="dialogue")
        except HTTPException as e:
            row = by_id[ln["id"]]
            row.update(error=str(e.detail), error_fp=ln["fingerprint"])
            failed += 1
            continue
        item = db.get(MediaItem, res["items"][0].id)
        item.tags = [take_tag(s.id)]
        g = db.get(Generation, item.generation_id)
        params = {**(g.params or {}), "script": {"script_id": s.id, "line_id": ln["id"]}}
        if emotion and engine != "chatterbox" and "design" in vc.ENGINES.get(engine, vc.ENGINES[vc.DEFAULT_ENGINE]).features:
            params["emotion"] = emotion
        g.params = params
        row = by_id[ln["id"]]
        row.update(take_id=g.id, take_media_id=item.id, take_fp=ln["fingerprint"], duration_s=None)
        row.pop("error", None)
        row.pop("error_fp", None)
        jobs.append(res["jobs"][0])
    s.lines = [dict(by_id[ln["id"]]) for ln in lines]
    refresh(db, s)
    return jobs, failed


def on_job_finished(db: Session, job: Job) -> None:
    """Worker hook: a line's take finished, so store its length / error; a mix moved the script's mix."""
    if job.type == MIX_JOB:
        if job.status != "done":
            return
        p = job.payload or {}
        s = db.get(VoiceScript, p.get("script_id") or "")
        if s is None:
            return
        s.mix = {**(s.mix or {}), "media_id": p.get("media_id"), "generation_id": job.generation_id,
                 "built_at": utcnow().isoformat() + "Z", "basis": p.get("basis")}
        return
    if job.type != "generate" or not job.generation_id:
        return
    g = db.get(Generation, job.generation_id)
    ref = (g.params or {}).get("script") if g is not None else None
    if not ref:
        return
    s = db.get(VoiceScript, ref.get("script_id") or "")
    if s is None:
        return
    rows = []
    for ln in s.lines or []:
        ln = dict(ln)
        if ln["id"] == ref.get("line_id") and ln.get("take_id") == g.id:
            if g.status in FINISHED:
                ln["duration_s"] = (job.result or {}).get("duration_s")
                ln.pop("error", None)
            elif g.status == "failed" or job.status in ("failed", "cancelled"):
                ln["error"] = job.error or "Cancelled"
                ln["error_fp"] = ln.get("take_fp")
        rows.append(ln)
    s.lines = rows
    refresh(db, s)


# ---------------------------------------------------------------- mix and stems

def _check_ready(db: Session, s: VoiceScript) -> list[dict]:
    lines = refresh(db, s)
    if not spoken(lines):
        raise HTTPException(409, "There are no lines to mix yet")
    waiting = not_ready(lines)
    if waiting:
        n = len(waiting)
        raise HTTPException(409, f"{n} line{'s' if n != 1 else ''} {'aren' if n != 1 else 'isn'}'t ready yet. "
                                 "Render the changed lines first.")
    return lines


def queue_mix(db: Session, cur, s: VoiceScript) -> Job:
    lines = _check_ready(db, s)
    takes, gaps, speakers, basis = mix_plan(s, lines)
    m = dict(s.mix or {})
    item = db.get(MediaItem, m.get("media_id") or "")
    if item is None or item.workspace_id != s.workspace_id:
        item = MediaItem(id=new_id(), workspace_id=s.workspace_id, kind="audio", origin="generated",
                         title=s.title[:300], tags=["dialogue"], project_id=s.project_id)
        db.add(item)
        db.flush()
    parent = item.generation_id
    st = settings_of(s)
    params = {"script_id": s.id, "lines": len(takes), "loudness": st["loudness"],
              "created_by": {"user_id": cur.id, "flow": "dialogue_mix"}}
    g = Generation(id=new_id(), workspace_id=s.workspace_id, project_id=None, target_type="media",
                   target_id=item.id, kind="audio", version=next_version(db, "media", item.id, "audio"),
                   status="queued", prompt=s.title, seed=new_seed(), parent_id=parent, params=params)
    db.add(g)
    db.flush()
    if item.generation_id is None:
        item.generation_id = g.id
    job = Job(workspace_id=s.workspace_id, type=MIX_JOB, generation_id=g.id, message="Waiting for a worker · Mix",
              payload={"script_id": s.id, "media_id": item.id, "takes": takes, "gaps": gaps, "basis": basis,
                       "loudness": st["loudness"]})
    db.add(job)
    db.flush()
    g.job_id = job.id
    lib.touch(item)
    m.update(media_id=item.id, job_id=job.id)
    s.mix = m
    return job


def queue_stems(db: Session, s: VoiceScript) -> Job:
    lines = _check_ready(db, s)
    takes, gaps, speakers, _ = mix_plan(s, lines)
    names = {c["id"]: c["name"] for c in s.cast or []}
    job = Job(workspace_id=s.workspace_id, type=STEMS_JOB, message="Waiting for a worker · Stems",
              payload={"script_id": s.id, "title": s.title, "takes": takes, "gaps": gaps, "speakers": speakers,
                       "names": {sp: names.get(sp, sp) for sp in set(speakers)}})
    db.add(job)
    db.flush()
    s.mix = {**(s.mix or {}), "stems_job_id": job.id}
    return job


def _take_files(db: Session, take_ids: list[str]):
    out = []
    for n, tid in enumerate(take_ids, start=1):
        g = db.get(Generation, tid or "")
        path = generation_file(g) if g is not None else None
        if path is None or not path.is_file():
            raise ScriptError(f"The take for line {n} is gone; render it again")
        out.append(path)
    return out


def timeline_graph(n: int, gaps: list[float], keep: list[bool] | None = None) -> str:
    """Every take back to back with its gap after it as padding; with `keep`, the takes not kept are
    muted in place so a stem lines up with the mix sample for sample."""
    parts = []
    for i in range(n):
        f = [f"aresample={SR}", f"aformat=sample_fmts=fltp:channel_layouts=mono"]
        if keep is not None and not keep[i]:
            f.append("volume=0")
        if gaps[i] > 0:
            f.append(f"apad=pad_dur={gaps[i]:.3f}")
        parts.append(f"[{i}:a]{','.join(f)}[p{i}]")
    parts.append("".join(f"[p{i}]" for i in range(n)) + f"concat=n={n}:v=0:a=1[out]")
    return ";".join(parts)


def _render_timeline(files, gaps, dst, keep=None, out_args=None, tick=None) -> None:
    inputs = []
    for p in files:
        inputs += ["-i", str(p)]
    ae.run([*inputs, "-filter_complex", timeline_graph(len(files), gaps, keep), "-map", "[out]",
            *(out_args or ["-c:a", "pcm_f32le"]), str(dst)], tick=tick)


def handle_mix(ctx) -> dict:
    db, job = ctx.db, ctx.job
    p = job.payload or {}
    gen = db.get(Generation, job.generation_id or "")
    if gen is None:
        raise ScriptError("The mix's record no longer exists")
    gen.status = "generating"
    db.commit()
    files = _take_files(db, p.get("takes") or [])
    gaps = [float(x) for x in p.get("gaps") or []]
    folder, rel_folder = lib.media_dir(gen.workspace_id)
    folder.mkdir(parents=True, exist_ok=True)
    dst = folder / f"{gen.id}.flac"
    joined = folder / f".{gen.id}.joined.wav"
    part = folder / f".{gen.id}.part.flac"
    t0 = time.monotonic()
    tick = lambda: ctx.progress(0.4, "Joining the lines")  # noqa: E731
    try:
        ctx.progress(0.05, f"Joining {len(files)} lines")
        _render_timeline(files, gaps, joined, tick=tick)
        loud = p.get("loudness")
        flac = ae.FORMATS["flac"][0]
        if loud and loud != "none":
            ctx.progress(0.6, "Measuring loudness")
            ae.render({"loudness": {"target": loud}}, joined, part, flac, tick=lambda: ctx.progress(0.7, "Levelling"))
        else:
            ae.run(["-i", str(joined), *flac, str(part)])
        ctx.progress(0.95, "Saving")
        part.replace(dst)
    finally:
        joined.unlink(missing_ok=True)
        part.unlink(missing_ok=True)
    db.refresh(gen)
    rel = f"{rel_folder}/{dst.name}"
    dur = round(aa.stream_info(dst).duration, 3)
    gen.params = {**(gen.params or {}), "duration_s": dur}
    gen.file_path, gen.media_type, gen.status = rel, "audio/flac", "ready"
    return {"file_path": rel, "media_type": "audio/flac", "duration_s": dur, "lines": len(files),
            "bytes": dst.stat().st_size, "seconds": round(time.monotonic() - t0, 3)}


def handle_stems(ctx) -> dict:
    db, job = ctx.db, ctx.job
    p = job.payload or {}
    files = _take_files(db, p.get("takes") or [])
    gaps = [float(x) for x in p.get("gaps") or []]
    speakers = p.get("speakers") or []
    names = p.get("names") or {}
    folder, rel_folder = lib.media_dir(job.workspace_id)
    folder.mkdir(parents=True, exist_ok=True)
    work = folder / f".{job.id}.stems"
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)
    zip_name = f"{safe_stem(p.get('title') or '', 'dialogue')}-stems-{job.id[:8]}.zip"
    zip_path = folder / zip_name
    order = list(dict.fromkeys(speakers))
    written = []
    try:
        for n, sp in enumerate(order, start=1):
            ctx.progress(0.05 + 0.85 * (n - 1) / max(1, len(order)), f"Stem {n} of {len(order)}")
            stem = f"{n:02d}-{safe_stem(names.get(sp) or sp, 'voice')}.wav"
            # unlevelled on purpose: stems are for a mixer, which sets its own levels
            _render_timeline(files, gaps, work / stem, keep=[x == sp for x in speakers],
                             out_args=["-c:a", "pcm_s16le"])
            written.append({"speaker_id": sp, "name": names.get(sp) or sp, "file": stem})
        ctx.progress(0.95, "Packing the zip")
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
            for w in written:
                z.write(work / w["file"], w["file"])
    finally:
        shutil.rmtree(work, ignore_errors=True)
    return {"url": media_url(f"{rel_folder}/{zip_name}"), "file_path": f"{rel_folder}/{zip_name}",
            "stems": written, "bytes": zip_path.stat().st_size}
