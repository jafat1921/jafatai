"""Minting, listing and revoking API tokens (contract v27). Checking a presented token lives in app.security."""
import secrets
from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import ApiToken, utcnow
from app.security import SCOPES, TOKEN_PREFIX, CurrentUser, hash_token

EXPIRY_DAYS = (30, 90, 365)
MAX_LIVE = 50


class TokenError(ValueError):
    pass


def new_secret() -> tuple[str, str]:
    """(prefix, full token). The prefix is hex so it can never contain the "_" separator."""
    prefix = secrets.token_hex(4)
    return prefix, f"{TOKEN_PREFIX}{prefix}_{secrets.token_urlsafe(32)}"


def mint(db: Session, cur: CurrentUser, name: str, scopes: list[str], expires_days: int | None) -> tuple[ApiToken, str]:
    name = name.strip()
    if not name:
        raise TokenError("Give the token a name")
    picked = [s for s in SCOPES if s in set(scopes)]
    if not picked:
        raise TokenError("Pick at least one scope")
    if cur.role == "viewer" and picked != ["read"]:
        # roles still apply to tokens, so a viewer's generate/manage token would only ever answer 403
        raise TokenError("Viewers can only make read tokens")
    if expires_days is not None and expires_days not in EXPIRY_DAYS:
        raise TokenError(f"Expiry must be one of {', '.join(map(str, EXPIRY_DAYS))} days, or never")
    live = db.scalars(select(ApiToken.id).where(ApiToken.user_id == cur.id, ApiToken.revoked_at.is_(None))).all()
    if len(live) >= MAX_LIVE:
        raise TokenError(f"You already have {MAX_LIVE} tokens; revoke one first")

    prefix, raw = new_secret()
    while db.scalars(select(ApiToken.id).where(ApiToken.prefix == prefix)).first():
        prefix, raw = new_secret()  # 4 billion prefixes; a clash is unlikely but cheap to rule out
    now = utcnow()
    row = ApiToken(user_id=cur.id, workspace_id=cur.workspace_id, name=name[:120], prefix=prefix,
                   token_hash=hash_token(raw), scopes=picked,
                   expires_at=now + timedelta(days=expires_days) if expires_days else None, created_at=now)
    db.add(row)
    db.flush()
    return row, raw


def list_for(db: Session, cur: CurrentUser) -> list[ApiToken]:
    return list(db.scalars(select(ApiToken).where(ApiToken.user_id == cur.id, ApiToken.workspace_id == cur.workspace_id)
                           .order_by(ApiToken.revoked_at.is_not(None), ApiToken.created_at.desc())).all())


def owned(db: Session, cur: CurrentUser, token_id: str) -> ApiToken | None:
    row = db.get(ApiToken, token_id)
    if row is None or row.user_id != cur.id or row.workspace_id != cur.workspace_id:
        return None
    return row


def revoke(row: ApiToken) -> None:
    if row.revoked_at is None:
        row.revoked_at = utcnow()


def status_of(row: ApiToken) -> str:
    if row.revoked_at is not None:
        return "revoked"
    if row.expires_at is not None and row.expires_at <= utcnow():
        return "expired"
    return "active"
