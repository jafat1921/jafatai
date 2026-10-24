"""Implant Preview (M22): surgeon-only. Every route answers 404 to accounts without access, and a patient is only
ever visible to the surgeon who created it."""
from typing import Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import audit
from app.config import get_settings
from app.db import get_db, release
from app.implant import service as im
from app.implant import sheets
from app.implant.guard import require_implant
from app.models import Generation, ImplantPatient, ImplantSession, utcnow
from app.security import CurrentUser, session_only

router = APIRouter(prefix="/implant", tags=["implant"], dependencies=[Depends(require_implant)])

Profile = Literal["low", "moderate", "moderate_plus", "high", "extra_high"]
Shape = Literal["round", "teardrop"]
Placement = Literal["subglandular", "submuscular", "dual_plane"]
Fill = Literal["silicone", "saline"]
FILE_HEADERS = {"Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer"}


class Measurements(BaseModel):
    height_cm: float | None = Field(None, ge=100, le=230)
    weight_kg: float | None = Field(None, ge=30, le=250)
    bra_size: str = Field("", max_length=20)
    chest_width_cm: float | None = Field(None, ge=15, le=60)
    bw_left_cm: float | None = Field(None, ge=5, le=25)
    bw_right_cm: float | None = Field(None, ge=5, le=25)
    snn_left_cm: float | None = Field(None, ge=10, le=40)
    snn_right_cm: float | None = Field(None, ge=10, le=40)
    nimf_left_cm: float | None = Field(None, ge=2, le=20)
    nimf_right_cm: float | None = Field(None, ge=2, le=20)
    pinch_cm: float | None = Field(None, ge=0, le=10)
    ptosis_grade: int | None = Field(None, ge=0, le=3)
    asymmetry: str = Field("", max_length=300)


class PatientIn(BaseModel):
    label: str = Field(min_length=1, max_length=120, description="A code or name the surgeon recognises")
    adult_confirmed: bool
    consent_attested: bool = Field(description="The patient signed the consent form")
    topless_ok: bool = False
    retention_months: int = Field(24, ge=1, le=120)
    measurements: Measurements = Measurements()
    notes: str = Field("", max_length=4000)

    @model_validator(mode="after")
    def _required(self):
        if not self.adult_confirmed:
            raise ValueError("Confirm the patient is 18 or older")
        if not self.consent_attested:
            raise ValueError("Record the patient's signed consent")
        return self


class PatientPatch(BaseModel):
    label: str | None = Field(None, min_length=1, max_length=120)
    topless_ok: bool | None = None
    retention_months: int | None = Field(None, ge=1, le=120)
    measurements: Measurements | None = None
    notes: str | None = Field(None, max_length=4000)


class OptionIn(BaseModel):
    label: str = Field("", max_length=60)
    left_cc: int = Field(ge=100, le=900)
    right_cc: int = Field(ge=100, le=900)
    profile: Profile = "moderate_plus"
    shape: Shape = "round"
    placement: Placement = "dual_plane"
    fill: Fill = "silicone"


class SessionIn(BaseModel):
    options: list[OptionIn] = Field(min_length=1, max_length=3)


class ApproveIn(BaseModel):
    option: int = Field(ge=0, le=2)
    notes: str = Field("", max_length=1500)


def _gen_out(g: Generation | None) -> dict | None:
    if g is None:
        return None
    return {"id": g.id, "status": g.status, "url": f"/api/implant/files/{g.id}" if g.file_path else None,
            "job_id": g.job_id, **{k: v for k, v in (g.params or {}).items() if k in ("view", "garment")},
            **({"option": g.params["implant"]["option"], "view": g.params["implant"]["view"]}
               if (g.params or {}).get("implant") else {})}


def _patient_out(db: Session, p: ImplantPatient, full: bool = False) -> dict:
    c = p.consent or {}
    out = {"id": p.id, "label": p.label, "adult_confirmed": p.adult_confirmed,
           "consent": {"at": c.get("at"), "attested_by": c.get("attested_by"), "topless_ok": bool(c.get("topless_ok")),
                       "form": bool(c.get("form_path"))},
           "retention_months": p.retention_months, "last_activity_at": p.last_activity_at, "created_at": p.created_at,
           "approved": bool((p.chart or {}).get("session_id"))}
    if not full:
        return out
    sessions = list(db.scalars(select(ImplantSession).where(ImplantSession.patient_id == p.id)
                               .order_by(ImplantSession.created_at.desc())))
    chart = dict(p.chart or {})
    return {**out, "measurements": p.measurements or {}, "notes": p.notes,
            "views": im.VIEWS, "photos": {v: _gen_out(g) for v, g in im.photos(db, p).items()},
            "sessions": [{"id": s.id, "created_at": s.created_at, "options": s.options,
                          "results": [_gen_out(g) for g in im.results(db, s)]} for s in sessions],
            "chart": {"session_id": chart.get("session_id"), "option": chart.get("option"),
                      "approved_at": chart.get("approved_at"), "versions": len(chart.get("versions") or []),
                      "url": f"/api/implant/patients/{p.id}/chart.pdf" if chart.get("chart_path") else None}}


def _patient(db: Session, cur: CurrentUser, pid: str) -> ImplantPatient:
    return im.own_patient(db, cur.user.id, pid)


def _session(db: Session, p: ImplantPatient, sid: str) -> ImplantSession:
    s = db.get(ImplantSession, sid)
    if s is None or s.patient_id != p.id:
        raise HTTPException(404, "Consultation not found")
    return s


@router.get("/patients")
@session_only
def list_patients(db: Session = Depends(get_db), cur: CurrentUser = Depends(require_implant)):
    rows = db.scalars(select(ImplantPatient).where(ImplantPatient.surgeon_user_id == cur.user.id)
                      .order_by(ImplantPatient.last_activity_at.desc()))
    return [_patient_out(db, p) for p in rows]


@router.post("/patients", status_code=201)
@session_only
def create_patient(body: PatientIn, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_implant)):
    p = ImplantPatient(workspace_id=cur.workspace_id, surgeon_user_id=cur.user.id, label=body.label.strip(),
                       adult_confirmed=True, retention_months=body.retention_months, notes=body.notes,
                       measurements=body.measurements.model_dump(exclude_none=True),
                       consent={"at": utcnow().isoformat(), "attested_by": cur.user.display_name or cur.user.email,
                                "topless_ok": body.topless_ok})
    db.add(p)
    db.flush()
    audit.record(db, cur.user, "implant_patient_create", "implant_patient", p.id, topless_ok=body.topless_ok)
    db.commit()
    return _patient_out(db, p, full=True)


@router.get("/patients/{patient_id}")
@session_only
def get_patient(patient_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_implant)):
    p = _patient(db, cur, patient_id)
    audit.record(db, cur.user, "implant_patient_view", "implant_patient", p.id)
    db.commit()
    return _patient_out(db, p, full=True)


@router.patch("/patients/{patient_id}")
@session_only
def patch_patient(patient_id: str, body: PatientPatch, db: Session = Depends(get_db),
                  cur: CurrentUser = Depends(require_implant)):
    p = _patient(db, cur, patient_id)
    sent = body.model_dump(exclude_unset=True)
    if body.label is not None:
        p.label = body.label.strip()
    if body.retention_months is not None:
        p.retention_months = body.retention_months
    if body.notes is not None:
        p.notes = body.notes
    if body.measurements is not None:
        p.measurements = body.measurements.model_dump(exclude_none=True)
    if body.topless_ok is not None:
        p.consent = {**(p.consent or {}), "topless_ok": body.topless_ok}
    im.touch(p)
    audit.record(db, cur.user, "implant_patient_update", "implant_patient", p.id, fields=sorted(sent))
    db.commit()
    return _patient_out(db, p, full=True)


@router.delete("/patients/{patient_id}", status_code=204)
@session_only
def delete_patient(patient_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_implant)):
    p = _patient(db, cur, patient_id)
    audit.record(db, cur.user, "implant_patient_delete", "implant_patient", p.id)
    im.purge(db, p)
    db.commit()
    return Response(status_code=204)


@router.post("/patients/{patient_id}/consent-form")
@session_only
async def upload_consent_form(patient_id: str, file: UploadFile = File(...), db: Session = Depends(get_db),
                              cur: CurrentUser = Depends(require_implant)):
    p = _patient(db, cur, patient_id)
    data = await file.read(im.MAX_PHOTO_BYTES + 1)
    if len(data) > im.MAX_PHOTO_BYTES:
        raise HTTPException(413, "The file is over 25 MB")
    ext = {"application/pdf": ".pdf", "image/jpeg": ".jpg", "image/png": ".png"}.get(file.content_type or "")
    if ext is None:
        raise HTTPException(422, "Upload the signed form as a PDF, JPEG or PNG")
    rel = im.patient_rel(p) / f"consent{ext}"
    dest = get_settings().data_dir / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    p.consent = {**(p.consent or {}), "form_path": rel.as_posix()}
    audit.record(db, cur.user, "implant_consent_form", "implant_patient", p.id)
    db.commit()
    return _patient_out(db, p, full=True)


@router.post("/patients/{patient_id}/photos", status_code=201)
@session_only
async def upload_photo(patient_id: str, file: UploadFile = File(...), view: str = Form(...),
                       garment: str = Form("garment"), crop: str = Form(""), db: Session = Depends(get_db),
                       cur: CurrentUser = Depends(require_implant)):
    p = _patient(db, cur, patient_id)
    data = await file.read(im.MAX_PHOTO_BYTES + 1)
    box = None
    if crop.strip():
        try:
            box = tuple(float(v) for v in crop.split(","))
            assert len(box) == 4
        except (ValueError, AssertionError):
            raise HTTPException(422, "crop is x,y,w,h as fractions of the photo") from None
    g = im.save_photo(db, p, view, garment, data, box)
    audit.record(db, cur.user, "implant_photo_upload", "implant_patient", p.id, view=view, garment=garment)
    db.commit()
    return _gen_out(g)


@router.post("/patients/{patient_id}/sessions", status_code=202)
@session_only
def create_session(patient_id: str, body: SessionIn, db: Session = Depends(get_db),
                   cur: CurrentUser = Depends(require_implant)):
    p = _patient(db, cur, patient_id)
    s = im.generate(db, p, [o.model_dump() for o in body.options])
    audit.record(db, cur.user, "implant_generate", "implant_patient", p.id, session=s.id, options=len(body.options))
    db.commit()
    return _patient_out(db, p, full=True)


@router.post("/patients/{patient_id}/sessions/{session_id}/approve")
@session_only
def approve_option(patient_id: str, session_id: str, body: ApproveIn, db: Session = Depends(get_db),
                   cur: CurrentUser = Depends(require_implant)):
    """The option the patient chose: its chart goes into the patient file (an earlier one stays as a version)."""
    p = _patient(db, cur, patient_id)
    s = _session(db, p, session_id)
    if body.option >= len(s.options):
        raise HTTPException(422, "No such option")
    picked = {g.params["implant"]["view"]: g for g in im.results(db, s)
              if g.params["implant"]["option"] == body.option and g.status in ("ready", "approved")}
    if not picked:
        raise HTTPException(409, "That option has no finished pictures yet")
    chart = dict(p.chart or {})
    versions = list(chart.get("versions") or [])
    data = sheets.chart(p, cur.user.display_name or cur.user.email, im.photos(db, p), s.options[body.option],
                        picked, body.notes)
    path = sheets.save_chart(p, data, len(versions) + 1)
    entry = {"session_id": s.id, "option": body.option, "chart_path": path, "approved_at": utcnow().isoformat()}
    p.chart = {**entry, "versions": versions + [entry]}
    if body.notes:
        p.notes = body.notes
    im.touch(p)
    audit.record(db, cur.user, "implant_approve", "implant_patient", p.id, session=s.id, option=body.option)
    db.commit()
    return _patient_out(db, p, full=True)


@router.get("/patients/{patient_id}/chart.pdf")
@session_only
def chart_pdf(patient_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_implant)):
    p = _patient(db, cur, patient_id)
    path = (p.chart or {}).get("chart_path")
    if not path or not (get_settings().data_dir / path).is_file():
        raise HTTPException(404, "No chart yet: approve an option first")
    audit.record(db, cur.user, "implant_chart_download", "implant_patient", p.id)
    db.commit()
    release(db)
    return FileResponse(get_settings().data_dir / path, media_type="application/pdf",
                        filename=f"chart {p.label}.pdf", headers=FILE_HEADERS)


@router.get("/patients/{patient_id}/sessions/{session_id}/consultation.pdf")
@session_only
def consultation_pdf(patient_id: str, session_id: str, db: Session = Depends(get_db),
                     cur: CurrentUser = Depends(require_implant)):
    p = _patient(db, cur, patient_id)
    s = _session(db, p, session_id)
    data = sheets.consultation(p, cur.user.display_name or cur.user.email, im.photos(db, p), s.options,
                               im.results(db, s))
    audit.record(db, cur.user, "implant_pdf_download", "implant_patient", p.id, session=s.id)
    db.commit()
    return Response(data, media_type="application/pdf",
                    headers={**FILE_HEADERS, "Content-Disposition": f'attachment; filename="consultation {p.label}.pdf"'})


@router.get("/files/{gen_id}")
@session_only
def get_file(gen_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_implant)):
    g = db.get(Generation, gen_id)
    if g is None or g.target_type not in ("implant_photo", "implant_result") or not g.file_path:
        raise HTTPException(404, "Not found")
    pid = g.target_id if g.target_type == "implant_photo" else getattr(db.get(ImplantSession, g.target_id),
                                                                       "patient_id", None)
    _patient(db, cur, pid or "")
    root = (get_settings().data_dir / "clinic").resolve()
    path = (get_settings().data_dir / g.file_path).resolve()
    if not path.is_relative_to(root) or not path.is_file():
        raise HTTPException(404, "Not found")
    release(db)
    return FileResponse(path, media_type=g.media_type or "image/png", headers=FILE_HEADERS)
