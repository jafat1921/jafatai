"""voice profiles (M11b / B2): the Voice studio library of cloned, designed and preset voices

Revision ID: 0013
Revises: 0012
Create Date: 2026-10-10 22:00:00
"""
from alembic import op
import sqlalchemy as sa


revision = '0013'
down_revision = '0012'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'voice_profile',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('workspace_id', sa.String(length=36), nullable=False),
        sa.Column('name', sa.String(length=120), nullable=False),
        sa.Column('kind', sa.String(length=10), nullable=False),
        sa.Column('language', sa.String(length=12), nullable=False, server_default='en'),
        sa.Column('notes', sa.Text(), nullable=False, server_default=''),
        sa.Column('gender_hint', sa.String(length=10), nullable=True),
        sa.Column('ref_media_id', sa.String(length=36), nullable=True),
        sa.Column('ref_generation_id', sa.String(length=36), nullable=True),
        sa.Column('ref_duration_s', sa.Float(), nullable=True),
        sa.Column('ref_text', sa.Text(), nullable=False, server_default=''),
        sa.Column('design', sa.JSON(), nullable=True),
        sa.Column('preset', sa.JSON(), nullable=True),
        sa.Column('portrait_media_id', sa.String(length=36), nullable=True),
        sa.Column('starred', sa.Boolean(), nullable=False, server_default=sa.text('0')),
        sa.Column('locked', sa.Boolean(), nullable=False, server_default=sa.text('0')),
        sa.Column('consent', sa.JSON(), nullable=True),
        sa.Column('uses', sa.Integer(), nullable=False, server_default=sa.text('0')),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('updated_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['workspace_id'], ['workspace.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_voice_profile_workspace_id', 'voice_profile', ['workspace_id'])
    op.create_index('ix_voice_profile_kind', 'voice_profile', ['kind'])
    op.create_index('ix_voice_profile_language', 'voice_profile', ['language'])
    op.create_index('ix_voice_profile_ref_media_id', 'voice_profile', ['ref_media_id'])
    op.create_index('ix_voice_profile_starred', 'voice_profile', ['starred'])
    op.create_index('ix_voice_profile_ws_created', 'voice_profile', ['workspace_id', 'created_at'])


def downgrade() -> None:
    op.drop_table('voice_profile')
