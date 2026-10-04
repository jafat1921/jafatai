"""reel: reel, reel_clip, shot.beats

Revision ID: 0004
Revises: 0003
Create Date: 2026-10-04 20:00:00

Additive only. shot.beats is a plain ADD COLUMN with a server default so existing rows
read back as []. Generation kinds 'mezzanine'/'render' need no schema change (kind is a
free string column); they are validated in the API layer.
"""
from alembic import op
import sqlalchemy as sa


revision = '0004'
down_revision = '0003'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('shot', sa.Column('beats', sa.JSON(), nullable=False, server_default='[]'))

    op.create_table(
        'reel',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('workspace_id', sa.String(length=36), nullable=False),
        sa.Column('project_id', sa.String(length=36), nullable=False),
        sa.Column('title', sa.String(length=300), nullable=False, server_default=''),
        sa.Column('settings', sa.JSON(), nullable=False, server_default='{}'),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('updated_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['project_id'], ['project.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['workspace_id'], ['workspace.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('project_id', name='uq_reel_project'),
    )
    op.create_index('ix_reel_workspace_id', 'reel', ['workspace_id'], unique=False)
    op.create_index('ix_reel_updated_at', 'reel', ['updated_at'], unique=False)

    op.create_table(
        'reel_clip',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('workspace_id', sa.String(length=36), nullable=False),
        sa.Column('reel_id', sa.String(length=36), nullable=False),
        sa.Column('shot_id', sa.String(length=36), nullable=False),
        sa.Column('scene_id', sa.String(length=36), nullable=False),
        # plain string: takes get bulk-deleted with their shot, and sync copes with a dangling id
        sa.Column('generation_id', sa.String(length=36), nullable=True),
        sa.Column('sort_order', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('trim_in_s', sa.Float(), nullable=False, server_default='0'),
        sa.Column('trim_out_s', sa.Float(), nullable=False, server_default='0'),
        sa.Column('transition_in', sa.String(length=12), nullable=False, server_default='cut'),
        sa.Column('transition_s', sa.Float(), nullable=False, server_default='0.5'),
        sa.Column('enabled', sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column('changed', sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column('source_duration_s', sa.Float(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('updated_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['reel_id'], ['reel.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['shot_id'], ['shot.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['scene_id'], ['scene.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['workspace_id'], ['workspace.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('reel_id', 'shot_id', name='uq_reel_clip_shot'),
    )
    op.create_index('ix_reel_clip_reel_id', 'reel_clip', ['reel_id'], unique=False)
    op.create_index('ix_reel_clip_scene_id', 'reel_clip', ['scene_id'], unique=False)
    op.create_index('ix_reel_clip_workspace_id', 'reel_clip', ['workspace_id'], unique=False)
    op.create_index('ix_reel_clip_updated_at', 'reel_clip', ['updated_at'], unique=False)


def downgrade() -> None:
    op.drop_index('ix_reel_clip_updated_at', table_name='reel_clip')
    op.drop_index('ix_reel_clip_workspace_id', table_name='reel_clip')
    op.drop_index('ix_reel_clip_scene_id', table_name='reel_clip')
    op.drop_index('ix_reel_clip_reel_id', table_name='reel_clip')
    op.drop_table('reel_clip')
    op.drop_index('ix_reel_updated_at', table_name='reel')
    op.drop_index('ix_reel_workspace_id', table_name='reel')
    op.drop_table('reel')
    op.drop_column('shot', 'beats')
