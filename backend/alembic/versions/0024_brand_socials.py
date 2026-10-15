"""Brand kit socials (contract v36 addendum): a list of social accounts beside the contact block

Revision ID: 0024
Revises: 0023
Create Date: 2026-10-15 23:00:00

The old one-line `contact.social` becomes socials[0]: the platform read from a link when it is one, else
Instagram (what a bare "@name" nearly always meant). Downgrade puts the first handle back.
"""
import json
import re

from alembic import op
import sqlalchemy as sa


revision = '0024'
down_revision = '0023'
branch_labels = None
depends_on = None

_HOSTS = {"facebook": ("facebook.com", "fb.com"), "tiktok": ("tiktok.com",), "linkedin": ("linkedin.com",),
          "x": ("x.com", "twitter.com"), "youtube": ("youtube.com",), "pinterest": ("pinterest.com",),
          "snapchat": ("snapchat.com",), "threads": ("threads.net",), "whatsapp": ("wa.me",)}


def _social(text: str) -> dict | None:
    # a frozen copy of the app's reading, so later changes there never change what this migration did
    text = re.sub(r"\s+", "", text or "")
    if not text:
        return None
    platform, url, handle = "instagram", None, text
    if "/" in text or text.lower().startswith(("http", "www.")):
        url = text if text.lower().startswith("http") else "https://" + text
        host = re.sub(r"^https?://(www\.|m\.)?", "", url, flags=re.I).split("/")[0].lower()
        platform = next((p for p, hs in _HOSTS.items() if host.endswith(hs)), "instagram")
        parts = [p for p in re.sub(r"^https?://[^/]+", "", url).split("/")
                 if p and p.lower() not in ("company", "in", "add", "c", "user", "channel")]
        if not parts:
            return None
        handle = parts[0]
    handle = handle.lstrip("@")
    if not re.match(r"^[\w.\-]{1,60}$", handle):
        return None
    shown = handle if platform == "linkedin" else "@" + handle
    return {"platform": platform, "handle": shown, "url": url or f"https://instagram.com/{handle}",
            "show_in_ads": True}


def upgrade() -> None:
    op.add_column('brand_kit', sa.Column('socials', sa.JSON(), nullable=False, server_default='[]'))
    conn = op.get_bind()
    for kid, contact in conn.execute(sa.text("SELECT id, contact FROM brand_kit")).fetchall():
        data = json.loads(contact) if isinstance(contact, str) else (contact or {})
        if not isinstance(data, dict) or "social" not in data:
            continue
        s = _social(data.pop("social") or "")
        conn.execute(sa.text("UPDATE brand_kit SET contact = :c, socials = :s WHERE id = :id"),
                     {"c": json.dumps(data), "s": json.dumps([s] if s else []), "id": kid})


def downgrade() -> None:
    conn = op.get_bind()
    for kid, contact, socials in conn.execute(sa.text("SELECT id, contact, socials FROM brand_kit")).fetchall():
        data = json.loads(contact) if isinstance(contact, str) else (contact or {})
        rows = json.loads(socials) if isinstance(socials, str) else (socials or [])
        if rows:
            data["social"] = rows[0].get("handle") or ""
            conn.execute(sa.text("UPDATE brand_kit SET contact = :c WHERE id = :id"),
                         {"c": json.dumps(data), "id": kid})
    # plain DROP COLUMN, not batch mode: see 0022
    op.execute('ALTER TABLE "brand_kit" DROP COLUMN socials')
