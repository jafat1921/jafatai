"""The audio edit stack (contract v15): validation, and one ffmpeg filter graph that applies it.

Steps run in the documented order: trim, cuts, silence trim, speed / pitch, chain, gain, loop_to,
append, fades, loudness. Lengths are worked out here rather than discovered by ffmpeg, so a fade-out
or a loop can be placed exactly; silence trim is the one step that needs the file, and its silences
are measured first and turned into trim points.
"""
import functools
import json
import math
import subprocess
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path

from pydantic import ValidationError

from app import audio_analysis as aa
from app.config import get_settings
from app.schemas import AudioEdit

SR = 48000
MIN_LEN = 0.05
EDGE_FADE = 0.004  # a few ms at every cut seam, or the waveform jumps and clicks
LOOP_XFADE = 0.05
APPEND_XFADE = 0.02
MAX_LOOPS = 200
SILENCE_PAD = 0.01  # keep the first transient's attack
PREVIEW_MAX_S = 20 * 60

# (integrated LUFS, true peak dBTP)
TARGETS = {"web": (-14.0, -1.0), "podcast": (-16.0, -1.0), "broadcast": (-23.0, -2.0), "acx": (-19.0, -3.0)}

# Stock ffmpeg filters only. The limiters keep level=0 (alimiter otherwise normalises its output up to
# the ceiling) and latency=1 so the wet path stays in time with the dry one when they're blended.
LIMIT = "alimiter=limit=0.891:attack=5:release=60:level=0:latency=1"  # about -1 dBFS
PRESETS: dict[str, list[str]] = {
    # spoken word on air: rumble out, steady level, a little presence
    "broadcast": ["highpass=f=80", "acompressor=threshold=-18dB:ratio=3:attack=5:release=120:makeup=2",
                  "equalizer=f=3000:t=q:w=1:g=2", LIMIT],
    # big low end and air, gently glued, with a short room behind it
    "cinematic": ["equalizer=f=60:t=q:w=0.8:g=3", "equalizer=f=10000:t=q:w=0.8:g=2",
                  "acompressor=threshold=-20dB:ratio=2:attack=20:release=250:makeup=1.5",
                  "aecho=0.9:0.9:35|61:0.18|0.10", LIMIT],
    # voice: a soft gate for room tone between phrases, mud cut, presence lift, firmer compression
    "podcast": ["highpass=f=90", "agate=threshold=0.01:ratio=2:attack=10:release=250",
                "equalizer=f=250:t=q:w=1:g=-2", "equalizer=f=4000:t=q:w=1:g=3",
                "acompressor=threshold=-20dB:ratio=4:attack=10:release=150:makeup=3", LIMIT],
    "warm": ["lowpass=f=12000", "equalizer=f=200:t=q:w=0.9:g=3", "equalizer=f=3500:t=q:w=1:g=-2",
             "acompressor=threshold=-16dB:ratio=2:attack=30:release=300:knee=6"],
    # only the sub-sonic rumble / DC offset goes; everything audible is left alone
    "raw": ["highpass=f=25"],
    # AM-ish band, squashed hard, then a soft clipper for the edge
    "radio": ["highpass=f=200", "lowpass=f=5000", "equalizer=f=1500:t=q:w=1:g=4",
              "acompressor=threshold=-24dB:ratio=6:attack=3:release=80:makeup=4", "asoftclip=type=tanh"],
    # the 300-3400 Hz telephone band, plus a little bit-crush for the codec grit
    "telephone": ["highpass=f=300:p=2", "highpass=f=300:p=2", "lowpass=f=3400:p=2", "lowpass=f=3400:p=2",
                  "acrusher=bits=8:mode=log:aa=1:mix=0.35", "volume=4dB", LIMIT],
    # a multi-tap echo stands in for reverb; the uneven delays keep it from ringing like a comb
    "hall": ["aecho=0.8:0.85:60|97|143|211|307:0.40|0.33|0.25|0.18|0.12", LIMIT],
}

# id -> (encoder args, extension, media type)
FORMATS: dict[str, tuple[list[str], str, str]] = {
    "wav16": (["-c:a", "pcm_s16le"], ".wav", "audio/wav"),
    "wav24": (["-c:a", "pcm_s24le"], ".wav", "audio/wav"),
    "wav32f": (["-c:a", "pcm_f32le"], ".wav", "audio/wav"),
    # float input would otherwise make a 32-bit FLAC, which a lot of players refuse
    "flac": (["-c:a", "flac", "-sample_fmt", "s32", "-bits_per_raw_sample", "24"], ".flac", "audio/flac"),
    "mp3_128": (["-c:a", "libmp3lame", "-b:a", "128k"], ".mp3", "audio/mpeg"),
    "mp3_192": (["-c:a", "libmp3lame", "-b:a", "192k"], ".mp3", "audio/mpeg"),
    "mp3_320": (["-c:a", "libmp3lame", "-b:a", "320k"], ".mp3", "audio/mpeg"),
    "opus": (["-c:a", "libopus", "-b:a", "160k", "-ar", "48000"], ".opus", "audio/ogg"),
    # a shareable video: the song under an animated waveform (WhatsApp / YouTube / Instagram take it as is)
    "mp4": (["-c:a", "aac", "-b:a", "192k"], ".mp4", "video/mp4"),
}

WAVE_BG = "0x1b1611"
WAVE_FG = "0xC9A24A"


class EditError(ValueError):
    """A stack that can't be applied to this audio (readable; the API turns it into a 422)."""


class TooLong(EditError):
    pass


class FFmpegFailed(RuntimeError):
    pass


def normalise(edit: dict | AudioEdit | None) -> dict:
    if isinstance(edit, AudioEdit):
        model = edit
    else:
        try:
            model = AudioEdit.model_validate(edit or {})
        except ValidationError as e:
            first = e.errors()[0]
            where = ".".join(str(p) for p in first["loc"])
            raise EditError(f"{where}: {first['msg']}" if where else first["msg"]) from None
    out = model.model_dump(mode="json")
    out["cuts"] = sorted(out["cuts"], key=lambda c: c["start"])
    out["markers"] = sorted(out["markers"], key=lambda m: m["t"])
    return out


# ---------------------------------------------------------------- planning

Segment = tuple[float, float]


def _subtract(segs: list[Segment], cut: Segment) -> list[Segment]:
    cs, ce = cut
    out = []
    for s, e in segs:
        if ce <= s or cs >= e:
            out.append((s, e))
            continue
        if cs - s > 0.001:
            out.append((s, cs))
        if e - ce > 0.001:
            out.append((ce, e))
    return out


def _audible(silences: list[dict], duration: float) -> list[Segment]:
    out, at = [], 0.0
    for s in sorted(silences, key=lambda x: x["start"]):
        if s["start"] > at:
            out.append((at, s["start"]))
        at = max(at, s["end"])
    if at < duration:
        out.append((at, duration))
    return out


def keep_segments(edit: dict, duration: float, silences: list[dict] | None = None) -> list[Segment]:
    """The parts of the source that survive trim, cuts and silence trim, in source time."""
    segs: list[Segment] = [(0.0, duration)]
    if edit.get("trim"):
        a, b = edit["trim"]["start"], min(edit["trim"]["end"], duration)
        if a >= duration or b - a < MIN_LEN:
            raise EditError(f"The trim is outside the audio (it's {duration:.2f} s long)")
        segs = [(a, b)]
    for c in edit.get("cuts") or []:
        segs = _subtract(segs, (c["start"], c["end"]))
    if edit.get("silence_trim") and silences is not None:
        spans = [(max(s, a), min(e, b)) for s, e in segs for a, b in _audible(silences, duration)
                 if min(e, b) > max(s, a)]
        if not spans:
            raise EditError("Nothing but silence is left to keep")
        t0 = min(x[0] for x in spans) - SILENCE_PAD
        t1 = max(x[1] for x in spans) + SILENCE_PAD
        segs = [(max(s, t0), min(e, t1)) for s, e in segs if min(e, t1) - max(s, t0) > 0.001]
    if sum(e - s for s, e in segs) < MIN_LEN:
        raise EditError("The cuts leave nothing to play")
    return segs


def atempo(factor: float) -> list[str]:
    # one atempo only goes 0.5..2; pitch compensation can need more, so chain them
    out = []
    while factor > 2.0:
        out.append("atempo=2.0")
        factor /= 2.0
    while factor < 0.5:
        out.append("atempo=0.5")
        factor /= 0.5
    if abs(factor - 1.0) > 1e-6:
        out.append(f"atempo={factor:.6f}")
    return out


@functools.lru_cache(maxsize=4)
def _filters(ff: str) -> str:
    try:
        return subprocess.run([ff, "-hide_banner", "-filters"], capture_output=True, text=True, timeout=30).stdout
    except (OSError, subprocess.SubprocessError):
        return ""


def has_filter(name: str) -> bool:
    return f" {name} " in _filters(get_settings().ffmpeg_path())


def has_rubberband() -> bool:
    return has_filter("rubberband")


def loudnorm(name: str, stats: dict | None = None) -> list[str]:
    i, tp = TARGETS[name]
    if stats is None:
        return [f"loudnorm=I={i}:TP={tp}:LRA=11:print_format=json"]
    # linear mode only holds while the target LRA covers the material's own range
    lra = min(50.0, max(7.0, float(stats["input_lra"]) + 1.0))
    ln = (f"loudnorm=I={i}:TP={tp}:LRA={lra:.1f}:measured_I={stats['input_i']}:measured_TP={stats['input_tp']}:"
          f"measured_LRA={stats['input_lra']}:measured_thresh={stats['input_thresh']}:"
          f"offset={stats['target_offset']}:linear=true:print_format=summary")
    # loudnorm always hands back 192 kHz
    return [ln, f"aresample={SR}"]


def parse_loudnorm(stderr: str) -> dict | None:
    blob = stderr[stderr.rfind("{"): stderr.rfind("}") + 1]
    try:
        stats = json.loads(blob)
        level = float(stats["input_i"])
    except (ValueError, KeyError):
        return None
    # silence measures -inf (or close to it); there's nothing to bring up
    if not math.isfinite(level) or level < -70:
        return None
    return stats


class Graph:
    """Builds a -filter_complex string; labels are made up as it goes."""

    def __init__(self):
        self.parts: list[str] = []
        self._n = 0

    def label(self) -> str:
        self._n += 1
        return f"x{self._n}"

    def chain(self, src: str, filters: list[str], out: str | None = None) -> str:
        if not filters:
            return src
        out = out or self.label()
        self.parts.append(f"[{src}]{','.join(filters)}[{out}]")
        return out

    def node(self, ins: list[str], filt: str, n_out: int = 1) -> list[str]:
        outs = [self.label() for _ in range(n_out)]
        self.parts.append("".join(f"[{i}]" for i in ins) + filt + "".join(f"[{o}]" for o in outs))
        return outs

    def text(self) -> str:
        return ";".join(self.parts)


def afmt(layout: str) -> str:
    return f"aformat=sample_fmts=fltp:sample_rates={SR}:channel_layouts={layout}"


def layout_for(*infos: aa.StreamInfo) -> str:
    # a mono voice note stays mono (upmixing would also make it read 3 LU louder)
    return "mono" if all(i.channels == 1 for i in infos) else "stereo"


def _seam(g: Graph, a: str, b: str, a_end: float, x: float) -> str:
    """The last x seconds of `a` (from a_end) crossfaded into the first x of `b`.

    Hand-built rather than acrossfade: ffmpeg 7.1's acrossfade drops most of its first input when both
    inputs are ready at once, which is always the case inside one graph."""
    tail = g.chain(a, [f"atrim=start={_f(a_end)}", "asetpts=PTS-STARTPTS", f"afade=t=out:d={x}"])
    head = g.chain(b, [f"atrim=end={x}", "asetpts=PTS-STARTPTS", f"afade=t=in:d={x}"])
    return g.node([tail, head], "amix=inputs=2:normalize=0:duration=longest")[0]


@dataclass
class Plan:
    graph: str
    duration: float
    label: str = "out"


def _f(x: float) -> str:
    return f"{x:.6f}"


def build(edit: dict, src: aa.StreamInfo, appends: list[aa.StreamInfo] | None = None,
          silences: list[dict] | None = None, *, rubberband: bool = False, loud: dict | None = None,
          measure_loudness: bool = False, meter: bool = False) -> Plan:
    """The filter graph for `edit`. Input 0 is the source and inputs 1.. the appended items.

    measure_loudness stops at a first-pass loudnorm (for parse_loudnorm); loud holds that pass's numbers
    for the real render. meter adds ebur128 at the end so the render's own stderr carries LUFS / peak."""
    appends = appends or []
    if src.duration <= 0:
        raise EditError("This audio has no length")
    layout = layout_for(src, *appends)
    g = Graph()
    cur = g.chain("0:a", [afmt(layout)])

    segs = keep_segments(edit, src.duration, silences)
    length = sum(e - s for s, e in segs)
    if len(segs) == 1 and segs[0] != (0.0, src.duration):
        a, b = segs[0]
        cur = g.chain(cur, [f"atrim=start={_f(a)}:end={_f(b)}", "asetpts=PTS-STARTPTS"])
    elif len(segs) > 1:
        pieces = []
        outs = g.node([cur], f"asplit={len(segs)}", len(segs))
        for k, ((a, b), o) in enumerate(zip(segs, outs)):
            f = [f"atrim=start={_f(a)}:end={_f(b)}", "asetpts=PTS-STARTPTS"]
            if k > 0:
                f.append(f"afade=t=in:d={EDGE_FADE}")
            if k < len(segs) - 1:
                f.append(f"afade=t=out:st={_f(max(0.0, b - a - EDGE_FADE))}:d={EDGE_FADE}")
            pieces.append(g.chain(o, f))
        cur = g.node(pieces, f"concat=n={len(pieces)}:v=0:a=1")[0]

    speed, pitch = float(edit.get("speed") or 1.0), float(edit.get("pitch") or 0.0)
    if pitch:
        ratio = 2 ** (pitch / 12)
        if rubberband:
            cur = g.chain(cur, [f"rubberband=tempo={speed:.6f}:pitch={ratio:.6f}"])
        else:
            # resampling shifts pitch and tempo together; atempo puts the tempo back (and applies speed)
            cur = g.chain(cur, [f"asetrate={round(SR * ratio)}", f"aresample={SR}", *atempo(speed / ratio)])
    elif abs(speed - 1.0) > 1e-6:
        cur = g.chain(cur, atempo(speed))
    length /= speed

    chain = edit.get("chain")
    if chain and chain["amount"] > 0:
        filters = PRESETS[chain["preset"]]
        wet = chain["amount"] / 100
        if wet >= 0.999:
            cur = g.chain(cur, filters)
        else:
            dry, w = g.node([cur], "asplit=2", 2)
            w = g.chain(w, filters)
            cur = g.node([dry, w], f"amix=inputs=2:weights='{1 - wet:.3f} {wet:.3f}':normalize=0:duration=first")[0]

    if edit.get("gain_db"):
        cur = g.chain(cur, [f"volume={edit['gain_db']:.2f}dB"])

    if edit.get("loop_to"):
        want = float(edit["loop_to"])
        if want > length + 0.001:
            if length <= LOOP_XFADE * 4:
                raise EditError("This is too short to loop")
            if (want - length) / (length - LOOP_XFADE) > MAX_LOOPS:
                raise EditError(f"Looping {length:.2f} s up to {want:.0f} s needs too many repeats")
            # the seam is baked into a loop unit (tail faded into head, then the body) and aloop repeats
            # that; the first pass plays the plain head
            x, end = LOOP_XFADE, length - LOOP_XFADE
            head, tl, hd, body = g.node([cur], "asplit=4", 4)
            head = g.chain(head, [f"atrim=end={_f(end)}", "asetpts=PTS-STARTPTS"])
            seam = _seam(g, tl, hd, end, x)
            body = g.chain(body, [f"atrim=start={x}:end={_f(end)}", "asetpts=PTS-STARTPTS"])
            unit = g.node([seam, body], "concat=n=2:v=0:a=1")[0]
            unit = g.chain(unit, [f"aloop=loop=-1:size={round(end * SR)}"])
            cur = g.node([head, unit], "concat=n=2:v=0:a=1")[0]
        cur = g.chain(cur, [f"atrim=end={_f(want)}", "asetpts=PTS-STARTPTS"])
        length = want
        if not (edit.get("fade_out") or {}).get("s"):
            d = min(1.5, length / 4)
            cur = g.chain(cur, [f"afade=t=out:st={_f(length - d)}:d={_f(d)}"])

    for k, info in enumerate(appends, start=1):
        if info.duration < APPEND_XFADE * 2 or length < APPEND_XFADE * 2:
            raise EditError("An appended clip is too short to join")
        x, end = APPEND_XFADE, length - APPEND_XFADE
        head, tl = g.node([cur], "asplit=2", 2)
        nhead, nbody = g.node([g.chain(f"{k}:a", [afmt(layout)])], "asplit=2", 2)
        head = g.chain(head, [f"atrim=end={_f(end)}", "asetpts=PTS-STARTPTS"])
        seam = _seam(g, tl, nhead, end, x)
        nbody = g.chain(nbody, [f"atrim=start={x}", "asetpts=PTS-STARTPTS"])
        cur = g.node([head, seam, nbody], "concat=n=3:v=0:a=1")[0]
        length += info.duration - APPEND_XFADE

    tail = []
    fi, fo = edit.get("fade_in") or {}, edit.get("fade_out") or {}
    if fi.get("s"):
        tail.append(f"afade=t=in:st=0:d={_f(min(fi['s'], length))}:curve={fi.get('curve') or 'tri'}")
    if fo.get("s"):
        d = min(fo["s"], length)
        tail.append(f"afade=t=out:st={_f(length - d)}:d={_f(d)}:curve={fo.get('curve') or 'tri'}")
    if edit.get("loudness"):
        name = edit["loudness"]["target"]
        if measure_loudness:
            tail += loudnorm(name)
        elif loud is not None:
            tail += loudnorm(name, loud)
    if meter and not measure_loudness:
        tail.append("ebur128=peak=true:framelog=quiet")
    g.chain(cur, tail or ["anull"], out="out")
    return Plan(g.text(), round(length, 3))


# ---------------------------------------------------------------- running ffmpeg

def run(args: list[str], timeout: float = 1800, tick=None, loglevel: str = "info") -> str:
    """ffmpeg with an argument list (never a shell). Returns stderr, where loudnorm and ebur128 report.
    `tick` is called every couple of seconds and may raise to cancel."""
    cmd = [get_settings().ffmpeg_path(), "-hide_banner", "-nostdin", "-nostats", "-y", "-loglevel", loglevel, *args]
    with tempfile.TemporaryFile() as errf:
        proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=errf)
        deadline = time.monotonic() + timeout
        try:
            while True:
                try:
                    proc.wait(timeout=2)
                    break
                except subprocess.TimeoutExpired:
                    if time.monotonic() > deadline:
                        raise FFmpegFailed("ffmpeg took too long") from None
                    if tick:
                        tick()
        except BaseException:
            proc.kill()
            proc.wait()
            raise
        errf.seek(0)
        err = errf.read().decode("utf-8", errors="replace")
    if proc.returncode != 0:
        why = [ln for ln in err.splitlines() if "rror" in ln or "nvalid" in ln][:4]
        raise FFmpegFailed("ffmpeg failed: " + (" | ".join(why) or err[-500:]))
    return err


def detect_silences(src: Path, timeout: float = 600) -> list[dict]:
    err = run(["-i", str(src), "-vn", "-af", f"silencedetect=n={aa.SILENCE_DB}dB:d=0.05", "-f", "null", "-"],
              timeout=timeout)
    return aa.parse_silences(err, aa.stream_info(src).duration)


def render(edit: dict, src: Path, dst: Path, out_args: list[str], appends: list[Path] | None = None, *,
           tick=None, timeout: float = 1800, meter: bool = False, max_s: float | None = None) -> dict:
    """Apply `edit` to src and write dst with the given encoder args. Two passes when there's a loudness
    target. Returns {duration_s} plus, with meter, the output's {lufs_i, lra, true_peak_db}."""
    edit = normalise(edit)
    appends = appends or []
    info = aa.stream_info(src)
    if not info.has_audio:
        raise EditError("This file has no audio")
    if max_s is not None and info.duration > max_s:
        raise TooLong(f"Longer than {max_s / 60:.0f} min")
    app_infos = [aa.stream_info(p) for p in appends]
    silences = detect_silences(src) if edit.get("silence_trim") else None
    rb = bool(edit.get("pitch")) and has_rubberband()
    inputs = ["-i", str(src)]
    for p in appends:
        inputs += ["-i", str(p)]
    loud = None
    if edit.get("loudness"):
        first = build(edit, info, app_infos, silences, rubberband=rb, measure_loudness=True)
        err = run([*inputs, "-filter_complex", first.graph, "-map", f"[{first.label}]", "-f", "null", "-"],
                  timeout=timeout, tick=tick)
        loud = parse_loudnorm(err)
        if tick:
            tick()
    plan = build(edit, info, app_infos, silences, rubberband=rb, loud=loud, meter=meter)
    if max_s is not None and plan.duration > max_s:
        raise TooLong(f"Longer than {max_s / 60:.0f} min")
    err = run([*inputs, "-filter_complex", plan.graph, "-map", f"[{plan.label}]", *out_args, str(dst)],
              timeout=timeout, tick=tick)
    out = {"duration_s": plan.duration}
    if meter:
        m = aa.parse_ebur128(err)
        out.update(lufs_i=m["lufs_i"], lra=m["lra"], true_peak_db=m["true_peak_db"])
    return out


def export(src: Path, dst: Path, fmt: str, loudness: str | None = None, timeout: float = 1800) -> None:
    """Convert a version as it is (no edit), optionally brought to a loudness target."""
    args, _, _ = FORMATS[fmt]
    if fmt == "mp4":
        return _waveform_video(src, dst, loudness, timeout)
    if not loudness:
        run(["-i", str(src), "-vn", "-map", "0:a:0", "-map_metadata", "-1", *args, str(dst)], timeout=timeout,
            loglevel="error")
        return
    render({"loudness": {"target": loudness}}, src, dst, ["-map_metadata", "-1", *args], timeout=timeout)


def _waveform_video(src: Path, dst: Path, loudness: str | None, timeout: float) -> None:
    audio = src
    tmp = None
    if loudness:
        tmp = dst.with_suffix(".level.wav")
        render({"loudness": {"target": loudness}}, src, tmp, ["-c:a", "pcm_s16le"], timeout=timeout)
        audio = tmp
    graph = (f"[1:a]showwaves=s=1280x320:mode=cline:rate=25:colors={WAVE_FG},format=rgba[w];"
             "[0:v][w]overlay=0:(H-h)/2:shortest=1,format=yuv420p[v]")
    try:
        run(["-f", "lavfi", "-i", f"color=c={WAVE_BG}:s=1280x720:r=25", "-i", str(audio),
             "-filter_complex", graph, "-map", "[v]", "-map", "1:a:0", "-map_metadata", "-1",
             "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-pix_fmt", "yuv420p",
             *FORMATS["mp4"][0], "-shortest", "-movflags", "+faststart", str(dst)],
            timeout=timeout, loglevel="error")
    finally:
        if tmp is not None:
            tmp.unlink(missing_ok=True)
