"""Accounts (contract v38): sign-up, email links, admin flag and per-user job ownership

Revision ID: 0027
Revises: 0026
Create Date: 2026-10-17 16:00:00

Everyone already here is taken as confirmed. The ADMIN_EMAIL user becomes the admin, the same person the old
"owner and ADMIN_EMAIL" rule picked. password_hash stays NOT NULL ("" means no password yet): relaxing it would
rebuild the user table, and with foreign keys on that cascades into memberships and tokens.
"""
import re
import unicodedata

from alembic import op
import sqlalchemy as sa

from app.config import get_settings


revision = '0027'
down_revision = '0026'
branch_labels = None
depends_on = None

user = sa.table('user', sa.column('id', sa.String), sa.column('email', sa.String),
                sa.column('display_name', sa.String), sa.column('created_at', sa.DateTime),
                sa.column('is_admin', sa.Boolean), sa.column('email_verified_at', sa.DateTime),
                sa.column('handle', sa.String))
workspace = sa.table('workspace', sa.column('id', sa.String), sa.column('owner_user_id', sa.String))
membership = sa.table('membership', sa.column('user_id', sa.String), sa.column('workspace_id', sa.String),
                      sa.column('role', sa.String), sa.column('created_at', sa.DateTime))
job = sa.table('job', sa.column('id', sa.String), sa.column('workspace_id', sa.String),
               sa.column('user_id', sa.String))
ledger = sa.table('usage_ledger', sa.column('workspace_id', sa.String), sa.column('user_id', sa.String))

USER_COLS = ('is_admin', 'email_verified_at', 'last_login_at', 'google_sub', 'avatar_url', 'handle',
             'session_version')


def _slug(text: str) -> str:
    # the same rule as app.accounts._slug, copied so this file never changes when that one does
    text = unicodedata.normalize('NFKD', text or '').encode('ascii', 'ignore').decode()
    return re.sub(r'[^a-z0-9]+', '-', text.lower()).strip('-')[:40] or 'studio'


def _backfill(bind) -> None:
    admin = get_settings().admin_email.strip().lower()
    bind.execute(sa.update(user).values(email_verified_at=sa.func.coalesce(user.c.email_verified_at,
                                                                          user.c.created_at)))
    if admin:
        bind.execute(sa.update(user).where(sa.func.lower(user.c.email) == admin).values(is_admin=True))

    taken: set[str] = set()
    for uid, email, name in bind.execute(sa.select(user.c.id, user.c.email, user.c.display_name)
                                         .order_by(user.c.created_at)).all():
        base = _slug(name or (email or '').split('@')[0])
        handle, n = base, 2
        while handle in taken:
            handle, n = f'{base}-{n}', n + 1
        taken.add(handle)
        bind.execute(sa.update(user).where(user.c.id == uid).values(handle=handle))

    # each workspace's first owner; their jobs so far are theirs (one user per studio until now)
    owners: dict[str, str] = {}
    for uid, ws in bind.execute(sa.select(membership.c.user_id, membership.c.workspace_id)
                                .where(membership.c.role == 'owner').order_by(membership.c.created_at)).all():
        owners.setdefault(ws, uid)
    for ws, uid in owners.items():
        bind.execute(sa.update(workspace).where(workspace.c.id == ws).values(owner_user_id=uid))
        bind.execute(sa.update(job).where(job.c.workspace_id == ws, job.c.user_id.is_(None)).values(user_id=uid))
        bind.execute(sa.update(ledger).where(ledger.c.workspace_id == ws, ledger.c.user_id.is_(None))
                     .values(user_id=uid))


def upgrade() -> None:
    op.add_column('user', sa.Column('is_admin', sa.Boolean(), nullable=False, server_default=sa.text('0')))
    op.add_column('user', sa.Column('email_verified_at', sa.DateTime(), nullable=True))
    op.add_column('user', sa.Column('last_login_at', sa.DateTime(), nullable=True))
    op.add_column('user', sa.Column('google_sub', sa.String(255), nullable=True))
    op.add_column('user', sa.Column('avatar_url', sa.String(1000), nullable=True))
    op.add_column('user', sa.Column('handle', sa.String(60), nullable=True))
    op.add_column('user', sa.Column('session_version', sa.Integer(), nullable=False, server_default=sa.text('0')))
    # unique indexes rather than constraints: SQLite adds those without a table rebuild
    op.create_index('ix_user_handle', 'user', ['handle'], unique=True)
    op.create_index('ix_user_google_sub', 'user', ['google_sub'], unique=True)

    op.add_column('workspace', sa.Column('owner_user_id', sa.String(36), nullable=True))
    op.create_index('ix_workspace_owner_user_id', 'workspace', ['owner_user_id'])
    op.add_column('job', sa.Column('user_id', sa.String(36), nullable=True))
    op.create_index('ix_job_user_id', 'job', ['user_id'])
    op.add_column('usage_ledger', sa.Column('user_id', sa.String(36), nullable=True))
    op.create_index('ix_usage_ledger_user_id', 'usage_ledger', ['user_id'])

    op.create_table(
        'email_token',
        sa.Column('id', sa.String(36), primary_key=True),
        sa.Column('user_id', sa.String(36), sa.ForeignKey('user.id', ondelete='CASCADE'), nullable=False),
        sa.Column('purpose', sa.String(10), nullable=False),
        sa.Column('token_hash', sa.String(64), nullable=False, unique=True),
        sa.Column('expires_at', sa.DateTime(), nullable=False),
        sa.Column('used_at', sa.DateTime(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False),
    )
    op.create_index('ix_email_token_user_id', 'email_token', ['user_id'])

    _backfill(op.get_bind())


def downgrade() -> None:
    op.drop_index('ix_email_token_user_id', table_name='email_token')
    op.drop_table('email_token')
    # plain DROP COLUMN, not batch mode: see 0022
    for table, col in (('usage_ledger', 'user_id'), ('job', 'user_id'), ('workspace', 'owner_user_id')):
        op.drop_index(f'ix_{table}_{col}', table_name=table)
        op.execute(f'ALTER TABLE "{table}" DROP COLUMN {col}')
    op.drop_index('ix_user_google_sub', table_name='user')
    op.drop_index('ix_user_handle', table_name='user')
    for col in reversed(USER_COLS):
        op.execute(f'ALTER TABLE "user" DROP COLUMN {col}')
