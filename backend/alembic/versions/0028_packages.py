"""Packages (contract v39): packages, subscriptions, usage grants, payments, the admin audit log

Revision ID: 0028
Revises: 0027
Create Date: 2026-10-17 20:00:00

Seeds Free (everyone's fallback), Demo (7 days) and Pro, and puts every non-admin already here on Free. Admins
stay unlimited whatever they hold, so they get no row.
"""
import uuid
from datetime import datetime, timezone

from alembic import op
import sqlalchemy as sa


revision = '0028'
down_revision = '0027'
branch_labels = None
depends_on = None

# the same three as app.packages.DEFAULTS, copied so this file never changes when that one does
SEED = (
    dict(slug='free', name='Free', description='For trying the studio out.', price_pkr=0, period='none', days=None,
         gpu_min_day=30.0, max_queued=2, kind='standard', public=True, sort=0),
    dict(slug='demo', name='Demo (7 days)', description='A week with room to explore.', price_pkr=0, period='none',
         days=7, gpu_min_day=120.0, max_queued=4, kind='demo', public=False, sort=1),
    dict(slug='pro', name='Pro', description='For regular work.', price_pkr=0, period='month', days=None,
         gpu_min_day=240.0, max_queued=6, kind='standard', public=True, sort=2),
)

USER_COLS = ('limit_gpu_min_day', 'limit_gpu_min_month', 'limit_max_queued')


def _seed(bind) -> None:
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    package = sa.table('package', *(sa.column(c) for c in (
        'id', 'slug', 'name', 'description', 'price_pkr', 'period', 'days', 'gpu_min_day', 'gpu_min_month',
        'max_queued', 'private_items', 'kind', 'public', 'active', 'sort', 'created_at', 'updated_at')),
        sa.column('models', sa.JSON), sa.column('features', sa.JSON))
    ids = {}
    for row in SEED:
        ids[row['slug']] = str(uuid.uuid4())
        bind.execute(sa.insert(package).values(id=ids[row['slug']], gpu_min_month=None, private_items=False,
                                               models=None, features={}, active=True, created_at=now,
                                               updated_at=now, **row))
    user = sa.table('user', sa.column('id'), sa.column('is_admin'))
    sub = sa.table('subscription', *(sa.column(c) for c in (
        'id', 'user_id', 'package_id', 'starts_at', 'ends_at', 'status', 'source', 'notes', 'created_at',
        'updated_at')))
    for (uid,) in bind.execute(sa.select(user.c.id).where(user.c.is_admin == sa.false())).all():
        bind.execute(sa.insert(sub).values(id=str(uuid.uuid4()), user_id=uid, package_id=ids['free'],
                                           starts_at=now, ends_at=None, status='active', source='signup_default',
                                           notes='', created_at=now, updated_at=now))


def upgrade() -> None:
    op.add_column('user', sa.Column('limit_gpu_min_day', sa.Float(), nullable=True))
    op.add_column('user', sa.Column('limit_gpu_min_month', sa.Float(), nullable=True))
    op.add_column('user', sa.Column('limit_max_queued', sa.Integer(), nullable=True))
    op.create_index('ix_job_user_lane_started', 'job', ['user_id', 'lane', 'started_at'])

    op.create_table(
        'package',
        sa.Column('id', sa.String(36), primary_key=True),
        sa.Column('slug', sa.String(60), nullable=True, unique=True),
        sa.Column('name', sa.String(120), nullable=False),
        sa.Column('description', sa.String(1000), nullable=False, server_default=''),
        sa.Column('price_pkr', sa.Integer(), nullable=False, server_default=sa.text('0')),
        sa.Column('period', sa.String(10), nullable=False, server_default='month'),
        sa.Column('days', sa.Integer(), nullable=True),
        sa.Column('gpu_min_day', sa.Float(), nullable=True),
        sa.Column('gpu_min_month', sa.Float(), nullable=True),
        sa.Column('max_queued', sa.Integer(), nullable=True),
        sa.Column('private_items', sa.Boolean(), nullable=False, server_default=sa.text('0')),
        sa.Column('models', sa.JSON(), nullable=True),
        sa.Column('features', sa.JSON(), nullable=False),
        sa.Column('kind', sa.String(10), nullable=False, server_default='standard'),
        sa.Column('public', sa.Boolean(), nullable=False, server_default=sa.text('0')),
        sa.Column('custom_for_user_id', sa.String(36), nullable=True),
        sa.Column('active', sa.Boolean(), nullable=False, server_default=sa.text('1')),
        sa.Column('sort', sa.Integer(), nullable=False, server_default=sa.text('0')),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('updated_at', sa.DateTime(), nullable=False),
    )
    op.create_index('ix_package_custom_for_user_id', 'package', ['custom_for_user_id'])

    op.create_table(
        'subscription',
        sa.Column('id', sa.String(36), primary_key=True),
        sa.Column('user_id', sa.String(36), sa.ForeignKey('user.id', ondelete='CASCADE'), nullable=False),
        sa.Column('package_id', sa.String(36), sa.ForeignKey('package.id'), nullable=False),
        sa.Column('starts_at', sa.DateTime(), nullable=False),
        sa.Column('ends_at', sa.DateTime(), nullable=True),
        sa.Column('status', sa.String(20), nullable=False),
        sa.Column('source', sa.String(20), nullable=False),
        sa.Column('notes', sa.String(1000), nullable=False, server_default=''),
        sa.Column('granted_by', sa.String(36), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('updated_at', sa.DateTime(), nullable=False),
    )
    op.create_index('ix_subscription_user_status', 'subscription', ['user_id', 'status'])
    op.create_index('ix_subscription_package_id', 'subscription', ['package_id'])
    op.create_index('ix_subscription_ends_at', 'subscription', ['ends_at'])

    op.create_table(
        'usage_grant',
        sa.Column('id', sa.String(36), primary_key=True),
        sa.Column('user_id', sa.String(36), sa.ForeignKey('user.id', ondelete='CASCADE'), nullable=False),
        sa.Column('gpu_min', sa.Float(), nullable=False),
        sa.Column('reason', sa.String(500), nullable=False, server_default=''),
        sa.Column('starts_at', sa.DateTime(), nullable=False),
        sa.Column('expires_at', sa.DateTime(), nullable=True),
        sa.Column('revoked_at', sa.DateTime(), nullable=True),
        sa.Column('granted_by', sa.String(36), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False),
    )
    op.create_index('ix_usage_grant_user_id', 'usage_grant', ['user_id'])

    op.create_table(
        'payment',
        sa.Column('id', sa.String(36), primary_key=True),
        sa.Column('user_id', sa.String(36), sa.ForeignKey('user.id', ondelete='CASCADE'), nullable=False),
        sa.Column('subscription_id', sa.String(36), nullable=True),
        sa.Column('package_id', sa.String(36), nullable=True),
        sa.Column('gateway', sa.String(40), nullable=False, server_default='manual'),
        sa.Column('amount_pkr', sa.Integer(), nullable=False),
        sa.Column('status', sa.String(20), nullable=False),
        sa.Column('reference', sa.String(200), nullable=False, server_default=''),
        sa.Column('raw', sa.JSON(), nullable=True),
        sa.Column('notes', sa.String(1000), nullable=False, server_default=''),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('updated_at', sa.DateTime(), nullable=False),
    )
    op.create_index('ix_payment_user_id', 'payment', ['user_id'])
    op.create_index('ix_payment_subscription_id', 'payment', ['subscription_id'])
    op.create_index('ix_payment_status', 'payment', ['status'])
    op.create_index('ix_payment_created_at', 'payment', ['created_at'])

    op.create_table(
        'admin_audit',
        sa.Column('id', sa.String(36), primary_key=True),
        sa.Column('actor_user_id', sa.String(36), nullable=True),
        sa.Column('actor_email', sa.String(320), nullable=False),
        sa.Column('action', sa.String(60), nullable=False),
        sa.Column('target_type', sa.String(20), nullable=False),
        sa.Column('target_id', sa.String(36), nullable=True),
        sa.Column('detail', sa.JSON(), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=False),
    )
    op.create_index('ix_admin_audit_action', 'admin_audit', ['action'])
    op.create_index('ix_admin_audit_target_id', 'admin_audit', ['target_id'])
    op.create_index('ix_admin_audit_created_at', 'admin_audit', ['created_at'])

    _seed(op.get_bind())


def downgrade() -> None:
    for table in ('admin_audit', 'payment', 'usage_grant', 'subscription', 'package'):
        op.drop_table(table)
    op.drop_index('ix_job_user_lane_started', table_name='job')
    # plain DROP COLUMN, not batch mode: see 0022
    for col in reversed(USER_COLS):
        op.execute(f'ALTER TABLE "user" DROP COLUMN {col}')
