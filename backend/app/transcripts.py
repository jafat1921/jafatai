"""Transcribe (contract v18): timed transcripts of Library audio and video, subtitles, and an LLM tidy-up.

Subtitle cues follow the usual broadcast rules: at most two lines of 42 characters, at most 7 seconds,
split on word timings when Whisper gave them and in proportion to the text when it didn't.
"""
import re
import shutil
import time

from fastapi import HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app import aerab
from app import library as lib
from app import subtitles as subs
from app.audio_analysis import stream_info
from app.models import Generation, Job, MediaItem, Transcript, new_id
from app.services import generation_file, new_seed, next_version

TRANSCRIBE_JOB = "transcribe"
CLEANUP_JOB = "transcript_cleanup"
VIDEO_JOB = "transcript_video"
FINISHED = ("ready", "approved")

MAX_CHARS = 42
MAX_LINES = 2
MAX_CUE_S = 7.0
MIN_CUE_S = 0.7
CLEANUP_BATCH = 25


# ---------------------------------------------------------------- subtitles

def wrap(text: str, width: int | None = None) -> list[str] | None:
    """The text on one line, or on two balanced lines, or None when it needs more than two.

    Width defaults to 42 (34 for Urdu's Nastaliq), counted in base letters: aerab don't take up a column."""
    return subs.wrap(text, width)


def _word_text(w: dict) -> str:
    return str(w.get("w") or w.get("word") or "").strip()


def _from_words(words: list[dict]) -> list[tuple[float, float, str]]:
    out, cur = [], []

    def emit():
        if cur:
            out.append((float(cur[0]["start"]), float(cur[-1]["end"]), " ".join(_word_text(w) for w in cur)))
            cur.clear()

    for w in words:
        if not _word_text(w):
            continue
        if cur:
            text = " ".join(_word_text(x) for x in cur + [w])
            too_long = wrap(text) is None or float(w["end"]) - float(cur[0]["start"]) > MAX_CUE_S
            # a full stop is a good place to break once the cue already says something
            sentence_end = re.search(r"[.?!۔؟]$", _word_text(cur[-1])) and len(" ".join(map(_word_text, cur))) > 20
            if too_long or sentence_end:
                emit()
        cur.append(w)
    emit()
    return out


def _proportional(start: float, end: float, text: str) -> list[tuple[float, float, str]]:
    chunks, cur = [], []
    for word in text.split():
        if cur and wrap(" ".join(cur + [word])) is None:
            chunks.append(" ".join(cur))
            cur = []
        cur.append(word)
    if cur:
        chunks.append(" ".join(cur))
    words = text.split()
    k = len(chunks)
    if k > 1:
        # same number of cues, words shared out evenly, so the last one isn't a lonely word or two
        even = [" ".join(words[round(i * len(words) / k):round((i + 1) * len(words) / k)]) for i in range(k)]
        if all(wrap(c) is not None for c in even):
            chunks = even
    total = sum(len(c) for c in chunks) or 1
    out, t = [], start
    for c in chunks:
        d = (end - start) * len(c) / total
        out.append((t, t + d, c))
        t += d
    return out


def cues(segments: list[dict], *, clean: bool = False) -> list[tuple[float, float, str]]:
    out: list[tuple[float, float, str]] = []
    for s in segments:
        text = (s.get("clean") if clean and s.get("clean") is not None else s.get("text")) or ""
        if not text.strip():
            continue
        # tidied text no longer matches the word timings
        words = None if clean and s.get("clean") is not None else s.get("words")
        if words:
            out += _from_words(words)
        else:
            out += _proportional(float(s["start"]), float(s["end"]), text)
    fixed = []
    for i, (a, b, text) in enumerate(out):
        b = max(b, a + MIN_CUE_S)
        if i + 1 < len(out):
            b = min(b, out[i + 1][0])
        fixed.append((round(a, 3), round(max(b, a + 0.05), 3), text))
    return fixed


def to_srt(items: list[tuple[float, float, str]]) -> str:
    return subs.srt_text(items)


def to_vtt(items: list[tuple[float, float, str]]) -> str:
    return subs.vtt_text(items)


# ---------------------------------------------------------------- the rows

def media_source(db: Session, workspace_id: str, media_id: str, *, video_only: bool = False
                 ) -> tuple[MediaItem, Generation]:
    item = db.get(MediaItem, media_id) if media_id else None
    if item is None or item.workspace_id != workspace_id:
        raise HTTPException(404, "Media not found")
    if item.kind not in (("video",) if video_only else ("audio", "video")):
        raise HTTPException(422, "Pick a video" if video_only else "Pick an audio clip or a video")
    g = db.get(Generation, item.generation_id or "")
    if g is None or g.status not in FINISHED or not g.file_path:
        raise HTTPException(409, "That item isn't finished yet")
    path = generation_file(g)
    if path is None or not path.is_file():
        raise HTTPException(422, "That item's file is missing")
    if not stream_info(path).has_audio:
        raise HTTPException(422, "That item has no sound to transcribe")
    return item, g


def transcript_out(t: Transcript) -> dict:
    return {"id": t.id, "media_id": t.media_id, "generation_id": t.generation_id, "title": t.title,
            "language": t.language, "text": t.text, "segments": t.segments or [], "cleanup_text": t.cleanup_text,
            "status": t.status, "error": t.error, "job_id": t.job_id, "duration_s": t.duration_s,
            "words": t.words, "created_at": t.created_at, "updated_at": t.updated_at}


def queue_transcribe(db: Session, workspace_id: str, media_id: str, language: str | None, words: bool,
                     cleanup: bool) -> tuple[Transcript, Job]:
    item, g = media_source(db, workspace_id, media_id)
    lang = (language or "").lower() or None
    t = Transcript(id=new_id(), workspace_id=workspace_id, media_id=item.id, generation_id=g.id,
                   title=item.title or "Transcript", language=None if lang == "auto" else lang, words=words,
                   status="queued", segments=[])
    db.add(t)
    db.flush()
    job = Job(workspace_id=workspace_id, type=TRANSCRIBE_JOB, payload={"transcript_id": t.id, "cleanup": cleanup},
              message="Waiting for a worker · Transcript")
    db.add(job)
    db.flush()
    t.job_id = job.id
    return t, job


def queue_cleanup(db: Session, t: Transcript) -> Job:
    job = Job(workspace_id=t.workspace_id, type=CLEANUP_JOB, payload={"transcript_id": t.id},
              message="Waiting for the LLM · Tidy transcript")
    db.add(job)
    db.flush()
    t.job_id = job.id
    return job


def queue_video(db: Session, t: Transcript, mode: str, clean: bool, user_id: str | None) -> tuple[MediaItem, Job]:
    item, src = media_source(db, t.workspace_id, t.media_id, video_only=True)
    if t.generation_id and t.generation_id != src.id:
        src = db.get(Generation, t.generation_id) or src
    keep = {k: v for k, v in (src.params or {}).items() if k in ("size", "fps", "duration_s", "aspect")}
    g = Generation(id=new_id(), workspace_id=t.workspace_id, project_id=None, target_type="media",
                   target_id=item.id, kind="video", version=next_version(db, "media", item.id, "video"),
                   status="queued", prompt=src.prompt or "", seed=new_seed(), parent_id=src.id,
                   note=f"Subtitles ({'burned in' if mode == 'burn' else 'soft'})",
                   params={**keep, "has_audio": True, "subtitles": {"transcript_id": t.id, "mode": mode,
                                                                     "clean": clean},
                           "source_id": src.id, "created_by": {"user_id": user_id, "flow": "transcribe"}})
    db.add(g)
    db.flush()
    job = Job(workspace_id=t.workspace_id, type=VIDEO_JOB, generation_id=g.id, message="Waiting for a worker · Subtitles",
              payload={"transcript_id": t.id, "generation_id": g.id, "source_id": src.id, "mode": mode,
                       "clean": clean})
    db.add(job)
    db.flush()
    g.job_id = job.id
    lib.touch(item)
    return item, job


# ---------------------------------------------------------------- jobs

def _recording_failure(ctx, transcript_id: str, fn, *, failed: str = "failed", prefix: str = ""):
    """Run fn(); if it raises, note it on the transcript in a fresh transaction (the worker rolls back)."""
    from app.worker import WorkerStopping

    db = ctx.db
    try:
        return fn()
    except BaseException as e:
        db.rollback()
        t = db.get(Transcript, transcript_id)
        if t is not None:
            if isinstance(e, WorkerStopping):
                t.status = "queued" if failed == "failed" else failed
            else:
                t.status = failed
                t.error = (prefix + (str(e) or "Cancelled"))[:2000]
            db.commit()
        raise


def _words(seg: dict) -> list[dict]:
    return [{"start": round(float(w["start"]), 3), "end": round(float(w["end"]), 3), "w": _word_text(w)}
            for w in seg.get("words") or [] if _word_text(w)]


def handle_transcribe(ctx) -> dict:
    db, job = ctx.db, ctx.job
    tid = (job.payload or {}).get("transcript_id") or ""
    t = db.get(Transcript, tid)
    if t is None:
        raise RuntimeError("The transcript no longer exists")

    def run():
        g = db.get(Generation, t.generation_id or "")
        path = generation_file(g) if g is not None else None
        if path is None or not path.is_file():
            raise RuntimeError("The file to transcribe is gone")
        t.status, t.error = "running", None
        db.commit()
        driver = ctx.driver_factory()
        if getattr(driver, "transcribe", None) is None:
            raise RuntimeError(f"The {getattr(driver, 'name', '?')} driver can't transcribe")
        ctx.progress(0.02, "Transcribing")
        res = driver.transcribe(path, t.language, ctx.progress)
        segs = []
        for s in res.get("segments") or []:
            text = " ".join(str(s.get("text") or "").split())
            if not text:
                continue
            row = {"start": round(float(s["start"]), 3), "end": round(float(s["end"]), 3), "text": text}
            if t.words:
                row["words"] = _words(s)
            segs.append(row)
        db.refresh(t)
        t.segments = segs
        t.text = " ".join(s["text"] for s in segs)
        t.language = t.language or res.get("language")
        t.duration_s = res.get("duration_s") or stream_info(path).duration
        t.status = "done"
        if (job.payload or {}).get("cleanup") and segs:
            queue_cleanup(db, t)
            t.status = "cleaning"
        return {"transcript_id": t.id, "segments": len(segs), "language": t.language}

    return _recording_failure(ctx, tid, run)


class CleanLine(BaseModel):
    i: int
    text: str


class CleanLines(BaseModel):
    lines: list[CleanLine]


def cleanup_messages(lines: list[str], language: str | None) -> list[dict]:
    rules = [
        "You tidy speech transcripts for reading.",
        "For each numbered line: remove filler words (um, uh, er, you know, I mean when it is filler), stutters, "
        "false starts and words said twice; fix punctuation and capitals.",
        "Keep every name, term, number and technical word exactly as written. Never add, summarise, translate "
        f"or change the meaning. The language stays {language or 'as it is'}.",
        'Reply as JSON: {"lines": [{"i": line number, "text": "tidied line"}]}, one entry per line.',
    ]
    # a tidied Urdu or Arabic transcript is read aloud and dubbed from, so it comes back marked
    marks = aerab.writing_rule(language, "\n".join(lines))
    if marks:
        rules.insert(3, marks)
    user ="\n".join(f"{i}. {line}" for i, line in enumerate(lines, 1))
    return [{"role": "system", "content": "\n".join(rules)}, {"role": "user", "content": user}]


def handle_cleanup(ctx) -> dict:
    from app.llm import chat_sync

    db, job = ctx.db, ctx.job
    tid = (job.payload or {}).get("transcript_id") or ""
    t = db.get(Transcript, tid)
    if t is None:
        raise RuntimeError("The transcript no longer exists")

    def run():
        t.status = "cleaning"
        db.commit()
        segs = [dict(s) for s in t.segments or []]
        for b in range(0, len(segs), CLEANUP_BATCH):
            batch = segs[b:b + CLEANUP_BATCH]
            ctx.progress(0.05 + 0.9 * b / max(1, len(segs)), "Tidying the transcript")
            res = chat_sync("creative", cleanup_messages([s["text"] for s in batch], t.language),
                            tick=lambda: ctx.progress(0.05 + 0.9 * b / max(1, len(segs)), "Tidying the transcript"),
                            schema=CleanLines, think=False, temperature=0.2, max_tokens=4000)
            got = {line.i: " ".join(line.text.split()) for line in res.data.lines}
            for k, s in enumerate(batch, 1):
                # a line the LLM dropped keeps its words; an empty answer means it was all filler
                s["clean"] = got.get(k, s["text"])
        cleaned = [s["clean"] for s in segs]
        if aerab.applies(t.language, "\n".join(cleaned)):
            ctx.progress(0.96, "Adding aerab")
            marked = aerab.finish_lines_sync(cleaned, t.language, tick=lambda: ctx.progress(0.96, "Adding aerab"),
                                             what=f"transcript {t.id}")
            for s, text in zip(segs, marked):
                s["clean"] = text
        db.refresh(t)
        t.segments = segs
        t.cleanup_text = " ".join(s["clean"] for s in segs if s["clean"])
        t.status, t.error = "done", None
        return {"transcript_id": t.id, "lines": len(segs)}

    # a failed tidy-up leaves the transcript itself as good as it was
    return _recording_failure(ctx, tid, run, failed="done", prefix="Cleanup failed: ")


def handle_video(ctx) -> dict:
    from app.dub import export as ex

    db, job = ctx.db, ctx.job
    p = job.payload or {}
    gen = db.get(Generation, job.generation_id or "")
    t = db.get(Transcript, p.get("transcript_id") or "")
    src = db.get(Generation, p.get("source_id") or "")
    if gen is None or t is None or src is None or generation_file(src) is None:
        raise RuntimeError("The transcript or its video is gone")
    gen.status = "generating"
    db.commit()
    folder, rel_folder = lib.media_dir(gen.workspace_id)
    work = folder / f".{gen.id}.subs"
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)
    dst, part = folder / f"{gen.id}.mp4", folder / f".{gen.id}.part.mp4"
    t0 = time.monotonic()
    try:
        items = cues(t.segments or [], clean=bool(p.get("clean")))
        burn = p.get("mode") == "burn"
        ctx.progress(0.2, "Burning in the subtitles" if burn else "Adding the subtitles")
        soft = [] if burn else [ex.Stream(subs.write_srt(work / "subs.srt", items, t.language), t.language,
                                          "Subtitles")]
        burned = ex.build_mp4(generation_file(src), part, [ex.Stream(None, t.language, "Original", True)], soft,
                              burn=items if burn else None, burn_language=t.language, work=work)
        part.replace(dst)
    finally:
        part.unlink(missing_ok=True)
        shutil.rmtree(work, ignore_errors=True)
    db.refresh(gen)
    rel = f"{rel_folder}/{dst.name}"
    gen.file_path, gen.media_type, gen.status = rel, "video/mp4", "ready"
    out = {"file_path": rel, "media_type": "video/mp4", "bytes": dst.stat().st_size,
           "seconds": round(time.monotonic() - t0, 3)}
    if burned:
        out["subtitles"] = burned
    return out
