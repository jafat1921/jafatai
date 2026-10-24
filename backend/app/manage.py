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
  implant-demo --email E --photo GEN:VIEW:GARMENT [--photo ...] --label L [--bra 32A] [--bw 12]
               [--ptosis 2] [--options sizes|lift]
                           a DEMO patient in that account's Implant Preview from AI pictures of fictional
                           people, rendered by the normal pipeline (M22)
  sample-packages          Creator and Studio on the website, Agency and Clinic for chosen clients; Pro and the
                           demo become clients only. Editable afterwards in the Package designer
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


DEMO_OPTIONS = {
    "sizes": [{"label": "Natural", "left_cc": 275, "right_cc": 275, "profile": "moderate"},
              {"label": "Fuller", "left_cc": 350, "right_cc": 350, "profile": "moderate_plus"},
              {"label": "Full", "left_cc": 425, "right_cc": 425, "profile": "high"}],
    "lift": [{"label": "Lift only volume", "left_cc": 250, "right_cc": 250, "profile": "moderate",
              "procedure": "augmentation_lift"},
             {"label": "Lift and fuller", "left_cc": 325, "right_cc": 325, "profile": "moderate_plus",
              "procedure": "augmentation_lift"}],
}


def implant_demo(args: list[str]) -> int:
    """A demo patient in someone's Implant Preview, from AI-generated pictures of fictional people, so a
    surgeon can be shown the area before any real patient is in it. Renders through the normal pipeline."""
    import argparse

    from app.implant import service as im
    from app.models import Generation, ImplantPatient, Membership, utcnow
    from app.services import generation_file

    p = argparse.ArgumentParser(prog="implant-demo")
    p.add_argument("--email", required=True, help="the account whose Implant Preview gets the demo")
    p.add_argument("--photo", action="append", required=True, metavar="GEN_ID:VIEW:GARMENT",
                   help="a finished AI picture, e.g. 364d…:front:garment (garment or topless)")
    p.add_argument("--label", required=True)
    p.add_argument("--bra", default="")
    p.add_argument("--bw", type=float, default=None, help="breast base width, cm (both sides)")
    p.add_argument("--ptosis", type=int, default=None)
    p.add_argument("--options", choices=sorted(DEMO_OPTIONS), default="sizes")
    a = p.parse_args(args)
    with SessionLocal() as db:
        user = db.scalars(select(User).where(User.email == a.email.strip().lower())).first()
        if user is None:
            print(f"no account {a.email}")
            return 1
        ws = db.scalars(select(Membership.workspace_id).where(Membership.user_id == user.id)
                        .order_by(Membership.created_at)).first()
        photos = []
        for spec in a.photo:
            gid, view, garment = (spec.split(":") + ["front", "garment"])[:3]
            g = db.get(Generation, gid)
            path = generation_file(g) if g is not None else None
            if g is None or g.target_type.startswith("implant_") or path is None or not path.is_file():
                print(f"{gid}: not a finished picture")
                return 1
            photos.append((view, garment, path.read_bytes()))
        topless = any(garment == "topless" for _, garment, _ in photos)
        m = {k: v for k, v in {"bra_size": a.bra, "bw_left_cm": a.bw, "bw_right_cm": a.bw,
                               "ptosis_grade": a.ptosis}.items() if v not in (None, "")}
        patient = ImplantPatient(workspace_id=ws, surgeon_user_id=user.id, label=f"DEMO · {a.label}"[:120],
                                 adult_confirmed=True, measurements=m, retention_months=12,
                                 notes="Demo patient: AI-generated fictional person, not a real patient.",
                                 consent={"at": utcnow().isoformat(), "topless_ok": topless, "demo": True,
                                          "attested_by": "Demo: AI-generated fictional person, no real patient"})
        db.add(patient)
        db.flush()
        for view, garment, data in photos:
            im.save_photo(db, patient, view, garment, data)
        im.generate(db, patient, [{"shape": "round", "placement": "dual_plane", "fill": "silicone", **o}
                                  for o in DEMO_OPTIONS[a.options]])
        db.commit()
        print(f"demo patient {patient.label} ({patient.id}) for {user.email}: rendering now")
    return 0


SAMPLE_PACKAGES = (
    dict(slug="creator", name="Creator", sort=3, public=True, price_pkr=2500, period="month",
         description="For creators and small shops posting every week: pictures, videos, voices and music, "
                     "in English and Urdu.",
         gpu_min_day=120.0, gpu_min_month=2400.0, max_queued=4),
    dict(slug="studio", name="Studio", sort=4, public=True, price_pkr=7500, period="month", private_items=True,
         description="For busy creators and brands: films, podcasts, dubbing and ads every day, with private "
                     "work and your brand kits.",
         gpu_min_day=360.0, gpu_min_month=7200.0, max_queued=8),
    dict(slug="agency", name="Agency", sort=5, public=False, price_pkr=25000, period="month", private_items=True,
         description="For agencies running several brands: a large monthly allowance, private work and "
                     "priority in the queue.",
         gpu_min_day=1200.0, gpu_min_month=24000.0, max_queued=16),
    dict(slug="clinic", name="Clinic", sort=6, public=False, price_pkr=15000, period="month", private_items=True,
         description="For clinics and surgeons. Implant Preview access is granted per surgeon by an admin.",
         gpu_min_day=240.0, gpu_min_month=4800.0, max_queued=6),
)


def sample_packages() -> int:
    """Sample packages for the website and for chosen clients; all editable afterwards in the Package designer.
    Safe to run again: existing slugs are left as they are."""
    from app.models import Package

    with SessionLocal() as db:
        for row in SAMPLE_PACKAGES:
            if db.scalars(select(Package).where(Package.slug == row["slug"])).first() is None:
                db.add(Package(kind="standard", active=True, features={}, **row))
                print(f"created {row['name']} ({'website' if row['public'] else 'clients only'})")
        # the website shows Free, Creator and Studio; Pro and the demo are offered to chosen clients
        for slug in ("pro", "demo"):
            p = db.scalars(select(Package).where(Package.slug == slug)).first()
            if p is not None and p.public:
                p.public = False
                print(f"{p.name}: now clients only")
        db.commit()
        shown = db.scalars(select(Package.name).where(Package.public.is_(True), Package.active.is_(True))
                           .order_by(Package.sort)).all()
        print("on the website:", ", ".join(shown))
    return 0


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
    if argv[:1] == ["implant-demo"]:
        return implant_demo(argv[1:])
    if argv[:1] == ["sample-packages"]:
        return sample_packages()
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
