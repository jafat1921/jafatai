"""Personal access tokens for the REST API (M12c, contract v27)

Revision ID: 0019
Revises: 0018
Create Date: 2026-10-14 16:00:00

One row per token. The secret itself is never stored: token_hash is its sha256 and prefix (unique) is how a
presented token finds its row before the constant-time compare.
"""
from alembic import op
import sqlalchemy as sa


revision = '0019'
down_revision = '0018'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'api_token',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('user_id', sa.String(length=36), nullable=False),
        sa.Column('workspace_id', sa.String(length=36), nullable=False),
        sa.Column('name', sa.String(length=120), nullable=False),
        sa.Column('prefix', sa.String(length=16), nullable=False),
        sa.Column('token_hash', sa.String(length=64), nullable=False),
        sa.Column('scopes', sa.JSON(), nullable=False),
        sa.Column('expires_at', sa.DateTime(), nullable=True),
        sa.Column('last_used_at', sa.DateTime(), nullable=True),
        sa.Column('revoked_at', sa.DateTime(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['user_id'], ['user.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['workspace_id'], ['workspace.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('prefix'),
    )
    op.create_index('ix_api_token_user_id', 'api_token', ['user_id'])
    op.create_index('ix_api_token_workspace_id', 'api_token', ['workspace_id'])


def downgrade() -> None:
    op.drop_index('ix_api_token_workspace_id', table_name='api_token')
    op.drop_index('ix_api_token_user_id', table_name='api_token')
    op.drop_table('api_token')
