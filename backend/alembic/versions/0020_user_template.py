"""Saved prompt templates per workspace (contract v31)

Revision ID: 0020
Revises: 0019
Create Date: 2026-10-14 18:00:00

"Save as template" from a result or the Generate / Edit forms. Rows go with their workspace; created_by is a
plain id so a template outlives the person who saved it.
"""
from alembic import op
import sqlalchemy as sa


revision = '0020'
down_revision = '0019'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'user_template',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('workspace_id', sa.String(length=36), nullable=False),
        sa.Column('created_by', sa.String(length=36), nullable=True),
        sa.Column('title', sa.String(length=120), nullable=False),
        sa.Column('description', sa.String(length=500), server_default='', nullable=False),
        sa.Column('target', sa.String(length=16), nullable=False),
        sa.Column('prompt', sa.Text(), nullable=False),
        sa.Column('negative', sa.Text(), server_default='', nullable=False),
        sa.Column('style', sa.String(length=40), nullable=True),
        sa.Column('model', sa.String(length=60), nullable=True),
        sa.Column('aspect', sa.String(length=8), nullable=True),
        sa.Column('count', sa.Integer(), server_default='1', nullable=False),
        sa.Column('ref_labels', sa.JSON(), nullable=False),
        sa.Column('examples', sa.JSON(), nullable=False),
        sa.Column('preview_generation_id', sa.String(length=36), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('updated_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['workspace_id'], ['workspace.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_user_template_workspace_id', 'user_template', ['workspace_id'])
    op.create_index('ix_user_template_ws_updated', 'user_template', ['workspace_id', 'updated_at'])


def downgrade() -> None:
    op.drop_index('ix_user_template_ws_updated', table_name='user_template')
    op.drop_index('ix_user_template_workspace_id', table_name='user_template')
    op.drop_table('user_template')
