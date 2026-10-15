"""Picture-and-soundtrack assembly shared by the story videos (app.stories) and Poetry Shorts (app.poetry).

Every part of the timeline becomes a clip of an exact frame count at 30 fps (a still with a slow zoom, or a
video fitted to its slot), the clips cross-fade into each other, the soundtrack goes underneath, then the
captions are burned in, chapters muxed, and an .srt and a small preview copy written next to the video.
"""
from pathlib import Path

from app import audio_edit as ae
from app import subtitles as st
from app.audio_analysis import stream_info
from app.podcast.publish import ffmetadata

SIZES = {"16:9": (1920, 1080), "9:16": (1080, 1920), "1:1": (1080, 1080)}
FPS = 30
XFADE = 0.4
ZOOM = 0.06
# a clip a little short of its slot is slowed down to fit rather than frozen on its last frame
MAX_SLOW = 0.15
# (size against the usual subtitle size, characters per line)
CAPTIONS = {"16:9": (1.2, 42), "9:16": (1.15, 22), "1:1": (1.15, 30)}
VENC = ["-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-r", str(FPS)]


def ff(args: list[str], tick=None) -> None:
    ae.run(args, timeout=4 * 3600, tick=tick, loglevel="error")


def clip(still: Path, dst: Path, frames: int, aspect: str, zoom: bool = True, tick=None) -> None:
    w, h = SIZES[aspect]
    z = f"1+{ZOOM}*on/{max(1, frames - 1)}" if zoom else "1"
    vf = (f"zoompan=z='{z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s={w}x{h}:fps={FPS},"
          "format=yuv420p")
    ff(["-loop", "1", "-framerate", str(FPS), "-i", str(still), "-vf", vf, "-frames:v", str(frames),
        *VENC, "-crf", "14", "-an", str(dst)], tick)


def video_clip(src: Path, dst: Path, frames: int, aspect: str, tick=None) -> str:
    """A clip made exactly `frames` long: trimmed from the start when longer; when shorter, slowed if up to
    MAX_SLOW covers it, else held on its last frame. Cover-cropped to the frame, its own sound dropped,
    30 fps. No zoom: the clip already moves."""
    w, h = SIZES[aspect]
    want = frames / FPS
    have = stream_info(src).duration or 0.0
    speed, how = 1.0, "trimmed" if have >= want else "held"
    if 0 < have < want <= have * (1 + MAX_SLOW):
        speed, how = want / have, "slowed"
    # tpad also covers the odd frame lost to rounding after a slow-down; -frames:v cuts the rest
    vf = (f"setpts={speed:.6f}*(PTS-STARTPTS),fps={FPS},scale={w}:{h}:force_original_aspect_ratio=increase,"
          f"crop={w}:{h},setsar=1,tpad=stop_mode=clone:stop_duration={want + 1:.3f},format=yuv420p")
    ff(["-i", str(src), "-vf", vf, "-frames:v", str(frames), *VENC, "-crf", "16", "-an", str(dst)], tick)
    return how


def xfade_graph(durs: list[float], audio: int, plan: dict) -> str:
    """Clips 0..n-1 cross-faded XFADE into each other (each clip but the last runs XFADE long, so the
    part starts stay on the soundtrack's clock), and the audio at input `audio` placed after the title."""
    parts, cur = [], "0:v"
    for k in range(1, len(durs)):
        off = sum(durs[:k]) - k * XFADE
        parts.append(f"[{cur}][{k}:v]xfade=transition=fade:duration={XFADE}:offset={off:.4f}[v{k}]")
        cur = f"v{k}"
    parts.append(f"[{cur}]format=yuv420p[vout]")
    a = [f"atrim=end={ae._f(plan['audio_len'])}", "asetpts=PTS-STARTPTS", "aresample=44100"]
    if plan["title_s"]:
        # the title card fades into the first second of sound
        a.append("afade=t=in:d=1")
    if plan["trimmed"]:
        a.append(f"afade=t=out:st={ae._f(max(0.0, plan['audio_len'] - 0.6))}:d=0.6")
    if plan["title_s"]:
        a.append(f"adelay=delays={round(plan['title_s'] * 1000)}:all=1")
    a += [f"apad=whole_dur={ae._f(plan['total'])}", f"atrim=end={ae._f(plan['total'])}"]
    parts.append(f"[{audio}:a]{','.join(a)}[aout]")
    return ";".join(parts)


def slot_frames(seconds: float, last: bool) -> int:
    # every part but the last runs XFADE long so the cross-fade eats into it, not the next part
    return max(2, round((seconds + (0.0 if last else XFADE)) * FPS))


def join(clips: list[Path], durs: list[float], audio: Path, plan: dict, dst: Path, crf: str, tick=None) -> None:
    inputs = []
    for c in clips:
        inputs += ["-i", str(c)]
    ff([*inputs, "-i", str(audio), "-filter_complex", xfade_graph(durs, len(clips), plan),
        "-map", "[vout]", "-map", "[aout]", *VENC, "-crf", crf, "-c:a", "aac", "-b:a", "192k",
        "-t", ae._f(plan["total"]), str(dst)], tick=tick)


def finish(joined: Path, work: Path, dst: Path, *, aspect: str, language: str | None, cues: list, title: str,
           chapters: list[dict], srt: Path | None = None, srt_cues: list | None = None, preview: Path | None = None,
           fade: float = 0.0, progress=None) -> dict | None:
    """Captions burned into the joined cut, chapters muxed, `dst` written, then the .srt and the preview.
    Returns what subtitles.burn said (None when there were no captions to burn)."""
    say = progress or (lambda f, m: None)
    w, h = SIZES[aspect]
    burned = None
    if cues:
        say(0.85, "Burning in the captions")
        scale, chars = CAPTIONS[aspect]
        burned = st.burn(joined, work / "captioned.mp4", cues, language=language, width=w, height=h,
                         timeout=4 * 3600, encode=[*VENC, "-crf", "20"], scale=scale, chars=chars, fade=fade)
        joined = work / "captioned.mp4"
    say(0.96, "Adding the chapters")
    meta = work / "chapters.txt"
    meta.write_text(ffmetadata({"title": title or ""}, chapters), encoding="utf-8")
    part = work / "final.mp4"
    ff(["-i", str(joined), "-i", str(meta), "-map", "0", "-map_metadata", "1", "-map_chapters", "1", "-c", "copy",
        "-movflags", "+faststart", str(part)])
    part.replace(dst)
    if srt is not None:
        st.write_srt(srt, cues if srt_cues is None else srt_cues, language)
    if preview is not None:
        # a small copy to watch over a slow link before downloading the full one (~0.5 Mbit/s)
        say(0.98, "Making the preview")
        pw, ph = (640, 360) if w > h else (360, 640) if h > w else (480, 480)
        ff(["-i", str(dst), "-vf", f"scale={pw}:{ph}:flags=lanczos,format=yuv420p", "-c:v", "libx264",
            "-preset", "veryfast", "-b:v", "430k", "-maxrate", "500k", "-bufsize", "1000k", "-c:a", "aac",
            "-b:a", "64k", "-movflags", "+faststart", str(preview)])
    return burned
