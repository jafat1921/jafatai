"""Ad Studio (M16, contract v36): brand-kit contact details and approved offer lines; ad campaigns

Revision ID: 0023
Revises: 0022
Create Date: 2026-10-15 20:00:00

The kit's contact block feeds an advert's footer and `claims` are the offer lines the copywriter may use
(it may never invent its own). A campaign's concepts, photos and per-format ads are JSON the stage job and
the editor write whole; the finished adverts are ordinary Library images.
"""
from alembic import op
import sqlalchemy as sa


revision = '0023'
down_revision = '0022'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('brand_kit', sa.Column('contact', sa.JSON(), nullable=False, server_default='{}'))
    op.add_column('brand_kit', sa.Column('claims', sa.JSON(), nullable=False, server_default='[]'))
    op.create_table(
        'ad_campaign',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('workspace_id', sa.String(length=36), nullable=False),
        sa.Column('via_api', sa.Boolean(), nullable=False, server_default=sa.text('0')),
        sa.Column('title', sa.String(length=200), server_default='', nullable=False),
        sa.Column('brand_kit_id', sa.String(length=36), nullable=True),
        sa.Column('language', sa.String(length=12), server_default='en', nullable=False),
        sa.Column('stage', sa.String(length=20), server_default='concepts', nullable=False),
        sa.Column('stages', sa.JSON(), nullable=False),
        sa.Column('brief', sa.JSON(), nullable=False),
        sa.Column('concepts', sa.JSON(), nullable=False),
        sa.Column('ads', sa.JSON(), nullable=False),
        sa.Column('job_id', sa.String(length=36), nullable=True),
        sa.Column('created_by', sa.String(length=36), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('updated_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['workspace_id'], ['workspace.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_ad_campaign_workspace_id', 'ad_campaign', ['workspace_id'])
    op.create_index('ix_ad_campaign_via_api', 'ad_campaign', ['via_api'])
    op.create_index('ix_ad_campaign_ws_updated', 'ad_campaign', ['workspace_id', 'updated_at'])


def downgrade() -> None:
    op.drop_index('ix_ad_campaign_ws_updated', table_name='ad_campaign')
    op.drop_index('ix_ad_campaign_via_api', table_name='ad_campaign')
    op.drop_index('ix_ad_campaign_workspace_id', table_name='ad_campaign')
    op.drop_table('ad_campaign')
    # plain DROP COLUMN, not batch mode: see 0022
    op.execute('ALTER TABLE "brand_kit" DROP COLUMN claims')
    op.execute('ALTER TABLE "brand_kit" DROP COLUMN contact')
