"""Score a Clip (contract v15): a video's own sound plus up to four audio tracks, mixed to its length.

Input 0 is the video; inputs 1.. are the tracks that aren't muted, in order. Everything is placed on
the video's timeline (adelay, then padded and cut to the video length) before it's mixed, so the
ducking key and the music line up sample for sample.
"""
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

from app import audio_analysis as aa
from app import audio_edit as ae

AUDIO_OUT = ["-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2"]
# fallback when the source's video codec won't go into an mp4 as it is (ProRes .mov and the like)
VIDEO_REENCODE = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p"]
STEM_ARGS = ["-c:a", "pcm_s24le"]
SAFETY = "alimiter=limit=0.97:attack=5:release=50:level=0:latency=1"


@dataclass
class Track:
    path: Path
    info: aa.StreamInfo
    spec: dict
    name: str = "track"


@dataclass
class MixPlan:
    graph: str
    duration: float
    stems: list[tuple[str, str]] = field(default_factory=list)  # (graph label, file name)
    ducked: bool = False


def duck_mix(amount_db: float) -> float:
    # sidechaincompress has no "range": it's run hard (ratio 20) and blended with the dry track, so the
    # deepest dip is about amount_db however loud the dialogue gets
    return 1 - 10 ** (-amount_db / 20)


def build(mix: dict, video: aa.StreamInfo, tracks: list[Track], *, loud: dict | None = None,
          measure_loudness: bool = False, stems: bool = False) -> MixPlan:
    dur = video.duration
    if dur <= 0:
        raise ae.EditError("The video has no length")
    fmt = ae.afmt("stereo")
    D = ae._f(dur)
    g = ae.Graph()
    lanes: list[str] = []
    stem_out: list[tuple[str, str]] = []

    fit = [f"apad=whole_dur={D}", f"atrim=end={D}", "asetpts=PTS-STARTPTS"]
    # input index stays the track's position; ones starting after the video ends are left out
    placed = [(k, t) for k, t in enumerate(tracks, start=1) if dur - float(t.spec.get("offset_s") or 0) > 0.01]

    orig = mix.get("original") or {}
    keep = orig.get("keep", True) and video.has_audio
    duck_amount = float((mix.get("duck") or {}).get("amount_db", 10))
    duckers = [t for _, t in placed if t.spec.get("duck")] if keep and duck_amount > 0 else []
    keys: list[str] = []
    if keep:
        src = g.chain("0:a", [fmt, *fit])
        if duckers:
            # the key is the original before its gain: how much dialogue there is, not how loud it's set
            src, *keys = g.node([src], f"asplit={len(duckers) + 1}", len(duckers) + 1)
        lane = g.chain(src, [f"volume={float(orig.get('gain_db') or 0):.2f}dB"] if orig.get("gain_db") else [])
        lanes.append(lane)
        if stems:
            stem_out.append((lane, "original.wav"))

    for k, t in placed:
        s = t.spec
        offset = float(s.get("offset_s") or 0)
        room = dur - offset
        avail = room if s.get("loop") else min(room, t.info.duration)
        f = [fmt, f"atrim=end={ae._f(avail)}", "asetpts=PTS-STARTPTS"]
        if s.get("fade_in_s"):
            f.append(f"afade=t=in:st=0:d={ae._f(min(s['fade_in_s'], avail))}")
        if s.get("fade_out_s"):
            fo = min(s["fade_out_s"], avail)
            f.append(f"afade=t=out:st={ae._f(avail - fo)}:d={ae._f(fo)}")
        if s.get("gain_db"):
            f.append(f"volume={float(s['gain_db']):.2f}dB")
        if offset > 0:
            f.append(f"adelay=delays={round(offset * 1000)}:all=1")
        lane = g.chain(f"{k}:a", f + fit)
        if t in duckers:
            # sidechaincompress stops a few hundred ms short when both inputs end together, so both
            # run on into padding and the result is cut back to the video length
            key = g.chain(keys[duckers.index(t)], ["apad"])
            lane = g.node([g.chain(lane, ["apad"]), key],
                          "sidechaincompress=threshold=0.03:ratio=20:attack=20:release=400:"
                          f"mix={duck_mix(duck_amount):.4f}")[0]
            lane = g.chain(lane, [f"atrim=end={D}", "asetpts=PTS-STARTPTS"])
        lanes.append(lane)
        if stems:
            stem_out.append((lane, f"{k:02d}-{t.name}.wav"))

    # stems branch off before the mix: each lane feeds both
    final_stems = []
    if stems:
        split = {}
        for lane, name in stem_out:
            a, b = g.node([lane], "asplit=2", 2)
            split[lane] = a
            final_stems.append((b, name))
        lanes = [split.get(x, x) for x in lanes]

    if lanes:
        cur = lanes[0] if len(lanes) == 1 else             g.node(lanes, f"amix=inputs={len(lanes)}:duration=longest:normalize=0")[0]
    else:
        cur = g.node([], f"anullsrc=r={ae.SR}:cl=stereo,atrim=end={D}")[0]
    tail = []
    if mix.get("loudness"):
        name = mix["loudness"]["target"]
        if measure_loudness:
            tail += ae.loudnorm(name)
        elif loud is not None:
            tail += ae.loudnorm(name, loud)
    if not measure_loudness:
        # several full-level tracks summed with normalize=0 can go over; this only touches those peaks
        tail.append(SAFETY)
    g.chain(cur, tail, out="out")
    return MixPlan(g.text(), round(dur, 3), final_stems, ducked=bool(duckers))


def _inputs(video: Path, tracks: list[Track]) -> list[str]:
    args = ["-i", str(video)]
    for t in tracks:
        if t.spec.get("loop"):
            args += ["-stream_loop", "-1"]
        args += ["-i", str(t.path)]
    return args


def _measure(mix: dict, video: Path, vinfo: aa.StreamInfo, tracks: list[Track], tick=None,
             timeout: float = 1800) -> dict | None:
    if not mix.get("loudness"):
        return None
    first = build(mix, vinfo, tracks, measure_loudness=True)
    err = ae.run([*_inputs(video, tracks), "-filter_complex", first.graph, "-map", "[out]", "-t", ae._f(first.duration),
                  "-f", "null", "-"], timeout=timeout, tick=tick)
    return ae.parse_loudnorm(err)


def active(tracks: list[Track]) -> list[Track]:
    return [t for t in tracks if not t.spec.get("mute")]


def preview(mix: dict, video: Path, tracks: list[Track], dst: Path, timeout: float = 300) -> dict:
    vinfo = aa.stream_info(video)
    tracks = active(tracks)
    loud = _measure(mix, video, vinfo, tracks, timeout=timeout)
    plan = build(mix, vinfo, tracks, loud=loud)
    ae.run([*_inputs(video, tracks), "-filter_complex", plan.graph, "-map", "[out]", "-t", ae._f(plan.duration),
            "-c:a", "libmp3lame", "-b:a", "128k", str(dst)], timeout=timeout)
    return {"duration_s": plan.duration}


def render(mix: dict, video: Path, tracks: list[Track], dst: Path, *, stems_zip: Path | None = None, tick=None,
           timeout: float = 3600) -> dict:
    vinfo = aa.stream_info(video)
    if not vinfo.has_video:
        raise ae.EditError("This file has no picture to score")
    tracks = active(tracks)
    loud = _measure(mix, video, vinfo, tracks, tick=tick, timeout=timeout)
    if tick:
        tick()
    plan = build(mix, vinfo, tracks, loud=loud, stems=stems_zip is not None)
    t = ae._f(plan.duration)
    work = dst.parent
    stem_files = [(lbl, work / f".{dst.stem}.{name}") for lbl, name in plan.stems]

    def args(vcodec: list[str]) -> list[str]:
        out = [*_inputs(video, tracks), "-filter_complex", plan.graph,
               "-map", "0:v:0", "-map", "[out]", *vcodec, *AUDIO_OUT, "-t", t, "-movflags", "+faststart", str(dst)]
        for lbl, path in stem_files:
            out += ["-map", f"[{lbl}]", *STEM_ARGS, "-t", t, str(path)]
        return out

    try:
        try:
            ae.run(args(["-c:v", "copy"]), timeout=timeout, tick=tick)
        except ae.FFmpegFailed:
            ae.run(args(VIDEO_REENCODE), timeout=timeout, tick=tick)
        out = {"duration_s": plan.duration, "ducked": plan.ducked, "tracks": len(tracks)}
        if stems_zip is not None and stem_files:
            part = stems_zip.with_name(stems_zip.name + ".part")
            with zipfile.ZipFile(part, "w", compression=zipfile.ZIP_DEFLATED) as zf:
                for (_, path), (_, name) in zip(stem_files, plan.stems):
                    zf.write(path, arcname=name)
            part.replace(stems_zip)
            out["stems"] = [name for _, name in plan.stems]
        return out
    finally:
        for _, path in stem_files:
            path.unlink(missing_ok=True)


def safe_stem(title: str, fallback: str = "track") -> str:
    from app.reel import safe_name

    return safe_name(title, fallback)[:40] or fallback
