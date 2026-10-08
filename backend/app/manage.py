"""Admin chores: uv run python -m app.manage <command>

  reset-password <email>   set a new password (prompted, or MIXAI_NEW_PASSWORD env)
  list-users
  thumbs                   make missing grid thumbnails for every finished image/video (optional;
                           the server also makes them on first view)
"""
import getpass
import os
import sys

from sqlalchemy import select

from app.db import SessionLocal
from app.models import User
from app.security import hash_password


def reset_password(email: str) -> int:
    pw = os.environ.get("MIXAI_NEW_PASSWORD") or getpass.getpass("New password: ")
    if len(pw) < 10:
        print("password must be at least 10 characters")
        return 1
    with SessionLocal() as db:
        user = db.scalars(select(User).where(User.email == email.strip().lower())).first()
        if not user:
            print(f"no user {email}")
            return 1
        user.password_hash = hash_password(pw)
        db.commit()
    print(f"password updated for {email}")
    return 0


def list_users() -> int:
    with SessionLocal() as db:
        for u in db.scalars(select(User).order_by(User.email)):
            print(u.email)
    return 0


def make_thumbs() -> int:
    from app import thumbs

    with SessionLocal() as db:
        made, failed = thumbs.backfill(db)
    print(f"thumbs: {made} made, {failed} failed")
    return 1 if failed and not made else 0


def main(argv: list[str]) -> int:
    if len(argv) >= 2 and argv[0] == "reset-password":
        return reset_password(argv[1])
    if argv[:1] == ["list-users"]:
        return list_users()
    if argv[:1] == ["thumbs"]:
        return make_thumbs()
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
