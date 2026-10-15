"""Style references (contract v36 §9): the brand's own adverts, read by the vision model into rules Ad Studio
follows. The `ad_style` job reads each reference in turn (general lane) and merges what it saw."""
import logging

from fastapi import HTTPException
from PIL import Image, ImageOps
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app import brand as br
from app.ads import vision as eye
from app.ads import service as svc
from app.models import BrandKit, Job, utcnow
from app.services import generation_file

log = logging.getLogger("mixai.ads")

JOB = "ad_style"
MAX_REFS = 6


def state(kit: BrandKit) -> dict:
    return dict(kit.ad_style or {})


def put(kit: BrandKit, data: dict) -> None:
    kit.ad_style = {**data, "updated_at": utcnow().isoformat()}
    flag_modified(kit, "ad_style")


def out(db: Session, kit: BrandKit) -> dict:
    from app.services import media_url

    st = state(kit)
    refs = []
    for mid in st.get("references") or []:
        g = br.media_generation(db, kit.workspace_id, mid)
        refs.append({"media_id": mid, "media_url": media_url(g.file_path) if g is not None and g.file_path else None})
    return {"references": refs, "rules": st.get("rules"), "status": st.get("status") or "none",
            "error": st.get("error"), "job_id": st.get("job_id"), "updated_at": st.get("updated_at")}


def queue(db: Session, kit: BrandKit) -> Job:
    job = Job(workspace_id=kit.workspace_id, type=JOB, message="Waiting for a worker · Reading your ads",
              payload={"brand_kit_id": kit.id})
    db.add(job)
    db.flush()
    put(kit, {**state(kit), "status": "working", "error": None, "job_id": job.id})
    return job


def set_references(db: Session, kit: BrandKit, ids: list[str]) -> Job | None:
    ids = list(dict.fromkeys(i for i in ids if i))
    if len(ids) > MAX_REFS:
        raise HTTPException(422, f"Up to {MAX_REFS} reference ads")
    for mid in ids:
        g = br.media_generation(db, kit.workspace_id, mid)
        if g is None or not (g.media_type or "").startswith("image/"):
            raise HTTPException(422, f"Reference {mid} isn't a picture in your library")
    if not ids:
        put(kit, {"references": [], "rules": None, "status": "none", "error": None, "job_id": None})
        return None
    put(kit, {**state(kit), "references": ids})
    return queue(db, kit)


def handle(ctx) -> dict:
    db, job = ctx.db, ctx.job
    kit = db.get(BrandKit, (job.payload or {}).get("brand_kit_id") or "")
    if kit is None or kit.workspace_id != job.workspace_id:
        raise RuntimeError("This brand kit no longer exists")
    refs = list(state(kit).get("references") or [])
    try:
        model = eye.vision_model(svc.writer_model())
        if model is None:
            raise eye.Unavailable("no vision model is installed on the LLM server")
        reads = []
        for i, mid in enumerate(refs):
            ctx.progress(i / max(1, len(refs)), f"Reading ad {i + 1} of {len(refs)}")
            g = br.media_generation(db, kit.workspace_id, mid)
            path = generation_file(g) if g is not None else None
            if path is None or not path.is_file():
                continue
            with Image.open(path) as im:
                img = ImageOps.exif_transpose(im).convert("RGB")
            try:
                reads.append({"media_id": mid, **eye.read_style(img, model, tick=lambda: ctx.progress(i / len(refs)))})
            except eye.Unavailable as e:
                log.warning("couldn't read reference %s: %s", mid, e)
        if not reads:
            raise eye.Unavailable("none of the reference ads could be read")
    except eye.Unavailable as e:
        put(kit, {**state(kit), "status": "failed", "error": str(e)[:300]})
        db.commit()
        raise RuntimeError(f"Reading your ads failed: {e}") from e
    rules = eye.merge(reads)
    rules["per_reference"] = reads
    put(kit, {**state(kit), "rules": rules, "status": "ready", "error": None, "model": model})
    ctx.progress(1.0, "Done")
    return {"brand_kit_id": kit.id, "rules": {k: v for k, v in rules.items() if k != "per_reference"}}
