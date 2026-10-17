"""Accounts (contract v38): one place that makes a user with their own studio, and the one-time email links."""
import hashlib
import re
import secrets
import unicodedata
from datetime import timedelta

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app import packages
from app.models import ApiToken, EmailToken, Membership, User, Workspace, utcnow
from app.security import hash_password

MIN_PASSWORD = 10
TOKEN_TTL = {
    "verify": timedelta(hours=48),
    "reset": timedelta(hours=1),
    # an admin-made account's "choose your password" link; it confirms the email too
    "invite": timedelta(days=7),
}


class AccountError(ValueError):
    pass


class AccountExists(AccountError):
    pass


def normalise_email(email: str) -> str:
    return email.strip().lower()


def looks_like_email(email: str) -> bool:
    return bool(re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email)) and len(email) <= 320


def check_password(pw: str) -> None:
    if len(pw) < MIN_PASSWORD:
        raise AccountError(f"Use at least {MIN_PASSWORD} characters for the password")
    if len(pw) > 256:
        raise AccountError("That password is too long")


def find_user(db: Session, email: str) -> User | None:
    return db.scalars(select(User).where(User.email == normalise_email(email))).first()


def _slug(text: str) -> str:
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:40] or "studio"


def unique_handle(db: Session, base: str) -> str:
    slug = _slug(base)
    taken = set(db.scalars(select(User.handle).where(User.handle.like(f"{slug}%"))))
    if slug not in taken:
        return slug
    n = 2
    while f"{slug}-{n}" in taken:
        n += 1
    return f"{slug}-{n}"


def create_account(db: Session, email: str, name: str = "", password: str | None = None, *,
                   verified: bool = False, admin: bool = False, workspace_name: str | None = None) -> User:
    """User + their own workspace + an owner membership + the Free package. Flushed, not committed."""
    email = normalise_email(email)
    # loose on purpose: an existing ADMIN_EMAIL like admin@localhost must still seed. Sign-up checks harder
    if not re.fullmatch(r"[^@\s]+@[^@\s]+", email) or len(email) > 320:
        raise AccountError("That doesn't look like an email address")
    if password is not None:
        check_password(password)
    if find_user(db, email):
        raise AccountExists("There's already an account for that email")
    name = name.strip()[:200]
    user = User(email=email, display_name=name, password_hash=hash_password(password) if password else "",
                is_admin=admin, email_verified_at=utcnow() if verified else None,
                handle=unique_handle(db, name or email.split("@")[0]))
    ws = Workspace(name=workspace_name or f"{name or email.split('@')[0]}'s studio")
    db.add_all([user, ws])
    db.flush()
    ws.owner_user_id = user.id
    db.add(Membership(user_id=user.id, workspace_id=ws.id, role="owner"))
    db.flush()
    packages.give_free(db, user)
    return user


def set_password(user: User, pw: str) -> None:
    check_password(pw)
    user.password_hash = hash_password(pw)
    sign_out_everywhere(user)


def sign_out_everywhere(user: User) -> None:
    user.session_version = (user.session_version or 0) + 1


def deactivate(db: Session, user: User) -> None:
    user.is_active = False
    sign_out_everywhere(user)
    db.execute(update(ApiToken).where(ApiToken.user_id == user.id, ApiToken.revoked_at.is_(None))
               .values(revoked_at=utcnow()))


# ---------------------------------------------------------------- email links

def _hash(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def issue_token(db: Session, user: User, purpose: str) -> str:
    """A fresh link for `purpose`; any older unused one stops working, so only the newest email counts."""
    now = utcnow()
    db.execute(update(EmailToken).where(EmailToken.user_id == user.id, EmailToken.purpose == purpose,
                                        EmailToken.used_at.is_(None)).values(used_at=now))
    raw = secrets.token_urlsafe(32)
    db.add(EmailToken(user_id=user.id, purpose=purpose, token_hash=_hash(raw), expires_at=now + TOKEN_TTL[purpose]))
    db.flush()
    return raw


def peek_token(db: Session, raw: str, purposes: tuple[str, ...]) -> EmailToken | None:
    if not raw or len(raw) > 200:
        return None
    row = db.scalars(select(EmailToken).where(EmailToken.token_hash == _hash(raw))).first()
    if row is None or row.purpose not in purposes:
        return None
    return row


def take_token(db: Session, raw: str, purposes: tuple[str, ...]) -> User | None:
    """The token's user when it's live, marking it used; None for unknown, used or expired."""
    row = peek_token(db, raw, purposes)
    if row is None or row.used_at is not None or row.expires_at <= utcnow():
        return None
    user = db.get(User, row.user_id)
    if user is None or not user.is_active:
        return None
    row.used_at = utcnow()
    # every one of these links reached the inbox, so any of them proves the address
    user.email_verified_at = user.email_verified_at or utcnow()
    return user
