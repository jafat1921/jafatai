"""podcast shows and episodes (M11c / C2): Podcast Studio

Revision ID: 0016
Revises: 0015
Create Date: 2026-10-12 01:00:00
"""
from alembic import op
import sqlalchemy as sa


revision = '0016'
down_revision = '0015'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'podcast_show',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('workspace_id', sa.String(length=36), nullable=False),
        sa.Column('name', sa.String(length=200), nullable=False),
        sa.Column('description', sa.Text(), nullable=False, server_default=''),
        sa.Column('author', sa.String(length=200), nullable=False, server_default=''),
        sa.Column('language', sa.String(length=12), nullable=False, server_default='en'),
        sa.Column('cover_media_id', sa.String(length=36), nullable=True),
        sa.Column('hosts', sa.JSON(), nullable=False),
        sa.Column('music', sa.JSON(), nullable=False),
        sa.Column('ads', sa.JSON(), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('updated_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['workspace_id'], ['workspace.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_podcast_show_workspace_id', 'podcast_show', ['workspace_id'])
    op.create_index('ix_podcast_show_ws_updated', 'podcast_show', ['workspace_id', 'updated_at'])

    op.create_table(
        'podcast_episode',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('workspace_id', sa.String(length=36), nullable=False),
        sa.Column('show_id', sa.String(length=36), nullable=True),
        sa.Column('title', sa.String(length=200), nullable=False),
        sa.Column('format', sa.String(length=20), nullable=False, server_default='conversation'),
        sa.Column('language', sa.String(length=12), nullable=False, server_default='en'),
        sa.Column('target_minutes', sa.Float(), nullable=False, server_default='5'),
        sa.Column('step', sa.Integer(), nullable=False, server_default='1'),
        sa.Column('cover_media_id', sa.String(length=36), nullable=True),
        sa.Column('sources', sa.JSON(), nullable=False),
        sa.Column('hosts', sa.JSON(), nullable=False),
        sa.Column('chapters', sa.JSON(), nullable=False),
        sa.Column('script_id', sa.String(length=36), nullable=True),
        sa.Column('settings', sa.JSON(), nullable=False),
        sa.Column('notes', sa.JSON(), nullable=True),
        sa.Column('outputs', sa.JSON(), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('updated_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['workspace_id'], ['workspace.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['show_id'], ['podcast_show.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['script_id'], ['voice_script.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_podcast_episode_workspace_id', 'podcast_episode', ['workspace_id'])
    op.create_index('ix_podcast_episode_show_id', 'podcast_episode', ['show_id'])
    op.create_index('ix_podcast_episode_ws_updated', 'podcast_episode', ['workspace_id', 'updated_at'])


def downgrade() -> None:
    op.drop_table('podcast_episode')
    op.drop_table('podcast_show')
