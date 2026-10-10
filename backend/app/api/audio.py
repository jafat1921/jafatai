"""Audio Studio (contract v14): songs, music and sound effects into the Library, and a lyrics writer."""
import logging
import re

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app import library as lib
from app import models_catalog as mc
from app.config import get_settings
from app.db import get_db
from app.llm import LLMError, chat
from app.models import Generation, Job, MediaItem, new_id
from app.schemas import AudioGenerateIn, ImageBatchOut, LyricsIn, LyricsOut
from app.security import CurrentUser, require_editor
from app.services import enqueue_generation, job_out, owned_source

log = logging.getLogger("mixai.audio")

router = APIRouter(prefix="/audio", tags=["audio"])

LANGUAGES = {"en": "English", "ur": "Urdu", "ur-latn": "Roman Urdu", "hi": "Hindi", "ar": "Arabic", "pa": "Punjabi",
             "bn": "Bengali", "fa": "Persian", "tr": "Turkish", "es": "Spanish", "fr": "French", "de": "German",
             "pt": "Portuguese", "it": "Italian", "ru": "Russian", "zh": "Mandarin Chinese", "ja": "Japanese",
             "ko": "Korean"}
# the alphabet each language must stay in; models (and people) reading lyrics trip over mixed scripts
SCRIPTS = {"ur": "Urdu script (Nastaliq / Perso-Arabic letters), never Roman letters",
           "ur-latn": "Roman Urdu: Urdu words spelt in Latin letters, the way people text, no Urdu script",
           "hi": "Devanagari", "pa": "Gurmukhi", "ar": "Arabic script", "fa": "Perso-Arabic script",
           "bn": "Bengali script"}
OFFLINE = "The lyrics writer is offline"


def _timbre_ref(db: Session, workspace_id: str, ref_id: str, m: mc.Model) -> Generation:
    if "timbre_ref" not in m.capabilities:
        raise HTTPException(422, f"{m.label} can't follow a voice or timbre reference; pick ACE-Step 1.5")
    g = owned_source(db, workspace_id, ref_id, "Timbre reference")
    if not (g.media_type or "").startswith("audio/") or g.status not in lib.FINISHED or not g.file_path:
        raise HTTPException(422, "The timbre reference isn't a finished audio clip")
    return g


@router.post("/generate", response_model=ImageBatchOut, status_code=202)
def generate_audio(body: AudioGenerateIn, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    prompt = " ".join(body.prompt.split())
    if not prompt:
        raise HTTPException(422, "A prompt is required")
    from app.api.library import generate_into

    into = generate_into(db, cur.workspace_id, body.folder_id, "audio")
    m, chosen = mc.choose(body.model, "audio", prompt, kind=body.kind)
    mc.check_audio(m, body.kind, body.duration_s)
    ref = _timbre_ref(db, cur.workspace_id, body.timbre_ref_id, m) if body.timbre_ref_id else None

    params = {"kind": body.kind, "model": m.id, "duration_s": body.duration_s, "user_prompt": prompt,
              "created_by": {"user_id": cur.id, "flow": "audio_generate"}, **chosen}
    if body.kind == "song":
        # lyrics, language and voice only mean something to the song models
        params.update(lyrics=body.lyrics.strip(), language=body.language, vocal=body.vocal or "none")
    for key in ("bpm", "category", "steps"):
        if getattr(body, key) is not None:
            params[key] = getattr(body, key)
    if ref is not None:
        params["timbre_ref_id"] = ref.id

    title = (body.title or "").strip() or lib.short_title(prompt)
    items, jobs = [], []
    for i in range(body.count):
        item = MediaItem(id=new_id(), workspace_id=cur.workspace_id, kind="audio", origin="generated", title=title,
                         tags=[], duration_s=body.duration_s, folder_id=into)
        db.add(item)
        db.flush()
        seed = (body.seed + i) % 2**31 if body.seed is not None else None
        g = enqueue_generation(db, workspace_id=cur.workspace_id, project_id=None, target_type="media",
                               target_id=item.id, kind=body.kind, prompt=prompt, params=dict(params), seed=seed)
        item.generation_id = g.id
        items.append(item)
        jobs.append(db.get(Job, g.job_id))
    db.commit()
    return ImageBatchOut(items=lib.items_out(db, items), jobs=[job_out(j) for j in jobs], model_resolved=m.id)


# ---------------------------------------------------------------- lyrics

class _Draft(BaseModel):
    lyrics: str
    tags: str = ""


_MARKER = re.compile(r"^[ \t]*\[[ \t]*([A-Za-z][A-Za-z -]*?)[ \t]*\d*[ \t]*\][ \t]*$", re.M)


def _tidy(lyrics: str) -> str:
    # [Verse 1] / [CHORUS] -> [verse] / [chorus]: the markers the song models were trained on
    text = _MARKER.sub(lambda mt: f"[{mt[1].strip().lower().replace(' ', '-')}]", lyrics.strip())
    return re.sub(r"\n{3,}", "\n\n", text)


def lyrics_messages(body: LyricsIn) -> list[dict]:
    lang = body.language.lower()
    name = LANGUAGES.get(lang, lang)
    sections = ", ".join(f"[{s.strip().lower()}]" for s in body.sections)
    rules = [
        "You are a songwriter. Write singable song lyrics: short lines, a clear rhythm, rhymes where the language "
        "allows, and a chorus people can remember.",
        f"Write the lyrics in {name}." + (f" Use {SCRIPTS[lang]}." if lang in SCRIPTS else ""),
        f"Use these sections in this order, each starting with its marker on a line of its own: {sections}. "
        "Markers stay in English and in square brackets exactly as given.",
        "Choruses repeat the same words each time. Four to eight lines per section.",
        "No titles, no notes, no chord names, no speaker labels, no names of real people.",
        "Also give the style tags for a music model: genre, mood, instruments, tempo feel and voice, in English, "
        "comma separated, at most 25 words.",
        'Reply as JSON: {"lyrics": the lyrics with section markers and newlines, "tags": the style tags}.',
    ]
    user = [f"Topic: {body.topic.strip()}"]
    if body.mood:
        user.append(f"Mood: {body.mood.strip()}")
    if body.style:
        user.append(f"Style: {body.style.strip()}")
    return [{"role": "system", "content": "\n".join(rules)}, {"role": "user", "content": "\n".join(user)}]


@router.post("/lyrics", response_model=LyricsOut)
async def write_lyrics(body: LyricsIn, cur: CurrentUser = Depends(require_editor)):
    try:
        res = await chat("creative", lyrics_messages(body), schema=_Draft, think=False, temperature=0.8,
                         max_tokens=1800, timeout=max(60.0, get_settings().enhance_timeout_s * 3))
    except LLMError as e:
        log.warning("lyrics writer unavailable: %s", e)
        raise HTTPException(503, OFFLINE) from None
    lyrics = _tidy(res.data.lyrics)
    if not lyrics:
        raise HTTPException(502, "The lyrics writer came back empty; try again")
    return LyricsOut(lyrics=lyrics, tags=" ".join(res.data.tags.split())[:300])
