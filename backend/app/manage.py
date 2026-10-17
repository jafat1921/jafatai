"""Admin chores: uv run python -m app.manage <command>

  reset-password <email>   set a new password (prompted, or MIXAI_NEW_PASSWORD env); signs the user out
                           everywhere
  create-user --email E --name N [--admin] [--unverified]
                           a new account with its own studio; password prompted, or MIXAI_NEW_PASSWORD env
  list-users
  thumbs                   make missing grid thumbnails for every finished image/video (optional;
                           the server also makes them on first view)
  catalogue-backfill       read EXIF, capture date, size and a duplicate-check hash for photos uploaded
                           before the photo catalogue (M10); safe to run again
  voice-samples [--engine omnivoice|kokoro|voxcpm] [--force] [--only id,id]
                           render the Voice Gallery's missing samples on this GPU box (contract v19)
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
        user.session_version = (user.session_version or 0) + 1
        db.commit()
    print(f"password updated for {email}")
    return 0


def create_user(args: list[str]) -> int:
    import argparse

    from app import accounts

    p = argparse.ArgumentParser(prog="create-user")
    p.add_argument("--email", required=True)
    p.add_argument("--name", default="")
    p.add_argument("--admin", action="store_true")
    # made by hand on the server, so the address is taken as confirmed unless asked otherwise
    p.add_argument("--unverified", action="store_true")
    a = p.parse_args(args)
    pw = os.environ.get("MIXAI_NEW_PASSWORD") or getpass.getpass("Password: ")
    with SessionLocal() as db:
        try:
            user = accounts.create_account(db, a.email, a.name, pw, verified=not a.unverified, admin=a.admin)
        except accounts.AccountError as e:
            print(e)
            return 1
        db.commit()
        print(f"created {user.email}{' (admin)' if user.is_admin else ''}")
    return 0


def list_users() -> int:
    with SessionLocal() as db:
        for u in db.scalars(select(User).order_by(User.email)):
            flags = [f for f, on in (("admin", u.is_admin), ("inactive", not u.is_active),
                                     ("unverified", u.email_verified_at is None)) if on]
            print(u.email + (f"  [{', '.join(flags)}]" if flags else ""))
    return 0


def make_thumbs() -> int:
    from app import thumbs

    with SessionLocal() as db:
        made, failed = thumbs.backfill(db)
    print(f"thumbs: {made} made, {failed} failed")
    # a partial run still exits 1 so the installer says which engine needs attention
    return 1 if failed else 0


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


def voice_samples(args: list[str], run=None) -> int:
    import argparse

    from app import voice_gallery

    p = argparse.ArgumentParser(prog="voice-samples")
    p.add_argument("--engine", choices=("omnivoice", "kokoro", "voxcpm"))
    p.add_argument("--force", action="store_true")
    p.add_argument("--only", default="")
    a = p.parse_args(args)
    only = [x.strip() for x in a.only.split(",") if x.strip()] or None
    made, failed = voice_gallery.render_samples(a.engine, a.force, only, run=run)
    print(f"voice samples: {made} made, {failed} failed")
    # a partial run still exits 1 so the installer says which engine needs attention
    return 1 if failed else 0


def main(argv: list[str]) -> int:
    if len(argv) >= 2 and argv[0] == "reset-password":
        return reset_password(argv[1])
    if argv[:1] == ["create-user"]:
        return create_user(argv[1:])
    if argv[:1] == ["list-users"]:
        return list_users()
    if argv[:1] == ["thumbs"]:
        return make_thumbs()
    if argv[:1] == ["catalogue-backfill"]:
        return catalogue_backfill()
    if argv[:1] == ["voice-samples"]:
        return voice_samples(argv[1:])
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
