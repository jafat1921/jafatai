from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse

from app.config import get_settings
from app.security import CurrentUser, get_current_user

router = APIRouter(tags=["media"])


def resolve_media_path(rel: str, workspace_id: str, data_dir: Path) -> Path | None:
    if not rel or "\x00" in rel:
        return None
    root = data_dir.resolve()
    try:
        target = (root / rel).resolve()
    except (OSError, ValueError):
        return None
    # tenancy: you only ever see files under your own workspace folder
    ws_root = root / "workspaces" / workspace_id
    if not target.is_relative_to(ws_root) or not target.is_file():
        return None
    return target


@router.get("/media/{path:path}")
def get_media(path: str, cur: CurrentUser = Depends(get_current_user)):
    target = resolve_media_path(path, cur.workspace_id, get_settings().data_dir)
    if target is None:
        raise HTTPException(404, "Not found")
    return FileResponse(target, headers={"Cache-Control": "private, max-age=3600"})
