"""ai suggestions

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-04 12:00:00
"""
from alembic import op
import sqlalchemy as sa


revision = '0002'
down_revision = '0001'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'suggestion',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('workspace_id', sa.String(length=36), nullable=False),
        sa.Column('project_id', sa.String(length=36), nullable=False),
        sa.Column('target_type', sa.String(length=20), nullable=False),
        sa.Column('target_id', sa.String(length=36), nullable=False),
        sa.Column('field', sa.String(length=40), nullable=False),
        sa.Column('current_text', sa.Text(), nullable=False),
        sa.Column('proposed_text', sa.Text(), nullable=False),
        sa.Column('action', sa.String(length=40), nullable=False),
        sa.Column('status', sa.String(length=20), nullable=False),
        sa.Column('job_id', sa.String(length=36), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('resolved_at', sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(['job_id'], ['job.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['project_id'], ['project.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['workspace_id'], ['workspace.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    with op.batch_alter_table('suggestion', schema=None) as batch_op:
        batch_op.create_index('ix_suggestion_project_id', ['project_id'], unique=False)
        batch_op.create_index('ix_suggestion_workspace_id', ['workspace_id'], unique=False)
        batch_op.create_index('ix_suggestion_target', ['target_type', 'target_id', 'status'], unique=False)


def downgrade() -> None:
    with op.batch_alter_table('suggestion', schema=None) as batch_op:
        batch_op.drop_index('ix_suggestion_target')
        batch_op.drop_index('ix_suggestion_workspace_id')
        batch_op.drop_index('ix_suggestion_project_id')
    op.drop_table('suggestion')
