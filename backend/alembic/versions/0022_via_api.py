"""Made through the API (contract v34): via_api on the studio's main tables

Revision ID: 0022
Revises: 0021
Create Date: 2026-10-15 18:00:00

Rows created with an API token on the REST routes stay out of the studio app's lists. Past token use wasn't
recorded per row, so the only rows marked here are the story jobs (an API-only feature) and the Library
items and generations they used; scripts/mark-api-items.py marks the rest by id or time window.
"""
from alembic import op
import sqlalchemy as sa


revision = '0022'
down_revision = '0021'
branch_labels = None
depends_on = None

TABLES = ('project', 'character', 'generation', 'job', 'media_item', 'folder', 'album', 'brand_kit', 'look',
          'voice_profile', 'voice_script', 'dub_project', 'transcript', 'podcast_show', 'podcast_episode',
          'video_podcast', 'user_template', 'poetry_short')

job = sa.table('job', sa.column('id', sa.String), sa.column('type', sa.String), sa.column('payload', sa.JSON),
               sa.column('via_api', sa.Boolean))
generation = sa.table('generation', sa.column('id', sa.String), sa.column('target_type', sa.String),
                      sa.column('target_id', sa.String), sa.column('job_id', sa.String),
                      sa.column('file_path', sa.String), sa.column('workspace_id', sa.String),
                      sa.column('via_api', sa.Boolean))
media_item = sa.table('media_item', sa.column('id', sa.String), sa.column('via_api', sa.Boolean))


def _chunks(ids, n=500):
    ids = sorted(ids)
    for i in range(0, len(ids), n):
        yield ids[i:i + n]


def _mark_stories(bind) -> None:
    jobs = bind.execute(sa.select(job.c.id, job.c.type, job.c.payload)
                        .where(job.c.type.in_(('story_audio', 'story_video')))).all()
    if not jobs:
        return
    gen_ids: set[str] = set()
    files: set[str] = set()
    for _, type_, payload in jobs:
        p = payload or {}
        if type_ == 'story_audio' and p.get('music_generation_id'):
            gen_ids.add(p['music_generation_id'])
        if type_ == 'story_video':
            files |= {f for f in (p.get('pictures') or {}).values() if isinstance(f, str)}
            tc = p.get('title_card') or {}
            if isinstance(tc, dict) and tc.get('file'):
                files.add(tc['file'])
    for chunk in _chunks(files):
        gen_ids |= set(bind.execute(sa.select(generation.c.id).where(generation.c.file_path.in_(chunk))).scalars())
    media_ids: set[str] = set()
    job_ids = {j[0] for j in jobs}
    for chunk in _chunks(gen_ids):
        for t_type, t_id, j_id in bind.execute(sa.select(generation.c.target_type, generation.c.target_id,
                                                         generation.c.job_id).where(generation.c.id.in_(chunk))):
            if t_type == 'media':
                media_ids.add(t_id)
            if j_id:
                job_ids.add(j_id)
    # the item's other versions (an upscale, an edit) came with it
    for chunk in _chunks(media_ids):
        gen_ids |= set(bind.execute(sa.select(generation.c.id).where(
            generation.c.target_type == 'media', generation.c.target_id.in_(chunk))).scalars())
    for table, ids in ((job, job_ids), (generation, gen_ids), (media_item, media_ids)):
        for chunk in _chunks(ids):
            bind.execute(sa.update(table).where(table.c.id.in_(chunk)).values(via_api=True))


def upgrade() -> None:
    for t in TABLES:
        op.add_column(t, sa.Column('via_api', sa.Boolean(), nullable=False, server_default=sa.text('0')))
        op.create_index(f'ix_{t}_via_api', t, ['via_api'])
    _mark_stories(op.get_bind())


def downgrade() -> None:
    for t in reversed(TABLES):
        op.drop_index(f'ix_{t}_via_api', table_name=t)
        # not batch mode: rebuilding project (or job) with foreign_keys=ON would cascade into its children.
        # SQLite 3.35+ and Postgres both drop a plain column in place
        op.execute(f'ALTER TABLE "{t}" DROP COLUMN via_api')
