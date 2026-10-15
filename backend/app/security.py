import hashlib
import hmac
from dataclasses import dataclass, replace
from datetime import timedelta

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError
from fastapi import Depends, HTTPException, Request, status
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import get_db
from app.models import VIA_API, ApiToken, Membership, User, utcnow

COOKIE_NAME = "mixai_session"
SESSION_MAX_AGE = 14 * 24 * 3600

# API tokens (contract v27): mxa_<8 hex prefix>_<secret>
TOKEN_PREFIX = "mxa_"
SCOPES = ("read", "generate", "manage")
METHOD_SCOPE = {"GET": "read", "HEAD": "read", "OPTIONS": "read", "POST": "generate", "PUT": "generate",
                "PATCH": "generate", "DELETE": "manage"}
SESSION_ONLY = "session"
TOUCH_EVERY = timedelta(minutes=1)

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
    # set when the request came in with an API token; a browser session has no scope limits
    token_id: str | None = None
    scopes: frozenset[str] | None = None
    # app (cookie session), api (token on the REST routes) or mcp (/api/mcp); see app.visibility
    channel: str = "app"
    # ?via= on an app request; only an admin's counts (app.visibility.wanted)
    via: str | None = None

    @property
    def id(self) -> str:
        return self.user.id

    @property
    def via_token(self) -> bool:
        return self.token_id is not None

    def can(self, scope: str) -> bool:
        return self.scopes is None or scope in self.scopes


def load_current(db: Session, user_id: str, workspace_id: str | None = None) -> CurrentUser | None:
    user = db.get(User, user_id)
    if not user or not user.is_active:
        return None
    # single workspace per user for now; workspace switching comes with multi-user
    q = select(Membership).where(Membership.user_id == user.id)
    if workspace_id:
        q = q.where(Membership.workspace_id == workspace_id)
    m = db.scalars(q.order_by(Membership.created_at)).first()
    if not m:
        return None
    return CurrentUser(user=user, workspace_id=m.workspace_id, role=m.role)


# ---------------------------------------------------------------- API tokens

def hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def split_token(raw: str) -> str | None:
    """The lookup prefix of a well-formed token, else None."""
    if not raw.startswith(TOKEN_PREFIX):
        return None
    prefix, sep, secret = raw[len(TOKEN_PREFIX):].partition("_")
    if len(prefix) != 8 or not sep or len(secret) < 20:
        return None
    return prefix


def resolve_token(db: Session, raw: str) -> CurrentUser | None:
    """A presented API token -> the user it acts as, with its scopes. None for anything not live.

    Plain function on purpose: the MCP server resolves its Bearer header with this too."""
    prefix = split_token(raw)
    if prefix is None:
        return None
    row = db.scalars(select(ApiToken).where(ApiToken.prefix == prefix)).first()
    if row is None or not hmac.compare_digest(row.token_hash, hash_token(raw)):
        return None
    now = utcnow()
    if row.revoked_at is not None or (row.expires_at is not None and row.expires_at <= now):
        return None
    cur = load_current(db, row.user_id, row.workspace_id)
    if cur is None:
        return None
    if row.last_used_at is None or now - row.last_used_at >= TOUCH_EVERY:
        # once a minute is plenty for "last used", and keeps a busy script from writing on every call
        db.execute(update(ApiToken).where(ApiToken.id == row.id).values(last_used_at=now))
        db.commit()
    return replace(cur, token_id=row.id, scopes=frozenset(row.scopes or ()), channel="api")


def bearer_token(request: Request) -> str | None:
    scheme, _, value = request.headers.get("authorization", "").partition(" ")
    if scheme.lower() != "bearer" or not value.strip():
        return None
    return value.strip()


def token_scope(scope: str):
    """Overrides the scope a route needs from a token, e.g. a POST that only reads. SESSION_ONLY refuses tokens."""
    def mark(fn):
        fn.token_scope = scope
        return fn
    return mark


session_only = token_scope(SESSION_ONLY)


def required_scope(request: Request) -> str:
    route = request.scope.get("route")
    override = getattr(getattr(route, "endpoint", None), "token_scope", None)
    return override or METHOD_SCOPE.get(request.method.upper(), "manage")


def check_scope(cur: CurrentUser, needed: str) -> None:
    if needed == SESSION_ONLY:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "API tokens can't be used here; sign in to the studio instead")
    if not cur.can(needed):
        raise HTTPException(status.HTTP_403_FORBIDDEN, f"This token doesn't have the '{needed}' scope")


def authenticate(db: Session, request: Request) -> CurrentUser:
    raw = bearer_token(request)
    if raw is not None:
        # a Bearer header wins over any cookie; it's also what makes token calls CSRF-safe
        cur = resolve_token(db, raw)
        if cur is None:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid, expired or revoked API token",
                                headers={"WWW-Authenticate": "Bearer"})
        check_scope(cur, required_scope(request))
        # whatever this request creates is stamped via_api (models._stamp_via_api)
        db.info[VIA_API] = True
        return cur
    token = request.cookies.get(COOKIE_NAME)
    uid = read_session_token(token) if token else None
    cur = load_current(db, uid) if uid else None
    if not cur:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not signed in")
    cur.via = request.query_params.get("via")
    return cur


def get_current_user(request: Request, db: Session = Depends(get_db)) -> CurrentUser:
    return authenticate(db, request)


def require_editor(cur: CurrentUser = Depends(get_current_user)) -> CurrentUser:
    if cur.role == "viewer":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Viewers can't change anything")
    return cur


# ---------------------------------------------------------------- who sees the API (PUBLIC_API, Update 4)

def is_admin(cur: CurrentUser) -> bool:
    return cur.role == "owner" and cur.user.email.lower() == get_settings().admin_email.strip().lower()


def can_use_api(cur: CurrentUser) -> bool:
    if get_settings().public_api:
        return cur.role in ("owner", "editor")
    return is_admin(cur)


def can_read_docs(cur: CurrentUser) -> bool:
    s = get_settings()
    if not s.api_docs:
        return False
    return True if s.public_api else is_admin(cur)


def _hidden(request: Request, db: Session) -> CurrentUser:
    # signed out and not allowed look the same (404), so the feature isn't advertised
    try:
        return authenticate(db, request)
    except HTTPException as e:
        if e.status_code == status.HTTP_401_UNAUTHORIZED:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Not Found") from None
        raise


def require_api_access(request: Request, db: Session = Depends(get_db)) -> CurrentUser:
    cur = _hidden(request, db)
    if not can_use_api(cur):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not Found")
    return cur


def require_docs_access(request: Request, db: Session = Depends(get_db)) -> CurrentUser:
    cur = _hidden(request, db)
    if not can_read_docs(cur):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not Found")
    return cur
