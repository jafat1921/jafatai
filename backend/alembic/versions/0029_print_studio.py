"""Print Studio (contract v41): ad_campaign.kind, "ad" for Ad Studio and "print" for print jobs

Revision ID: 0029
Revises: 0028
Create Date: 2026-10-18 12:00:00

A print job is an Ad Studio campaign with print settings in its brief; the kind keeps the two lists apart.
"""
from alembic import op
import sqlalchemy as sa


revision = '0029'
down_revision = '0028'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('ad_campaign', sa.Column('kind', sa.String(20), nullable=False, server_default='ad'))


def downgrade() -> None:
    # plain DROP COLUMN, not batch mode: see 0022
    op.execute('ALTER TABLE "ad_campaign" DROP COLUMN kind')
