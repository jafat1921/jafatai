"""Develop workflow (M10 phase 2 / D1): Snapshots, and Sync / Paste settings onto many pictures.

Settings travel by group, like Lightroom's Copy Settings dialog. Syncing onto a picture keeps its own
settings for every group that wasn't ticked, so "sync White Balance" never undoes someone's crop.
"""
import copy

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Generation, PhotoSnapshot
from app.photo import develop as dv
from app.photo import service as svc
from app.services import owned_source

MAX_SYNC = 500
# what the Copy Settings dialog offers; "geometry" is crop, straighten and flip
COPY_GROUPS = (*dv.GROUP_KEYS.keys(),)


def edit_state(db: Session, g: Generation) -> tuple[Generation, dict]:
    """(base version, params) for a picture's current version: a developed version re-opens on its base."""
    d = (g.params or {}).get("develop") or {}
    if d.get("base"):
        base = db.get(Generation, d["base"])
        if base is not None and base.status in svc.FINISHED and base.file_path:
            return base, dv.normalise(d.get("params") or {})
    return g, dv.normalise({})


def merge_groups(mine: dict, theirs: dict, groups: list[str]) -> dict:
    """mine with every key of `groups` taken from theirs (both normalised). The on/off switch travels too."""
    out = copy.deepcopy(mine)
    for gid in groups:
        for k in dv.GROUP_KEYS.get(gid, []):
            out[k] = copy.deepcopy(theirs[k])
        if gid in dv.SWITCHABLE:
            off = set(out["off"])
            if gid in theirs["off"]:
                off.add(gid)
            else:
                off.discard(gid)
            out["off"] = [x for x in dv.SWITCHABLE if x in off]
    return out


def check_groups(groups: list[str]) -> list[str]:
    bad = [g for g in groups if g not in COPY_GROUPS]
    if bad:
        raise HTTPException(422, f"Unknown settings group(s): {', '.join(bad)} (expected {', '.join(COPY_GROUPS)})")
    if not groups:
        raise HTTPException(422, "Pick at least one group of settings")
    return groups


def queue_sync(db: Session, workspace_id: str, ids: list[str], params: dict, groups: list[str], fmt: str,
               quality: int, user_id: str | None) -> list[dict]:
    if len(ids) > MAX_SYNC:
        raise HTTPException(422, f"At most {MAX_SYNC} pictures at a time")
    check_groups(groups)
    theirs = dv.normalise(params)
    out = []
    for any_id in dict.fromkeys(ids):
        try:
            current = owned_source(db, workspace_id, any_id)
            svc.check_image(current)
        except HTTPException as e:
            out.append({"id": any_id, "job_id": None, "error": str(e.detail)})
            continue
        base, mine = edit_state(db, current)
        merged = merge_groups(mine, theirs, groups)
        if merged == mine:
            out.append({"id": any_id, "job_id": None, "error": None, "unchanged": True})
            continue
        job = svc.queue_render(db, base, merged, fmt, quality, "Synced settings", user_id)
        out.append({"id": any_id, "job_id": job.id, "error": None})
    return out


# ---------------------------------------------------------------- snapshots

def snapshot_out(s: PhotoSnapshot) -> dict:
    return {"id": s.id, "name": s.name, "base_id": s.base_id, "params": dv.sparse(s.params),
            "created_at": s.created_at, "updated_at": s.updated_at}


def snapshots(db: Session, g: Generation) -> list[dict]:
    rows = db.scalars(select(PhotoSnapshot).where(PhotoSnapshot.target_type == g.target_type,
                                                  PhotoSnapshot.target_id == g.target_id)
                      .order_by(PhotoSnapshot.created_at.desc()))
    return [snapshot_out(s) for s in rows]


def owned_snapshot(db: Session, workspace_id: str, sid: str) -> PhotoSnapshot:
    s = db.get(PhotoSnapshot, sid)
    if s is None or s.workspace_id != workspace_id:
        raise HTTPException(404, "Snapshot not found")
    return s

