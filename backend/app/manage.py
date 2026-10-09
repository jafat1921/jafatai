"""Admin chores: uv run python -m app.manage <command>

  reset-password <email>   set a new password (prompted, or MIXAI_NEW_PASSWORD env)
  list-users
  thumbs                   make missing grid thumbnails for every finished image/video (optional;
                           the server also makes them on first view)
  catalogue-backfill       read EXIF, capture date, size and a duplicate-check hash for photos uploaded
                           before the photo catalogue (M10); safe to run again
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


def catalogue_backfill() -> int:
    import hashlib

    from app.catalogue import exif as ex
    from app.catalogue.importer import apply_exif
    from app.config import get_settings
    from app.models import Generation, MediaItem

    done = missing = 0
    with SessionLocal() as db:
        items = db.scalars(select(MediaItem).where(MediaItem.kind == "image", MediaItem.content_hash.is_(None))).all()
        for item in items:
            first = db.scalars(select(Generation).where(Generation.target_type == "media",
                                                        Generation.target_id == item.id)
                               .order_by(Generation.version).limit(1)).first()
            path = get_settings().data_dir / (item.source_path or (first.file_path if first else "") or "")
            if not path.is_file():
                missing += 1
                continue
            h = hashlib.sha256()
            with open(path, "rb") as f:
                for chunk in iter(lambda: f.read(1 << 20), b""):
                    h.update(chunk)
            item.content_hash = h.hexdigest()
            item.bytes = item.bytes or path.stat().st_size
            item.original_name = item.original_name or ((first.params or {}).get("original_name") if first else None)
            if item.origin == "upload" and item.captured_at is None:
                apply_exif(item, ex.read(path))
            done += 1
            if done % 200 == 0:
                db.commit()
        db.commit()
    print(f"catalogue: {done} photos updated, {missing} files missing")
    return 0


def main(argv: list[str]) -> int:
    if len(argv) >= 2 and argv[0] == "reset-password":
        return reset_password(argv[1])
    if argv[:1] == ["list-users"]:
        return list_users()
    if argv[:1] == ["thumbs"]:
        return make_thumbs()
    if argv[:1] == ["catalogue-backfill"]:
        return catalogue_backfill()
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
