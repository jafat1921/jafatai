"""media library: media_item

Revision ID: 0005
Revises: 0004
Create Date: 2026-10-07 15:00:00

Additive only: one new table. Standalone generations use target_type 'media' and kinds
'image' / 'upload' / 'video', which need no schema change (free string columns).
"""
from alembic import op
import sqlalchemy as sa


revision = '0005'
down_revision = '0004'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'media_item',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('workspace_id', sa.String(length=36), nullable=False),
        sa.Column('kind', sa.String(length=10), nullable=False),
        sa.Column('origin', sa.String(length=20), nullable=False),
        sa.Column('title', sa.String(length=300), nullable=False, server_default=''),
        sa.Column('tags', sa.JSON(), nullable=False, server_default='[]'),
        sa.Column('project_id', sa.String(length=36), nullable=True),
        sa.Column('generation_id', sa.String(length=36), nullable=True),
        sa.Column('width', sa.Integer(), nullable=True),
        sa.Column('height', sa.Integer(), nullable=True),
        sa.Column('duration_s', sa.Float(), nullable=True),
        sa.Column('thumb_path', sa.String(length=500), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('updated_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['workspace_id'], ['workspace.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['project_id'], ['project.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_media_item_workspace_id', 'media_item', ['workspace_id'], unique=False)
    op.create_index('ix_media_item_project_id', 'media_item', ['project_id'], unique=False)
    op.create_index('ix_media_item_updated_at', 'media_item', ['updated_at'], unique=False)
    op.create_index('ix_media_item_ws_created', 'media_item', ['workspace_id', 'created_at'], unique=False)


def downgrade() -> None:
    op.drop_index('ix_media_item_ws_created', table_name='media_item')
    op.drop_index('ix_media_item_updated_at', table_name='media_item')
    op.drop_index('ix_media_item_project_id', table_name='media_item')
    op.drop_index('ix_media_item_workspace_id', table_name='media_item')
    op.drop_table('media_item')
