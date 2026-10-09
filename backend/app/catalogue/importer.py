"""Storing one upload as a catalogue photo: duplicate check, working copy, EXIF columns, album."""
import uuid
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import thumbs, uploads
from app.catalogue import convert, exif as ex
from app.models import Album, AlbumItem, Generation, MediaItem, new_id, utcnow


def apply_exif(item: MediaItem, e: ex.Exif) -> None:
    item.captured_at = e.captured_at
    item.camera = e.camera[:120] if e.camera else None
    item.lens = e.lens[:160] if e.lens else None
    item.focal_mm, item.aperture, item.shutter_s, item.iso = e.focal_mm, e.aperture, e.shutter_s, e.iso
    item.gps_lat, item.gps_lng = e.gps_lat, e.gps_lng
    item.exif = e.raw or None


def duplicate_of(db: Session, workspace_id: str, sha256: str | None) -> MediaItem | None:
    if not sha256:
        return None
    return db.scalars(select(MediaItem).where(MediaItem.workspace_id == workspace_id,
                                              MediaItem.content_hash == sha256).limit(1)).first()


def target_album(db: Session, workspace_id: str, album_id: str | None) -> Album | None:
    if not album_id:
        return None
    album = db.get(Album, album_id)
    if album is None or album.workspace_id != workspace_id:
        raise HTTPException(404, "That album doesn't exist")
    if album.kind not in ("album", "shoot"):
        raise HTTPException(422, "Photos can only be imported into an album or a shoot")
    return album


def add_to_album(db: Session, album: Album, item: MediaItem) -> None:
    if db.scalars(select(AlbumItem.id).where(AlbumItem.album_id == album.id, AlbumItem.media_id == item.id)).first():
        return
    last = db.scalars(select(AlbumItem.position).where(AlbumItem.album_id == album.id)
                      .order_by(AlbumItem.position.desc()).limit(1)).first()
    db.add(AlbumItem(workspace_id=album.workspace_id, album_id=album.id, media_id=item.id,
                     position=(last or 0) + 1))
    album.updated_at = utcnow()


def store(db: Session, workspace_id: str, user_id: str, got: uploads.Received, folder: Path,
          rel_folder: str) -> tuple[MediaItem, bool]:
    """(item, was_duplicate). Only the Photos import asks for on_duplicate=skip; other uploads (references,
    Image studio sources) have always made a new item each time and still do."""
    album = target_album(db, workspace_id, got.fields.get("album_id"))
    skip = got.fields.get("on_duplicate") == "skip"
    dup = duplicate_of(db, workspace_id, got.sha256) if skip else None
    if dup is not None:
        got.path.unlink(missing_ok=True)
        if album is not None:
            add_to_album(db, album, dup)
            db.commit()
        return dup, True

    name = uuid.uuid4().hex
    kind = "image" if got.media_type.startswith("image/") else "video"
    meta = ex.read(got.path) if kind == "image" else ex.Exif()
    source_rel = source_type = None
    if got.media_type in uploads.CONVERTED:
        ext = Path(got.filename).suffix.lower() or ".bin"
        source = folder / f"{name}.source{ext}"
        got.path.replace(source)
        try:
            w = convert.working_copy(source, got.media_type, folder / f"{name}.jpg", meta)
        except convert.ConvertError as e:
            source.unlink(missing_ok=True)
            raise HTTPException(415, str(e)) from None
        final, media_type = w.path, "image/jpeg"
        info = uploads.MediaInfo(w.width, w.height)
        source_rel, source_type = f"{rel_folder}/{source.name}", got.media_type
    else:
        info = uploads.probe_image(got.path, got.media_type) if kind == "image" else uploads.probe_video(got.path)
        final = folder / f"{name}{uploads.EXT[got.media_type]}"
        got.path.replace(final)
        media_type = got.media_type
    # the grid asks for this straight away; a 40 MB upload shouldn't be what it gets
    thumbs.ensure_all(final, media_type)

    title = (got.title or Path(got.filename).stem or "Upload")[:300]
    item = MediaItem(id=new_id(), workspace_id=workspace_id, kind=kind, origin="upload", title=title, tags=[],
                     width=info.width, height=info.height, duration_s=info.duration_s,
                     original_name=got.filename[:300] or None, bytes=got.size, content_hash=got.sha256,
                     source_path=source_rel, source_type=source_type)
    if kind == "image":
        apply_exif(item, meta)
    params = {"original_name": got.filename[:300], "bytes": got.size, "size": [info.width, info.height],
              "created_by": {"user_id": user_id, "flow": "upload"}}
    if source_rel:
        params.update(source_file=source_rel, source_type=source_type)
    if kind == "video":
        params.update(duration_s=info.duration_s, fps=info.fps, has_audio=info.has_audio)
    g = Generation(workspace_id=workspace_id, project_id=None, target_type="media", target_id=item.id,
                   kind="upload", version=1, status="ready", prompt="", params=params, seed=0,
                   file_path=f"{rel_folder}/{final.name}", media_type=media_type)
    db.add(item)
    db.add(g)
    db.flush()
    item.generation_id = g.id
    if album is not None:
        add_to_album(db, album, item)
    db.commit()
    return item, False
