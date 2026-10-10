"""voice scripts (M11b / B3): dialogue and narration projects with a cast and fingerprinted lines

Revision ID: 0014
Revises: 0013
Create Date: 2026-10-10 23:30:00
"""
from alembic import op
import sqlalchemy as sa


revision = '0014'
down_revision = '0013'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'voice_script',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('workspace_id', sa.String(length=36), nullable=False),
        sa.Column('title', sa.String(length=200), nullable=False),
        sa.Column('language', sa.String(length=12), nullable=False, server_default='en'),
        sa.Column('engine', sa.String(length=20), nullable=False, server_default='auto'),
        sa.Column('project_id', sa.String(length=36), nullable=True),
        sa.Column('cast', sa.JSON(), nullable=False),
        sa.Column('lines', sa.JSON(), nullable=False),
        sa.Column('settings', sa.JSON(), nullable=False),
        sa.Column('mix', sa.JSON(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('updated_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['workspace_id'], ['workspace.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['project_id'], ['project.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_voice_script_workspace_id', 'voice_script', ['workspace_id'])
    op.create_index('ix_voice_script_project_id', 'voice_script', ['project_id'])
    op.create_index('ix_voice_script_ws_updated', 'voice_script', ['workspace_id', 'updated_at'])


def downgrade() -> None:
    op.drop_table('voice_script')
