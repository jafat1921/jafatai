"""The DubProject row: its stages, segments and speakers, the editor's changes, and queueing stage jobs.

JSON columns only notice a new object, so every change here builds a fresh list or dict.
"""
import copy
import uuid
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app import voices as vc
from app.config import get_settings
from app.lanes import dub_lane
from app.models import DubProject, Generation, Job, MediaItem
from app.services import generation_file, job_out, media_url

STAGES = ("extract", "separate", "transcribe", "speakers", "translate", "cast", "render", "fit", "verify", "mix")
# the pipeline stops after these for the user to check (and fix) what they produced
REVIEW_AFTER = ("speakers", "translate")
STAGE_LABELS = {"extract": "Extracting the sound", "separate": "Separating voice and background",
                "transcribe": "Transcribing", "speakers": "Finding the speakers", "translate": "Translating",
                "cast": "Casting voices", "render": "Voicing the lines", "fit": "Fitting the timing",
                "verify": "Checking the takes", "mix": "Mixing the dub"}
STAGE_JOB = "dub_stage"
EXPORT_JOB = "dub_export"
DEFAULT_SETTINGS = {"quality": "fast", "fit": "smart", "keep_background": True, "background_db": 0.0,
                    "voice_match": "per_speaker", "speakers": "auto"}
FITS = ("smart", "stretch", "strict")
# a target line whose take no longer matches its text / voice / timing
RENDERED = ("rendered", "fitted", "verified")
FINISHED = ("ready", "approved")
ACTIVE_JOB = ("queued", "running")


def seg_id() -> str:
    return "s" + uuid.uuid4().hex[:8]


def dub_dir(dub: DubProject) -> tuple[Path, str]:
    rel = f"workspaces/{dub.workspace_id}/dubs/{dub.id}"
    return get_settings().data_dir / rel, rel


def new_stages() -> dict:
    return {s: {"status": "pending", "progress": 0.0} for s in STAGES}


def set_stage(dub: DubProject, name: str, **fields) -> None:
    stages = copy.deepcopy(dub.stages or new_stages())
    row = {k: v for k, v in stages.get(name, {}).items() if k != "error"}
    row.update({k: v for k, v in fields.items() if v is not None})
    stages[name] = row
    dub.stages = stages


def reset_from(dub: DubProject, name: str) -> None:
    for s in STAGES[STAGES.index(name):]:
        set_stage(dub, s, status="pending", progress=0.0)


def first_open(dub: DubProject) -> str | None:
    return next((s for s in STAGES if (dub.stages or {}).get(s, {}).get("status") != "done"), None)


def active_job(db: Session, dub: DubProject) -> Job | None:
    job = db.get(Job, dub.job_id) if dub.job_id else None
    return job if job is not None and job.status in ACTIVE_JOB else None


def ensure_idle(db: Session, dub: DubProject) -> None:
    if active_job(db, dub) is not None:
        raise HTTPException(409, "The dub is busy with a step; wait for it to finish or cancel it first")


def queue_stage(db: Session, dub: DubProject, stage: str, run: dict | None = None) -> Job:
    job = Job(workspace_id=dub.workspace_id, type=STAGE_JOB, lane=dub_lane(stage),
              payload={"dub_id": dub.id, "stage": stage, **(run or {})},
              message=f"Waiting for a worker · Dub: {STAGE_LABELS[stage]}")
    db.add(job)
    db.flush()
    dub.job_id = job.id
    dub.stage = stage
    set_stage(dub, stage, status="pending", progress=0.0)
    return job


# ---------------------------------------------------------------- reading

def target(seg: dict, lang: str) -> dict:
    return (seg.get("target") or {}).get(lang) or {}


def langs_of(dub: DubProject, run: dict | None) -> list[str]:
    run = run or {}
    langs = run.get("langs") or list(run.get("only") or {}) or dub.targets or []
    return [lang for lang in langs if lang in (dub.targets or [])]


def speaker_map(dub: DubProject) -> dict[str, dict]:
    return {s["id"]: s for s in dub.speakers or []}


def _file_url(dub: DubProject, rel: str | None, version: str | None = None) -> str | None:
    if not rel:
        return None
    root, base = dub_dir(dub)
    if not (root / rel).is_file():
        return None
    url = media_url(f"{base}/{rel}")
    # the same path is written again on a re-render; the version keeps the browser from replaying the old take
    return f"{url}?v={version}" if version else url


def _item_url(db: Session, media_id: str | None) -> str | None:
    item = db.get(MediaItem, media_id) if media_id else None
    g = db.get(Generation, item.generation_id) if item is not None and item.generation_id else None
    return media_url(g.file_path) if g is not None and g.status in FINISHED else None


def dub_out(db: Session, dub: DubProject, *, light: bool = False) -> dict:
    src = db.get(Generation, dub.video_generation_id)
    job = db.get(Job, dub.job_id) if dub.job_id else None
    out = {"id": dub.id, "video_id": dub.video_id, "video_generation_id": dub.video_generation_id,
           "title": dub.title, "source_language": dub.source_language, "targets": list(dub.targets or []),
           "stage": dub.stage, "stages": dub.stages or new_stages(), "settings": {**DEFAULT_SETTINGS,
                                                                                  **(dub.settings or {})},
           "duration_s": dub.duration_s, "video_url": media_url(src.file_path) if src is not None else None,
           "job": job_out(job) if job is not None else None, "created_at": dub.created_at,
           "updated_at": dub.updated_at, "segment_count": len(dub.segments or []),
           "speaker_count": len(dub.speakers or [])}
    tracks = {}
    for lang, t in (dub.tracks or {}).items():
        tracks[lang] = {**t, "url": _item_url(db, t.get("media_id"))}
    out["tracks"] = tracks
    if light:
        return out
    voices = vc.find_voices(db, dub.workspace_id, [s.get("voice_id") for s in dub.speakers or []])
    samples = {m.id: m for m in db.query(MediaItem).filter(
        MediaItem.id.in_([s.get("sample_media_id") for s in dub.speakers or [] if s.get("sample_media_id")])).all()}
    out["speakers"] = [{**s, "sample_url": _item_url(db, s.get("sample_media_id")),
                        "sample_duration_s": getattr(samples.get(s.get("sample_media_id")), "duration_s", None),
                        "voice_name": voices[s["voice_id"]].name if s.get("voice_id") in voices else None}
                       for s in dub.speakers or []]
    segs = []
    for s in dub.segments or []:
        row = {k: v for k, v in s.items() if k != "target"}
        row["target"] = {}
        for lang, t in (s.get("target") or {}).items():
            tid = t.get("take_id")
            fitted = t.get("status") in ("fitted", "verified")
            url = None
            if tid:
                url = (_file_url(dub, f"fit/{lang}/{s['id']}.flac", tid) if fitted else None) or \
                    _file_url(dub, f"takes/{lang}/{tid}.flac", tid)
            row["target"][lang] = {**t, "take_url": url}
        segs.append(row)
    out["segments"] = segs
    out["glossary"] = dub.glossary or []
    out["stems"] = {"vocals": _file_url(dub, "vocals.wav"), "instrumental": _file_url(dub, "instrumental.wav")}
    return out


# ---------------------------------------------------------------- editing

def _stale(t: dict) -> dict:
    """A target line whose text, voice or slot changed: re-voice it if it was voiced, else it just waits."""
    t = dict(t)
    if t.get("take_id") or t.get("status") in RENDERED + ("failed",):
        t["status"] = "stale"
    elif t.get("text", "").strip():
        t["status"] = "translated"
    t.pop("verify", None)
    return t


def edit_segments(dub: DubProject, edits: list[dict], speakers: dict[str, dict]) -> None:
    by_id = {s["id"]: s for s in dub.segments or []}
    out = copy.deepcopy(dub.segments or [])
    index = {s["id"]: i for i, s in enumerate(out)}
    for e in edits:
        if e["id"] not in by_id:
            raise HTTPException(404, f"Segment {e['id']} not found")
        seg = out[index[e["id"]]]
        retake = False
        if e.get("source_text") is not None and " ".join(e["source_text"].split()) != seg.get("source_text"):
            seg["source_text"] = " ".join(e["source_text"].split())
            seg.pop("words", None)
            # the translation was of the old words: translate those lines again
            seg["target"] = {lang: {**t, "status": "pending", "verify": None} for lang, t in
                             (seg.get("target") or {}).items()}
        if e.get("speaker_id") is not None and e["speaker_id"] != seg.get("speaker_id"):
            if e["speaker_id"] not in speakers:
                raise HTTPException(422, f"Unknown speaker {e['speaker_id']}")
            seg["speaker_id"] = e["speaker_id"]
            retake = True
        for key in ("start", "end"):
            if e.get(key) is not None and abs(float(e[key]) - float(seg[key])) > 1e-3:
                seg[key] = round(float(e[key]), 3)
                retake = True
        if seg["end"] - seg["start"] < 0.2:
            raise HTTPException(422, "A segment has to be at least 0.2 s long")
        tgt = dict(seg.get("target") or {})
        for lang, change in (e.get("target") or {}).items():
            if lang not in (dub.targets or []):
                raise HTTPException(422, f"{lang} isn't one of this dub's languages")
            t = dict(tgt.get(lang) or {"fit": (dub.settings or {}).get("fit", "smart"), "status": "pending"})
            changed = False
            if change.get("text") is not None and " ".join(change["text"].split()) != t.get("text"):
                t["text"] = " ".join(change["text"].split())
                t["shortened"] = False
                changed = True
            if change.get("fit") is not None and change["fit"] != t.get("fit"):
                if change["fit"] not in FITS:
                    raise HTTPException(422, f"fit must be one of {', '.join(FITS)}")
                t["fit"] = change["fit"]
                changed = True
            if change.get("voice_id") is not None and change["voice_id"] != t.get("voice_id"):
                t["voice_id"] = change["voice_id"] or None
                changed = True
            tgt[lang] = _stale(t) if changed else t
        if retake:
            tgt = {lang: _stale(t) for lang, t in tgt.items()}
        seg["target"] = tgt
    dub.segments = out


def edit_speakers(db: Session, dub: DubProject, edits: list[dict]) -> None:
    out = copy.deepcopy(dub.speakers or [])
    index = {s["id"]: i for i, s in enumerate(out)}
    recast = set()
    for e in edits:
        if e["id"] not in index:
            raise HTTPException(404, f"Speaker {e['id']} not found")
        s = out[index[e["id"]]]
        if e.get("label") is not None:
            s["label"] = " ".join(e["label"].split())[:80] or s["label"]
        if "voice_id" in e and e["voice_id"] != s.get("voice_id"):
            if e["voice_id"]:
                if vc.find_voice(db, dub.workspace_id, e["voice_id"]) is None:
                    raise HTTPException(422, "That voice isn't in the library")
            s["voice_id"] = e["voice_id"] or None
            recast.add(s["id"])
    dub.speakers = out
    if recast:
        dub.segments = [{**seg, "target": {lang: _stale(t) for lang, t in (seg.get("target") or {}).items()}}
                        if seg.get("speaker_id") in recast else seg for seg in copy.deepcopy(dub.segments or [])]


def set_targets(dub: DubProject, targets: list[str]) -> None:
    targets = list(dict.fromkeys(t.lower() for t in targets))
    added = [t for t in targets if t not in (dub.targets or [])]
    dub.targets = targets
    status = (dub.stages or {}).get("translate", {}).get("status")
    if added and status in ("done", "review"):
        # the new languages still need translating; everything after it follows
        reset_from(dub, "translate")
        dub.stage = "translate"


def _split_text(text: str, frac: float) -> tuple[str, str]:
    words = text.split()
    if len(words) < 2:
        return text, ""
    k = min(len(words) - 1, max(1, round(len(words) * frac)))
    return " ".join(words[:k]), " ".join(words[k:])


def split_segment(dub: DubProject, segment_id: str, at: float) -> None:
    segs = copy.deepcopy(dub.segments or [])
    i = next((k for k, s in enumerate(segs) if s["id"] == segment_id), None)
    if i is None:
        raise HTTPException(404, "Segment not found")
    s = segs[i]
    if not s["start"] + 0.2 <= at <= s["end"] - 0.2:
        raise HTTPException(422, "Split somewhere inside the segment, at least 0.2 s from either end")
    words = s.get("words") or []
    if words:
        left_w = [w for w in words if (w["start"] + w["end"]) / 2 < at]
        right_w = [w for w in words if (w["start"] + w["end"]) / 2 >= at]
        left_t, right_t = " ".join(w["w"] for w in left_w), " ".join(w["w"] for w in right_w)
        frac = len(left_w) / max(1, len(words))
    else:
        frac = (at - s["start"]) / (s["end"] - s["start"])
        left_t, right_t = _split_text(s.get("source_text") or "", frac)
        left_w = right_w = []
    a, b = dict(s), dict(s)
    a.update(end=round(at, 3), source_text=left_t, words=left_w)
    b.update(id=seg_id(), start=round(at, 3), source_text=right_t, words=right_w)
    ta, tb = {}, {}
    for lang, t in (s.get("target") or {}).items():
        x, y = _split_text(t.get("text") or "", frac)
        ta[lang] = _stale({**t, "text": x})
        tb[lang] = _stale({**{k: v for k, v in t.items() if k not in ("take_id", "takes")}, "text": y,
                           "status": "translated" if y else t.get("status")})
    a["target"], b["target"] = ta, tb
    segs[i:i + 1] = [a, b]
    dub.segments = segs


def merge_segments(dub: DubProject, ids: list[str]) -> None:
    segs = copy.deepcopy(dub.segments or [])
    pos = [k for k, s in enumerate(segs) if s["id"] in ids]
    if len(pos) < 2 or len(pos) != len(set(ids)):
        raise HTTPException(422, "Pick two or more segments to merge")
    if pos != list(range(pos[0], pos[0] + len(pos))):
        raise HTTPException(422, "Only neighbouring segments can be merged")
    group = [segs[k] for k in pos]
    first = dict(group[0])
    first.update(end=max(s["end"] for s in group),
                 source_text=" ".join(s.get("source_text") or "" for s in group).strip(),
                 words=[w for s in group for w in s.get("words") or []])
    tgt = {}
    for lang in {lang for s in group for lang in (s.get("target") or {})}:
        parts = [target(s, lang) for s in group]
        base = next((p for p in parts if p), {})
        tgt[lang] = _stale({**base, "text": " ".join((p.get("text") or "") for p in parts).strip()})
    first["target"] = tgt
    segs[pos[0]:pos[-1] + 1] = [first]
    dub.segments = segs


# ---------------------------------------------------------------- sources

def video_file(db: Session, dub: DubProject) -> Path:
    g = db.get(Generation, dub.video_generation_id)
    path = generation_file(g) if g is not None else None
    if path is None or not path.is_file():
        raise RuntimeError("The video being dubbed is gone")
    return path
