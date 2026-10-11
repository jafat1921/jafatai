"""Voice Gallery (contract v19): ready-made voices from a JSON catalogue, their samples, and the
`gallery:<id>` voice ids that speak, dialogue and dub resolve without adding the voice first.

Kept free of app.voices at import time: voices builds its Kokoro presets from this catalogue.
"""
import json
import logging
import shutil
from functools import lru_cache
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import voice_instruct
from app.config import get_settings
from app.models import Job, VoiceProfile, new_id

log = logging.getLogger("mixai.gallery")

CATALOGUE = Path(__file__).resolve().parent / "data" / "voice_gallery.json"
PREFIX = "gallery:"
SAMPLE_JOB = "voice_sample"
GENDERS = ("male", "female", "neutral")
AGES = ("child", "young", "adult", "elder")
STYLES = ("narrator", "news", "warm", "deep", "energetic", "calm", "storyteller", "whisper", "radio", "villain",
          "teacher", "podcast", "poetry", "kids")
FACETS = ("language", "gender", "age", "style", "engine")
AGE_LABELS = {"child": "Child", "young": "Young", "adult": "Adult", "elder": "Elder"}
LOUDNESS = "podcast"
SAMPLE_FORMAT = "mp3_128"

# one natural line per language; Urdu stays in Urdu script and gets aerab like any speech
SAMPLE_LINES = {
    "en": "Hello, this is my voice. Let me tell you a story worth hearing.",
    "ur": "السلام علیکم، یہ میری آواز ہے۔ آئیے، آپ کو ایک دلچسپ کہانی سناتا ہوں۔",
    "hi": "नमस्ते, यह मेरी आवाज़ है। आइए, आपको एक दिलचस्प कहानी सुनाता हूँ।",
    "pa": "ਸਤ ਸ੍ਰੀ ਅਕਾਲ, ਇਹ ਮੇਰੀ ਆਵਾਜ਼ ਹੈ। ਆਓ, ਤੁਹਾਨੂੰ ਇੱਕ ਕਹਾਣੀ ਸੁਣਾਵਾਂ।",
    "ps": "سلام، دا زما غږ دی. راځئ چې تاسو ته یوه کیسه وکړم.",
    "ar": "مرحباً، هذا صوتي. دعني أحكي لك حكاية تستحق الاستماع.",
    "fa": "سلام، این صدای من است. بگذارید داستانی شنیدنی برایتان تعریف کنم.",
    "tr": "Merhaba, bu benim sesim. Size dinlemeye değer bir hikâye anlatayım.",
    "bn": "নমস্কার, এটা আমার কণ্ঠ। চলুন, আপনাকে একটা গল্প শোনাই।",
    "es": "Hola, esta es mi voz. Déjame contarte una historia que vale la pena.",
    "fr": "Bonjour, voici ma voix. Laissez-moi vous raconter une belle histoire.",
    "it": "Ciao, questa è la mia voce. Lascia che ti racconti una storia.",
    "pt": "Olá, esta é a minha voz. Deixe-me contar uma história para você.",
    "ja": "こんにちは、これが私の声です。素敵な物語をお話ししましょう。",
    "zh": "你好，这是我的声音。让我给你讲一个值得一听的故事。",
}


class GalleryError(ValueError):
    pass


@lru_cache(maxsize=1)
def raw() -> tuple[dict, ...]:
    with open(CATALOGUE, encoding="utf-8") as f:
        return tuple(json.load(f)["voices"])


def kokoro_rows() -> list[dict]:
    return [v for v in raw() if v.get("engine") == "kokoro"]


def problems(entries) -> list[str]:
    from app import voices as vc

    out, seen = [], set()
    for v in entries:
        vid = v.get("id") or ""
        if not vid or vid.startswith(PREFIX) or any(c.isspace() for c in vid):
            out.append(f"bad id {vid!r}")
        if vid in seen:
            out.append(f"{vid}: duplicate id")
        seen.add(vid)
        e = vc.ENGINES.get(v.get("engine") or "")
        if e is None:
            out.append(f"{vid}: unknown engine {v.get('engine')!r}")
            continue
        if v.get("gender") not in GENDERS:
            out.append(f"{vid}: gender {v.get('gender')!r}")
        if v.get("age") not in AGES:
            out.append(f"{vid}: age {v.get('age')!r}")
        if not v.get("name") or not v.get("languages"):
            out.append(f"{vid}: needs a name and languages")
        out += [f"{vid}: style {s!r}" for s in v.get("styles") or [] if s not in STYLES]
        out += [f"{vid}: {e.label} doesn't speak {lang}" for lang in v.get("languages") or []
                if lang not in e.languages and not e.open_languages]
        if e.id == "kokoro":
            if not v.get("preset") or v["preset"][:1] != vid[:1]:
                out.append(f"{vid}: a Kokoro voice needs its preset id")
        else:
            if "design" not in e.features:
                out.append(f"{vid}: {e.label} can't design a voice")
            if not str(v.get("instruct") or "").strip() or not isinstance(v.get("seed"), int):
                out.append(f"{vid}: a designed voice needs instruct and an int seed")
            elif e.id == "omnivoice":
                ins = voice_instruct.normalise(v["instruct"])
                if ins.ignored or ins.text != v["instruct"]:
                    out.append(f"{vid}: OmniVoice only takes {', '.join(voice_instruct.VALID)} (got {v['instruct']!r})")
    return out


@lru_cache(maxsize=1)
def catalogue() -> dict[str, dict]:
    bad = problems(raw())
    if bad:
        raise GalleryError("voice_gallery.json: " + "; ".join(bad[:10]))
    return {v["id"]: v for v in raw()}


def get(gallery_id: str) -> dict | None:
    return catalogue().get(gallery_id)


def parse(voice_id: str | None) -> str | None:
    """'gallery:af_heart' -> 'af_heart'; anything else -> None."""
    if voice_id and voice_id.startswith(PREFIX):
        return voice_id[len(PREFIX):]
    return None


def recipe(v: dict) -> tuple[str, dict]:
    """(kind, design-or-preset JSON) the way a VoiceProfile stores it."""
    if v["engine"] == "kokoro":
        return "preset", {"engine": "kokoro", "id": v["preset"], "gallery": v["id"]}
    spec = {"description": v["instruct"], "seed": v["seed"], "engine": v["engine"], "gallery": v["id"]}
    if v.get("speed"):
        spec["speed"] = v["speed"]
    return "design", spec


def notes_of(v: dict) -> str:
    return " · ".join([v.get("accent") or "", ", ".join(v.get("styles") or [])]).strip(" ·")


def as_profile(v: dict, workspace_id: str) -> VoiceProfile:
    # never added to a session: it only has to look like a library voice to the speech code
    kind, spec = recipe(v)
    p = VoiceProfile(id=PREFIX + v["id"], workspace_id=workspace_id, name=v["name"], kind=kind,
                     language=v["languages"][0], notes=notes_of(v), gender_hint=v.get("gender"), uses=0,
                     starred=False, locked=True)
    if kind == "design":
        p.design = spec
    else:
        p.preset = spec
    return p


# ---------------------------------------------------------------- browsing

def _values(v: dict, facet: str) -> list[str]:
    if facet == "language":
        return list(v.get("languages") or [])
    if facet == "style":
        return list(v.get("styles") or [])
    return [v.get(facet)] if v.get(facet) else []


def _label(facet: str, value: str) -> str:
    from app import voices as vc

    if facet == "language":
        return vc.lang_name(value)
    if facet == "engine":
        e = vc.ENGINES.get(value)
        return e.label if e else value
    if facet == "age":
        return AGE_LABELS.get(value, value)
    return value.capitalize()


def _matches_q(v: dict, q: str) -> bool:
    from app import voices as vc

    hay = " ".join([v["id"], v["name"], v.get("accent") or "", " ".join(v.get("styles") or []),
                    v.get("instruct") or "", v.get("description") or "", v.get("gender") or "", v.get("age") or "",
                    " ".join(vc.lang_name(x) for x in v.get("languages") or [])]).lower()
    return all(word in hay for word in q.lower().split())


def search(q: str | None = None, **filters: str | None) -> dict:
    """{items, total, facets}; each facet counts with every other filter applied."""
    rows = [v for v in catalogue().values() if not q or _matches_q(v, q)]
    wanted = {k: (val or "").strip().lower() for k, val in filters.items() if k in FACETS and val}

    def keep(v, skip=None):
        return all(want in _values(v, k) for k, want in wanted.items() if k != skip)

    facets = {}
    for facet in FACETS:
        counts: dict[str, int] = {}
        for v in rows:
            if keep(v, facet):
                for x in _values(v, facet):
                    counts[x] = counts.get(x, 0) + 1
        facets[facet] = sorted(({"value": k, "label": _label(facet, k), "count": n} for k, n in counts.items()),
                               key=lambda f: (-f["count"], f["label"]))
    items = [v for v in rows if keep(v)]
    return {"items": items, "total": len(items), "facets": facets}


def sample_dir() -> Path:
    return get_settings().data_dir / "voice_gallery"


def sample_path(gallery_id: str) -> Path:
    return sample_dir() / f"{gallery_id}.mp3"


def added_voices(db: Session, workspace_id: str) -> dict[str, VoiceProfile]:
    rows = db.scalars(select(VoiceProfile).where(VoiceProfile.workspace_id == workspace_id,
                                                 VoiceProfile.kind.in_(("design", "preset")))).all()
    out: dict[str, VoiceProfile] = {}
    for p in rows:
        gid = ((p.design if p.kind == "design" else p.preset) or {}).get("gallery")
        if gid and gid not in out:
            out[gid] = p
    return out


def item_out(v: dict, added: dict[str, VoiceProfile]) -> dict:
    kind, _ = recipe(v)
    mine = added.get(v["id"])
    out = {"id": v["id"], "voice_id": PREFIX + v["id"], "name": v["name"], "language": v["languages"][0],
           "languages": list(v["languages"]), "gender": v["gender"], "age": v["age"], "accent": v.get("accent") or "",
           "styles": list(v.get("styles") or []), "engine": v["engine"], "kind": kind,
           "sample_url": f"/api/voices/gallery/{v['id']}/sample", "sample_ready": sample_path(v["id"]).is_file(),
           "added_voice_id": mine.id if mine else None, "starred": bool(mine and mine.starred)}
    if kind == "design":
        out.update(instruct=v["instruct"], seed=v["seed"], description=v.get("description") or v["instruct"])
    else:
        out["preset"] = v["preset"]
    return out


def add(db: Session, workspace_id: str, v: dict, starred: bool | None = None) -> tuple[VoiceProfile, bool]:
    """The workspace's library copy of a gallery voice, made once. Returns (voice, created)."""
    p = added_voices(db, workspace_id).get(v["id"])
    created = p is None
    if created:
        p = as_profile(v, workspace_id)
        p.id = new_id()
        p.locked = False
        db.add(p)
    if starred is not None:
        p.starred = starred
    db.flush()
    return p, created


# ---------------------------------------------------------------- samples

def sample_text(language: str) -> str:
    return SAMPLE_LINES.get(language, SAMPLE_LINES["en"])


def speech_params(v: dict) -> tuple[dict, int | None]:
    kind, spec = recipe(v)
    lang = v["languages"][0]
    vspec = {"kind": kind, "name": v["name"]}
    if kind == "design":
        vspec["design"] = {k: spec[k] for k in ("description", "seed", "engine", "speed") if k in spec}
    else:
        vspec["preset"] = spec["id"]
    params = {"kind": "speech", "model": v["engine"], "engine": v["engine"], "language": lang,
              "text": sample_text(lang), "speed": 1.0, "duration_s": None, "voice": vspec}
    return params, v.get("seed")


def with_aerab(params: dict) -> dict:
    if params.get("language") != "ur" or not get_settings().urdu_aerab:
        return params
    from app import aerab
    from app.llm import LLMError

    try:
        marked, n, _ = aerab.mark_sync(params["text"])
    except LLMError as e:
        log.warning("aerab skipped for a gallery sample: %s", e)
        return params
    return {**params, "text": marked} if n else params


def level(src: Path, gallery_id: str) -> Path:
    from app import audio_edit

    dst = sample_path(gallery_id)
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_suffix(".part.mp3")
    audio_edit.export(src, tmp, SAMPLE_FORMAT, loudness=LOUDNESS, timeout=300)
    tmp.replace(dst)
    return dst


def pending_job(db: Session, gallery_id: str) -> Job | None:
    rows = db.scalars(select(Job).where(Job.type == SAMPLE_JOB, Job.status.in_(("queued", "running")))).all()
    return next((j for j in rows if (j.payload or {}).get("gallery_id") == gallery_id), None)


def queue_sample(db: Session, workspace_id: str, gallery_id: str) -> Job:
    job = pending_job(db, gallery_id)
    if job is None:
        job = Job(workspace_id=workspace_id, type=SAMPLE_JOB, payload={"gallery_id": gallery_id},
                  message=f"Waiting for a worker · Sample of {get(gallery_id)['name']}")
        db.add(job)
        db.flush()
    return job


def handle_sample(ctx) -> dict:
    gid = (ctx.job.payload or {}).get("gallery_id") or ""
    v = get(gid)
    if v is None:
        raise RuntimeError(f"No gallery voice '{gid}'")
    path = sample_path(gid)
    if path.is_file():
        return {"gallery_id": gid, "url": f"/api/voices/gallery/{gid}/sample"}
    ctx.progress(0.01, "Preparing the sample line")
    params, seed = speech_params(v)
    params = with_aerab(params)
    work = sample_dir() / f".{gid}.work"
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)
    try:
        driver = ctx.driver_factory()
        res = driver.generate_audio(params["text"], params, seed, work / "take.flac",
                                    lambda f, m: ctx.progress(0.05 + 0.85 * f, m or "Speaking the sample"))
        ctx.progress(0.92, "Levelling")
        level(res.path, gid)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    return {"gallery_id": gid, "url": f"/api/voices/gallery/{gid}/sample"}


def render_samples(engine: str | None = None, force: bool = False, only: list[str] | None = None,
                   run=None, say=print) -> tuple[int, int]:
    """Render missing samples in batches: one runner call per engine (per language for Kokoro, whose
    pipeline is per language). Returns (made, failed)."""
    from app import venv_runner, voices as vc

    todo = [v for v in catalogue().values()
            if (not engine or v["engine"] == engine) and (not only or v["id"] in only)
            and (force or not sample_path(v["id"]).is_file())]
    if only:
        unknown = sorted(set(only) - set(catalogue()))
        if unknown:
            say(f"unknown gallery ids: {', '.join(unknown)}")
    groups: dict[tuple[str, str], list[dict]] = {}
    for v in todo:
        key = (v["engine"], v["languages"][0] if v["engine"] == "kokoro" else "")
        groups.setdefault(key, []).append(v)
    made = failed = 0
    work = sample_dir() / ".batch"
    for (eid, lang), batch in groups.items():
        e = vc.get_engine(eid)
        say(f"{e.label}{' ' + lang if lang else ''}: {len(batch)} sample(s)")
        shutil.rmtree(work, ignore_errors=True)
        work.mkdir(parents=True)
        segs = []
        for i, v in enumerate(batch):
            params, seed = speech_params(v)
            params = with_aerab(params)
            seg = {"text": vc.spoken_text(params["text"], e), "out": str(work / f"{i}.wav"),
                   "language": params["language"], "seed": seed}
            if params["voice"]["kind"] == "design":
                desc = params["voice"]["design"]["description"]
                seg["instruct"] = voice_instruct.normalise(desc).text if eid == "omnivoice" else desc
            else:
                seg["voice"] = params["voice"]["preset"]
            segs.append(seg)
        first = segs[0]
        job = {"engine": eid, "language": first["language"], "seed": first["seed"], "device": "cuda",
               "per_segment": True, "segments": segs, "instruct": first.get("instruct"), "voice": first.get("voice")}
        try:
            (run or venv_runner.run)(e.runner, e.venv, job, need_gb=e.vram_gb,
                                     progress=lambda f, m: say(f"  {m or ''} {f:.0%}".rstrip()))
        except Exception as err:  # noqa: BLE001  (one engine failing shouldn't stop the others)
            say(f"  {e.label} failed: {err}")
            failed += len(batch)
            continue
        for v, seg in zip(batch, segs):
            wav = Path(seg["out"])
            try:
                if not wav.is_file():
                    raise RuntimeError("no audio written")
                level(wav, v["id"])
                made += 1
            except Exception as err:  # noqa: BLE001
                say(f"  {v['id']}: {err}")
                failed += 1
    shutil.rmtree(work, ignore_errors=True)
    return made, failed
