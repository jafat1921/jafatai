"""photo snapshots (M10 phase 2 / D1): named develop settings per picture, Lightroom's Snapshots panel

Revision ID: 0012
Revises: 0011
Create Date: 2026-10-09 21:00:00
"""
from alembic import op
import sqlalchemy as sa


revision = '0012'
down_revision = '0011'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'photo_snapshot',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('workspace_id', sa.String(length=36), nullable=False),
        sa.Column('target_type', sa.String(length=20), nullable=False),
        sa.Column('target_id', sa.String(length=36), nullable=False),
        sa.Column('base_id', sa.String(length=36), nullable=False),
        sa.Column('name', sa.String(length=120), nullable=False),
        sa.Column('params', sa.JSON(), nullable=False, server_default='{}'),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('updated_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['workspace_id'], ['workspace.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_photo_snapshot_workspace_id', 'photo_snapshot', ['workspace_id'])
    op.create_index('ix_photo_snapshot_target', 'photo_snapshot', ['target_type', 'target_id'])


def downgrade() -> None:
    op.drop_table('photo_snapshot')
