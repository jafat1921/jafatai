"""photo studio looks (contract v9): new table look

Revision ID: 0010
Revises: 0009
Create Date: 2026-10-09 12:00:00

Additive only: one new table, nothing existing is touched. Built-in looks are not inserted here; the app
upserts them at start-up (app.photo.looks.ensure_builtins) so their params can change without a migration.
"""
from alembic import op
import sqlalchemy as sa

revision = '0010'
down_revision = '0009'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'look',
        sa.Column('id', sa.String(length=36), primary_key=True),
        sa.Column('workspace_id', sa.String(length=36), sa.ForeignKey('workspace.id', ondelete='CASCADE'),
                  nullable=True),
        sa.Column('name', sa.String(length=200), nullable=False),
        sa.Column('description', sa.Text(), nullable=False, server_default=''),
        sa.Column('category', sa.String(length=80), nullable=False, server_default=''),
        sa.Column('params', sa.JSON(), nullable=False, server_default='{}'),
        sa.Column('cube_path', sa.String(length=500), nullable=True),
        sa.Column('cube_size', sa.Integer(), nullable=True),
        sa.Column('source', sa.String(length=20), nullable=False),
        sa.Column('thumb_path', sa.String(length=500), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('updated_at', sa.DateTime(), nullable=False),
    )
    op.create_index('ix_look_workspace_id', 'look', ['workspace_id'])


def downgrade() -> None:
    op.drop_index('ix_look_workspace_id', table_name='look')
    op.drop_table('look')
