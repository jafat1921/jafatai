"""job lanes (two GPUs): job.lane image | video | general

Revision ID: 0009
Revises: 0008
Create Date: 2026-10-08 10:00:00

Additive only: one NOT NULL column with a server default, so every old row reads 'general'.
Existing jobs are then classified like new ones (app.lanes). Waiting and running ones matter most (a lane
worker would never pick up an image job queued before the upgrade); finished ones because Retry requeues them.
"""
from alembic import op
import sqlalchemy as sa

from app.lanes import lane_for

revision = '0009'
down_revision = '0008'
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table('job') as batch:
        batch.add_column(sa.Column('lane', sa.String(length=10), nullable=False, server_default='general'))
    op.create_index('ix_job_lane', 'job', ['lane'])

    conn = op.get_bind()
    rows = conn.execute(sa.text(
        "SELECT job.id, job.type, generation.kind FROM job LEFT JOIN generation ON generation.id = job.generation_id"
    )).fetchall()
    for job_id, job_type, kind in rows:
        lane = lane_for(job_type, kind)
        if lane != 'general':
            conn.execute(sa.text("UPDATE job SET lane = :lane WHERE id = :id"), {"lane": lane, "id": job_id})


def downgrade() -> None:
    op.drop_index('ix_job_lane', table_name='job')
    with op.batch_alter_table('job') as batch:
        batch.drop_column('lane')
