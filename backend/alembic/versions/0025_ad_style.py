"""Brand kit ad style (contract v36 §9): the style rules read from the brand's own adverts

Revision ID: 0025
Revises: 0024
Create Date: 2026-10-16 10:00:00
"""
from alembic import op
import sqlalchemy as sa


revision = '0025'
down_revision = '0024'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('brand_kit', sa.Column('ad_style', sa.JSON(), nullable=False, server_default='{}'))


def downgrade() -> None:
    # plain DROP COLUMN, not batch mode: see 0022
    op.execute('ALTER TABLE "brand_kit" DROP COLUMN ad_style')
