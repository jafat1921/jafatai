"""shot.camera_rack: the structured camera (size, angle, move, speed) from the P2 camera rack

Revision ID: 0007
Revises: 0006
Create Date: 2026-10-07 18:30:00

Additive only: one ADD COLUMN with a server default, so existing shots read back as {} and keep
their free-text camera.
"""
from alembic import op
import sqlalchemy as sa


revision = '0007'
down_revision = '0006'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('shot', sa.Column('camera_rack', sa.JSON(), nullable=False, server_default='{}'))


def downgrade() -> None:
    op.drop_column('shot', 'camera_rack')
