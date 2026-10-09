"""Photo catalogue: list/filter/sort/facets, marks, metadata, albums, shoots, clients (contract v11)."""
from datetime import date, datetime, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import update
from sqlalchemy.orm import Session

from app import library as lib
from app import organise as org
from app.catalogue import albums as al
from app.catalogue import query as cq
from app.config import get_settings
from app.db import get_db
from app.models import Album, Client, MediaItem
from app.schemas import MediaItemOut
from app.security import CurrentUser, get_current_user, require_editor

router = APIRouter(tags=["photos"])


class PhotoPage(BaseModel):
    items: list[MediaItemOut]
    total: int
    offset: int
    next_offset: int | None = None


class MarksIn(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=al.MAX_BATCH)
    rating: int | None = Field(None, ge=0, le=5)
    flag: Literal["pick", "reject", "none"] | None = None
    label: Literal["red", "yellow", "green", "blue", "purple", "none"] | None = None


class MetadataIn(BaseModel):
    title: str | None = Field(None, max_length=300)
    caption: str | None = Field(None, max_length=4000)
    keywords: list[str] | None = Field(None, max_length=60)


class AlbumIn(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    kind: Literal["folder", "album", "smart", "shoot"] = "album"
    parent_id: str | None = None
    client_id: str | None = None
    shoot_date: str | None = Field(None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    venue: str | None = Field(None, max_length=200)
    notes: str | None = Field(None, max_length=4000)
    rules: dict | None = None
    sort: int | None = None


class AlbumPatch(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=160)
    parent_id: str | None = None
    client_id: str | None = None
    shoot_date: str | None = Field(None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    venue: str | None = Field(None, max_length=200)
    notes: str | None = Field(None, max_length=4000)
    rules: dict | None = None
    cover_id: str | None = None
    sort: int | None = None


class AlbumItemsIn(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=al.MAX_BATCH)
    action: Literal["add", "remove"] = "add"


class OrderIn(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=al.MAX_BATCH)


class ClientIn(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    email: str = Field("", max_length=200)
    phone: str = Field("", max_length=60)
    notes: str = Field("", max_length=4000)


class ClientPatch(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=160)
    email: str | None = Field(None, max_length=200)
    phone: str | None = Field(None, max_length=60)
    notes: str | None = Field(None, max_length=4000)


# ---------------------------------------------------------------- helpers

def _csv(v: str | None) -> list[str]:
    return [x.strip() for x in (v or "").split(",") if x.strip()][:50]


def _day(v: str | None, name: str) -> datetime | None:
    if not v:
        return None
    try:
        return datetime.combine(date.fromisoformat(v[:10]), datetime.min.time())
    except ValueError:
        raise HTTPException(422, f"{name} must be a date like 2026-10-09") from None


def photo_filter(
    q: str | None = Query(None, max_length=200),
    origin: Literal["generated", "upload"] | None = None,
    rating_min: int | None = Query(None, ge=0, le=5),
    rating_max: int | None = Query(None, ge=0, le=5),
    flag: str | None = Query(None, max_length=40, description="comma list of pick, reject, none"),
    label: str | None = Query(None, max_length=60, description="comma list of red..purple, none"),
    camera: str | None = Query(None, max_length=2000),
    lens: str | None = Query(None, max_length=2000),
    keyword: str | None = Query(None, max_length=1000),
    date_from: str | None = None,
    date_to: str | None = Query(None, description="inclusive day"),
    added_from: str | None = None,
    edited: bool | None = None,
    album_id: str | None = None,
    folder_id: str | None = None,
    client_id: str | None = None,
    favourite: bool = False,
    cur: CurrentUser = Depends(get_current_user),
) -> cq.Filter:
    flags, labels = _csv(flag), _csv(label)
    if any(f not in (*cq.FLAGS, "none") for f in flags):
        raise HTTPException(422, "flag takes pick, reject or none")
    if any(x not in (*cq.LABELS, "none") for x in labels):
        raise HTTPException(422, f"label takes {', '.join(cq.LABELS)} or none")
    to = _day(date_to, "date_to")
    # camera and lens names can hold commas ("Canon EOS R5, Mark II" doesn't exist, but be safe): use |
    return cq.Filter(q=q or "", origin=origin, rating_min=rating_min, rating_max=rating_max, flags=flags,
                     labels=labels, cameras=[x for x in (camera or "").split("|") if x],
                     lenses=[x for x in (lens or "").split("|") if x], keywords=_csv(keyword),
                     date_from=_day(date_from, "date_from"), date_to=to + timedelta(days=1) if to else None,
                     added_from=_day(added_from, "added_from"),
                     edited=edited, album_id=album_id, folder_id=folder_id, client_id=client_id,
                     favourite_of=cur.id if favourite else None)


def _owned_photo(db: Session, workspace_id: str, media_id: str) -> MediaItem:
    m = db.get(MediaItem, media_id)
    if m is None or m.workspace_id != workspace_id or m.kind != "image":
        raise HTTPException(404, "Photo not found")
    return m


def _album(db: Session, cur: CurrentUser, album_id: str) -> Album:
    try:
        return al.owned(db, cur.workspace_id, album_id)
    except LookupError as e:
        raise HTTPException(404, str(e)) from None


def _one(db: Session, cur: CurrentUser, album_id: str) -> dict:
    return next(a for a in al.tree(db, cur.workspace_id) if a["id"] == album_id)


# ---------------------------------------------------------------- photos

@router.get("/photos", response_model=PhotoPage)
def list_photos(f: cq.Filter = Depends(photo_filter),
                sort: Literal["taken", "added", "edited", "rating", "name", "size", "manual"] = "taken",
                order: Literal["asc", "desc"] = "desc", offset: int = Query(0, ge=0),
                limit: int = Query(100, ge=1, le=cq.MAX_LIMIT), db: Session = Depends(get_db),
                cur: CurrentUser = Depends(get_current_user)):
    try:
        rows, total = cq.list_photos(db, cur.workspace_id, f, sort=sort, desc=order == "desc", offset=offset,
                                     limit=limit)
    except cq.QueryError as e:
        raise HTTPException(422, str(e)) from None
    items = org.annotate(db, cur.workspace_id, cur.id, lib.items_out(db, rows))
    nxt = offset + len(rows)
    return PhotoPage(items=items, total=total, offset=offset, next_offset=nxt if nxt < total else None)


@router.get("/photos/facets")
def photo_facets(f: cq.Filter = Depends(photo_filter), db: Session = Depends(get_db),
                 cur: CurrentUser = Depends(get_current_user)):
    try:
        return cq.facets(db, cur.workspace_id, f)
    except cq.QueryError as e:
        raise HTTPException(422, str(e)) from None


@router.get("/photos/{media_id}/neighbours")
def neighbours(media_id: str, f: cq.Filter = Depends(photo_filter),
               sort: Literal["taken", "added", "edited", "rating", "name", "size", "manual"] = "taken",
               order: Literal["asc", "desc"] = "desc", db: Session = Depends(get_db),
               cur: CurrentUser = Depends(get_current_user)):
    try:
        return cq.neighbours(db, cur.workspace_id, f, media_id, sort=sort, desc=order == "desc")
    except cq.QueryError as e:
        raise HTTPException(422, str(e)) from None


@router.post("/photos/marks")
def set_marks(body: MarksIn, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    values = {}
    if body.rating is not None:
        values["rating"] = body.rating
    if body.flag is not None:
        values["flag"] = "" if body.flag == "none" else body.flag
    if body.label is not None:
        values["label"] = "" if body.label == "none" else body.label
    if not values:
        raise HTTPException(422, "Send a rating, flag or label")
    n = db.execute(update(MediaItem).where(MediaItem.workspace_id == cur.workspace_id, MediaItem.kind == "image",
                                           MediaItem.id.in_(body.ids)).values(**values)
                   .execution_options(synchronize_session=False)).rowcount
    db.commit()
    return {"updated": n or 0, **{k: v for k, v in values.items()}}


@router.patch("/photos/{media_id}", response_model=MediaItemOut)
def patch_photo(media_id: str, body: MetadataIn, db: Session = Depends(get_db),
                cur: CurrentUser = Depends(require_editor)):
    m = _owned_photo(db, cur.workspace_id, media_id)
    if body.title is not None:
        m.title = body.title.strip()[:300] or m.title
    if body.caption is not None:
        m.caption = body.caption.strip()
    if body.keywords is not None:
        m.tags = lib.clean_tags(body.keywords)
    db.commit()
    return org.annotate(db, cur.workspace_id, cur.id, [lib.item_out(db, m)])[0]


@router.get("/photos/{media_id}/exif")
def photo_exif(media_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(get_current_user)):
    from app.catalogue.exif import shutter_text

    m = _owned_photo(db, cur.workspace_id, media_id)
    return {"captured_at": m.captured_at, "camera": m.camera, "lens": m.lens, "focal_mm": m.focal_mm,
            "aperture": m.aperture, "shutter": shutter_text(m.shutter_s), "iso": m.iso,
            "gps": {"lat": m.gps_lat, "lng": m.gps_lng} if m.gps_lat is not None else None,
            "original_name": m.original_name, "bytes": m.bytes, "source_type": m.source_type,
            "width": m.width, "height": m.height, "tags": m.exif or {}}


@router.get("/photos/{media_id}/source")
def photo_source(media_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(get_current_user)):
    m = _owned_photo(db, cur.workspace_id, media_id)
    path = get_settings().data_dir / m.source_path if m.source_path else None
    if not path or not path.is_file():
        raise HTTPException(404, "This photo has no separate original file")
    name = m.original_name or path.name
    return FileResponse(path, filename=name, media_type="application/octet-stream")


# ---------------------------------------------------------------- albums

@router.get("/albums")
def list_albums(db: Session = Depends(get_db), cur: CurrentUser = Depends(get_current_user)):
    return al.tree(db, cur.workspace_id)


@router.post("/albums", status_code=201)
def create_album(body: AlbumIn, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    try:
        a = al.create(db, cur.workspace_id, body.model_dump(exclude_unset=True) | {"kind": body.kind})
    except LookupError as e:
        raise HTTPException(404, str(e)) from None
    except (al.AlbumError, cq.QueryError) as e:
        raise HTTPException(422, str(e)) from None
    db.commit()
    return _one(db, cur, a.id)


@router.patch("/albums/{album_id}")
def patch_album(album_id: str, body: AlbumPatch, db: Session = Depends(get_db),
                cur: CurrentUser = Depends(require_editor)):
    a = _album(db, cur, album_id)
    try:
        al.update_album(db, cur.workspace_id, a, body.model_dump(exclude_unset=True))
    except LookupError as e:
        raise HTTPException(404, str(e)) from None
    except (al.AlbumError, cq.QueryError) as e:
        raise HTTPException(422, str(e)) from None
    db.commit()
    return _one(db, cur, a.id)


@router.delete("/albums/{album_id}", status_code=204)
def delete_album(album_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    al.delete_album(db, _album(db, cur, album_id))
    db.commit()
    return Response(status_code=204)


@router.post("/albums/{album_id}/items")
def album_items(album_id: str, body: AlbumItemsIn, db: Session = Depends(get_db),
                cur: CurrentUser = Depends(require_editor)):
    a = _album(db, cur, album_id)
    try:
        n = (al.add_items if body.action == "add" else al.remove_items)(db, cur.workspace_id, a, body.ids)
    except al.AlbumError as e:
        raise HTTPException(422, str(e)) from None
    db.commit()
    return {"changed": n, "album": _one(db, cur, a.id)}


@router.post("/albums/{album_id}/order", status_code=204)
def album_order(album_id: str, body: OrderIn, db: Session = Depends(get_db),
                cur: CurrentUser = Depends(require_editor)):
    try:
        al.reorder(db, cur.workspace_id, _album(db, cur, album_id), body.ids)
    except al.AlbumError as e:
        raise HTTPException(422, str(e)) from None
    db.commit()
    return Response(status_code=204)


# ---------------------------------------------------------------- clients

@router.get("/clients")
def list_clients(db: Session = Depends(get_db), cur: CurrentUser = Depends(get_current_user)):
    return al.clients(db, cur.workspace_id)


@router.post("/clients", status_code=201)
def create_client(body: ClientIn, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    c = Client(workspace_id=cur.workspace_id, **{k: v.strip() for k, v in body.model_dump().items()})
    db.add(c)
    db.commit()
    return al.client_out(c)


@router.patch("/clients/{client_id}")
def patch_client(client_id: str, body: ClientPatch, db: Session = Depends(get_db),
                 cur: CurrentUser = Depends(require_editor)):
    try:
        c = al.owned_client(db, cur.workspace_id, client_id)
    except LookupError as e:
        raise HTTPException(404, str(e)) from None
    for k, v in body.model_dump(exclude_unset=True).items():
        if v is not None:
            setattr(c, k, v.strip())
    db.commit()
    return next(x for x in al.clients(db, cur.workspace_id) if x["id"] == c.id)


@router.delete("/clients/{client_id}", status_code=204)
def delete_client(client_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    try:
        c = al.owned_client(db, cur.workspace_id, client_id)
    except LookupError as e:
        raise HTTPException(404, str(e)) from None
    # shoots stay (their photos are the photographer's work); they just lose the client
    db.execute(update(Album).where(Album.client_id == c.id).values(client_id=None))
    db.delete(c)
    db.commit()
    return Response(status_code=204)
