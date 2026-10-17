"""The admin audit log (contract v39): one row for every change an admin makes."""
from sqlalchemy.orm import Session

from app.models import AdminAudit, User


def record(db: Session, actor: User, action: str, target_type: str = "", target_id: str | None = None,
           **detail) -> AdminAudit:
    row = AdminAudit(actor_user_id=actor.id, actor_email=actor.email, action=action, target_type=target_type,
                     target_id=target_id, detail=_plain(detail))
    db.add(row)
    return row


def _plain(value):
    # JSON column: datetimes and the like go in as text
    if isinstance(value, dict):
        return {k: _plain(v) for k, v in value.items() if v is not None}
    if isinstance(value, (list, tuple)):
        return [_plain(v) for v in value]
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return str(value)
