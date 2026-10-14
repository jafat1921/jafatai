"""Settings -> API tokens (contract v27). Browser session only: a token can never mint or revoke tokens."""
from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy.orm import Session

from app import tokens as tk
from app.db import get_db
from app.models import ApiToken
from app.schemas import TokenCreatedOut, TokenIn, TokenOut
from app.security import CurrentUser, require_api_access, session_only

router = APIRouter(prefix="/tokens", tags=["tokens"])


def _out(row: ApiToken, cls=TokenOut, **extra):
    return cls(id=row.id, name=row.name, prefix=row.prefix, scopes=list(row.scopes or []),
               status=tk.status_of(row), expires_at=row.expires_at, last_used_at=row.last_used_at,
               revoked_at=row.revoked_at, created_at=row.created_at, **extra)


@router.get("", response_model=list[TokenOut])
@session_only
def list_tokens(db: Session = Depends(get_db), cur: CurrentUser = Depends(require_api_access)):
    return [_out(t) for t in tk.list_for(db, cur)]


@router.post("", response_model=TokenCreatedOut, status_code=201)
@session_only
def create_token(body: TokenIn, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_api_access)):
    try:
        row, raw = tk.mint(db, cur, body.name, list(body.scopes), body.expires_days)
    except tk.TokenError as e:
        raise HTTPException(422, str(e)) from None
    db.commit()
    return _out(row, TokenCreatedOut, token=raw)


@router.delete("/{token_id}", status_code=204)
@session_only
def revoke_token(token_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_api_access)):
    row = tk.owned(db, cur, token_id)
    if row is None:
        raise HTTPException(404, "Token not found")
    tk.revoke(row)
    db.commit()
    return Response(status_code=204)
