from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import get_db
from app.models import User
from app.ratelimit import SlidingWindow
from app.schemas import LoginIn, UserOut
from app.security import (
    COOKIE_NAME,
    SESSION_MAX_AGE,
    CurrentUser,
    can_read_docs,
    can_use_api,
    get_current_user,
    is_admin,
    load_current,
    make_session_token,
    session_only,
    verify_password,
)

router = APIRouter(prefix="/auth", tags=["auth"])

# failed logins per client IP. Behind Caddy, uvicorn's --proxy-headers makes request.client the real caller
LOGIN_FAILURES = SlidingWindow(limit=5, window_s=60)


def _user_out(cur: CurrentUser) -> UserOut:
    u = cur.user
    return UserOut(id=u.id, email=u.email, display_name=u.display_name, workspace_id=cur.workspace_id, role=cur.role,
                   api_access=can_use_api(cur), api_docs=can_read_docs(cur), admin=is_admin(cur))


@router.post("/login", response_model=UserOut)
def login(body: LoginIn, request: Request, response: Response, db: Session = Depends(get_db)):
    ip = request.client.host if request.client else "unknown"
    wait = LOGIN_FAILURES.retry_after(ip)
    if wait:
        raise HTTPException(429, f"Too many sign-in attempts. Try again in {wait} seconds.",
                            headers={"Retry-After": str(wait)})
    user = db.scalars(select(User).where(User.email == body.email.strip().lower())).first()
    if not user or not verify_password(body.password, user.password_hash):
        LOGIN_FAILURES.hit(ip)
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
@session_only
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
@session_only
def me(cur: CurrentUser = Depends(get_current_user)):
    return _user_out(cur)
