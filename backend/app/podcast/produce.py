"""The episode mix (contract v20): the script's lines on one timeline, with intro / bed / outro music ducked
under the voice and the whole thing levelled for podcast apps.

Two ffmpeg runs: the voice track first (every take back to back with its gap, as in a Dialogue mix, but in
stereo), then the music around it. Start times are worked out here from each file's length, so the
timeline that SRT, chapters and the video use is the same one the audio was built from.
"""
import hashlib
import json
import shutil
import time
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app import audio_analysis as aa
from app import audio_edit as ae
from app import dialogue as dl
from app import library as lib
from app import mixdown as md
from app.models import Generation, Job, MediaItem, PodcastEpisode, VoiceScript, utcnow
from app.podcast import service as sv
from app.services import generation_file

# (integrated LUFS, true peak dBTP): the usual podcast-app targets
LOUDNESS = {"stereo": (-16.0, -1.0), "mono": (-19.0, -1.0)}
MUSIC = ("intro", "bed", "outro")
BED_FADE_IN = 1.5
BED_FADE_OUT = 2.0
OUTRO_FADE = 2.0


class ProduceError(RuntimeError):
    pass


def plan(s: VoiceScript, ep: PodcastEpisode, lines: list[dict]) -> dict:
    """{items, basis}: what plays, in order, with the gap after each. Breaks lengthen the gap before them
    and a change of chapter adds chapter_gap_s."""
    st = sv.settings_of(ep)
    gaps_st = {**dl.settings_of(s), "gap_s": float(st["gap_s"])}
    keep = {id(ln) for ln in dl.spoken(lines)}
    names = {c["id"]: c["name"] for c in s.cast or []}
    items: list[dict] = []
    chapter = None
    for ln in lines:
        if id(ln) in keep:
            chapter = ln.get("chapter_id") or chapter
            if items and items[-1]["chapter_id"] != chapter:
                items[-1]["gap"] = round(items[-1]["gap"] + float(st["chapter_gap_s"]), 3)
            items.append({"line_id": ln["id"], "take_id": ln.get("take_id"), "kind": dl.kind_of(ln),
                          "speaker_id": ln.get("speaker_id"), "name": names.get(ln.get("speaker_id"), ""),
                          "text": ln.get("text") or "", "chapter_id": chapter,
                          "gap": round(dl.gap_after(ln, gaps_st), 3)})
        elif dl.kind_of(ln) == "break" and items:
            items[-1]["gap"] = round(items[-1]["gap"] + dl.break_s(ln), 3)
    if items:
        items[-1]["gap"] = 0.0
    blob = [[(i["take_id"], i["gap"], i["chapter_id"]) for i in items], {k: st[k] for k in MUSIC}, st["duck_db"], st["loudness"],
            [(c["id"], c["title"]) for c in ep.chapters or []]]
    return {"items": items, "basis": hashlib.sha1(json.dumps(blob, sort_keys=True).encode()).hexdigest()}


def queue_mix(db: Session, cur, ep: PodcastEpisode) -> Job:
    s = db.get(VoiceScript, ep.script_id or "")
    if s is None or not s.lines:
        raise HTTPException(409, "Write or paste the script first")
    lines = dl._check_ready(db, s)
    st = sv.settings_of(ep)
    for key in MUSIC:
        if st[key].get("media_id"):
            sv.audio_item(db, ep.workspace_id, st[key]["media_id"], f"{key} music")
    p = plan(s, ep, lines)
    params = {"episode_id": ep.id, "lines": len(p["items"]), "loudness": st["loudness"],
              "created_by": {"user_id": cur.id, "flow": "podcast_mix"}}
    item, g = sv.library_version(db, ep, "mix", "audio", ep.title, ["podcast"], params)
    return sv.queue_job(db, ep, sv.MIX_JOB, "mix", "Episode mix", {
        "media_id": item.id, "items": p["items"], "basis": p["basis"], "settings": st,
        "chapters": ep.chapters or []}, g)


# ---------------------------------------------------------------- the graph

def voice_graph(n: int, gaps: list[float]) -> str:
    parts = []
    for i in range(n):
        f = [f"aresample={ae.SR}", ae.afmt("stereo")]
        if gaps[i] > 0:
            f.append(f"apad=pad_dur={gaps[i]:.3f}")
        parts.append(f"[{i}:a]{','.join(f)}[p{i}]")
    parts.append("".join(f"[p{i}]" for i in range(n)) + f"concat=n={n}:v=0:a=1[out]")
    return ";".join(parts)


def layout(st: dict, voice_s: float, music: dict[str, float]) -> dict:
    """Where everything sits, in seconds: {lead, speech_end, outro_start, outro_len, total}."""
    lead = float(st["intro"]["lead_s"]) if "intro" in music else 0.0
    end = lead + voice_s
    outro_start = outro_len = 0.0
    total = end
    if "outro" in music:
        outro_len = min(music["outro"], float(st["outro"]["max_s"]))
        outro_start = max(lead, end - float(st["outro"]["overlap_s"]))
        total = max(end, outro_start + outro_len)
    return {"lead": lead, "speech_end": end, "outro_start": outro_start, "outro_len": outro_len, "total": total}


def loudnorm(preset: str, stats: dict | None) -> list[str]:
    i, tp = LOUDNESS[preset]
    if stats is None:
        return [f"loudnorm=I={i}:TP={tp}:LRA=11:print_format=json"]
    lra = min(50.0, max(7.0, float(stats["input_lra"]) + 1.0))
    return [f"loudnorm=I={i}:TP={tp}:LRA={lra:.1f}:measured_I={stats['input_i']}:measured_TP={stats['input_tp']}:"
            f"measured_LRA={stats['input_lra']}:measured_thresh={stats['input_thresh']}:"
            f"offset={stats['target_offset']}:linear=true:print_format=summary", f"aresample={ae.SR}"]


def build(st: dict, voice_s: float, music: dict[str, float], *, loud: dict | None = None,
          measure: bool = False) -> tuple[str, dict]:
    """Input 0 is the voice track, then intro, bed and outro (those present, in that order)."""
    at = layout(st, voice_s, music)
    T = ae._f(at["total"])
    fmt = ae.afmt("stereo")
    fit = [f"apad=whole_dur={T}", f"atrim=end={T}", "asetpts=PTS-STARTPTS"]
    g = ae.Graph()

    def delay(s: float) -> list[str]:
        return [f"adelay=delays={round(s * 1000)}:all=1"] if s > 0 else []

    def gain(key: str) -> list[str]:
        db = float(st[key].get("gain_db") or 0)
        return [f"volume={db:.2f}dB"] if db else []

    lanes: list[tuple[str, list[str]]] = []
    k = 1
    if "intro" in music:
        lead, overlap = at["lead"], float(st["intro"]["overlap_s"])
        length = min(music["intro"], lead + overlap)
        f = [fmt, f"atrim=end={ae._f(length)}", "asetpts=PTS-STARTPTS"]
        fo = min(max(overlap, 0.5), length / 2)
        if music["intro"] > length + 0.01 or overlap > 0:
            f.append(f"afade=t=out:st={ae._f(length - fo)}:d={ae._f(fo)}")
        lanes.append((f"{k}:a", f + gain("intro")))
        k += 1
    if "bed" in music:
        v = max(voice_s, 0.1)
        f = [fmt, f"atrim=end={ae._f(v)}", "asetpts=PTS-STARTPTS", f"afade=t=in:d={min(BED_FADE_IN, v / 3):.3f}",
             f"afade=t=out:st={ae._f(max(0.0, v - min(BED_FADE_OUT, v / 3)))}:d={min(BED_FADE_OUT, v / 3):.3f}"]
        lanes.append((f"{k}:a", f + gain("bed") + delay(at["lead"])))
        k += 1
    if "outro" in music:
        n = at["outro_len"]
        f = [fmt, f"atrim=end={ae._f(n)}", "asetpts=PTS-STARTPTS"]
        if music["outro"] > n + 0.01:
            d = min(OUTRO_FADE, n / 3)
            f.append(f"afade=t=out:st={ae._f(n - d)}:d={ae._f(d)}")
        lanes.append((f"{k}:a", f + gain("outro") + delay(at["outro_start"])))

    duck = float(st["duck_db"] or 0)
    voice = g.chain("0:a", [fmt, *delay(at["lead"]), *fit])
    keys: list[str] = []
    if lanes and duck > 0:
        voice, *keys = g.node([voice], f"asplit={len(lanes) + 1}", len(lanes) + 1)
    mixed = [voice]
    for n, (src, f) in enumerate(lanes):
        lane = g.chain(src, f + fit)
        if keys:
            # as in Score a Clip: run long into padding, compress hard against the voice, blend, cut back
            key = g.chain(keys[n], ["apad"])
            lane = g.node([g.chain(lane, ["apad"]), key],
                          "sidechaincompress=threshold=0.03:ratio=20:attack=20:release=400:"
                          f"mix={md.duck_mix(duck):.4f}")[0]
            lane = g.chain(lane, [f"atrim=end={T}", "asetpts=PTS-STARTPTS"])
        mixed.append(lane)
    cur = mixed[0] if len(mixed) == 1 else \
        g.node(mixed, f"amix=inputs={len(mixed)}:duration=longest:normalize=0")[0]
    tail = []
    preset = st["loudness"]
    if preset == "mono":
        tail.append(ae.afmt("mono"))
    if preset in LOUDNESS:
        tail += loudnorm(preset, None if measure else loud) if (measure or loud is not None) else []
    if not measure:
        tail.append(md.SAFETY if preset not in LOUDNESS else ae.LIMIT)
    g.chain(cur, tail or ["anull"], out="out")
    return g.text(), at


def _music_files(db: Session, st: dict) -> dict[str, Path]:
    out = {}
    for key in MUSIC:
        mid = st[key].get("media_id")
        if not mid:
            continue
        item = db.get(MediaItem, mid)
        g = db.get(Generation, item.generation_id or "") if item is not None else None
        path = generation_file(g) if g is not None else None
        if path is None or not path.is_file():
            raise ProduceError(f"The {key} music is gone from the Library")
        out[key] = path
    return out


def timeline(items: list[dict], durs: list[float], lead: float) -> list[dict]:
    out, t = [], lead
    for it, d in zip(items, durs):
        out.append({"line_id": it["line_id"], "kind": it["kind"], "speaker_id": it["speaker_id"],
                    "name": it["name"], "text": it["text"], "chapter_id": it["chapter_id"],
                    "start": round(t, 3), "end": round(t + d, 3)})
        t += d + float(it["gap"])
    return out


def chapter_marks(chapters: list[dict], tl: list[dict], total: float) -> list[dict]:
    """[{id, title, start, end}] covering the whole file: the first starts at 0 (the intro is part of it)
    and each one ends where the next begins."""
    starts = []
    for c in chapters:
        first = next((t["start"] for t in tl if t["chapter_id"] == c["id"]), None)
        if first is not None:
            starts.append((c, first))
    out = []
    for n, (c, start) in enumerate(starts):
        end = starts[n + 1][1] if n + 1 < len(starts) else total
        out.append({"id": c["id"], "title": c["title"], "start": 0.0 if n == 0 else round(start, 3),
                    "end": round(end, 3)})
    return out


def render(db: Session, items: list[dict], st: dict, dst: Path, work: Path, tick=None) -> dict:
    files = dl._take_files(db, [it["take_id"] for it in items])
    durs = [aa.stream_info(f).duration for f in files]
    if not files or not all(d > 0 for d in durs):
        raise ProduceError("A take has no length; render it again")
    voice = work / "voice.wav"
    inputs = []
    for p in files:
        inputs += ["-i", str(p)]
    ae.run([*inputs, "-filter_complex", voice_graph(len(files), [float(i["gap"]) for i in items]), "-map", "[out]",
            "-c:a", "pcm_f32le", str(voice)], tick=tick)
    voice_s = aa.stream_info(voice).duration
    music_files = _music_files(db, st)
    music = {k: aa.stream_info(p).duration for k, p in music_files.items()}
    args = ["-i", str(voice)]
    for key in MUSIC:
        if key in music_files:
            if key == "bed":
                args += ["-stream_loop", "-1"]
            args += ["-i", str(music_files[key])]
    loud = None
    if st["loudness"] in LOUDNESS:
        graph, at = build(st, voice_s, music, measure=True)
        err = ae.run([*args, "-filter_complex", graph, "-map", "[out]", "-t", ae._f(at["total"]), "-f", "null", "-"],
                     tick=tick)
        loud = ae.parse_loudnorm(err)
    graph, at = build(st, voice_s, music, loud=loud)
    channels = ["-ac", "1"] if st["loudness"] == "mono" else ["-ac", "2"]
    ae.run([*args, "-filter_complex", graph, "-map", "[out]", "-t", ae._f(at["total"]), *channels,
            *ae.FORMATS["flac"][0], str(dst)], tick=tick)
    return {"durs": durs, "layout": at, "voice_s": voice_s}


def handle_mix(ctx) -> dict:
    db, job = ctx.db, ctx.job
    p = job.payload or {}
    gen = db.get(Generation, job.generation_id or "")
    ep = db.get(PodcastEpisode, p.get("episode_id") or "")
    if gen is None or ep is None:
        raise ProduceError("The episode or its mix record no longer exists")
    gen.status = "generating"
    db.commit()
    items = p.get("items") or []
    st = p.get("settings") or sv.settings_of(ep)
    folder, rel_folder = lib.media_dir(gen.workspace_id)
    folder.mkdir(parents=True, exist_ok=True)
    work = folder / f".{gen.id}.podcast"
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)
    dst, part = folder / f"{gen.id}.flac", folder / f".{gen.id}.part.flac"
    t0 = time.monotonic()
    try:
        ctx.progress(0.05, f"Joining {len(items)} lines")
        res = render(db, items, st, part, work, tick=lambda: ctx.progress(0.5, "Mixing the episode"))
        ctx.progress(0.95, "Saving")
        part.replace(dst)
    finally:
        part.unlink(missing_ok=True)
        shutil.rmtree(work, ignore_errors=True)
    total = round(aa.stream_info(dst).duration, 3)
    tl = timeline(items, res["durs"], res["layout"]["lead"])
    db.refresh(gen)
    db.refresh(ep)
    rel = f"{rel_folder}/{dst.name}"
    gen.params = {**(gen.params or {}), "duration_s": total}
    gen.file_path, gen.media_type, gen.status = rel, "audio/flac", "ready"
    outs = dict(ep.outputs or {})
    outs["mix"] = {"media_id": p.get("media_id"), "generation_id": gen.id, "duration_s": total,
                   "built_at": utcnow().isoformat() + "Z", "basis": p.get("basis"), "timeline": tl,
                   "chapters": chapter_marks(p.get("chapters") or [], tl, total),
                   "music": {k: st[k].get("media_id") for k in MUSIC}, "loudness": st["loudness"]}
    ep.outputs = outs
    return {"file_path": rel, "media_type": "audio/flac", "duration_s": total, "lines": len(items),
            "lead_s": res["layout"]["lead"], "seconds": round(time.monotonic() - t0, 3)}
