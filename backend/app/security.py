from dataclasses import dataclass

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError
from fastapi import Depends, HTTPException, Request, status
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import get_db
from app.models import Membership, User

COOKIE_NAME = "mixai_session"
SESSION_MAX_AGE = 14 * 24 * 3600

_hasher = PasswordHasher()


def hash_password(pw: str) -> str:
    return _hasher.hash(pw)


def verify_password(pw: str, hashed: str) -> bool:
    try:
        return _hasher.verify(hashed, pw)
    except (VerificationError, InvalidHashError):
        return False


def _serializer() -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(get_settings().app_secret, salt="mixai-session")


def make_session_token(user_id: str) -> str:
    return _serializer().dumps({"uid": user_id})


def read_session_token(token: str) -> str | None:
    try:
        data = _serializer().loads(token, max_age=SESSION_MAX_AGE)
    except (BadSignature, SignatureExpired):
        return None
    return data.get("uid") if isinstance(data, dict) else None


@dataclass
class CurrentUser:
    user: User
    workspace_id: str
    role: str

    @property
    def id(self) -> str:
        return self.user.id


def load_current(db: Session, user_id: str) -> CurrentUser | None:
    user = db.get(User, user_id)
    if not user or not user.is_active:
        return None
    # single workspace per user for now; workspace switching comes with multi-user
    m = db.scalars(
        select(Membership).where(Membership.user_id == user.id).order_by(Membership.created_at)
    ).first()
    if not m:
        return None
    return CurrentUser(user=user, workspace_id=m.workspace_id, role=m.role)


def get_current_user(request: Request, db: Session = Depends(get_db)) -> CurrentUser:
    token = request.cookies.get(COOKIE_NAME)
    uid = read_session_token(token) if token else None
    cur = load_current(db, uid) if uid else None
    if not cur:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not signed in")
    return cur


def require_editor(cur: CurrentUser = Depends(get_current_user)) -> CurrentUser:
    if cur.role == "viewer":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Viewers can't change anything")
    return cur
