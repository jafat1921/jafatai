"""AI video podcast (M11d / VP1): an episode turned into a multi-camera lip-synced video

Revision ID: 0017
Revises: 0016
Create Date: 2026-10-12 09:00:00
"""
from alembic import op
import sqlalchemy as sa


revision = '0017'
down_revision = '0016'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'video_podcast',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('workspace_id', sa.String(length=36), nullable=False),
        sa.Column('episode_id', sa.String(length=36), nullable=False),
        sa.Column('project_id', sa.String(length=36), nullable=False),
        sa.Column('stage', sa.String(length=20), nullable=False, server_default='cast'),
        sa.Column('stages', sa.JSON(), nullable=False),
        sa.Column('settings', sa.JSON(), nullable=False),
        sa.Column('hosts', sa.JSON(), nullable=False),
        sa.Column('set_location_id', sa.String(length=36), nullable=True),
        sa.Column('plan', sa.JSON(), nullable=False),
        sa.Column('outputs', sa.JSON(), nullable=False),
        sa.Column('job_id', sa.String(length=36), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('updated_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['workspace_id'], ['workspace.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['episode_id'], ['podcast_episode.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['project_id'], ['project.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_video_podcast_workspace_id', 'video_podcast', ['workspace_id'])
    op.create_index('ix_video_podcast_episode_id', 'video_podcast', ['episode_id'], unique=True)
    op.create_index('ix_video_podcast_project_id', 'video_podcast', ['project_id'])


def downgrade() -> None:
    op.drop_table('video_podcast')
