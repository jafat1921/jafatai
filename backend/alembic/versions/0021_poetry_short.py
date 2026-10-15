"""Poetry Shorts (M15, contract v33): a sung poem cut into a short video

Revision ID: 0021
Revises: 0020
Create Date: 2026-10-15 10:00:00

One row per Short. Poem lines, their timings, the scenes and the outputs are JSON the stage job writes whole;
the song, keyframes and clips are ordinary generations.
"""
from alembic import op
import sqlalchemy as sa


revision = '0021'
down_revision = '0020'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'poetry_short',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('workspace_id', sa.String(length=36), nullable=False),
        sa.Column('title', sa.String(length=200), server_default='', nullable=False),
        sa.Column('language', sa.String(length=12), server_default='ur', nullable=False),
        sa.Column('stage', sa.String(length=20), server_default='poem', nullable=False),
        sa.Column('stages', sa.JSON(), nullable=False),
        sa.Column('settings', sa.JSON(), nullable=False),
        sa.Column('poem', sa.JSON(), nullable=False),
        sa.Column('lines', sa.JSON(), nullable=False),
        sa.Column('song', sa.JSON(), nullable=False),
        sa.Column('timing', sa.JSON(), nullable=False),
        sa.Column('scenes', sa.JSON(), nullable=False),
        sa.Column('outputs', sa.JSON(), nullable=False),
        sa.Column('job_id', sa.String(length=36), nullable=True),
        sa.Column('created_by', sa.String(length=36), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('updated_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['workspace_id'], ['workspace.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_poetry_short_workspace_id', 'poetry_short', ['workspace_id'])
    op.create_index('ix_poetry_short_ws_updated', 'poetry_short', ['workspace_id', 'updated_at'])


def downgrade() -> None:
    op.drop_index('ix_poetry_short_ws_updated', table_name='poetry_short')
    op.drop_index('ix_poetry_short_workspace_id', table_name='poetry_short')
    op.drop_table('poetry_short')
