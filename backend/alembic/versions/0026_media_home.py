"""Studio parts (contract v37): media_item.home, the studio a Library item is a working part of

Revision ID: 0026
Revises: 0025
Create Date: 2026-10-17 10:00:00

None is a final output, listed everywhere. Rows made before the column existed are marked from what they
already carry (tags, title, the flow that made their current version), the same idea as visibility.mark.
"""
import json

from alembic import op
import sqlalchemy as sa


revision = '0026'
down_revision = '0025'
branch_labels = None
depends_on = None

media_item = sa.table('media_item', sa.column('id', sa.String), sa.column('kind', sa.String),
                      sa.column('origin', sa.String), sa.column('title', sa.String), sa.column('tags', sa.JSON),
                      sa.column('generation_id', sa.String), sa.column('home', sa.String))
generation = sa.table('generation', sa.column('id', sa.String), sa.column('params', sa.JSON))

FLOWS = {'dub_sample': 'dub', 'voice_design': 'voice'}


def _list(v) -> list:
    # JSON columns come back decoded on SQLite and Postgres alike, but an old raw insert may hold text
    if isinstance(v, str):
        try:
            v = json.loads(v)
        except ValueError:
            return []
    return v if isinstance(v, list) else []


def _dict(v) -> dict:
    if isinstance(v, str):
        try:
            v = json.loads(v)
        except ValueError:
            return {}
    return v if isinstance(v, dict) else {}


def home_for(kind: str, origin: str, title: str, tags: list, flow: str | None) -> str | None:
    title = title or ''
    if 'character sheet' in tags or 'test clip' in tags or title.endswith('· voice preview'):
        return 'character'
    if title.startswith('BlogCreatorPro '):
        return 'story'
    if kind == 'audio' and tags == ['poetry']:
        return 'poetry'
    if 'story' in tags:
        return 'story'
    if flow in FLOWS:
        return FLOWS[flow]
    if 'brand' in tags and origin == 'upload':
        return 'brand'
    return None


def _backfill(bind) -> None:
    rows = bind.execute(
        sa.select(media_item.c.id, media_item.c.kind, media_item.c.origin, media_item.c.title, media_item.c.tags,
                  generation.c.params)
        .select_from(media_item.outerjoin(generation, generation.c.id == media_item.c.generation_id))
        .where(media_item.c.home.is_(None))).all()
    marks: dict[str, list[str]] = {}
    for id_, kind, origin, title, tags, params in rows:
        flow = _dict(_dict(params).get('created_by')).get('flow')
        home = home_for(kind, origin, title, _list(tags), flow)
        if home:
            marks.setdefault(home, []).append(id_)
    for home, ids in marks.items():
        for i in range(0, len(ids), 500):
            bind.execute(sa.update(media_item).where(media_item.c.id.in_(ids[i:i + 500])).values(home=home))


def upgrade() -> None:
    op.add_column('media_item', sa.Column('home', sa.String(120), nullable=True))
    op.create_index('ix_media_item_home', 'media_item', ['home'])
    _backfill(op.get_bind())


def downgrade() -> None:
    op.drop_index('ix_media_item_home', table_name='media_item')
    # plain DROP COLUMN, not batch mode: see 0022
    op.execute('ALTER TABLE "media_item" DROP COLUMN home')
