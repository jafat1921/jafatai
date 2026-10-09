"""Catalogue queries: the filter bar, sort orders, facet counts and smart-album rules (contract v11).

Everything here is image MediaItems (uploads + generated stills). Project frames stay in the general
Library; they have no files of their own to rate or file into albums.
"""
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from sqlalchemy import String, and_, case, cast, exists, false, func, or_, select, true
from sqlalchemy.orm import Session

from app.models import Album, AlbumItem, Favourite, Generation, MediaItem, utcnow

FLAGS = ("pick", "reject")
LABELS = ("red", "yellow", "green", "blue", "purple")
SORTS = ("taken", "added", "edited", "rating", "name", "size", "manual")
MAX_LIMIT = 200
TAKEN = func.coalesce(MediaItem.captured_at, MediaItem.created_at)


class QueryError(ValueError):
    pass


@dataclass
class Filter:
    q: str = ""
    origin: str | None = None
    rating_min: int | None = None
    rating_max: int | None = None
    flags: list[str] = field(default_factory=list)  # pick | reject | none
    labels: list[str] = field(default_factory=list)  # red .. purple | none
    cameras: list[str] = field(default_factory=list)
    lenses: list[str] = field(default_factory=list)
    keywords: list[str] = field(default_factory=list)  # all must match
    date_from: datetime | None = None
    date_to: datetime | None = None
    added_from: datetime | None = None
    edited: bool | None = None
    album_id: str | None = None
    folder_id: str | None = None
    client_id: str | None = None
    favourite_of: str | None = None  # user id


def edited_clause():
    return exists().where(Generation.target_type == "media", Generation.target_id == MediaItem.id,
                          Generation.version > 1, Generation.status.in_(("ready", "approved")))


def _kw(word: str):
    from app.library import clean_tags

    t = (clean_tags([word]) or [word.lower()])[0]
    return cast(MediaItem.tags, String).like(f'%"{t}"%')


def _in_album(album_id: str):
    return exists().where(AlbumItem.media_id == MediaItem.id, AlbumItem.album_id == album_id)


def scope_clauses(db: Session, workspace_id: str, f: Filter, *, skip: tuple[str, ...] = ()) -> list:
    """WHERE parts for a filter. `skip` leaves facets out so each facet counts the others' result."""
    c = [MediaItem.workspace_id == workspace_id, MediaItem.kind == "image"]
    if f.origin:
        c.append(MediaItem.origin == f.origin)
    if f.q.strip():
        like = f"%{f.q.strip().lower()}%"
        c.append(or_(func.lower(MediaItem.title).like(like), func.lower(MediaItem.caption).like(like),
                     func.lower(cast(MediaItem.tags, String)).like(like), func.lower(MediaItem.camera).like(like),
                     func.lower(MediaItem.original_name).like(like)))
    if f.album_id:
        album = db.get(Album, f.album_id)
        if album is None or album.workspace_id != workspace_id:
            raise QueryError("That album doesn't exist")
        if album.kind == "smart":
            c.append(rules_clause(db, workspace_id, album.rules or {}, depth=1))
        elif album.kind == "folder":
            ids = descendant_albums(db, workspace_id, album.id)
            c.append(exists().where(AlbumItem.media_id == MediaItem.id, AlbumItem.album_id.in_(ids or [""])))
        else:
            c.append(_in_album(album.id))
    if f.client_id:
        shoots = select(Album.id).where(Album.workspace_id == workspace_id, Album.client_id == f.client_id)
        c.append(exists().where(AlbumItem.media_id == MediaItem.id, AlbumItem.album_id.in_(shoots)))
    if f.folder_id:
        c.append(MediaItem.folder_id == f.folder_id)
    if f.favourite_of:
        c.append(exists().where(Favourite.user_id == f.favourite_of, Favourite.media_ref == MediaItem.id))
    if "rating" not in skip:
        if f.rating_min is not None:
            c.append(MediaItem.rating >= f.rating_min)
        if f.rating_max is not None:
            c.append(MediaItem.rating <= f.rating_max)
    if f.flags and "flag" not in skip:
        c.append(MediaItem.flag.in_([x if x != "none" else "" for x in f.flags]))
    if f.labels and "label" not in skip:
        c.append(MediaItem.label.in_([x if x != "none" else "" for x in f.labels]))
    if f.cameras and "camera" not in skip:
        c.append(MediaItem.camera.in_(f.cameras))
    if f.lenses and "lens" not in skip:
        c.append(MediaItem.lens.in_(f.lenses))
    if f.keywords and "keyword" not in skip:
        c.extend(_kw(k) for k in f.keywords)
    if "date" not in skip:
        if f.date_from:
            c.append(TAKEN >= f.date_from)
        if f.date_to:
            c.append(TAKEN < f.date_to)
    if f.added_from:
        c.append(MediaItem.created_at >= f.added_from)
    if f.edited is not None and "edited" not in skip:
        c.append(edited_clause() if f.edited else ~edited_clause())
    return c


def descendant_albums(db: Session, workspace_id: str, folder_id: str) -> list[str]:
    rows = db.execute(select(Album.id, Album.parent_id, Album.kind).where(Album.workspace_id == workspace_id)).all()
    kids: dict[str | None, list] = {}
    for r in rows:
        kids.setdefault(r.parent_id, []).append(r)
    out, todo = [], [folder_id]
    while todo:
        for r in kids.get(todo.pop(), []):
            if r.kind in ("album", "shoot"):
                out.append(r.id)
            todo.append(r.id)
    return out


# ---------------------------------------------------------------- smart albums

RULE_FIELDS = {
    "rating": ("=", "!=", ">=", "<="), "flag": ("=", "!="), "label": ("=", "!="),
    "camera": ("=", "contains"), "lens": ("=", "contains"), "keyword": ("has", "lacks"),
    "text": ("contains",), "captured": ("in_last_days", "before", "after"), "origin": ("=",),
    "edited": ("=",), "album": ("in", "not_in"), "iso": (">=", "<="), "focal": (">=", "<="),
    "aperture": (">=", "<="),
}


def validate_rules(rules: dict) -> dict:
    if not isinstance(rules, dict):
        raise QueryError("Smart album rules must be an object")
    match = rules.get("match", "all")
    items = rules.get("rules") or []
    if match not in ("all", "any"):
        raise QueryError("match must be 'all' or 'any'")
    if not isinstance(items, list) or not 1 <= len(items) <= 20:
        raise QueryError("A smart album needs 1 to 20 rules")
    clean = []
    for r in items:
        fld, op = (r or {}).get("field"), (r or {}).get("op")
        if fld not in RULE_FIELDS:
            raise QueryError(f"Unknown rule field '{fld}'")
        if op not in RULE_FIELDS[fld]:
            raise QueryError(f"'{fld}' rules use {', '.join(RULE_FIELDS[fld])}, not '{op}'")
        clean.append({"field": fld, "op": op, "value": r.get("value")})
    return {"match": match, "rules": clean}


def _num(v, name: str) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        raise QueryError(f"'{name}' needs a number") from None


def _rule(db: Session, workspace_id: str, r: dict, depth: int):
    fld, op, v = r["field"], r["op"], r.get("value")
    if fld in ("rating", "iso", "focal", "aperture"):
        col = {"rating": MediaItem.rating, "iso": MediaItem.iso, "focal": MediaItem.focal_mm,
               "aperture": MediaItem.aperture}[fld]
        n = _num(v, fld)
        return {"=": col == n, "!=": col != n, ">=": col >= n, "<=": col <= n}[op]
    if fld in ("flag", "label"):
        col = MediaItem.flag if fld == "flag" else MediaItem.label
        val = "" if v in (None, "none") else str(v)
        return col == val if op == "=" else col != val
    if fld in ("camera", "lens"):
        col = MediaItem.camera if fld == "camera" else MediaItem.lens
        s = str(v or "")
        return col == s if op == "=" else func.lower(col).like(f"%{s.lower()}%")
    if fld == "keyword":
        return _kw(str(v or "")) if op == "has" else ~_kw(str(v or ""))
    if fld == "text":
        like = f"%{str(v or '').lower()}%"
        return or_(func.lower(MediaItem.title).like(like), func.lower(MediaItem.caption).like(like))
    if fld == "captured":
        if op == "in_last_days":
            return TAKEN >= utcnow() - timedelta(days=_num(v, "days"))
        try:
            at = datetime.fromisoformat(str(v))
        except ValueError:
            raise QueryError("captured before/after needs a date like 2026-10-09") from None
        return TAKEN < at if op == "before" else TAKEN >= at
    if fld == "origin":
        return MediaItem.origin == str(v)
    if fld == "edited":
        return edited_clause() if v in (True, "true", 1) else ~edited_clause()
    if fld == "album":
        album = db.get(Album, str(v or ""))
        if album is None or album.workspace_id != workspace_id:
            return false() if op == "in" else true()
        if album.kind == "smart":
            if depth >= 3:
                raise QueryError("Smart albums can only refer to each other 3 levels deep")
            inner = rules_clause(db, workspace_id, album.rules or {}, depth + 1)
        else:
            inner = _in_album(album.id)
        return inner if op == "in" else ~inner
    raise QueryError(f"Unknown rule field '{fld}'")


def rules_clause(db: Session, workspace_id: str, rules: dict, depth: int = 0):
    rules = validate_rules(rules)
    parts = [_rule(db, workspace_id, r, depth) for r in rules["rules"]]
    return and_(*parts) if rules["match"] == "all" else or_(*parts)


# ---------------------------------------------------------------- listing

def order_by(sort: str, desc: bool, album_id: str | None):
    if sort not in SORTS:
        raise QueryError(f"sort must be one of {', '.join(SORTS)}")
    if sort == "manual":
        if not album_id:
            raise QueryError("Manual order only exists inside an album")
        pos = select(AlbumItem.position).where(AlbumItem.album_id == album_id,
                                               AlbumItem.media_id == MediaItem.id).scalar_subquery()
        return [pos.asc(), MediaItem.id]
    col = {"taken": TAKEN, "added": MediaItem.created_at, "edited": MediaItem.updated_at,
           "rating": MediaItem.rating, "name": func.lower(MediaItem.title), "size": MediaItem.bytes}[sort]
    first = col.desc() if desc else col.asc()
    # ties (same rating, same second) keep capture order so the grid doesn't shuffle on refresh
    return [first, TAKEN.desc(), MediaItem.id.desc()]


def list_photos(db: Session, workspace_id: str, f: Filter, *, sort: str = "taken", desc: bool = True,
                offset: int = 0, limit: int = 100) -> tuple[list[MediaItem], int]:
    limit = max(1, min(MAX_LIMIT, limit))
    where = scope_clauses(db, workspace_id, f)
    total = db.scalar(select(func.count()).select_from(MediaItem).where(*where)) or 0
    rows = db.scalars(select(MediaItem).where(*where).order_by(*order_by(sort, desc, f.album_id))
                      .offset(max(0, offset)).limit(limit)).all()
    return list(rows), total


def neighbours(db: Session, workspace_id: str, f: Filter, media_id: str, *, sort: str = "taken",
               desc: bool = True, window: int = 60) -> dict:
    """Ids around one photo in the current source, for Develop's filmstrip and next/previous."""
    where = scope_clauses(db, workspace_id, f)
    ids = list(db.scalars(select(MediaItem.id).where(*where).order_by(*order_by(sort, desc, f.album_id))
                          .limit(5000)))
    if media_id not in ids:
        return {"ids": ids[:window], "index": None, "total": len(ids)}
    i = ids.index(media_id)
    lo = max(0, i - window // 2)
    return {"ids": ids[lo:lo + window], "index": i - lo, "position": i + 1, "total": len(ids),
            "prev": ids[i - 1] if i > 0 else None, "next": ids[i + 1] if i + 1 < len(ids) else None}


# ---------------------------------------------------------------- facets

def facets(db: Session, workspace_id: str, f: Filter) -> dict:
    def grouped(col, skip: str, top: int | None = None):
        where = scope_clauses(db, workspace_id, f, skip=(skip,))
        q = select(col, func.count()).where(*where).group_by(col).order_by(func.count().desc())
        if top:
            q = q.limit(top)
        return db.execute(q).all()

    out = {
        "flag": {(k or "none"): n for k, n in grouped(MediaItem.flag, "flag")},
        "rating": {str(k): n for k, n in grouped(MediaItem.rating, "rating")},
        "label": {(k or "none"): n for k, n in grouped(MediaItem.label, "label")},
        "camera": [{"value": k, "count": n} for k, n in grouped(MediaItem.camera, "camera", 40) if k],
        "lens": [{"value": k, "count": n} for k, n in grouped(MediaItem.lens, "lens", 40) if k],
    }
    where = scope_clauses(db, workspace_id, f, skip=("keyword",))
    counts: dict[str, int] = {}
    for tags in db.scalars(select(MediaItem.tags).where(*where).limit(20000)):
        for t in tags or []:
            counts[t] = counts.get(t, 0) + 1
    out["keyword"] = [{"value": k, "count": n} for k, n in sorted(counts.items(), key=lambda x: (-x[1], x[0]))[:80]]
    where = scope_clauses(db, workspace_id, f, skip=("date",))
    year = func.strftime("%Y-%m", TAKEN)
    months: dict[str, dict[str, int]] = {}
    for ym, n in db.execute(select(year, func.count()).where(*where).group_by(year)).all():
        if ym:
            months.setdefault(ym[:4], {})[ym[5:7]] = n
    out["date"] = [{"year": y, "count": sum(m.values()), "months": [{"month": k, "count": v} for k, v in sorted(m.items())]}
                   for y, m in sorted(months.items(), reverse=True)]
    where = scope_clauses(db, workspace_id, f, skip=("edited",))
    ed = db.scalar(select(func.sum(case((edited_clause(), 1), else_=0))).where(*where)) or 0
    total = db.scalar(select(func.count()).select_from(MediaItem).where(*where)) or 0
    out["edited"] = {"yes": int(ed), "no": int(total - ed)}
    out["total"] = db.scalar(select(func.count()).select_from(MediaItem).where(*scope_clauses(db, workspace_id, f))) or 0
    return out
