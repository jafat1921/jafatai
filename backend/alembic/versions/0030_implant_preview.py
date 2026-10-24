"""Implant Preview (M22): user.implant_access, implant_patient, implant_session

Revision ID: 0030
Revises: 0029
Create Date: 2026-10-24 12:00:00

Opt-in per account: everyone starts without it. Photos and results are generation rows; their files sit under
data/clinic/, so this migration has nothing to move.
"""
from alembic import op
import sqlalchemy as sa


revision = '0030'
down_revision = '0029'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('user', sa.Column('implant_access', sa.Boolean(), nullable=False, server_default=sa.text('0')))
    op.create_table(
        'implant_patient',
        sa.Column('id', sa.String(36), primary_key=True),
        sa.Column('workspace_id', sa.String(36), sa.ForeignKey('workspace.id', ondelete='CASCADE'), nullable=False),
        sa.Column('surgeon_user_id', sa.String(36), sa.ForeignKey('user.id', ondelete='CASCADE'), nullable=False),
        sa.Column('label', sa.String(120), nullable=False),
        sa.Column('adult_confirmed', sa.Boolean(), nullable=False),
        sa.Column('consent', sa.JSON(), nullable=False),
        sa.Column('measurements', sa.JSON(), nullable=False),
        sa.Column('notes', sa.Text(), nullable=False),
        sa.Column('retention_months', sa.Integer(), nullable=False),
        sa.Column('chart', sa.JSON(), nullable=False),
        sa.Column('last_activity_at', sa.DateTime(), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('updated_at', sa.DateTime(), nullable=False),
    )
    op.create_index('ix_implant_patient_workspace_id', 'implant_patient', ['workspace_id'])
    op.create_index('ix_implant_patient_surgeon_user_id', 'implant_patient', ['surgeon_user_id'])
    op.create_table(
        'implant_session',
        sa.Column('id', sa.String(36), primary_key=True),
        sa.Column('patient_id', sa.String(36), sa.ForeignKey('implant_patient.id', ondelete='CASCADE'),
                  nullable=False),
        sa.Column('options', sa.JSON(), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=False),
    )
    op.create_index('ix_implant_session_patient_id', 'implant_session', ['patient_id'])


def downgrade() -> None:
    op.drop_table('implant_session')
    op.drop_table('implant_patient')
    # plain DROP COLUMN, not batch mode: see 0022
    op.execute('ALTER TABLE "user" DROP COLUMN implant_access')
