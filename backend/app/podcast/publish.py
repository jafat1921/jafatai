"""Publishing an episode (contract v20): the tagged MP3 / M4A with cover and chapters, the SRT from the mix
timeline, show notes as Markdown, and the Audiogram (the cover, a waveform, speaker names and subtitles
as a quick share video; the endpoints and job type still say "video")."""
import re
import shutil
import time
from pathlib import Path

from fastapi import HTTPException
from PIL import Image, ImageDraw, ImageOps
from sqlalchemy.orm import Session

from app import audio_analysis as aa
from app import audio_edit as ae
from app import brand_render as br
from app import library as lib
from app import subtitles as st
from app import transcripts as tr
from app.models import Generation, Job, MediaItem, PodcastEpisode, PodcastShow, utcnow
from app.podcast import service as sv
from app.services import generation_file

FORMATS = {"mp3": (["-c:a", "libmp3lame", "-b:a", "192k", "-id3v2_version", "3", "-write_id3v1", "1"], ".mp3",
                   "audio/mpeg"),
           "m4a": (["-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"], ".m4a", "audio/mp4")}
COVER_PX = 1400
SIZES = {"16:9": (1920, 1080), "1:1": (1080, 1080)}
FPS = 25
# Antique Atelier, after dark: a walnut ground, parchment type, brass waveform
GROUND = (31, 26, 20)
PARCHMENT = (242, 232, 216)
BRASS = "0xC9A66B"
LABEL_BG = (201, 166, 107)
LABEL_INK = (31, 26, 20)


class PublishError(RuntimeError):
    pass


# ---------------------------------------------------------------- text outputs

def timeline_cues(timeline: list[dict]) -> list[tuple[float, float, str]]:
    segs = [{"start": t["start"], "end": t["end"], "text": t["text"]} for t in timeline
            if (t.get("text") or "").strip() and t.get("kind") in ("speech", "recording", "ad")]
    return tr.cues(segs)


def srt(timeline: list[dict]) -> str:
    return tr.to_srt(timeline_cues(timeline))


def stamp(t: float) -> str:
    t = int(round(t))
    h, rest = divmod(t, 3600)
    m, s = divmod(rest, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def notes_markdown(ep: PodcastEpisode, show: PodcastShow | None, notes: dict | None, chapters: list[dict]) -> str:
    n = notes or {}
    out = [f"# {ep.title}"]
    if show is not None:
        out.append(f"*{show.name}*" + (f" · {show.author}" if show.author else ""))
    if n.get("description"):
        out += ["", n["description"]]
    marks = n.get("chapters") or [{"title": c["title"], "start": c["start"]} for c in chapters]
    if marks:
        out += ["", "## Chapters", ""] + [f"- {stamp(c['start'])} {c['title']}" for c in marks]
    if n.get("key_points"):
        out += ["", "## Key points", ""] + [f"- {k}" for k in n["key_points"]]
    return "\n".join(out) + "\n"


_META_ESC = re.compile(r"([=;#\\\n])")


def _esc(v: str) -> str:
    return _META_ESC.sub(r"\\\1", v)


def ffmetadata(tags: dict, chapters: list[dict]) -> str:
    rows = [";FFMETADATA1"] + [f"{k}={_esc(str(v))}" for k, v in tags.items() if v]
    for c in chapters:
        rows += ["", "[CHAPTER]", "TIMEBASE=1/1000", f"START={round(c['start'] * 1000)}",
                 f"END={round(c['end'] * 1000)}", f"title={_esc(c['title'])}"]
    return "\n".join(rows) + "\n"


# ---------------------------------------------------------------- queueing

def _mix(db: Session, ep: PodcastEpisode) -> tuple[dict, Generation]:
    mix = (ep.outputs or {}).get("mix") or {}
    g = db.get(Generation, mix.get("generation_id") or "")
    if g is None or g.status not in sv.FINISHED or generation_file(g) is None:
        raise HTTPException(409, "Mix the episode first")
    return mix, g


def cover_for(db: Session, ep: PodcastEpisode, cover_id: str | None) -> str | None:
    if cover_id:
        return sv.image_item(db, ep.workspace_id, cover_id).id
    if ep.cover_media_id:
        return ep.cover_media_id
    show = db.get(PodcastShow, ep.show_id) if ep.show_id else None
    return show.cover_media_id if show is not None else None


def queue_publish(db: Session, cur, ep: PodcastEpisode, fmt: str, cover_id: str | None, notes: bool) -> Job:
    _mix(db, ep)
    if fmt not in FORMATS:
        raise HTTPException(422, "Publish as mp3 or m4a")
    cover = cover_for(db, ep, cover_id)
    params = {"episode_id": ep.id, "format": fmt, "created_by": {"user_id": cur.id, "flow": "podcast_publish"}}
    item, g = sv.library_version(db, ep, "publish", "audio", f"{ep.title} ({fmt.upper()})", ["podcast"], params)
    return sv.queue_job(db, ep, sv.PUBLISH_JOB, "publish", "Publish", {
        "media_id": item.id, "format": fmt, "cover_media_id": cover, "notes": notes}, g)


def queue_video(db: Session, cur, ep: PodcastEpisode, aspect: str, burn: bool, cover_id: str | None) -> Job:
    mix, _ = _mix(db, ep)
    if aspect not in SIZES:
        raise HTTPException(422, "The video is 16:9 or 1:1")
    cover = cover_for(db, ep, cover_id)
    w, h = SIZES[aspect]
    params = {"episode_id": ep.id, "aspect": aspect, "size": f"{w}x{h}", "fps": FPS, "has_audio": True,
              "duration_s": mix.get("duration_s"), "created_by": {"user_id": cur.id, "flow": "podcast_video"}}
    item, g = sv.library_version(db, ep, "video", "video", f"{ep.title} (audiogram)", ["podcast"], params)
    return sv.queue_job(db, ep, sv.VIDEO_JOB, "video", "Audiogram", {
        "media_id": item.id, "aspect": aspect, "burn": burn, "cover_media_id": cover}, g)


# ---------------------------------------------------------------- cover art

def _cover_image(db: Session, media_id: str | None) -> Image.Image | None:
    item = db.get(MediaItem, media_id) if media_id else None
    g = db.get(Generation, item.generation_id or "") if item is not None else None
    path = generation_file(g) if g is not None else None
    if path is None or not path.is_file():
        return None
    try:
        with Image.open(path) as im:
            return ImageOps.exif_transpose(im).convert("RGB")
    except OSError:
        return None


def square(img: Image.Image, px: int) -> Image.Image:
    # a podcast cover is square; anything else is cropped to its centre rather than letterboxed
    return ImageOps.fit(img, (px, px), Image.LANCZOS)


def placeholder_cover(title: str, show: str, px: int) -> Image.Image:
    img = Image.new("RGB", (px, px), GROUND)
    d = ImageDraw.Draw(img)
    d.rectangle((px * 0.06, px * 0.06, px * 0.94, px * 0.94), outline=LABEL_BG, width=max(2, px // 160))
    font, lines = br.fit_text(d, title or "Podcast", None, px // 9, px * 0.76, 4)
    br.draw_lines(d, lines, font, px / 2, px * 0.32, PARCHMENT)
    if show:
        f2, l2 = br.fit_text(d, show, None, px // 20, px * 0.76, 2)
        br.draw_lines(d, l2, f2, px / 2, px * 0.78, LABEL_BG)
    return img


# ---------------------------------------------------------------- the audio file

def _work(folder: Path, gen_id: str) -> Path:
    # absolute: the video encode runs with this as its working directory
    w = (folder / f".{gen_id}.publish").resolve()
    shutil.rmtree(w, ignore_errors=True)
    w.mkdir(parents=True)
    return w


def handle_publish(ctx) -> dict:
    db, job = ctx.db, ctx.job
    p = job.payload or {}
    gen = db.get(Generation, job.generation_id or "")
    ep = db.get(PodcastEpisode, p.get("episode_id") or "")
    if gen is None or ep is None:
        raise PublishError("The episode or its publish record no longer exists")
    mix = (ep.outputs or {}).get("mix") or {}
    src = generation_file(db.get(Generation, mix.get("generation_id") or ""))
    if src is None or not src.is_file():
        raise PublishError("The episode's mix is gone; mix it again")
    gen.status = "generating"
    db.commit()
    show = db.get(PodcastShow, ep.show_id) if ep.show_id else None
    if p.get("notes") and not ep.notes:
        from app.llm import LLMError
        from app.podcast.writer import make_notes

        ctx.progress(0.05, "Writing the show notes")
        try:
            ep.notes = make_notes(ep, show.name if show else "", mix, lambda: ctx.progress(0.05, "Writing the show notes"))
            db.commit()
        except LLMError:
            # notes are a nicety; the file publishes without them
            pass
    fmt = p.get("format") or "mp3"
    args, ext, mtype = FORMATS[fmt]
    folder, rel_folder = lib.media_dir(gen.workspace_id)
    work = _work(folder, gen.id)
    dst, part = folder / f"{gen.id}{ext}", work / f"part{ext}"
    t0 = time.monotonic()
    chapters = mix.get("chapters") or []
    try:
        tags = {"title": ep.title, "album": show.name if show else ep.title,
                "artist": (show.author if show else "") or (show.name if show else ""),
                "album_artist": show.author if show else "", "genre": "Podcast",
                "comment": (ep.notes or {}).get("description") or (show.description if show else ""),
                "date": str(utcnow().year), "language": ep.language}
        meta = work / "meta.txt"
        meta.write_text(ffmetadata(tags, chapters), encoding="utf-8")
        inputs = ["-i", str(src), "-i", str(meta)]
        maps = ["-map", "0:a", "-map_metadata", "1", "-map_chapters", "1"]
        img = _cover_image(db, p.get("cover_media_id"))
        img = square(img, COVER_PX) if img is not None else placeholder_cover(ep.title, show.name if show else "",
                                                                             COVER_PX)
        cover = work / "cover.jpg"
        img.save(cover, "JPEG", quality=90)
        inputs += ["-i", str(cover)]
        maps += ["-map", "2:v", "-c:v", "copy", "-disposition:v:0", "attached_pic",
                 "-metadata:s:v", "title=Album cover", "-metadata:s:v", "comment=Cover (front)"]
        ctx.progress(0.3, f"Encoding the {fmt.upper()}")
        ae.run([*inputs, *maps, *args, str(part)], tick=lambda: ctx.progress(0.5, f"Encoding the {fmt.upper()}"))
        part.replace(dst)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    db.refresh(gen)
    db.refresh(ep)
    rel = f"{rel_folder}/{dst.name}"
    dur = round(aa.stream_info(dst).duration, 3)
    gen.params = {**(gen.params or {}), "duration_s": dur}
    gen.file_path, gen.media_type, gen.status = rel, mtype, "ready"
    outs = dict(ep.outputs or {})
    outs["publish"] = {"media_id": p.get("media_id"), "generation_id": gen.id, "format": fmt,
                       "built_at": utcnow().isoformat() + "Z", "chapters": len(chapters)}
    ep.outputs = outs
    return {"file_path": rel, "media_type": mtype, "duration_s": dur, "chapters": len(chapters),
            "bytes": dst.stat().st_size, "seconds": round(time.monotonic() - t0, 3)}


# ---------------------------------------------------------------- the video

def _box(aspect: str) -> dict:
    w, h = SIZES[aspect]
    if aspect == "16:9":
        return {"cover": (140, 140, 640), "title": (900, 170, 880), "label": (900, 470), "wave": (900, 560, 880, 220)}
    return {"cover": ((w - 520) // 2, 70, 520), "title": (110, 620, 860), "label": (110, 760), "wave": (110, 820, 860, 140)}


def background(aspect: str, cover: Image.Image | None, title: str, show: str) -> Image.Image:
    w, h = SIZES[aspect]
    b = _box(aspect)
    img = Image.new("RGB", (w, h), GROUND)
    x, y, px = b["cover"]
    img.paste(square(cover, px) if cover is not None else placeholder_cover(title, show, px), (x, y))
    d = ImageDraw.Draw(img)
    tx, ty, tw = b["title"]
    font, lines = br.fit_text(d, title, None, 64 if aspect == "16:9" else 52, tw, 3)
    if aspect == "16:9":
        top = ty
        for ln in lines:
            s, kw = br.shaped(ln)
            d.text((tx, top), s, font=font, fill=PARCHMENT, **kw)
            top += br.text_block_height(font, 1)
        if show:
            f2 = br.load_font(None, 34)
            s, kw = br.shaped(show)
            d.text((tx, top + 10), s, font=f2, fill=LABEL_BG, **kw)
    else:
        br.draw_lines(d, lines[:2], font, w / 2, ty, PARCHMENT)
    return img


def label(name: str, height: int = 64) -> Image.Image:
    # an Urdu host's name in Nastaliq, like the subtitles under it
    font = br.load_font(st.font_file(st.font_for(None, name)), int(height * 0.55))
    probe = ImageDraw.Draw(Image.new("RGB", (8, 8)))
    tw = int(br.text_width(probe, name, font)) + height
    img = Image.new("RGBA", (max(tw, height * 2), height), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((0, 0, img.width - 1, height - 1), radius=height // 2, fill=LABEL_BG + (255,))
    s, kw = br.shaped(name)
    d.text((height // 2, height * 0.18), s, font=font, fill=LABEL_INK, **kw)
    return img


def speaker_spans(timeline: list[dict]) -> dict[str, list[tuple[float, float]]]:
    """Name -> on-screen spans; a speaker's back-to-back lines are one span, held through the gap."""
    out: dict[str, list[tuple[float, float]]] = {}
    prev = None
    for t in timeline:
        if t.get("kind") not in ("speech", "recording", "ad") or not t.get("name"):
            prev = None
            continue
        spans = out.setdefault(t["name"], [])
        if prev is not None and prev["name"] == t["name"] and spans:
            spans[-1] = (spans[-1][0], t["end"])
        else:
            spans.append((t["start"], t["end"]))
        prev = t
    return out


def video_graph(aspect: str, labels: list[tuple[int, list[tuple[float, float]]]]) -> str:
    b = _box(aspect)
    wx, wy, ww, wh = b["wave"]
    lx, ly = b["label"]
    parts = [f"[1:a]aformat=channel_layouts=mono,showwaves=s={ww}x{wh}:mode=cline:rate={FPS}:colors={BRASS},"
             "format=rgba[w]", f"[0:v][w]overlay={wx}:{wy}[v0]"]
    cur = "v0"
    for n, (idx, spans) in enumerate(labels, start=1):
        on = "+".join(f"between(t,{a:.2f},{z:.2f})" for a, z in spans)
        parts.append(f"[{cur}][{idx}:v]overlay={lx}:{ly}:enable='{on}'[v{n}]")
        cur = f"v{n}"
    parts.append(f"[{cur}]format=yuv420p[vout]")
    return ";".join(parts)


def _venc(crf: int) -> list[str]:
    return ["-c:v", "libx264", "-preset", "veryfast", "-tune", "stillimage", "-crf", str(crf), "-pix_fmt", "yuv420p",
            "-r", str(FPS)]


def handle_video(ctx) -> dict:
    from app.dub.engines import _ffmpeg

    db, job = ctx.db, ctx.job
    p = job.payload or {}
    gen = db.get(Generation, job.generation_id or "")
    ep = db.get(PodcastEpisode, p.get("episode_id") or "")
    if gen is None or ep is None:
        raise PublishError("The episode or its audiogram record no longer exists")
    mix = (ep.outputs or {}).get("mix") or {}
    audio = generation_file(db.get(Generation, mix.get("generation_id") or ""))
    if audio is None or not audio.is_file():
        raise PublishError("The episode's mix is gone; mix it again")
    gen.status = "generating"
    db.commit()
    show = db.get(PodcastShow, ep.show_id) if ep.show_id else None
    aspect = p.get("aspect") or "16:9"
    folder, rel_folder = lib.media_dir(gen.workspace_id)
    work = _work(folder, gen.id)
    dst, part = (folder / f"{gen.id}.mp4").resolve(), work / "part.mp4"
    total = aa.stream_info(audio).duration
    t0 = time.monotonic()
    tl = mix.get("timeline") or []
    try:
        ctx.progress(0.05, "Drawing the frame")
        background(aspect, _cover_image(db, p.get("cover_media_id")), ep.title, show.name if show else "") \
            .save(work / "bg.png")
        inputs = ["-loop", "1", "-framerate", str(FPS), "-i", str(work / "bg.png"), "-i", str(audio.resolve())]
        labels = []
        for n, (name, spans) in enumerate(speaker_spans(tl).items()):
            label(name).save(work / f"label{n}.png")
            inputs += ["-i", str(work / f"label{n}.png")]
            labels.append((n + 2, spans))
        cues = timeline_cues(tl) if p.get("burn") else []
        plain = work / "plain.mp4" if cues else part
        ctx.progress(0.15, "Rendering the audiogram")
        # nearly lossless when the subtitle pass is going to encode it again
        _ffmpeg([*inputs, "-filter_complex", video_graph(aspect, labels), "-map", "[vout]", "-map", "1:a",
                 *_venc(16 if cues else 23), "-c:a", "aac", "-b:a", "192k", "-t", ae._f(total),
                 "-movflags", "+faststart", str(plain)], timeout=7200, cwd=work)
        burn, burned = False, None
        if cues:
            ctx.progress(0.6, "Burning in the subtitles")
            w, h = SIZES[aspect]
            try:
                burned = st.burn(plain, part, cues, language=ep.language, width=w, height=h, timeout=7200,
                                 encode=_venc(23))
                burn = True
            except RuntimeError:
                # the audiogram is still worth having without its subtitles
                plain.replace(part)
        part.replace(dst)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    db.refresh(gen)
    db.refresh(ep)
    rel = f"{rel_folder}/{dst.name}"
    w, h = SIZES[aspect]
    gen.params = {**(gen.params or {}), "duration_s": round(total, 3), "burned": burn}
    if burned and burned["fonts_missing"]:
        gen.params["fonts_missing"] = burned["fonts_missing"]
    gen.file_path, gen.media_type, gen.status = rel, "video/mp4", "ready"
    outs = dict(ep.outputs or {})
    outs["video"] = {"media_id": p.get("media_id"), "generation_id": gen.id, "aspect": aspect, "burned": burn,
                     "built_at": utcnow().isoformat() + "Z"}
    ep.outputs = outs
    out = {"file_path": rel, "media_type": "video/mp4", "width": w, "height": h, "duration_s": round(total, 3),
           "burned": burn, "bytes": dst.stat().st_size, "seconds": round(time.monotonic() - t0, 3)}
    if burned:
        out["subtitles"] = burned
    return out
