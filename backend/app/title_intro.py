"""Opening titles for a Quick Create film (contract v4a).

The card is the film's title in its own language (Urdu in Nastaliq with its aerab) with the English title
under it, over a darkened still of the first scene, pushed in slowly and faded in and out, with a short
instrumental sting from the music models under it. The autopilot writes the card into project.settings
.title_intro once the outline is done and queues the sting early; the stitch (reel.handle_assemble) draws it
and joins it in front of the first scene, for whole-film renders only.
"""
import logging
from pathlib import Path

from fastapi import HTTPException
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageOps
from sqlalchemy.orm import Session

from app import brand_render as br
from app import models_catalog as mc
from app import storyboard as sb
from app import subtitles as st
from app.models import Generation, Job, MediaItem, Project, new_id
from app.services import enqueue_generation, generation_file

log = logging.getLogger("mixai.title_intro")

SECONDS = 7.0
FADE_IN_S = 1.0
FADE_OUT_S = 1.2
MUSIC_S = 10.0
MUSIC_MODEL = "sa3_small_music"
MUSIC_GAIN = 0.6  # the film's loudness pass levels the whole thing; this keeps the sting under the first lines
CHAPTER = "Title"
ZOOM = 0.04
INK = (243, 233, 210)
SHADE = 0.42

STINGS = {
    "cinematic": "Cinematic opening title sting, slow swelling strings and low brass, a soft timpani hit, "
                 "warm and dramatic, ending on a long held chord, instrumental",
    "documentary": "Gentle documentary opening theme, piano and soft strings, calm and curious, instrumental",
    "animated": "Playful animated film opening sting, bright orchestral, plucked strings and glockenspiel, "
                "instrumental",
    "commercial": "Short polished commercial intro, modern uplifting synth and light percussion, instrumental",
}


# ---------------------------------------------------------------- planning (autopilot side)

def queue_music(db: Session, project: Project, style: str, parent_job_id: str) -> Generation | None:
    """The sting, as a working-part Library item. None when this server has no music model for it."""
    from app.api.library import generate_into

    prompt = STINGS.get(style, STINGS["cinematic"])
    try:
        m, chosen = mc.choose(MUSIC_MODEL, "audio", prompt, kind="music")
        mc.check_audio(m, "music", MUSIC_S)
    except HTTPException as e:
        log.warning("no opening title music: %s", e.detail)
        return None
    params = {"kind": "music", "model": m.id, "duration_s": MUSIC_S, "user_prompt": prompt,
              "created_by": {"flow": "title_intro", "job_id": parent_job_id}, **chosen}
    item = MediaItem(id=new_id(), workspace_id=project.workspace_id, kind="audio", origin="generated",
                     title=f"{project.title} · opening title"[:200], tags=["title music"], duration_s=MUSIC_S,
                     home="film", folder_id=generate_into(db, project.workspace_id, None, "audio"))
    db.add(item)
    db.flush()
    g = enqueue_generation(db, workspace_id=project.workspace_id, project_id=None, target_type="media",
                           target_id=item.id, kind="music", prompt=prompt, params=params, seed=None)
    item.generation_id = g.id
    job = db.get(Job, g.job_id) if g.job_id else None
    if job is not None:
        job.payload = {**(job.payload or {}), "parent_job_id": parent_job_id}
    return g


def card(project: Project, title_local: str, language: str, music_id: str | None = None) -> dict:
    """What the stitch draws: the main line in the film's language, the English title under it."""
    english = project.title.strip()
    local = (title_local or "").strip() if language != "en" else ""
    main = local or english
    # a title typed in Urdu as the override has no English line to go under it
    sub = english if local and local != english and not br.is_rtl(english) else ""
    return {"title": main, "subtitle": sub, "language": language, "font": st.font_for(language, main),
            "subtitle_font": st.font_for("en", sub), "rtl": br.is_rtl(main), "seconds": SECONDS,
            "fade_in_s": FADE_IN_S, "fade_out_s": FADE_OUT_S, "music_id": music_id}


def for_render(project: Project, full: bool) -> dict | None:
    # TODO: let the Reel page edit the card or switch it off (today: PATCH settings.title_intro = null)
    c = (project.settings or {}).get("title_intro")
    # a range stitch is a working cut, so it opens straight on its first scene
    return dict(c) if full and isinstance(c, dict) and (c.get("title") or "").strip() else None


# ---------------------------------------------------------------- drawing and encoding (stitch side)

def background(db: Session, scene, first_take: Generation | None, work: Path) -> Image.Image | None:
    """The first scene's establishing frame, else a frame from the first take."""
    if scene is not None and scene.location_id:
        g = sb.approved(db, "location", scene.location_id, "establishing")
        f = generation_file(g) if g else None
        if f is not None and f.is_file():
            with Image.open(f) as im:
                return ImageOps.exif_transpose(im).convert("RGB")
    f = generation_file(first_take) if first_take is not None else None
    if f is not None and f.is_file():
        return br.grab_frame(f, 1.0, work / "first.png")
    return None


def still(c: dict, size: tuple[int, int], bg: Image.Image | None) -> Image.Image:
    # drawn at twice the frame so the slow push-in doesn't step whole pixels
    w, h = size[0] * 2, size[1] * 2
    if bg is not None:
        img = ImageOps.fit(bg, (w, h), Image.LANCZOS).filter(ImageFilter.GaussianBlur(w / 900))
        img = ImageEnhance.Brightness(img).enhance(SHADE)
    else:
        img = Image.new("RGB", (w, h), (14, 12, 10))
    d = ImageDraw.Draw(img, "RGBA")
    nastaliq = c.get("font") == st.NASTALIQ
    # Nastaliq stacks and slopes, so it needs more height for the same weight on screen
    size_main = round(min(w, h) * (0.15 if nastaliq else 0.11))
    font, lines = br.fit_text(d, c["title"], st.font_file(c["font"]), size_main, w * 0.84, 2)
    block = br.text_block_height(font, len(lines))
    sub_font, sub_lines = (None, [])
    if c.get("subtitle"):
        sub_font, sub_lines = br.fit_text(d, c["subtitle"], st.font_file(c.get("subtitle_font") or st.LATIN),
                                          round(min(w, h) * 0.045), w * 0.8, 1)
    sub_h = br.text_block_height(sub_font, 1) if sub_font else 0
    top = h * 0.46 - (block + sub_h) / 2
    br.draw_lines(d, lines, font, w / 2, top, INK)
    if sub_font:
        y = top + block + h * 0.02
        d.line((w * 0.44, y - h * 0.008, w * 0.56, y - h * 0.008), fill=INK + (150,), width=max(2, h // 400))
        br.draw_lines(d, sub_lines, sub_font, w / 2, y + h * 0.01, INK + (220,))
    return img


def clip_cmd(still_png: Path, music: Path | None, dst: Path, c: dict, size: tuple[int, int], *, fps: int,
             venc: list[str], aenc: list[str], afmt: str, head_idr_s: float) -> list[str]:
    w, h = size
    secs = float(c.get("seconds") or SECONDS)
    fin, fout = float(c.get("fade_in_s") or FADE_IN_S), float(c.get("fade_out_s") or FADE_OUT_S)
    frames = round(secs * fps)
    v = (f"[0:v]zoompan=z='1+{ZOOM}*on/{frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s={w}x{h}"
         f":fps={fps},setsar=1,fade=t=in:st=0:d={fin:.3f},fade=t=out:st={secs - fout:.3f}:d={fout:.3f},"
         "format=yuv420p[v]")
    args = ["-loop", "1", "-framerate", str(fps), "-t", f"{secs:.3f}", "-i", str(still_png)]
    if music is not None:
        args += ["-i", str(music)]
        a = (f"[1:a]atrim=0:{secs:.3f},asetpts=PTS-STARTPTS,aresample=48000,{afmt},volume={MUSIC_GAIN},"
             f"afade=t=in:st=0:d=0.3,afade=t=out:st={max(0.0, secs - 2.0):.3f}:d=2,apad=whole_dur={secs:.3f}[a]")
    else:
        args += ["-f", "lavfi", "-t", f"{secs:.3f}", "-i", "anullsrc=r=48000:cl=stereo"]
        a = f"[1:a]{afmt}[a]"
    return [*args, "-filter_complex", f"{v};{a}", "-map", "[v]", "-map", "[a]", *venc, *aenc,
            "-force_key_frames", f"expr:lt(t,{head_idr_s})", "-forced-idr", "1", "-t", f"{secs:.3f}",
            "-movflags", "+faststart", str(dst)]


def build(db: Session, c: dict, scene, first_take: Generation | None, size: tuple[int, int], work: Path,
          dst: Path) -> dict:
    from app import reel as rl

    work.mkdir(parents=True, exist_ok=True)
    png = work / "title.png"
    still(c, size, background(db, scene, first_take, work)).save(png)
    music = None
    g = db.get(Generation, c.get("music_id") or "") if c.get("music_id") else None
    if g is not None and g.status in ("ready", "approved"):
        f = generation_file(g)
        music = f if f is not None and f.is_file() else None
    rl.run_ff(clip_cmd(png, music, dst, c, size, fps=rl.FPS, venc=rl.VENC, aenc=rl.AENC, afmt=rl.AFMT,
                       head_idr_s=rl.HEAD_IDR_S))
    return {"length": round(float(c.get("seconds") or SECONDS), 3), "music": music is not None,
            "font": c.get("font"), "font_file": str(st.font_file(c.get("font") or st.LATIN) or "")}
