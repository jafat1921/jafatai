from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import get_db
from app.models import User
from app.schemas import LoginIn, UserOut
from app.security import (
    COOKIE_NAME,
    SESSION_MAX_AGE,
    CurrentUser,
    get_current_user,
    load_current,
    make_session_token,
    verify_password,
)

router = APIRouter(prefix="/auth", tags=["auth"])


def _user_out(cur: CurrentUser) -> UserOut:
    u = cur.user
    return UserOut(id=u.id, email=u.email, display_name=u.display_name, workspace_id=cur.workspace_id, role=cur.role)


@router.post("/login", response_model=UserOut)
def login(body: LoginIn, response: Response, db: Session = Depends(get_db)):
    user = db.scalars(select(User).where(User.email == body.email.strip().lower())).first()
    if not user or not verify_password(body.password, user.password_hash):
        raise HTTPException(401, "Wrong email or password")
    cur = load_current(db, user.id)
    if not cur:
        raise HTTPException(401, "This account has no workspace")
    response.set_cookie(
        COOKIE_NAME,
        make_session_token(user.id),
        max_age=SESSION_MAX_AGE,
        httponly=True,
        samesite="lax",
        secure=get_settings().is_prod,
        path="/",
    )
    return _user_out(cur)


@router.post("/logout", status_code=204)
def logout(_: CurrentUser = Depends(get_current_user)):
    resp = Response(status_code=204)
    resp.delete_cookie(COOKIE_NAME, path="/", httponly=True, samesite="lax", secure=get_settings().is_prod)
    return resp


@router.get("/dev-login")
def dev_login(request: Request):
    # Local convenience only. Anything proxied (Caddy adds X-Forwarded-For) or not
    # explicitly in dev mode gets nothing, so a server deployment never hands this out.
    s = get_settings()
    local = request.client is not None and request.client.host in ("127.0.0.1", "::1", "localhost")
    if s.app_env.lower() != "dev" or not s.dev_login_prefill or not local or "x-forwarded-for" in request.headers:
        return {"enabled": False}
    return {"enabled": True, "email": s.admin_email, "password": s.admin_password}


@router.get("/me", response_model=UserOut)
def me(cur: CurrentUser = Depends(get_current_user)):
    return _user_out(cur)
