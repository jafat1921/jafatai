"""Voice studio (contract v16): the voice library, transcripts and design previews.

POST /audio/speak lives with the rest of Audio Studio in app.api.audio.
"""
from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import literal_column, or_, select
from sqlalchemy.orm import Session

from app import voices as vc
from app.db import get_db
from app.models import VoiceProfile
from app.schemas import DesignPreviewIn, JobOut, SpeakDesignIn, SpeakIn, SpeakOut, VoiceIn, VoiceOut, VoicePatch
from app.security import CurrentUser, get_current_user, require_editor
from app.services import get_owned, job_out

router = APIRouter(prefix="/voices", tags=["voices"])


def _warnings(v: VoiceProfile) -> list[str]:
    d = v.ref_duration_s
    if not v.ref_media_id or d is None:
        return []
    return ["short"] if d < vc.REF_GOOD[0] else ["long"] if d > vc.REF_GOOD[1] else []


def _out(db: Session, v: VoiceProfile) -> VoiceOut:
    return VoiceOut(**vc.voice_out(db, v, _warnings(v)))


def _set_ref(db: Session, cur: CurrentUser, v: VoiceProfile, media_id: str) -> None:
    g, dur, _ = vc.ref_clip(db, cur.workspace_id, media_id)
    v.ref_media_id, v.ref_generation_id, v.ref_duration_s = media_id, g.id, dur


@router.get("/engines")
def engines(cur: CurrentUser = Depends(get_current_user)):
    # a bare list, one row per engine; the default is OmniVoice (contract v16)
    return vc.engines_out()


@router.get("", response_model=list[VoiceOut])
def list_voices(q: str | None = Query(None, max_length=120), language: str | None = Query(None, max_length=12),
                kind: str | None = Query(None, max_length=10), starred: bool | None = None,
                db: Session = Depends(get_db), cur: CurrentUser = Depends(get_current_user)):
    stmt = select(VoiceProfile).where(VoiceProfile.workspace_id == cur.workspace_id)
    if q and q.strip():
        like = f"%{q.strip()}%"
        stmt = stmt.where(or_(VoiceProfile.name.ilike(like), VoiceProfile.notes.ilike(like)))
    if language:
        stmt = stmt.where(VoiceProfile.language == language.lower())
    if kind:
        stmt = stmt.where(VoiceProfile.kind == kind)
    if starred is not None:
        stmt = stmt.where(VoiceProfile.starred == starred)
    # rowid breaks ties between voices made in the same instant, keeping it newest first
    rows = db.scalars(stmt.order_by(VoiceProfile.created_at.desc(), literal_column("voice_profile.rowid").desc())).all()
    return [_out(db, v) for v in rows]


@router.post("", response_model=VoiceOut, status_code=201)
def create_voice(body: VoiceIn, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    v = VoiceProfile(workspace_id=cur.workspace_id, name=body.name.strip(), kind=body.kind,
                     language=body.language.lower(), notes=body.notes.strip(), gender_hint=body.gender_hint,
                     ref_text=" ".join(body.ref_text.split()), starred=body.starred, locked=body.locked, uses=0,
                     portrait_media_id=vc.check_portrait(db, cur.workspace_id, body.portrait_media_id))
    if body.kind == "clone":
        if not body.ref_media_id:
            raise HTTPException(422, "A cloned voice needs a reference clip")
        # consent first: no point measuring a clip we may not use
        v.consent = vc.check_consent(body.consent.model_dump() if body.consent else None, cur.id)
        _set_ref(db, cur, v, body.ref_media_id)
    elif body.kind == "design":
        v.design = vc.clean_design(body.design.model_dump() if body.design else None)
    else:
        v.preset = vc.clean_preset(body.preset.model_dump() if body.preset else None)
        v.language = vc.kokoro_preset(v.preset["id"]).language
    db.add(v)
    db.commit()
    return _out(db, v)


def _owned(db: Session, cur: CurrentUser, voice_id: str) -> VoiceProfile:
    return get_owned(db, VoiceProfile, voice_id, cur.workspace_id, "Voice")


@router.get("/{voice_id}", response_model=VoiceOut)
def get_voice(voice_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(get_current_user)):
    return _out(db, _owned(db, cur, voice_id))


@router.patch("/{voice_id}", response_model=VoiceOut)
def patch_voice(voice_id: str, body: VoicePatch, db: Session = Depends(get_db),
                cur: CurrentUser = Depends(require_editor)):
    v = _owned(db, cur, voice_id)
    data = body.model_dump(exclude_unset=True)
    if data.get("locked") is False:
        v.locked = False  # unlocking in the same request as the change is fine
    kind = data.get("kind") or v.kind
    given = {k: x for k, x in (data.get("design") or {}).items() if x is not None}
    design = vc.clean_design({**(v.design or {}), **given}) if data.get("design") else None
    changes_identity = (
        kind != v.kind
        or (data.get("ref_media_id") and data["ref_media_id"] != v.ref_media_id)
        or (design is not None and {k: design[k] for k in ("description", "seed", "engine")} != v.design)
        or (data.get("preset") and vc.clean_preset(data["preset"]) != v.preset)
    )
    if v.locked and changes_identity:
        raise HTTPException(409, "This voice is locked; unlock it to change its reference clip or design")

    if kind == "clone":
        if data.get("consent") or v.consent is None:
            v.consent = vc.check_consent(data.get("consent"), cur.id)
        if data.get("ref_media_id") and data["ref_media_id"] != v.ref_media_id:
            _set_ref(db, cur, v, data["ref_media_id"])
        if not v.ref_media_id:
            raise HTTPException(422, "A cloned voice needs a reference clip")
    elif kind == "design":
        if design is None and not v.design:
            raise HTTPException(422, "A designed voice needs a description")
        if design is not None:
            v.design = design
    else:
        if data.get("preset"):
            v.preset = vc.clean_preset(data["preset"])
        if not v.preset:
            raise HTTPException(422, "A preset voice needs a preset")
        v.language = vc.kokoro_preset(v.preset["id"]).language
    v.kind = kind

    for key in ("name", "notes"):
        if data.get(key) is not None:
            setattr(v, key, data[key].strip())
    if data.get("language") and kind != "preset":
        v.language = data["language"].lower()
    if "ref_text" in data:
        v.ref_text = " ".join((data["ref_text"] or "").split())
    if "gender_hint" in data:
        v.gender_hint = data["gender_hint"]
    if "portrait_media_id" in data:
        v.portrait_media_id = vc.check_portrait(db, cur.workspace_id, data["portrait_media_id"])
    for key in ("starred", "locked"):
        if data.get(key) is not None:
            setattr(v, key, data[key])
    db.commit()
    return _out(db, v)


@router.delete("/{voice_id}", status_code=204)
def delete_voice(voice_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    # the reference clip is an ordinary Library item and stays there
    db.delete(_owned(db, cur, voice_id))
    db.commit()
    return Response(status_code=204)


@router.post("/{voice_id}/transcribe", response_model=JobOut, status_code=202)
def transcribe(voice_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    v = _owned(db, cur, voice_id)
    if not v.ref_generation_id:
        raise HTTPException(422, "This voice has no reference clip to transcribe")
    job = vc.queue_transcribe(db, v)
    db.commit()
    return job_out(job)


@router.post("/design/preview", response_model=SpeakOut, status_code=202)
def design_preview(body: DesignPreviewIn, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    language = body.language.lower()
    text = (body.text or "").strip() or vc.PANGRAMS.get(language, vc.PANGRAMS["en"])
    speak = SpeakIn(text=text, design=SpeakDesignIn(description=body.description, seed=body.seed),
                    engine=body.engine, language=language, aerab=body.aerab, count=1,
                    title=f"Voice design · {' '.join(body.description.split())[:60]}", folder_id=body.folder_id)
    out = vc.queue_speech(db, cur, speak, flow="voice_design")
    db.commit()
    return SpeakOut(**out)
