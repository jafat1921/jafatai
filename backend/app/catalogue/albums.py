"""Albums, album folders, smart albums, shoots and clients (contract v11)."""

from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import Session

from app import thumbs
from app.catalogue import query as cq
from app.models import Album, AlbumItem, Client, Generation, MediaItem, utcnow

KINDS = ("folder", "album", "smart", "shoot")
MAX_DEPTH = 6
MAX_BATCH = 2000


class AlbumError(ValueError):
    pass


def owned(db: Session, workspace_id: str, album_id: str | None) -> Album:
    a = db.get(Album, album_id) if album_id else None
    if a is None or a.workspace_id != workspace_id:
        raise LookupError("That album doesn't exist")
    return a


def owned_client(db: Session, workspace_id: str, client_id: str | None) -> Client:
    c = db.get(Client, client_id) if client_id else None
    if c is None or c.workspace_id != workspace_id:
        raise LookupError("That client doesn't exist")
    return c


def _depth(db: Session, parent_id: str | None) -> int:
    d, cur, seen = 0, parent_id, set()
    while cur and cur not in seen:
        seen.add(cur)
        d += 1
        cur = db.scalar(select(Album.parent_id).where(Album.id == cur))
    return d


def _check_parent(db: Session, workspace_id: str, album: Album | None, parent_id: str | None) -> None:
    if not parent_id:
        return
    parent = owned(db, workspace_id, parent_id)
    if parent.kind != "folder":
        raise AlbumError("Albums can only go inside an album folder")
    if album is not None:
        cur = parent_id
        while cur:
            if cur == album.id:
                raise AlbumError("An album folder can't go inside itself")
            cur = db.scalar(select(Album.parent_id).where(Album.id == cur))
    if _depth(db, parent_id) >= MAX_DEPTH:
        raise AlbumError(f"Album folders nest at most {MAX_DEPTH} deep")


def _covers(db: Session, albums: list[Album]) -> dict[str, str | None]:
    """album id -> thumbnail url: the chosen cover, else the first photo in it."""
    want: dict[str, str] = {a.id: a.cover_id for a in albums if a.cover_id}
    plain = [a.id for a in albums if a.kind in ("album", "shoot") and not a.cover_id]
    if plain:
        first = select(AlbumItem.album_id, func.min(AlbumItem.position).label("p")).where(
            AlbumItem.album_id.in_(plain)).group_by(AlbumItem.album_id).subquery()
        for aid, mid in db.execute(select(AlbumItem.album_id, AlbumItem.media_id).join(
                first, (first.c.album_id == AlbumItem.album_id) & (first.c.p == AlbumItem.position))):
            want.setdefault(aid, mid)
    if not want:
        return {}
    gens = dict(db.execute(select(MediaItem.id, MediaItem.generation_id).where(MediaItem.id.in_(set(want.values())))).all())
    gmap = {g.id: g for g in db.scalars(select(Generation).where(Generation.id.in_([g for g in gens.values() if g])))}
    return {aid: thumbs.url_for(gmap.get(gens.get(mid))) for aid, mid in want.items()}


def album_out(a: Album, count: int, cover: str | None, client: str | None = None) -> dict:
    return {"id": a.id, "name": a.name, "kind": a.kind, "parent_id": a.parent_id, "client_id": a.client_id,
            "client_name": client, "shoot_date": a.shoot_date, "venue": a.venue, "notes": a.notes,
            "rules": a.rules, "cover_id": a.cover_id, "cover_url": cover, "sort": a.sort, "count": count,
            "created_at": a.created_at, "updated_at": a.updated_at}


def tree(db: Session, workspace_id: str) -> list[dict]:
    albums = list(db.scalars(select(Album).where(Album.workspace_id == workspace_id)
                             .order_by(Album.sort, func.lower(Album.name))))
    counts = dict(db.execute(select(AlbumItem.album_id, func.count()).where(AlbumItem.workspace_id == workspace_id)
                             .group_by(AlbumItem.album_id)).all())
    for a in albums:
        if a.kind == "smart":
            try:
                counts[a.id] = db.scalar(select(func.count()).select_from(MediaItem).where(
                    *cq.scope_clauses(db, workspace_id, cq.Filter(album_id=a.id)))) or 0
            except cq.QueryError:
                counts[a.id] = 0
        elif a.kind == "folder":
            ids = cq.descendant_albums(db, workspace_id, a.id)
            counts[a.id] = db.scalar(select(func.count(func.distinct(AlbumItem.media_id)))
                                     .where(AlbumItem.album_id.in_(ids or [""]))) or 0
    covers = _covers(db, albums)
    clients = dict(db.execute(select(Client.id, Client.name).where(Client.workspace_id == workspace_id)).all())
    return [album_out(a, counts.get(a.id, 0), covers.get(a.id), clients.get(a.client_id)) for a in albums]


def create(db: Session, workspace_id: str, data: dict) -> Album:
    kind = data.get("kind") or "album"
    if kind not in KINDS:
        raise AlbumError(f"kind must be one of {', '.join(KINDS)}")
    _check_parent(db, workspace_id, None, data.get("parent_id"))
    a = Album(workspace_id=workspace_id, kind=kind, name=data["name"].strip()[:160], parent_id=data.get("parent_id"))
    _apply(db, workspace_id, a, data)
    db.add(a)
    db.flush()
    return a


def _apply(db: Session, workspace_id: str, a: Album, data: dict) -> None:
    if "name" in data and data["name"] is not None:
        a.name = data["name"].strip()[:160] or a.name
    if "client_id" in data:
        if data["client_id"] and a.kind != "shoot":
            raise AlbumError("Only shoots belong to a client")
        a.client_id = owned_client(db, workspace_id, data["client_id"]).id if data["client_id"] else None
    for k in ("shoot_date", "venue", "notes"):
        if k in data and data[k] is not None:
            setattr(a, k, data[k])
    if "rules" in data:
        if a.kind != "smart":
            if data["rules"]:
                raise AlbumError("Only smart albums have rules")
        else:
            a.rules = cq.validate_rules(data["rules"] or {})
    if "cover_id" in data:
        a.cover_id = data["cover_id"] or None
    if "sort" in data and data["sort"] is not None:
        a.sort = int(data["sort"])
    if a.kind == "smart" and not a.rules:
        raise AlbumError("A smart album needs rules")


def update_album(db: Session, workspace_id: str, a: Album, data: dict) -> Album:
    if "parent_id" in data:
        _check_parent(db, workspace_id, a, data["parent_id"])
        a.parent_id = data["parent_id"] or None
    _apply(db, workspace_id, a, data)
    a.updated_at = utcnow()
    return a


def delete_album(db: Session, a: Album) -> None:
    # a folder hands its contents to its own parent, like Library folders do; photos are never deleted
    db.execute(update(Album).where(Album.parent_id == a.id).values(parent_id=a.parent_id))
    db.delete(a)


def _media_ids(db: Session, workspace_id: str, ids: list[str]) -> list[str]:
    if len(ids) > MAX_BATCH:
        raise AlbumError(f"At most {MAX_BATCH} photos at a time")
    found = set(db.scalars(select(MediaItem.id).where(MediaItem.workspace_id == workspace_id, MediaItem.id.in_(ids))))
    return [i for i in dict.fromkeys(ids) if i in found]


def _writable(a: Album) -> None:
    if a.kind not in ("album", "shoot"):
        raise AlbumError("Smart albums and album folders fill themselves; add photos to an album or shoot")


def add_items(db: Session, workspace_id: str, a: Album, ids: list[str]) -> int:
    _writable(a)
    ids = _media_ids(db, workspace_id, ids)
    have = set(db.scalars(select(AlbumItem.media_id).where(AlbumItem.album_id == a.id, AlbumItem.media_id.in_(ids))))
    pos = db.scalar(select(func.max(AlbumItem.position)).where(AlbumItem.album_id == a.id)) or 0
    added = 0
    for mid in ids:
        if mid in have:
            continue
        pos += 1
        added += 1
        db.add(AlbumItem(workspace_id=workspace_id, album_id=a.id, media_id=mid, position=pos))
    a.updated_at = utcnow()
    return added


def remove_items(db: Session, workspace_id: str, a: Album, ids: list[str]) -> int:
    _writable(a)
    n = db.execute(delete(AlbumItem).where(AlbumItem.album_id == a.id, AlbumItem.media_id.in_(ids))).rowcount
    if a.cover_id in ids:
        a.cover_id = None
    a.updated_at = utcnow()
    return n or 0


def reorder(db: Session, workspace_id: str, a: Album, ids: list[str]) -> None:
    """ids in their new order; photos left out keep their relative order after them."""
    _writable(a)
    rows = {r.media_id: r for r in db.scalars(select(AlbumItem).where(AlbumItem.album_id == a.id))}
    rest = sorted((r for m, r in rows.items() if m not in set(ids)), key=lambda r: r.position)
    order = [rows[m] for m in dict.fromkeys(ids) if m in rows] + rest
    for i, r in enumerate(order, 1):
        r.position = i


def memberships(db: Session, ids: list[str]) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    if ids:
        for mid, aid in db.execute(select(AlbumItem.media_id, AlbumItem.album_id).where(AlbumItem.media_id.in_(ids))):
            out.setdefault(mid, []).append(aid)
    return out


# ---------------------------------------------------------------- clients

def client_out(c: Client, shoots: int = 0, photos: int = 0) -> dict:
    return {"id": c.id, "name": c.name, "email": c.email, "phone": c.phone, "notes": c.notes,
            "shoots": shoots, "photos": photos, "created_at": c.created_at, "updated_at": c.updated_at}


def clients(db: Session, workspace_id: str) -> list[dict]:
    rows = list(db.scalars(select(Client).where(Client.workspace_id == workspace_id).order_by(func.lower(Client.name))))
    shoots = dict(db.execute(select(Album.client_id, func.count()).where(Album.workspace_id == workspace_id,
                                                                         Album.client_id.is_not(None))
                             .group_by(Album.client_id)).all())
    photos = dict(db.execute(select(Album.client_id, func.count(func.distinct(AlbumItem.media_id)))
                             .join(AlbumItem, AlbumItem.album_id == Album.id)
                             .where(Album.workspace_id == workspace_id, Album.client_id.is_not(None))
                             .group_by(Album.client_id)).all())
    return [client_out(c, shoots.get(c.id, 0), photos.get(c.id, 0)) for c in rows]
