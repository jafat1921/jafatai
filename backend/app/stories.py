"""Story books for BlogCreatorPro (contract v28): a narrated book and its read-along videos.

story_audio speaks every line of the book in one runner call (one model load; each line carries its
speaker's seed / voice), lays the lines out per page, levels the whole book to -16 LUFS and, when asked,
checks each page with Whisper and puts a ducked music bed under it. story_video is plain ffmpeg on the
general lane: one still per page with a slow zoom (or a Library video clip fitted to the page's length),
cross-faded, captions burned in, chapters muxed.

The files live in workspaces/<ws>/stories/<job id>/ and only the names a job's result lists can be
downloaded. They are swept after KEEP_DAYS; BlogCreatorPro keeps its own copies.
"""
import logging
import re
import shutil
import time
from difflib import SequenceMatcher
from pathlib import Path

from fastapi import HTTPException
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageOps
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import aerab
from app import audio_analysis as aa
from app import audio_edit as ae
from app import brand_render as br
from app import dialogue as dl
from app import library as lib
from app import montage as mt
from app import models_catalog as mc
from app import subtitles as st
from app import venv_runner, voices
from app.config import get_settings
from app.lanes import gpu_lane
from app.models import Generation, Job, MediaItem, new_id
from app.podcast import produce
# the ffmpeg side moved to app.montage (Poetry Shorts cut the same way); the names stay importable from here
from app.montage import FPS, MAX_SLOW, SIZES, XFADE, clip, video_clip, xfade_graph  # noqa: F401
from app.podcast.publish import GROUND, PARCHMENT
from app.services import enqueue_generation, generation_file, new_seed, owned_source

log = logging.getLogger("mixai.stories")

AUDIO_JOB = "story_audio"
VIDEO_JOB = "story_video"
ENGINES = ("voxcpm", "chatterbox", "kokoro")
EMOTIONS = ("happy", "sad", "excited", "scared", "angry", "whisper", "calm")
# VoxCPM2 reads the hint in its voice description; Chatterbox only has an intensity knob
HINTS = {"happy": "happy, smiling", "sad": "sad, subdued", "excited": "excited, lively", "scared": "scared, trembling",
         "angry": "angry, sharp", "whisper": "whispering softly", "calm": "calm, gentle"}
EXAGGERATION = {"whisper": 0.3, "calm": 0.3, "sad": 0.35, "happy": 0.7, "scared": 0.8, "excited": 1.1, "angry": 1.2}
MUSIC_MODELS = {"ace15": ("ace15_turbo", "song"), "sa3": ("sa3_small_music", "music")}
MUSIC_SECONDS = 120.0
# how far the bed sits under the voice before ducking takes it further down while someone speaks
LEVELS = {"soft": 22.0, "normal": 16.0}
DUCK_DB = 8.0
TARGET_LUFS = -16.0
MP3 = ["-c:a", "libmp3lame", "-b:a", "192k", "-ar", "44100"]
KEEP_DAYS = 7
WAIT_PRIORITY = -5
POLL_S = 30

# stills are drawn at twice the frame so zoompan's whole-pixel steps don't shimmer
OVERSAMPLE = 2
PICTURE_SHARE = 0.6  # 9:16: the picture's share of the height; captions go below
# a still this close to the frame's shape fills it instead of sitting on its blurred copy
FILL_TOLERANCE = 0.03


class StoryError(RuntimeError):
    pass


def story_dir(workspace_id: str, job_id: str) -> Path:
    return get_settings().data_dir / "workspaces" / workspace_id / "stories" / job_id


def prune_old(workspace_id: str) -> int:
    root = story_dir(workspace_id, "x").parent
    if not root.is_dir():
        return 0
    cutoff = time.time() - KEEP_DAYS * 86400
    n = 0
    for d in root.iterdir():
        if d.is_dir() and d.stat().st_mtime < cutoff:
            shutil.rmtree(d, ignore_errors=True)
            n += 1
    return n


def file_names(result: dict | None) -> set[str]:
    """Every file a finished story job lists; the download route serves these and nothing else."""
    r = result or {}
    names = {p.get("file") for p in r.get("pages") or []}
    names |= {(r.get("full") or {}).get("file"), (r.get("full_music") or {}).get("file"), r.get("file"), r.get("srt"), r.get("preview")}
    return {n for n in names if isinstance(n, str) and n}


# ---------------------------------------------------------------- queueing the narration

def check_engine(engine: str, language: str) -> voices.Engine:
    if engine == "omnivoice":
        raise HTTPException(422, "OmniVoice can't be used for stories: its weights are CC-BY-NC (non-commercial). "
                                 "Use voxcpm, chatterbox or kokoro")
    if engine not in ENGINES:
        raise HTTPException(422, f"'{engine}' isn't a story engine (use {', '.join(ENGINES)})")
    try:
        e = voices.get_engine(engine)
        voices.check_language(e, language)
    except voices.VoiceError as err:
        raise HTTPException(422, str(err)) from None
    return e


def clean_cast(cast: dict, e: voices.Engine, language: str) -> dict:
    out = {}
    for name, c in cast.items():
        if e.id == "kokoro":
            if not c.get("preset"):
                raise HTTPException(422, f"{name}: Kokoro speaks preset voices; give a preset such as bf_emma")
            p = voices.kokoro_preset(c["preset"])
            if p is None:
                raise HTTPException(422, f"{name}: '{c['preset']}' isn't a Kokoro voice")
            if p.language != language:
                raise HTTPException(422, f"{name}: the Kokoro voice {p.name} speaks {voices.lang_name(p.language)}, "
                                         f"not {voices.lang_name(language)}")
            out[name] = {"preset": p.id}
        else:
            d = c.get("design")
            if not d:
                raise HTTPException(422, f"{name}: {e.label} needs a designed voice (design: description and seed)")
            seed = d.get("seed")
            out[name] = {"description": " ".join(d["description"].split()),
                         "seed": int(seed) % 2**31 if seed is not None else new_seed()}
    return out


def _queue_music(db: Session, cur, music: dict) -> Generation:
    from app.api.library import generate_into

    model_id, kind = MUSIC_MODELS[music["model"]]
    prompt = " ".join(music["prompt"].split())
    m, chosen = mc.choose(model_id, "audio", prompt, kind=kind)
    secs = min(MUSIC_SECONDS, m.max_duration_s or MUSIC_SECONDS)
    mc.check_audio(m, kind, secs)
    params = {"kind": kind, "model": m.id, "duration_s": secs, "user_prompt": prompt,
              "created_by": {"user_id": cur.id, "flow": "story_music"}, **chosen}
    if kind == "song":
        # ACE-Step with no lyrics is instrumental
        params.update(lyrics="", language="en", vocal="none", aerab=False)
    item = MediaItem(id=new_id(), workspace_id=cur.workspace_id, kind="audio", origin="generated",
                     title=f"Story music · {lib.short_title(prompt)}", tags=["story"], duration_s=secs,
                     folder_id=generate_into(db, cur.workspace_id, None, "audio"))
    db.add(item)
    db.flush()
    g = enqueue_generation(db, workspace_id=cur.workspace_id, project_id=None, target_type="media",
                           target_id=item.id, kind=kind, prompt=prompt, params=params, seed=None)
    item.generation_id = g.id
    return g


def queue_audio(db: Session, cur, req: dict) -> Job:
    language = req["language"].lower()
    e = check_engine(req["engine"], language)
    cast = clean_cast(req["cast"], e, language)
    music = req.get("music")
    gen = _queue_music(db, cur, music) if music and music["level"] != "off" else None
    lines = sum(len(p["lines"]) for p in req["pages"])
    job = Job(workspace_id=cur.workspace_id, type=AUDIO_JOB, message="Waiting for a worker · Story narration",
              payload={"request": req, "language": language, "engine": e.id, "cast": cast, "lines": lines,
                       "music_generation_id": gen.id if gen else None,
                       "created_by": {"user_id": cur.id, "flow": "story_audio"}})
    db.add(job)
    db.flush()
    return job


# ---------------------------------------------------------------- speaking

def _with_aerab(ctx, texts: list[str], language: str) -> list[str]:
    joined = "\n".join(texts)
    if not get_settings().urdu_aerab or not aerab.applies(language, joined):
        return texts
    from app.llm import LLMError

    try:
        ctx.progress(0.02, "Adding aerab to the story")
        r = aerab.mark_sync(joined, aerab.target(language, joined), tick=lambda: ctx.progress(0.02, "Adding aerab"))
    except LLMError as err:
        log.warning("aerab skipped for story %s: %s", ctx.job.id, err)
        return texts
    marked = r.text.split("\n")
    return marked if r.marked and len(marked) == len(texts) else texts


def runner_segments(e: voices.Engine, cast: dict, rows: list[dict], work: Path) -> list[dict]:
    """One segment per line, each with its own speaker's voice, so the whole book is one model load."""
    segs = []
    for n, ln in enumerate(rows):
        c = cast[ln["speaker"]]
        seg = {"text": ln["spoken"], "out": str(work / f"line{n:05d}.wav")}
        emotion = ln.get("emotion")
        if e.id == "kokoro":
            seg["voice"] = c["preset"]
        else:
            seg["seed"] = c["seed"]
            if e.id == "voxcpm":
                seg["instruct"] = ", ".join(x for x in (c["description"], HINTS.get(emotion or "")) if x)
            elif emotion:
                seg["exaggeration"] = EXAGGERATION[emotion]
        segs.append(seg)
    return segs


_LINE_N = re.compile(r"line (\d+)\s*/\s*\d+")


def _speak(ctx, e: voices.Engine, language: str, segs: list[dict], page_of: list[int], pages: int,
           lane: str | None) -> None:
    def tick(f: float, msg: str) -> None:
        m = _LINE_N.search(msg or "")
        if m is None and f < 0.15:
            ctx.progress(0.03 + 0.6 * f, msg or f"Starting {e.label}")
            return
        i = int(m[1]) - 1 if m else int((f - 0.15) / 0.8 * len(segs))
        i = max(0, min(len(segs) - 1, i))
        ctx.progress(0.03 + 0.6 * f, f"Speaking page {page_of[i] + 1} of {pages}")

    first = segs[0]
    job = {"engine": e.id, "language": language, "device": "cuda", "per_segment": True, "segments": segs,
           "seed": first.get("seed"), "instruct": None, "voice": first.get("voice")}
    # one load for the whole book, so the usual per-call limit would cut a long one short
    timeout = max(get_settings().audio_runner_timeout_s, 600 + 20 * len(segs))
    ctx.progress(0.03, f"Starting {e.label}")
    venv_runner.run(e.runner, e.venv, job, lane=lane, need_gb=e.vram_gb, progress=tick, timeout=timeout)
    for s in segs:
        if not Path(s["out"]).is_file():
            raise StoryError(f"{e.label} didn't write {Path(s['out']).name}")


def _encode(src: Path, dst: Path, gain_db: float, tick=None) -> None:
    ae.run(["-i", str(src), "-af", f"volume={gain_db:.2f}dB,{ae.LIMIT}", "-ac", "1", *MP3, str(dst)],
           tick=tick, loglevel="error")


def loudness(path: Path, tick=None) -> float | None:
    err = ae.run(["-i", str(path), "-af", "ebur128=peak=true:framelog=quiet", "-f", "null", "-"], tick=tick)
    lufs = aa.parse_ebur128(err)["lufs_i"]
    return lufs if lufs is not None and lufs > -70 else None


_WORD = re.compile(r"[^\W_]+(?:['’][^\W_]+)*")


def words(text: str) -> list[str]:
    return [w.replace("’", "'") for w in _WORD.findall(text.lower())]


def match(expected: str, heard: str) -> float:
    a, b = words(expected), words(heard)
    if not a:
        return 1.0 if not b else 0.0
    return round(SequenceMatcher(None, a, b, autojunk=False).ratio(), 3)


def _check(ctx, pages: list[dict], files: list[Path], language: str, lane: str | None) -> list[float]:
    w = voices.WHISPER
    job = {"audios": [str(f) for f in files], "language": language, "model": "large-v3", "device": "cuda"}
    res = venv_runner.run(w["runner"], w["venv"], job, lane=lane, need_gb=w["vram_gb"],
                          progress=lambda f, m: ctx.progress(0.8 + 0.12 * f, m or "Checking the pages"),
                          timeout=max(get_settings().audio_runner_timeout_s, 300 + 10 * len(files)))
    heard = res.get("texts") or []
    return [match(" ".join(ln["text"] for ln in p["lines"]), heard[i] if i < len(heard) else "")
            for i, p in enumerate(pages)]


def narrate(ctx, p: dict, out: Path, work: Path) -> dict:
    req, language = p["request"], p["language"]
    e = voices.get_engine(p["engine"])
    pages = req["pages"]
    rows = [{**ln, "page": i} for i, page in enumerate(pages) for ln in page["lines"]]
    spoken = _with_aerab(ctx, [" ".join(ln["text"].split()) for ln in rows], language)
    for ln, s in zip(rows, spoken):
        ln["spoken"] = s
    segs = runner_segments(e, p["cast"], rows, work)
    lane = gpu_lane(getattr(ctx, "lanes", None))
    _speak(ctx, e, language, segs, [ln["page"] for ln in rows], len(pages), lane)

    gap_line, gap_page = float(req.get("gap_line", 0.35)), float(req.get("gap_page", 1.2))
    durs = [aa.stream_info(Path(s["out"])).duration for s in segs]
    tick = lambda: ctx.progress(0.7, "Joining the pages")  # noqa: E731
    page_wavs, out_pages, k = [], [], 0
    for i, page in enumerate(pages):
        n = len(page["lines"])
        files = [Path(s["out"]) for s in segs[k:k + n]]
        gaps = [gap_line] * (n - 1) + [0.0]
        t, times = 0.0, []
        for ln, d, g in zip(page["lines"], durs[k:k + n], gaps):
            times.append({"start": round(t, 3), "end": round(t + d, 3), "speaker": ln["speaker"], "text": ln["text"]})
            t += d + g
        wav = work / f"page{i:04d}.wav"
        ctx.progress(0.64 + 0.06 * i / len(pages), f"Joining page {i + 1} of {len(pages)}")
        dl._render_timeline(files, gaps, wav, tick=tick)
        page_wavs.append(wav)
        out_pages.append({"key": page["key"], "file": f"{page['key']}.mp3",
                          "duration": round(aa.stream_info(wav).duration, 3), "lines": times})
        k += n

    full_wav = work / "full.wav"
    dl._render_timeline(page_wavs, [gap_page] * len(page_wavs), full_wav, tick=tick)
    ctx.progress(0.72, "Levelling the book")
    lufs = loudness(full_wav, tick)
    # one gain for the whole book, so a page file sounds exactly like its stretch of full.mp3
    gain = TARGET_LUFS - lufs if lufs is not None else 0.0
    for i, (pg, wav) in enumerate(zip(out_pages, page_wavs)):
        ctx.progress(0.73 + 0.05 * i / len(out_pages), f"Saving page {i + 1} of {len(out_pages)}")
        _encode(wav, out / pg["file"], gain, tick)
    _encode(full_wav, out / "full.mp3", gain, tick)

    t, spans = 0.0, []
    for pg in out_pages:
        end = t + pg["duration"] + gap_page
        spans.append({"key": pg["key"], "start": round(t, 3), "end": round(end, 3)})
        t = end
    if req.get("check"):
        ctx.progress(0.8, "Checking the pages")
        for pg, m in zip(out_pages, _check(ctx, out_pages, [out / pg["file"] for pg in out_pages], language, lane)):
            pg["match"] = m
    seeds = {name: c["seed"] for name, c in p["cast"].items() if "seed" in c}
    return {"pages": out_pages, "full": {"file": "full.mp3", "duration": round(t, 3), "pages": spans},
            "engine": e.id, "seeds": seeds}


# ---------------------------------------------------------------- the music bed

def mix_music(voice: Path, bed: Path, dst: Path, work: Path, level: str, tick=None) -> dict:
    """The bed looped (cross-faded seams) to the book's length, set LEVELS[level] under the voice, ducked
    while anyone speaks, faded in and out, and the mix levelled to -16 LUFS. Same graph as a podcast bed."""
    voice_s = aa.stream_info(voice).duration
    looped = work / "bed.wav"
    # TODO: a book over an hour gets its bed looped to the hour only (AudioEdit caps loop_to at 3600 s)
    r = ae.render({"loop_to": round(min(voice_s, 3600.0), 3)}, bed, looped, ["-c:a", "pcm_f32le"], tick=tick,
                  meter=True)
    bed_lufs = r.get("lufs_i")
    want = TARGET_LUFS - LEVELS[level]
    gain = want - bed_lufs if bed_lufs is not None and bed_lufs > -70 else -LEVELS[level]
    st_ = {"intro": {}, "outro": {}, "bed": {"gain_db": round(gain, 2)}, "duck_db": DUCK_DB, "loudness": "stereo"}
    music = {"bed": aa.stream_info(looped).duration}
    args = ["-i", str(voice), "-i", str(looped)]
    graph, at = produce.build(st_, voice_s, music, measure=True)
    err = ae.run([*args, "-filter_complex", graph, "-map", "[out]", "-t", ae._f(at["total"]), "-f", "null", "-"],
                 tick=tick)
    graph, at = produce.build(st_, voice_s, music, loud=ae.parse_loudnorm(err))
    ae.run([*args, "-filter_complex", graph, "-map", "[out]", "-t", ae._f(at["total"]), "-ac", "2", *MP3, str(dst)],
           tick=tick, loglevel="error")
    return {"bed_gain_db": round(gain, 2), "duck_db": DUCK_DB}


def _other_work_queued(ctx) -> bool:
    lanes = getattr(ctx, "lanes", None)
    lane_ok = [Job.lane.in_(lanes)] if lanes else []
    return bool(ctx.db.scalar(select(func.count()).select_from(Job).where(
        Job.status == "queued", Job.priority > WAIT_PRIORITY, Job.id != ctx.job.id, *lane_ok)))


def _music_ready(ctx, gen_id: str) -> Generation:
    """The bed's generation once it has finished one way or the other; until then the job steps aside."""
    from app import worker

    db = ctx.db
    deadline = time.monotonic() + POLL_S
    while True:
        g = db.get(Generation, gen_id, populate_existing=True)
        if g is None or g.status not in ("queued", "generating"):
            return g
        if _other_work_queued(ctx) or time.monotonic() > deadline:
            db.commit()
            raise worker.JobDeferred("Waiting for the music bed", priority=WAIT_PRIORITY)
        ctx.progress(0.93, "Waiting for the music bed")
        time.sleep(1.0)


def handle_audio(ctx) -> dict:
    db, job = ctx.db, ctx.job
    p = dict(job.payload or {})
    out = story_dir(job.workspace_id, job.id)
    work = out / ".work"
    out.mkdir(parents=True, exist_ok=True)
    prune_old(job.workspace_id)
    if p.get("spoken") is None:
        shutil.rmtree(work, ignore_errors=True)
        work.mkdir(parents=True)
        try:
            spoken = narrate(ctx, p, out, work)
        finally:
            shutil.rmtree(work, ignore_errors=True)
        # kept, so a job waiting on its music bed doesn't speak the book again when it comes back
        p["spoken"] = spoken
        job.payload = p
        db.commit()
    result = dict(p["spoken"])
    gid = p.get("music_generation_id")
    if gid:
        g = _music_ready(ctx, gid)
        bed = generation_file(g) if g is not None and g.status in ("ready", "approved") else None
        if bed is None or not bed.is_file():
            # the narration is still worth having; BCP sees there's no full_music
            result["warnings"] = ["The music bed couldn't be made, so there's no full_music.mp3"]
        else:
            ctx.progress(0.95, "Mixing the music bed")
            work.mkdir(parents=True, exist_ok=True)
            try:
                mix_music(out / "full.mp3", bed, out / "full_music.mp3", work, p["request"]["music"]["level"],
                          tick=lambda: ctx.progress(0.96, "Mixing the music bed"))
            finally:
                shutil.rmtree(work, ignore_errors=True)
            result["full_music"] = {"file": "full_music.mp3"}
    ctx.progress(1.0, "Done")
    return result


# ---------------------------------------------------------------- queueing the video

def finished_audio(db: Session, workspace_id: str, job_id: str) -> Job:
    a = db.get(Job, job_id)
    if a is None or a.workspace_id != workspace_id or a.type != AUDIO_JOB:
        raise HTTPException(404, "Story audio job not found")
    if a.status != "done" or not a.result:
        raise HTTPException(409, "The story audio job hasn't finished")
    return a


def plan_video(res: dict, title_s: float, end_s: float, max_seconds: float | None) -> dict:
    """Which pages play and where everything sits: a Short keeps whole pages from the start while the
    title card, those pages and the end card still fit in max_seconds."""
    spans = res["full"]["pages"]
    keep = spans
    if max_seconds:
        keep = []
        for sp in spans:
            if title_s + sp["end"] + end_s > max_seconds + 1e-6:
                break
            keep.append(sp)
        if not keep:
            raise HTTPException(422, f"The first page alone runs past max_seconds ({max_seconds:g} s)")
    audio_len = keep[-1]["end"]
    lines = {p["key"]: p.get("lines") or [] for p in res["pages"]}
    segments = [{"kind": "title", "seconds": title_s}] if title_s else []
    segments += [{"kind": "page", "key": sp["key"], "seconds": round(sp["end"] - sp["start"], 3)} for sp in keep]
    if end_s:
        segments.append({"kind": "end", "seconds": end_s})
    cues = [{"start": round(title_s + sp["start"] + ln["start"], 3), "end": round(title_s + sp["start"] + ln["end"], 3),
             "text": ln["text"]} for sp in keep for ln in lines.get(sp["key"], [])]
    return {"segments": segments, "cues": cues, "audio_len": round(audio_len, 3), "title_s": title_s,
            "chapters": [{"key": sp["key"], "start": round(title_s + sp["start"], 3)} for sp in keep],
            "trimmed": audio_len < res["full"]["duration"] - 1e-3,
            "total": round(title_s + audio_len + end_s, 3)}


def _picture(db: Session, workspace_id: str, media_id: str, what: str, video_ok: bool = False) -> tuple[str, bool]:
    """The file behind a Library item (or generation) and whether it's a video; pages may be either,
    the title card's cover only a picture."""
    noun = "picture or video" if video_ok else "picture"
    try:
        g = owned_source(db, workspace_id, media_id, what)
    except HTTPException:
        raise HTTPException(422, f"{what}: no {noun} '{media_id}' in the Library") from None
    path = generation_file(g)
    mt = g.media_type or ""
    video = video_ok and mt.startswith("video/")
    if not (mt.startswith("image/") or video) or g.status not in lib.FINISHED or path is None or not path.is_file():
        raise HTTPException(422, f"{what}: '{media_id}' isn't a finished {noun}")
    return g.file_path, video


def queue_video(db: Session, cur, req: dict) -> Job:
    a = finished_audio(db, cur.workspace_id, req["audio_job"])
    res = a.result
    if req["use_music"] and not res.get("full_music"):
        raise HTTPException(422, "That narration has no music bed; set use_music to false")
    known = {p["key"] for p in res["pages"]}
    pics: dict[str, str] = {}
    videos: list[str] = []
    for pg in req["pages"]:
        if pg["key"] not in known:
            raise HTTPException(422, f"Page '{pg['key']}' isn't in the story audio job")
        if pg["key"] in pics:
            raise HTTPException(422, f"Page '{pg['key']}' is listed twice")
        pics[pg["key"]], video = _picture(db, cur.workspace_id, pg["media_id"], f"Page {pg['key']}", video_ok=True)
        if video:
            videos.append(pg["key"])
    title, end = req.get("title_card"), req.get("end_card")
    plan = plan_video(res, float(title["seconds"]) if title else 0.0, float(end["seconds"]) if end else 0.0,
                      req.get("max_seconds"))
    missing = [s["key"] for s in plan["segments"] if s["kind"] == "page" and s["key"] not in pics]
    if missing:
        raise HTTPException(422, f"No picture for page {', '.join(missing[:5])}")
    if title:
        cover = title.get("media_id")
        first = next(s["key"] for s in plan["segments"] if s["kind"] == "page")
        if cover:
            title = {**title, "file": _picture(db, cur.workspace_id, cover, "Title card")[0]}
        else:
            # a video first page lends the title card its first frame
            title = {**title, "file": pics[first], "video": first in videos}
    aspect = req["aspect"]
    job = Job(workspace_id=cur.workspace_id, type=VIDEO_JOB, message="Waiting for a worker · Story video",
              payload={"audio_job": a.id, "audio_file": "full_music.mp3" if req["use_music"] else "full.mp3",
                       "aspect": aspect, "pictures": pics, "videos": videos, "title_card": title, "end_card": end,
                       "captions": req["captions"], "language": (a.payload or {}).get("language"), "plan": plan,
                       "name": f"story_{aspect.replace(':', 'x')}",
                       "created_by": {"user_id": cur.id, "flow": "story_video"}})
    db.add(job)
    db.flush()
    return job


# ---------------------------------------------------------------- drawing the stills

def _open(rel: str) -> Image.Image:
    with Image.open(get_settings().data_dir / rel) as im:
        return ImageOps.exif_transpose(im).convert("RGB")


def _backdrop(img: Image.Image, w: int, h: int) -> Image.Image:
    # blurred small and scaled up: the same look as a full-size blur at a fraction of the cost
    small = ImageOps.fit(img, (max(8, w // 16), max(8, h // 16)), Image.BILINEAR).filter(ImageFilter.GaussianBlur(2))
    return ImageEnhance.Brightness(small.resize((w, h), Image.BILINEAR)).enhance(0.45)


def fills(img: Image.Image, aspect: str) -> bool:
    w, h = SIZES[aspect]
    return abs(img.width / img.height / (w / h) - 1) <= FILL_TOLERANCE


def picture_frame(img: Image.Image, aspect: str, scale: int = OVERSAMPLE) -> Image.Image:
    w, h = (v * scale for v in SIZES[aspect])
    if fills(img, aspect):
        # already the frame's shape: cover-crop, and the captions sit over it as on 16:9
        return ImageOps.fit(img, (w, h), Image.LANCZOS)
    canvas = Image.new("RGB", (w, h), GROUND)
    bh = h if aspect == "16:9" else round(h * PICTURE_SHARE)
    canvas.paste(_backdrop(img, w, bh), (0, 0))
    fg = ImageOps.contain(img, (w, bh), Image.LANCZOS)
    canvas.paste(fg, ((w - fg.width) // 2, (bh - fg.height) // 2))
    return canvas


def _text(canvas: Image.Image, text: str, language: str | None, top: float, size: int, band: bool) -> None:
    d = ImageDraw.Draw(canvas, "RGBA")
    w = canvas.width
    font, lines = br.fit_text(d, text, st.font_file(st.font_for(language, text)), size, w * 0.82, 3)
    block = br.text_block_height(font, len(lines))
    if band:
        pad = size * 0.45
        d.rounded_rectangle((w * 0.06, top - pad, w * 0.94, top + block + pad * 0.6), radius=int(pad),
                            fill=(0, 0, 0, 150))
    br.draw_lines(d, lines, font, w / 2, top, PARCHMENT)


def title_frame(img: Image.Image, aspect: str, title: str, language: str | None) -> Image.Image:
    canvas = picture_frame(img, aspect)
    h = canvas.height
    if aspect == "16:9":
        _text(canvas, title, language, h * 0.66, round(h * 0.08), band=True)
    elif fills(img, aspect):
        # no caption area under a full-frame picture, so the title gets the band
        _text(canvas, title, language, h * (PICTURE_SHARE + 0.1), round(h * 0.045), band=True)
    else:
        _text(canvas, title, language, h * (PICTURE_SHARE + 0.1), round(h * 0.045), band=False)
    return canvas


def end_frame(aspect: str, text: str, language: str | None) -> Image.Image:
    w, h = (v * OVERSAMPLE for v in SIZES[aspect])
    canvas = Image.new("RGB", (w, h), GROUND)
    size = round(min(w, h) * 0.1)
    _text(canvas, text, language, h / 2 - size * 0.7, size, band=False)
    return canvas


# ---------------------------------------------------------------- the video

def chapter_rows(plan: dict) -> list[dict]:
    ch = plan["chapters"]
    end_audio = plan["title_s"] + plan["audio_len"]
    return [{"start": c["start"], "end": ch[i + 1]["start"] if i + 1 < len(ch) else end_audio, "title": c["key"]}
            for i, c in enumerate(ch)]


def handle_video(ctx) -> dict:
    job = ctx.job
    p = job.payload or {}
    plan, aspect = p["plan"], p["aspect"]
    w, h = SIZES[aspect]
    language = p.get("language")
    audio = story_dir(job.workspace_id, p["audio_job"]) / p["audio_file"]
    if not audio.is_file():
        raise StoryError("The narration's files are gone (they're kept 7 days); make the story audio again")
    out = story_dir(job.workspace_id, job.id)
    work = out / ".work"
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)
    prune_old(job.workspace_id)
    name = p.get("name") or "story"
    dst, srt = out / f"{name}.mp4", out / f"{name}.srt"
    preview = out / f"{name}_preview.mp4"
    segs = plan["segments"]
    videos = set(p.get("videos") or [])
    t0 = time.monotonic()
    try:
        clips, durs = [], []
        for i, s in enumerate(segs):
            msg = f"Drawing part {i + 1} of {len(segs)}"
            ctx.progress(0.03 + 0.62 * i / len(segs), msg)
            length = s["seconds"] + (XFADE if i < len(segs) - 1 else 0.0)
            frames = max(2, round(length * FPS))
            c = work / f"c{i:04d}.mp4"
            tick = lambda i=i, msg=msg: ctx.progress(0.03 + 0.62 * i / len(segs), msg)  # noqa: E731
            clips.append(c)
            durs.append(frames / FPS)
            if s["kind"] == "page" and s["key"] in videos:
                video_clip(get_settings().data_dir / p["pictures"][s["key"]], c, frames, aspect, tick=tick)
                continue
            if s["kind"] == "page":
                img = picture_frame(_open(p["pictures"][s["key"]]), aspect)
            elif s["kind"] == "title":
                tc = p["title_card"]
                cover = (br.grab_frame(get_settings().data_dir / tc["file"], 0.0, work / "cover.png")
                         if tc.get("video") else _open(tc["file"]))
                img = title_frame(cover or Image.new("RGB", SIZES[aspect], GROUND), aspect, tc.get("title") or "",
                                  language)
            else:
                img = end_frame(aspect, (p.get("end_card") or {}).get("text") or "The End", language)
            still = work / f"s{i:04d}.png"
            img.save(still)
            clip(still, c, frames, aspect, zoom=s["kind"] != "end", tick=tick)
            still.unlink(missing_ok=True)
        ctx.progress(0.7, "Joining the pages")
        joined = work / "joined.mp4"
        cues = plan["cues"] if p.get("captions") else []
        mt.join(clips, durs, audio, plan, joined, "16" if cues else "20",
                tick=lambda: ctx.progress(0.75, "Joining the pages"))
        burned = mt.finish(joined, work, dst, aspect=aspect, language=language, cues=cues,
                           title=(p.get("title_card") or {}).get("title") or "", chapters=chapter_rows(plan),
                           srt=srt, srt_cues=plan["cues"], preview=preview, progress=ctx.progress)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    out_ = {"file": dst.name, "duration": round(aa.stream_info(dst).duration, 3), "width": w, "height": h,
            "chapters": plan["chapters"], "srt": srt.name, "preview": preview.name, "seconds": round(time.monotonic() - t0, 3)}
    if burned and burned.get("fonts_missing"):
        out_["fonts_missing"] = burned["fonts_missing"]
    return out_
