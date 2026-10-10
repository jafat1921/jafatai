"""dub projects and transcripts (M11b / B4): Dub a video, and the Transcribe page

Revision ID: 0015
Revises: 0014
Create Date: 2026-10-11 01:00:00
"""
from alembic import op
import sqlalchemy as sa


revision = '0015'
down_revision = '0014'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'dub_project',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('workspace_id', sa.String(length=36), nullable=False),
        sa.Column('video_id', sa.String(length=36), nullable=False),
        sa.Column('video_generation_id', sa.String(length=36), nullable=False),
        sa.Column('title', sa.String(length=200), nullable=False),
        sa.Column('source_language', sa.String(length=12), nullable=True),
        sa.Column('targets', sa.JSON(), nullable=False),
        sa.Column('stage', sa.String(length=20), nullable=False, server_default='extract'),
        sa.Column('stages', sa.JSON(), nullable=False),
        sa.Column('speakers', sa.JSON(), nullable=False),
        sa.Column('segments', sa.JSON(), nullable=False),
        sa.Column('glossary', sa.JSON(), nullable=False),
        sa.Column('settings', sa.JSON(), nullable=False),
        sa.Column('tracks', sa.JSON(), nullable=False),
        sa.Column('duration_s', sa.Float(), nullable=True),
        sa.Column('job_id', sa.String(length=36), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('updated_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['workspace_id'], ['workspace.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_dub_project_workspace_id', 'dub_project', ['workspace_id'])
    op.create_index('ix_dub_project_video_id', 'dub_project', ['video_id'])
    op.create_index('ix_dub_project_ws_updated', 'dub_project', ['workspace_id', 'updated_at'])

    op.create_table(
        'transcript',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('workspace_id', sa.String(length=36), nullable=False),
        sa.Column('media_id', sa.String(length=36), nullable=False),
        sa.Column('generation_id', sa.String(length=36), nullable=True),
        sa.Column('title', sa.String(length=300), nullable=False, server_default=''),
        sa.Column('language', sa.String(length=12), nullable=True),
        sa.Column('words', sa.Boolean(), nullable=False, server_default=sa.text('1')),
        sa.Column('status', sa.String(length=20), nullable=False, server_default='queued'),
        sa.Column('text', sa.Text(), nullable=False, server_default=''),
        sa.Column('segments', sa.JSON(), nullable=False),
        sa.Column('cleanup_text', sa.Text(), nullable=True),
        sa.Column('duration_s', sa.Float(), nullable=True),
        sa.Column('error', sa.Text(), nullable=True),
        sa.Column('job_id', sa.String(length=36), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('updated_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['workspace_id'], ['workspace.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_transcript_workspace_id', 'transcript', ['workspace_id'])
    op.create_index('ix_transcript_media_id', 'transcript', ['media_id'])
    op.create_index('ix_transcript_ws_created', 'transcript', ['workspace_id', 'created_at'])


def downgrade() -> None:
    op.drop_table('transcript')
    op.drop_table('dub_project')
