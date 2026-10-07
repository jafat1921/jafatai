"""brand kits: brand_kit, project.settings, shot.brand_placements

Revision ID: 0006
Revises: 0005
Create Date: 2026-10-07 18:00:00

Additive only. Both new columns are plain ADD COLUMNs with server defaults, so existing
rows read back as {} / [] and no table gets rebuilt.
"""
from alembic import op
import sqlalchemy as sa


revision = '0006'
down_revision = '0005'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'brand_kit',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('workspace_id', sa.String(length=36), nullable=False),
        sa.Column('name', sa.String(length=200), nullable=False),
        sa.Column('is_default', sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column('palette', sa.JSON(), nullable=False, server_default='[]'),
        sa.Column('style_text', sa.Text(), nullable=False, server_default=''),
        sa.Column('voice_text', sa.Text(), nullable=False, server_default=''),
        sa.Column('tagline', sa.String(length=300), nullable=False, server_default=''),
        sa.Column('logos', sa.JSON(), nullable=False, server_default='{}'),
        sa.Column('products', sa.JSON(), nullable=False, server_default='[]'),
        sa.Column('font_files', sa.JSON(), nullable=False, server_default='[]'),
        sa.Column('reference_media_ids', sa.JSON(), nullable=False, server_default='[]'),
        sa.Column('settings', sa.JSON(), nullable=False, server_default='{}'),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('updated_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['workspace_id'], ['workspace.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_brand_kit_workspace_id', 'brand_kit', ['workspace_id'], unique=False)
    op.create_index('ix_brand_kit_updated_at', 'brand_kit', ['updated_at'], unique=False)
    op.add_column('project', sa.Column('settings', sa.JSON(), nullable=False, server_default='{}'))
    op.add_column('shot', sa.Column('brand_placements', sa.JSON(), nullable=False, server_default='[]'))


def downgrade() -> None:
    op.drop_column('shot', 'brand_placements')
    op.drop_column('project', 'settings')
    op.drop_index('ix_brand_kit_updated_at', table_name='brand_kit')
    op.drop_index('ix_brand_kit_workspace_id', table_name='brand_kit')
    op.drop_table('brand_kit')
