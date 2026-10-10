"""Audio editor and Score a Clip glue (contract v15): sources, new versions and the two CPU jobs.

An edit becomes a new version of the same Library item, the way Photo Studio develops do: a Generation
whose parent is the source version, made by an `audio_render` job; the item moves to it when the job
finishes (app.library.on_job_finished). A mix is the same thing on the video item (`audio_mix`).
"""
import time

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app import audio_analysis as aa
from app import audio_edit as ae
from app import library as lib
from app import mixdown as md
from app.models import Generation, Job, MediaItem, new_id
from app.services import generation_file, media_url, new_seed, next_version


RENDER_JOB = "audio_render"
MIX_JOB = "audio_mix"
FINISHED = ("ready", "approved")
# what a video version keeps from the one it was mixed from: the picture is the same
VIDEO_KEEP = ("size", "fps", "duration_s", "aspect")


class AudioJobError(RuntimeError):
    pass


# ---------------------------------------------------------------- sources

def _item(db: Session, workspace_id: str, item_id: str, label: str) -> MediaItem:
    item = db.get(MediaItem, item_id) if item_id else None
    # same 404 for missing and someone else's
    if item is None or item.workspace_id != workspace_id:
        raise HTTPException(404, f"{label} not found")
    return item


def _version(db: Session, item: MediaItem, version: str | None) -> Generation:
    g = db.get(Generation, version or item.generation_id or "")
    if g is None or g.target_type != "media" or g.target_id != item.id:
        raise HTTPException(404, "That version isn't part of this item")
    return g


def _usable(g: Generation, prefix: str, what: str) -> None:
    if not (g.media_type or "").startswith(prefix):
        raise HTTPException(422, f"This isn't {what}")
    if g.status not in FINISHED or not g.file_path:
        raise HTTPException(409, f"This {what.split()[-1]} isn't finished yet ({g.status})")
    path = generation_file(g)
    if path is None or not path.is_file():
        raise HTTPException(422, f"This {what.split()[-1]}'s file is missing")


def audio_source(db: Session, workspace_id: str, item_id: str, version: str | None = None
                 ) -> tuple[MediaItem, Generation]:
    item = _item(db, workspace_id, item_id, "Audio")
    if item.kind != "audio":
        raise HTTPException(422, "This item isn't audio")
    g = _version(db, item, version)
    _usable(g, "audio/", "an audio clip")
    return item, g


def audio_ref(db: Session, workspace_id: str, item_id: str, what: str) -> Generation:
    """The current version of another audio item (append, mix tracks), checked the same way."""
    try:
        return audio_source(db, workspace_id, item_id)[1]
    except HTTPException as e:
        raise HTTPException(e.status_code, f"{what}: {e.detail}") from None


def video_source(db: Session, workspace_id: str, item_id: str) -> tuple[MediaItem, Generation]:
    item = _item(db, workspace_id, item_id, "Video")
    if item.kind != "video":
        raise HTTPException(422, "Score a Clip needs a video")
    g = _version(db, item, None)
    _usable(g, "video/", "a video")
    return item, g


def mix_tracks(db: Session, workspace_id: str, specs: list[dict]) -> list[md.Track]:
    out = []
    for n, s in enumerate(specs, start=1):
        g = audio_ref(db, workspace_id, s["media_id"], f"Track {n}")
        item = db.get(MediaItem, s["media_id"])
        path = generation_file(g)
        out.append(md.Track(path, aa.stream_info(path), s, md.safe_stem(item.title if item else "", "track")))
    return out


# ---------------------------------------------------------------- queueing

def _new_version(db: Session, item: MediaItem, source: Generation, kind: str, params: dict, job_type: str,
                 payload: dict, message: str, note: str | None) -> Job:
    g = Generation(id=new_id(), workspace_id=source.workspace_id, project_id=None, target_type="media",
                   target_id=item.id, kind=kind, version=next_version(db, "media", item.id, kind), status="queued",
                   prompt=source.prompt or "", seed=new_seed(), parent_id=source.id, note=note, params=params)
    db.add(g)
    db.flush()
    job = Job(workspace_id=source.workspace_id, type=job_type, generation_id=g.id, message=message,
              payload={"generation_id": g.id, "source_id": source.id, **payload})
    db.add(job)
    db.flush()
    g.job_id = job.id
    lib.touch(item)
    return job


def queue_render(db: Session, item: MediaItem, source: Generation, edit: dict, note: str | None,
                 user_id: str | None) -> Job:
    edit = ae.normalise(edit)
    # pinned to the versions current now, so a later edit of an appended item doesn't change this one
    appends = [audio_ref(db, item.workspace_id, i, "Append").id for i in edit["append"]]
    params = {"edit": edit, "source_id": source.id, "created_by": {"user_id": user_id, "flow": "audio_edit"}}
    return _new_version(db, item, source, "audio", params, RENDER_JOB, {"append": appends},
                        "Waiting for a worker · Edit", note)


def queue_mix(db: Session, item: MediaItem, source: Generation, mix: dict, stems: bool, note: str | None,
              user_id: str | None) -> Job:
    tracks = [audio_ref(db, item.workspace_id, t["media_id"], f"Track {n}").id
              for n, t in enumerate(mix["tracks"], start=1)]
    keep = {k: v for k, v in (source.params or {}).items() if k in VIDEO_KEEP}
    params = {**keep, "has_audio": True, "mix": mix, "source_id": source.id, "stems": stems,
              "created_by": {"user_id": user_id, "flow": "score_clip"}}
    return _new_version(db, item, source, "video", params, MIX_JOB, {"tracks": tracks, "stems": stems},
                        "Waiting for a worker · Score", note)


# ---------------------------------------------------------------- jobs

def _gen_file(db: Session, gen_id: str, what: str):
    g = db.get(Generation, gen_id or "")
    path = generation_file(g) if g is not None else None
    if path is None or not path.is_file():
        raise AudioJobError(f"{what} is gone")
    return g, path


def _start(ctx) -> Generation:
    gen = ctx.db.get(Generation, ctx.job.generation_id) if ctx.job.generation_id else None
    if gen is None:
        raise AudioJobError("The new version's record no longer exists")
    gen.status = "generating"
    ctx.db.commit()
    return gen


def handle_render(ctx) -> dict:
    db, job = ctx.db, ctx.job
    gen = _start(ctx)
    payload = job.payload or {}
    _, src = _gen_file(db, payload.get("source_id"), "The source audio")
    appends = [_gen_file(db, i, "An appended clip")[1] for i in payload.get("append") or []]
    edit = (gen.params or {}).get("edit") or {}
    folder, rel_folder = lib.media_dir(gen.workspace_id)
    folder.mkdir(parents=True, exist_ok=True)
    dst = folder / f"{gen.id}.flac"
    part = folder / f".{gen.id}.part.flac"
    t0 = time.monotonic()
    ctx.progress(0.05, "Measuring loudness" if edit.get("loudness") else "Rendering the edit")
    try:
        info = ae.render(edit, src, part, ae.FORMATS["flac"][0], appends,
                         tick=lambda: ctx.progress(0.5, "Rendering the edit"))
        ctx.progress(0.95, "Saving")
        part.replace(dst)
    finally:
        part.unlink(missing_ok=True)
    db.refresh(gen)
    rel = f"{rel_folder}/{dst.name}"
    gen.params = {**(gen.params or {}), "duration_s": info["duration_s"]}
    gen.file_path, gen.media_type, gen.status = rel, "audio/flac", "ready"
    return {"file_path": rel, "media_type": "audio/flac", "duration_s": info["duration_s"],
            "bytes": dst.stat().st_size, "seconds": round(time.monotonic() - t0, 3)}


def handle_mix(ctx) -> dict:
    db, job = ctx.db, ctx.job
    gen = _start(ctx)
    payload = job.payload or {}
    _, video = _gen_file(db, payload.get("source_id"), "The source video")
    mix = (gen.params or {}).get("mix") or {}
    specs = mix.get("tracks") or []
    tracks = []
    for n, (gid, spec) in enumerate(zip(payload.get("tracks") or [], specs), start=1):
        _, path = _gen_file(db, gid, f"Track {n}")
        item = db.get(MediaItem, spec.get("media_id") or "")
        tracks.append(md.Track(path, aa.stream_info(path), spec, md.safe_stem(item.title if item else "", "track")))
    folder, rel_folder = lib.media_dir(gen.workspace_id)
    folder.mkdir(parents=True, exist_ok=True)
    dst = folder / f"{gen.id}.mp4"
    part = folder / f".{gen.id}.part.mp4"
    zip_path = folder / f"{gen.id}.stems.zip" if payload.get("stems") else None
    t0 = time.monotonic()
    ctx.progress(0.05, "Measuring loudness" if mix.get("loudness") else "Mixing")
    try:
        info = md.render(mix, video, tracks, part, stems_zip=zip_path,
                         tick=lambda: ctx.progress(0.5, "Mixing the soundtrack"))
        ctx.progress(0.95, "Saving")
        part.replace(dst)
    finally:
        part.unlink(missing_ok=True)
    db.refresh(gen)
    rel = f"{rel_folder}/{dst.name}"
    gen.file_path, gen.media_type, gen.status = rel, "video/mp4", "ready"
    out = {"file_path": rel, "media_type": "video/mp4", "duration_s": info["duration_s"], "ducked": info["ducked"],
           "bytes": dst.stat().st_size, "seconds": round(time.monotonic() - t0, 3)}
    if zip_path is not None and zip_path.is_file():
        out["stems"] = media_url(f"{rel_folder}/{zip_path.name}")
        out["stems_tracks"] = info.get("stems") or []
    return out
