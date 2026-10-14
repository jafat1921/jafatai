"""The ten dub stages and the two job handlers (dub_stage, dub_export).

Each stage reads what the stage before left (files in the dub's data dir, the row's JSON), does its
part and hands on to the next with a new job. The JSON is written back after each step; the job
context's progress ticks commit, so a stage that fails halfway keeps the lines it already finished.
"""
import copy
import logging
import shutil
import time
import wave
import zlib
from pathlib import Path

import numpy as np

from app import aerab, voices
from app import audio_edit as ae
from app import library as lib
from app.audio_analysis import _decode_mono, stream_info
from app.config import get_settings
from app.dub import engines, export as ex, project as pj, text as tx
from app.models import DubProject, Generation, MediaItem, VoiceProfile, new_id, utcnow
from app.services import generation_file, new_seed, next_version

log = logging.getLogger("mixai.dub")

MIX_SR = 48000
SMART_MAX = 1.25
STRETCH = (0.8, 1.5)
TRIM_FADE_S = 0.06
WER_FLAG = 0.35
OVERRUN_FLAG = 0.3
SAMPLE_S = (6.0, 12.0)


class StageError(RuntimeError):
    pass


def _driver_call(ctx, name: str):
    driver = ctx.driver_factory()
    fn = getattr(driver, name, None)
    if fn is None:
        raise StageError(f"The {getattr(driver, 'name', '?')} driver can't {name.replace('_', ' ')}")
    return fn


def _tick(ctx, stage: str, done: float, message: str | None = None):
    ctx.progress(done, message or pj.STAGE_LABELS[stage])


def _segments(dub: DubProject) -> list[dict]:
    return copy.deepcopy(dub.segments or [])


def _set_target(segs: list[dict], seg_id: str, lang: str, **fields) -> None:
    for s in segs:
        if s["id"] == seg_id:
            tgt = dict(s.get("target") or {})
            tgt[lang] = {**(tgt.get(lang) or {}), **fields}
            s["target"] = tgt
            return


# ---------------------------------------------------------------- extract / separate

def stage_extract(ctx, dub: DubProject, run: dict) -> dict:
    root, _ = pj.dub_dir(dub)
    out = root / "source.wav"
    video = pj.video_file(ctx.db, dub)
    info = stream_info(video)
    dub.duration_s = round(info.duration, 3)
    if out.is_file() and out.stat().st_size > 0:
        return {"cached": True}
    if not info.has_audio:
        raise StageError("This video has no sound to dub")
    root.mkdir(parents=True, exist_ok=True)
    _tick(ctx, "extract", 0.2)
    part = root / ".source.part.wav"
    engines._ffmpeg(["-i", str(video), "-vn", "-ac", "2", "-ar", str(MIX_SR), "-c:a", "pcm_s16le", str(part)])
    part.replace(out)
    return {"duration_s": dub.duration_s}


def stage_separate(ctx, dub: DubProject, run: dict) -> dict:
    root, _ = pj.dub_dir(dub)
    model = get_settings().dub_separation_model
    vocals, bed = root / "vocals.wav", root / "instrumental.wav"
    if vocals.is_file() and bed.is_file() and (dub.stages or {}).get("separate", {}).get("model") == model:
        return {"cached": True, "model": model}
    work = root / "stems"
    shutil.rmtree(work, ignore_errors=True)
    separate = _driver_call(ctx, "separate")
    res = separate(root / "source.wav", work, model, lambda f, m: _tick(ctx, "separate", 0.05 + 0.9 * f, m))
    for src, dst in ((Path(res["vocals"]), vocals), (Path(res["instrumental"]), bed)):
        if not src.is_file():
            raise StageError(f"The separation didn't write {dst.stem}")
        # same rate and channels as the source, so the mix never resamples a stem it lines up with
        engines._ffmpeg(["-i", str(src), "-ac", "2", "-ar", str(MIX_SR), "-c:a", "pcm_s16le", str(dst)])
    shutil.rmtree(work, ignore_errors=True)
    pj.set_stage(dub, "separate", model=model)
    return {"model": model}


# ---------------------------------------------------------------- transcribe / speakers

def stage_transcribe(ctx, dub: DubProject, run: dict) -> dict:
    root, _ = pj.dub_dir(dub)
    transcribe = _driver_call(ctx, "transcribe")
    lang = dub.source_language if dub.source_language not in (None, "", "auto") else None
    res = transcribe(root / "vocals.wav", lang, lambda f, m: _tick(ctx, "transcribe", f, m))
    segs = []
    for s in res.get("segments") or []:
        text = " ".join(str(s.get("text") or "").split())
        if not text or float(s["end"]) - float(s["start"]) < 0.15:
            continue
        words = [{"start": round(float(w["start"]), 3), "end": round(float(w["end"]), 3),
                  "w": str(w.get("word") or w.get("w") or "").strip()} for w in s.get("words") or []]
        segs.append({"id": pj.seg_id(), "start": round(float(s["start"]), 3), "end": round(float(s["end"]), 3),
                     "speaker_id": None, "source_text": text, "words": [w for w in words if w["w"]],
                     "target": {}})
    if not segs:
        raise StageError("Nobody seems to speak in this video: the transcript came back empty")
    dub.segments = segs
    if not lang:
        dub.source_language = res.get("language") or dub.source_language
    return {"segments": len(segs), "language": dub.source_language}


def _sample(ctx, dub: DubProject, spk: dict, segs: list[dict]) -> str | None:
    """6-12 s of one speaker from the separated voice, as a Library item to clone from."""
    root, _ = pj.dub_dir(dub)
    mine = sorted((s for s in segs if s["speaker_id"] == spk["id"]), key=lambda s: s["end"] - s["start"],
                  reverse=True)
    spans, total = [], 0.0
    for s in mine:
        if total >= SAMPLE_S[0]:
            break
        a, b = s["start"], min(s["end"], s["start"] + SAMPLE_S[1] - total)
        if b - a > 0.3:
            spans.append((a, b))
            total += b - a
    if not spans:
        return None
    spans.sort()
    clip = root / "samples" / f"{spk['id']}.flac"
    engines.cut_clip(root / "vocals.wav", spans, clip)
    return library_audio(ctx.db, dub, clip, f"{dub.title} · {spk['label']} (voice sample)", "dub_sample",
                         spk.get("sample_media_id"))[0]


def stage_speakers(ctx, dub: DubProject, run: dict) -> dict:
    root, _ = pj.dub_dir(dub)
    segs = _segments(dub)
    want = (dub.settings or {}).get("speakers", "auto")
    n = int(want) if str(want).isdigit() else None
    if n == 1 or len(segs) < 2:
        labels = [0] * len(segs)
    else:
        embed = _driver_call(ctx, "speaker_embed")
        emb = embed(root / "vocals.wav", [(s["start"], s["end"]) for s in segs],
                    lambda f, m: _tick(ctx, "speakers", 0.05 + 0.6 * f, m))
        # TODO: real diarisation (overlapping speech, a speaker change inside one segment) once a model
        # without a gated token is worth the install
        labels = engines.cluster(emb, min(n, len(segs)) if n else None, get_settings().dub_speaker_threshold)
    old = {s["id"]: s for s in dub.speakers or []}
    speakers = []
    for k in range(max(labels) + 1 if labels else 0):
        sid = f"spk{k + 1}"
        speakers.append({"id": sid, "label": old.get(sid, {}).get("label") or f"Speaker {k + 1}",
                         "voice_id": old.get(sid, {}).get("voice_id"),
                         "sample_media_id": old.get(sid, {}).get("sample_media_id")})
    for s, k in zip(segs, labels):
        s["speaker_id"] = f"spk{k + 1}"
    for i, spk in enumerate(speakers):
        _tick(ctx, "speakers", 0.7 + 0.3 * i / max(1, len(speakers)), "Cutting voice samples")
        try:
            spk["sample_media_id"] = _sample(ctx, dub, spk, segs)
        except RuntimeError as e:
            log.warning("no voice sample for %s/%s: %s", dub.id, spk["id"], e)
    dub.segments, dub.speakers = segs, speakers
    return {"speakers": len(speakers)}


# ---------------------------------------------------------------- translate / cast

def stage_translate(ctx, dub: DubProject, run: dict) -> dict:
    segs = _segments(dub)
    names = {s["id"]: s["label"] for s in dub.speakers or []}
    careful = (dub.settings or {}).get("quality") == "careful"
    fit = (dub.settings or {}).get("fit", "smart")
    done = 0
    for lang in pj.langs_of(dub, run):
        only = set((run.get("only") or {}).get(lang) or []) or None
        todo = [s for s in segs if (only is None or s["id"] in only) and
                pj.target(s, lang).get("status", "pending") == "pending"]
        if lang == dub.source_language:
            # re-voicing in the same language: the transcript is the script
            for s in todo:
                _set_target(segs, s["id"], lang, text=s["source_text"], fit=pj.target(s, lang).get("fit", fit),
                            status="translated")
            continue
        for b in range(0, len(todo), tx.BATCH):
            batch = [{"id": s["id"], "start": s["start"], "end": s["end"], "text": s["source_text"],
                      "speaker": names.get(s.get("speaker_id"))} for s in todo[b:b + tx.BATCH]]
            frac = b / max(1, len(todo))

            def tick(frac=frac):
                _tick(ctx, "translate", 0.05 + 0.85 * frac, f"Translating into {voices.lang_name(lang)}")

            tick()
            got = tx.translate_batch(batch, dub.source_language, lang, dub.glossary or [], careful, tick)
            missing = [x["id"] for x in batch if not got.get(x["id"], "").strip()]
            if missing:
                # one more try for the lines it skipped, on their own
                again = tx.translate_batch([x for x in batch if x["id"] in missing], dub.source_language, lang,
                                           dub.glossary or [], False, tick)
                got.update({k: v for k, v in again.items() if v.strip()})
            for x in batch:
                text = got.get(x["id"], "").strip()
                prev = pj.target(next(s for s in segs if s["id"] == x["id"]), lang)
                _set_target(segs, x["id"], lang, text=text, fit=prev.get("fit", fit), shortened=False,
                            status="translated" if text else "skipped", verify=None)
                done += 1
        _mark_lines(ctx, dub, segs, [s["id"] for s in todo], lang, "translate", 0.92)
        dub.segments = copy.deepcopy(segs)
    dub.segments = segs
    return {"translated": done}


def _mark_lines(ctx, dub: DubProject, segs: list[dict], ids: list[str], lang: str, stage: str, frac: float,
                only_unmarked: bool = False) -> None:
    """Aerab on the target lines of `ids` (Arabic-script targets only); the TTS reads the marks, the
    verify stage ignores them. With the LLM away the lines stay as they are."""
    by_id = {s["id"]: s for s in segs}
    rows = [(i, pj.target(by_id[i], lang).get("text") or "") for i in ids if i in by_id]
    rows = [(i, t) for i, t in rows if t and (not only_unmarked or aerab.unmarked(t))]
    if not rows or not aerab.applies(lang, "\n".join(t for _, t in rows)):
        return
    _tick(ctx, stage, frac, f"Adding aerab to the {voices.lang_name(lang)} lines")
    marked = aerab.finish_lines_sync([t for _, t in rows], lang, what=f"dub {dub.id}",
                                     tick=lambda: _tick(ctx, stage, frac, "Adding aerab"))
    for (i, old), new in zip(rows, marked):
        if new != old:
            _set_target(segs, i, lang, text=new)


def default_design(dub: DubProject, spk: dict) -> dict:
    # a stable made-up voice per speaker until the user casts one, so a speaker never changes voice mid-film
    return {"description": "A clear, natural adult voice with a neutral accent",
            "seed": zlib.crc32(f"{dub.id}:{spk['id']}".encode()) % 2**31, "engine": voices.default_engine()}


def stage_cast(ctx, dub: DubProject, run: dict) -> dict:
    db = ctx.db
    speakers = copy.deepcopy(dub.speakers or [])
    for spk in speakers:
        if spk.get("voice_id") and voices.find_voice(db, dub.workspace_id, spk["voice_id"]) is None:
            spk["voice_id"] = None
        if not spk.get("voice_id") and spk.get("sample_media_id"):
            # a voice the user cloned from this very speaker beats any stand-in
            v = db.query(VoiceProfile).filter(VoiceProfile.workspace_id == dub.workspace_id,
                                              VoiceProfile.ref_media_id == spk["sample_media_id"]).first()
            if v is not None:
                spk["voice_id"] = v.id
        if not spk.get("voice_id") and not spk.get("design"):
            spk["design"] = default_design(dub, spk)
    dub.speakers = speakers
    return {"cast": sum(1 for s in speakers if s.get("voice_id"))}


# ---------------------------------------------------------------- render / fit / verify

def _voice(db, dub: DubProject, voice_id: str | None, spk: dict, lang: str) -> tuple[dict, int]:
    voice = voices.find_voice(db, dub.workspace_id, voice_id)
    design = None if voice is not None else (spk.get("design") or default_design(dub, spk))
    e = voices.resolve_engine("auto", voice, design)
    if e.id == "kokoro" and voice is not None:
        p = voices.kokoro_preset((voice.preset or {}).get("id") or "")
        if p is not None and p.language != lang:
            raise voices.VoiceError(f"The Kokoro voice {p.name} speaks {voices.lang_name(p.language)}, not "
                                    f"{voices.lang_name(lang)}")
    voices.check_language(e, lang)
    if voice is None:
        vspec = {"kind": "design", "design": design}
        seed = int(design["seed"])
    elif voice.kind == "clone":
        g = db.get(Generation, voice.ref_generation_id or "")
        if g is None or not g.file_path:
            raise voices.VoiceError(f"The reference clip of “{voice.name}” is gone")
        vspec = {"kind": "clone", "name": voice.name, "ref_file": g.file_path, "ref_text": voice.ref_text or ""}
        seed = zlib.crc32(voice.id.encode()) % 2**31
    elif voice.kind == "design":
        vspec = {"kind": "design", "name": voice.name, "design": voice.design}
        seed = int((voice.design or {}).get("seed") or 0)
    else:
        vspec = {"kind": "preset", "name": voice.name, "preset": (voice.preset or {}).get("id")}
        seed = 0
    params = {"kind": "speech", "model": e.id, "engine": e.id, "language": lang, "speed": 1.0, "voice": vspec,
              "aerab": False}
    return params, seed


def _spoken(text: str, engine: str) -> str:
    e = voices.ENGINES.get(engine, voices.default())
    return " ".join(str(v) for k, v in voices.segments(text, e) if k == "text")


def stage_render(ctx, dub: DubProject, run: dict) -> dict:
    db = ctx.db
    root, _ = pj.dub_dir(dub)
    speak = _driver_call(ctx, "speak_many")
    spk_by_id = pj.speaker_map(dub)
    segs = _segments(dub)
    failed, errors, rendered = 0, [], 0
    langs = pj.langs_of(dub, run)
    for li, lang in enumerate(langs):
        only = set((run.get("only") or {}).get(lang) or []) or None
        todo = [s for s in segs if pj.target(s, lang).get("text") and (
            s["id"] in only if only is not None else pj.target(s, lang).get("status") in ("translated", "stale",
                                                                                            "failed"))]
        # lines typed or pasted in the editor never went through the translate pass
        _mark_lines(ctx, dub, segs, [x["id"] for x in todo], lang, "render", 0.01, only_unmarked=True)
        groups: dict[tuple, list[dict]] = {}
        for s in todo:
            key = (s.get("speaker_id"), pj.target(s, lang).get("voice_id") or None)
            groups.setdefault(key, []).append(s)
        for gi, ((spk_id, override), group) in enumerate(groups.items()):
            spk = spk_by_id.get(spk_id) or {"id": spk_id or "spk1", "label": "Speaker"}
            frac = (li + gi / max(1, len(groups))) / max(1, len(langs))
            try:
                params, seed = _voice(db, dub, override or spk.get("voice_id"), spk, lang)
                texts, outs, takes = [], [], []
                for s in group:
                    t = pj.target(s, lang)
                    n = int(t.get("takes") or 0) + 1
                    take = f"{s['id']}.{n}"
                    texts.append(_spoken(t["text"], params["engine"]))
                    outs.append(root / "takes" / lang / f"{take}.flac")
                    takes.append((take, n))
                outs[0].parent.mkdir(parents=True, exist_ok=True)
                durations = speak(params, texts, outs, seed,
                                  lambda f, m, frac=frac: _tick(ctx, "render", 0.02 + 0.95 * frac, m or
                                                                f"Voicing {spk.get('label')}"))
                for s, (take, n), d in zip(group, takes, durations):
                    _set_target(segs, s["id"], lang, take_id=take, takes=n, natural_s=round(float(d), 3),
                                status="rendered", error=None, verify=None, engine=params["engine"])
                    rendered += 1
            except (voices.VoiceError, RuntimeError) as e:
                for s in group:
                    _set_target(segs, s["id"], lang, status="failed", error=str(e)[:400])
                failed += len(group)
                errors.append(str(e))
            dub.segments = copy.deepcopy(segs)
            db.commit()
    if failed:
        raise StageError(f"{failed} line{'s' if failed != 1 else ''} couldn't be voiced: {errors[0][:300]}")
    return {"rendered": rendered}


def fit_filter(strategy: str, natural: float, slot: float) -> tuple[list[str], float, bool]:
    """(filters, tempo, trimmed) to fit a take of `natural` seconds into a `slot`."""
    ratio = natural / slot if slot > 0 else 1.0
    tempo, trim, pad = 1.0, False, False
    if strategy == "stretch":
        tempo = min(STRETCH[1], max(STRETCH[0], ratio))
        trim = pad = True
    elif strategy == "strict":
        trim = natural > slot
    else:
        tempo = min(SMART_MAX, ratio) if ratio > 1.0 else 1.0
    filters = ae.atempo(tempo)
    after = natural / tempo
    if trim and after > slot:
        filters += [f"atrim=0:{slot:.3f}", f"afade=t=out:st={max(0.0, slot - TRIM_FADE_S):.3f}:d={TRIM_FADE_S}"]
    if pad:
        filters += [f"apad=whole_dur={slot:.3f}", f"atrim=0:{slot:.3f}"]
    return filters, round(tempo, 4), trim and after > slot


def stage_fit(ctx, dub: DubProject, run: dict) -> dict:
    from app.llm import LLMError

    root, _ = pj.dub_dir(dub)
    segs = _segments(dub)
    rerender: dict[str, list[str]] = {}
    langs = pj.langs_of(dub, run)
    n = 0
    for lang in langs:
        todo = [s for s in segs if pj.target(s, lang).get("status") == "rendered"]
        for i, s in enumerate(todo):
            _tick(ctx, "fit", 0.05 + 0.9 * i / max(1, len(todo)))
            t = pj.target(s, lang)
            slot = max(0.2, s["end"] - s["start"])
            natural = float(t.get("natural_s") or 0)
            strategy = t.get("fit") or (dub.settings or {}).get("fit", "smart")
            if strategy == "smart" and natural / slot > SMART_MAX and not t.get("shortened"):
                try:
                    shorter = tx.shorter_line(t["text"], s["source_text"], slot, lang, dub.glossary or [],
                                              tick=lambda: _tick(ctx, "fit", 0.5, "Asking for a shorter line"))
                except LLMError as e:
                    log.warning("no shorter line for %s: %s", s["id"], e)
                    shorter = ""
                if shorter and len(aerab.strip(shorter)) < len(aerab.strip(t["text"])):
                    shorter = aerab.finish_sync(shorter, lang, what=f"dub {dub.id} shorter line").text
                    _set_target(segs, s["id"], lang, text=shorter, text_before=t["text"], shortened=True,
                                status="stale")
                    rerender.setdefault(lang, []).append(s["id"])
                    continue
                _set_target(segs, s["id"], lang, shortened=True)
            filters, tempo, trimmed = fit_filter(strategy, natural, slot)
            src = root / "takes" / lang / f"{t['take_id']}.flac"
            dst = root / "fit" / lang / f"{s['id']}.flac"
            dst.parent.mkdir(parents=True, exist_ok=True)
            args = ["-i", str(src)]
            if filters:
                args += ["-af", ",".join(filters)]
            engines._ffmpeg([*args, "-ac", "1", "-ar", str(MIX_SR), "-c:a", "flac", str(dst)])
            fitted = round(stream_info(dst).duration, 3)
            _set_target(segs, s["id"], lang, status="fitted", tempo=tempo, trimmed=trimmed, fitted_s=fitted)
            n += 1
        dub.segments = copy.deepcopy(segs)
    dub.segments = segs
    return {"fitted": n, "rerender": rerender}


def stage_verify(ctx, dub: DubProject, run: dict) -> dict:
    root, _ = pj.dub_dir(dub)
    check = _driver_call(ctx, "transcribe_many")
    segs = _segments(dub)
    flagged = 0
    for lang in pj.langs_of(dub, run):
        todo = [s for s in segs if pj.target(s, lang).get("status") == "fitted"]
        if not todo:
            continue
        paths = [root / "fit" / lang / f"{s['id']}.flac" for s in todo]
        heard = check(paths, lang, lambda f, m: _tick(ctx, "verify", 0.05 + 0.9 * f, m),
                      expect=[pj.target(s, lang)["text"] for s in todo])
        for s, h in zip(todo, heard):
            t = pj.target(s, lang)
            w = tx.wer(t["text"], h or "")
            over = round(max(0.0, float(t.get("fitted_s") or 0) - (s["end"] - s["start"])), 3)
            flags = (["wer"] if w > WER_FLAG else []) + (["overrun"] if over > OVERRUN_FLAG else [])
            flagged += bool(flags)
            _set_target(segs, s["id"], lang, status="verified",
                        verify={"wer": w, "overrun_s": over, "flags": flags, "heard": (h or "")[:500]})
        dub.segments = copy.deepcopy(segs)
    dub.segments = segs
    return {"flagged": flagged}


# ---------------------------------------------------------------- mix

def voice_track(dub: DubProject, lang: str, dst: Path) -> None:
    """Every fitted line at its start time on one mono track as long as the video. Lines are laid down
    in order with a small rolling buffer, so a two-hour film never sits in memory whole."""
    root, _ = pj.dub_dir(dub)
    total = int(round((dub.duration_s or 0) * MIX_SR))
    segs = sorted((s for s in dub.segments or [] if pj.target(s, lang).get("status") in ("fitted", "verified")),
                  key=lambda s: s["start"])
    dst.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(dst), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(MIX_SR)
        written = 0
        buf, buf_at = np.zeros(0, np.float32), 0

        def put(samples: np.ndarray):
            nonlocal written
            samples = samples[: max(0, total - written)]
            w.writeframes((np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes())
            written += len(samples)

        for s in segs:
            a = _decode_mono(root / "fit" / lang / f"{s['id']}.flac", MIX_SR)
            at = int(round(s["start"] * MIX_SR))
            if at >= buf_at + len(buf):
                put(buf)
                while written < min(at, total):
                    put(np.zeros(min(MIX_SR * 10, min(at, total) - written), np.float32))
                buf, buf_at = a.copy(), max(at, written)
            else:
                end = at + len(a) - buf_at
                if end > len(buf):
                    buf = np.concatenate([buf, np.zeros(end - len(buf), np.float32)])
                buf[at - buf_at: at - buf_at + len(a)] += a
        put(buf)
        while written < total:
            put(np.zeros(min(MIX_SR * 10, total - written), np.float32))


def library_audio(db, dub: DubProject, src: Path, title: str, flow: str, media_id: str | None = None,
                  lang: str | None = None) -> tuple[str, str]:
    """A finished file as a Library audio item, or as the next version of `media_id` when it still exists."""
    folder, rel_folder = lib.media_dir(dub.workspace_id)
    folder.mkdir(parents=True, exist_ok=True)
    item = db.get(MediaItem, media_id) if media_id else None
    if item is None or item.workspace_id != dub.workspace_id:
        item = MediaItem(id=new_id(), workspace_id=dub.workspace_id, kind="audio", origin="generated", title=title,
                         tags=["dub"])
        db.add(item)
        db.flush()
    g = Generation(id=new_id(), workspace_id=dub.workspace_id, project_id=None, target_type="media",
                   target_id=item.id, kind="audio", version=next_version(db, "media", item.id, "audio"),
                   status="ready", prompt=title, seed=new_seed(),
                   params={"created_by": {"flow": flow}, "dub_id": dub.id, "language": lang},
                   media_type="audio/flac")
    dst = folder / f"{g.id}.flac"
    shutil.copyfile(src, dst)
    g.file_path = f"{rel_folder}/{dst.name}"
    g.params = {**g.params, "duration_s": round(stream_info(dst).duration, 3)}
    db.add(g)
    db.flush()
    item.generation_id = g.id
    item.duration_s = g.params["duration_s"]
    lib.touch(item)
    return item.id, g.id


def stage_mix(ctx, dub: DubProject, run: dict) -> dict:
    db = ctx.db
    root, _ = pj.dub_dir(dub)
    settings = {**pj.DEFAULT_SETTINGS, **(dub.settings or {})}
    built = []
    langs = pj.langs_of(dub, run)
    for li, lang in enumerate(langs):
        missing = [s for s in dub.segments or [] if pj.target(s, lang).get("status") not in ("fitted", "verified",
                                                                                              "skipped")]
        if missing:
            raise StageError(f"{len(missing)} {voices.lang_name(lang)} line(s) aren't voiced yet; regenerate them "
                             f"first")
        _tick(ctx, "mix", 0.05 + 0.9 * li / max(1, len(langs)), f"Mixing the {voices.lang_name(lang)} dub")
        voice = root / "mix" / f"{lang}.voice.wav"
        voice_track(dub, lang, voice)
        dur = dub.duration_s or stream_info(voice).duration
        part = root / "mix" / f".{lang}.part.flac"
        args, graph = [], []
        if settings["keep_background"]:
            args += ["-i", str(root / "instrumental.wav")]
            args += ["-i", str(voice)]
            graph.append(f"[0:a]volume={float(settings['background_db']):.2f}dB,aformat=channel_layouts=stereo[bg]")
            graph.append("[1:a]aformat=channel_layouts=stereo[v]")
            graph.append("[bg][v]amix=inputs=2:normalize=0:duration=longest[m]")
        else:
            args += ["-i", str(voice)]
            graph.append("[0:a]aformat=channel_layouts=stereo[m]")
        # loudnorm hands its frames on with shifted timestamps; renumbering them keeps atrim honest
        post = ",".join([*ae.loudnorm("podcast"), f"aresample={MIX_SR}", "asetpts=N/SR/TB",
                         f"apad=whole_dur={dur:.3f}", f"atrim=0:{dur:.3f}"])
        graph.append(f"[m]{post}[out]")
        engines._ffmpeg([*args, "-filter_complex", ";".join(graph), "-map", "[out]", "-ar", str(MIX_SR), "-ac", "2",
                         "-c:a", "flac", str(part)])
        old = (dub.tracks or {}).get(lang) or {}
        media_id, gen_id = library_audio(db, dub, part, f"{dub.title} · {ex.dub_title(lang)}", "dub",
                                         old.get("media_id"), lang)
        part.unlink(missing_ok=True)
        tracks = dict(dub.tracks or {})
        tracks[lang] = {"media_id": media_id, "generation_id": gen_id, "built_at": utcnow().isoformat() + "Z"}
        dub.tracks = tracks
        built.append(lang)
    return {"tracks": built}


STAGE_FNS = {"extract": stage_extract, "separate": stage_separate, "transcribe": stage_transcribe,
             "speakers": stage_speakers, "translate": stage_translate, "cast": stage_cast, "render": stage_render,
             "fit": stage_fit, "verify": stage_verify, "mix": stage_mix}


# ---------------------------------------------------------------- the job handlers

def _run_scope(payload: dict) -> dict:
    return {k: payload[k] for k in ("langs", "only", "regen") if payload.get(k)}


def handle_stage(ctx) -> dict:
    from app.worker import JobCancelled, WorkerStopping

    db, job = ctx.db, ctx.job
    p = job.payload or {}
    dub = db.get(DubProject, p.get("dub_id") or "")
    if dub is None:
        raise RuntimeError("The dub no longer exists")
    stage = p.get("stage")
    if stage not in STAGE_FNS:
        raise RuntimeError(f"Unknown dub stage '{stage}'")
    if dub.job_id != job.id:
        return {"skipped": True, "reason": "a newer run took over"}
    run = _run_scope(p)
    pj.set_stage(dub, stage, status="running", progress=0.0, started_at=utcnow().isoformat() + "Z")
    dub.stage = stage
    db.commit()
    t0 = time.monotonic()
    try:
        result = STAGE_FNS[stage](ctx, dub, run) or {}
    except BaseException as e:
        db.rollback()
        dub = db.get(DubProject, dub.id)
        if dub is not None:
            if isinstance(e, WorkerStopping):
                pj.set_stage(dub, stage, status="pending")
            else:
                msg = "Cancelled" if isinstance(e, JobCancelled) else (str(e) or type(e).__name__)
                pj.set_stage(dub, stage, status="failed", error=msg[:1000])
                dub.job_id = job.id
            db.commit()
        raise
    seconds = round(time.monotonic() - t0, 2)
    if stage in pj.REVIEW_AFTER and not run.get("regen"):
        pj.set_stage(dub, stage, status="review", progress=1.0, seconds=seconds)
        return {"stage": stage, "review": True, **result}
    pj.set_stage(dub, stage, status="done", progress=1.0, seconds=seconds)
    rerender = result.get("rerender") or {}
    if stage == "fit" and rerender:
        # the shorter lines go round once more: render them, then fit, verify and mix as usual
        pj.reset_from(dub, "render")
        pj.queue_stage(db, dub, "render", {**run, "langs": pj.langs_of(dub, run), "only": rerender})
        return {"stage": stage, "next": "render", **result}
    i = pj.STAGES.index(stage)
    if i + 1 < len(pj.STAGES):
        nxt = pj.STAGES[i + 1]
        pj.queue_stage(db, dub, nxt, run)
        return {"stage": stage, "next": nxt, **result}
    return {"stage": stage, "finished": True, **result}


def subtitle_cues(dub: DubProject, lang: str) -> list[tuple[float, float, str]]:
    from app import transcripts

    rows = [{"start": s["start"], "end": s["end"], "text": aerab.strip(pj.target(s, lang).get("text") or "")}
            for s in dub.segments or []]
    return transcripts.cues(rows)


def handle_export(ctx) -> dict:
    from app import transcripts

    db, job = ctx.db, ctx.job
    p = job.payload or {}
    gen = db.get(Generation, job.generation_id or "")
    dub = db.get(DubProject, p.get("dub_id") or "")
    if gen is None or dub is None:
        raise RuntimeError("The dub or its new version is gone")
    gen.status = "generating"
    db.commit()
    video = pj.video_file(db, dub)
    root, _ = pj.dub_dir(dub)
    folder, rel_folder = lib.media_dir(gen.workspace_id)
    work = root / f".export-{gen.id}"
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)
    dst, part = folder / f"{gen.id}.mp4", folder / f".{gen.id}.part.mp4"
    langs = p["langs"]
    # the default language first: players without a track menu play the first one
    langs = [p["default_lang"]] + [x for x in langs if x != p["default_lang"]]
    t0 = time.monotonic()
    try:
        audio = []
        for lang in langs:
            tg = db.get(Generation, (dub.tracks or {}).get(lang, {}).get("generation_id") or "")
            path = generation_file(tg) if tg is not None else None
            if path is None or not path.is_file():
                raise StageError(f"The {voices.lang_name(lang)} track is gone; mix it again")
            audio.append(ex.Stream(path, lang, ex.dub_title(lang), lang == p["default_lang"]))
        if p.get("include_original") and stream_info(video).has_audio:
            audio.append(ex.Stream(None, dub.source_language, "Original", False))
        subs, burn = [], None
        if p.get("subtitles") == "srt":
            for lang in langs:
                srt = work / f"subs_{lang}.srt"
                srt.write_text(transcripts.to_srt(subtitle_cues(dub, lang)), encoding="utf-8")
                subs.append(ex.Stream(srt, lang, voices.lang_name(lang)))
        elif p.get("subtitles") == "burn":
            burn = subtitle_cues(dub, p["default_lang"])
        ctx.progress(0.2, "Burning in the subtitles" if burn else "Packing the languages")
        burned = ex.build_mp4(video, part, audio, subs, burn=burn, burn_language=p["default_lang"], work=work)
        part.replace(dst)
        stems = None
        if p.get("stems"):
            stems = folder / f"{gen.id}.stems.zip"
            files = {"instrumental.wav": root / "instrumental.wav", "original_voices.wav": root / "vocals.wav"}
            files.update({f"dub_{lang}_voice.wav": root / "mix" / f"{lang}.voice.wav" for lang in langs})
            ex.stems_zip(stems, files)
    finally:
        part.unlink(missing_ok=True)
        shutil.rmtree(work, ignore_errors=True)
    db.refresh(gen)
    rel = f"{rel_folder}/{dst.name}"
    gen.file_path, gen.media_type, gen.status = rel, "video/mp4", "ready"
    out = {"file_path": rel, "media_type": "video/mp4", "langs": langs, "bytes": dst.stat().st_size,
           "seconds": round(time.monotonic() - t0, 3)}
    if burned:
        out["subtitles"] = burned
    if stems is not None:
        from app.services import media_url

        out["stems"] = media_url(f"{rel_folder}/{stems.name}")
    return out
