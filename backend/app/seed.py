import logging

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models import Membership, User, Workspace
from app.security import hash_password

log = logging.getLogger(__name__)


def seed(db: Session) -> None:
    from app.photo.looks import ensure_builtins

    ensure_builtins(db)
    if db.scalar(select(func.count()).select_from(User)):
        return
    s = get_settings()
    ws = Workspace(name="Default")
    user = User(
        email=s.admin_email.strip().lower(),
        display_name=s.admin_name,
        password_hash=hash_password(s.admin_password),
    )
    db.add_all([ws, user])
    db.flush()
    db.add(Membership(user_id=user.id, workspace_id=ws.id, role="owner"))
    db.commit()
    log.info("seeded workspace and admin %s", user.email)
    if s.admin_password == "change-me":
        log.warning("ADMIN_PASSWORD is still the default; change it in .env")
