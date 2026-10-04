"""storyboard: locations, shots, scene.location_id, project.style_bible

Revision ID: 0003
Revises: 0002
Create Date: 2026-10-04 18:00:00

Additive only. Columns on existing tables are plain ADD COLUMNs (no batch rebuild):
rebuilding `scene` on SQLite with foreign_keys=ON would cascade-delete scene_version rows.
"""
from alembic import op
import sqlalchemy as sa


revision = '0003'
down_revision = '0002'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('project', sa.Column('style_bible', sa.Text(), nullable=False, server_default=''))
    op.add_column('scene', sa.Column('location_id', sa.String(length=36), nullable=True))
    op.create_index('ix_scene_location_id', 'scene', ['location_id'], unique=False)

    op.create_table(
        'location',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('workspace_id', sa.String(length=36), nullable=False),
        sa.Column('project_id', sa.String(length=36), nullable=False),
        sa.Column('name', sa.String(length=200), nullable=False),
        sa.Column('description', sa.Text(), nullable=False),
        sa.Column('source', sa.String(length=20), nullable=False),
        sa.Column('locked', sa.Boolean(), nullable=False),
        sa.Column('time_of_day_variants', sa.JSON(), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('updated_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['project_id'], ['project.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['workspace_id'], ['workspace.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_location_project_id', 'location', ['project_id'], unique=False)
    op.create_index('ix_location_workspace_id', 'location', ['workspace_id'], unique=False)

    op.create_table(
        'shot',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('workspace_id', sa.String(length=36), nullable=False),
        sa.Column('project_id', sa.String(length=36), nullable=False),
        sa.Column('scene_id', sa.String(length=36), nullable=False),
        sa.Column('sort_order', sa.Integer(), nullable=False),
        sa.Column('shot_type', sa.String(length=30), nullable=False),
        sa.Column('duration_s', sa.Float(), nullable=False),
        sa.Column('description', sa.Text(), nullable=False),
        sa.Column('camera', sa.String(length=300), nullable=False),
        sa.Column('prompt', sa.Text(), nullable=False),
        sa.Column('prompt_mode', sa.String(length=10), nullable=False),
        sa.Column('start_prompt', sa.Text(), nullable=False),
        sa.Column('end_prompt', sa.Text(), nullable=False),
        sa.Column('motion_prompt', sa.Text(), nullable=False),
        sa.Column('character_ids', sa.JSON(), nullable=False),
        sa.Column('location_id', sa.String(length=36), nullable=True),
        sa.Column('seam_in', sa.String(length=10), nullable=False),
        sa.Column('handoff_text', sa.Text(), nullable=False),
        sa.Column('stale', sa.Boolean(), nullable=False),
        sa.Column('source', sa.String(length=20), nullable=False),
        sa.Column('locked', sa.Boolean(), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('updated_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['project_id'], ['project.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['scene_id'], ['scene.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['workspace_id'], ['workspace.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_shot_project_id', 'shot', ['project_id'], unique=False)
    op.create_index('ix_shot_scene_id', 'shot', ['scene_id'], unique=False)
    op.create_index('ix_shot_workspace_id', 'shot', ['workspace_id'], unique=False)
    op.create_index('ix_shot_updated_at', 'shot', ['updated_at'], unique=False)


def downgrade() -> None:
    op.drop_index('ix_shot_updated_at', table_name='shot')
    op.drop_index('ix_shot_workspace_id', table_name='shot')
    op.drop_index('ix_shot_scene_id', table_name='shot')
    op.drop_index('ix_shot_project_id', table_name='shot')
    op.drop_table('shot')
    op.drop_index('ix_location_workspace_id', table_name='location')
    op.drop_index('ix_location_project_id', table_name='location')
    op.drop_table('location')
    op.drop_index('ix_scene_location_id', table_name='scene')
    # drop_column on SQLite needs 3.35+; fine for a dev-only downgrade
    op.drop_column('scene', 'location_id')
    op.drop_column('project', 'style_bible')
