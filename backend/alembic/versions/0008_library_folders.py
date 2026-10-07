"""library organisation (polish P4): folder, folder_link, favourite, saved_filter, media_item.folder_id

Revision ID: 0008
Revises: 0007
Create Date: 2026-10-07 20:00:00

Additive only: four new tables and one nullable ADD COLUMN, so existing media rows read back unfiled.
"""
from alembic import op
import sqlalchemy as sa


revision = '0008'
down_revision = '0007'
branch_labels = None
depends_on = None


def _stamps():
    return [sa.Column('created_at', sa.DateTime(), nullable=False)]


def upgrade() -> None:
    op.create_table(
        'folder',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('workspace_id', sa.String(length=36), nullable=False),
        sa.Column('name', sa.String(length=120), nullable=False),
        sa.Column('parent_id', sa.String(length=36), nullable=True),
        sa.Column('kind', sa.String(length=10), nullable=False, server_default='any'),
        sa.Column('sort', sa.Integer(), nullable=False, server_default=sa.text('0')),
        *_stamps(),
        sa.Column('updated_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['workspace_id'], ['workspace.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_folder_workspace_id', 'folder', ['workspace_id'])
    op.create_index('ix_folder_parent_id', 'folder', ['parent_id'])

    op.create_table(
        'folder_link',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('workspace_id', sa.String(length=36), nullable=False),
        sa.Column('folder_id', sa.String(length=36), nullable=False),
        sa.Column('media_ref', sa.String(length=60), nullable=False),
        *_stamps(),
        sa.ForeignKeyConstraint(['workspace_id'], ['workspace.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['folder_id'], ['folder.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('workspace_id', 'media_ref', name='uq_folder_link_ref'),
    )
    op.create_index('ix_folder_link_workspace_id', 'folder_link', ['workspace_id'])
    op.create_index('ix_folder_link_folder_id', 'folder_link', ['folder_id'])

    op.create_table(
        'favourite',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('workspace_id', sa.String(length=36), nullable=False),
        sa.Column('user_id', sa.String(length=36), nullable=False),
        sa.Column('media_ref', sa.String(length=60), nullable=False),
        *_stamps(),
        sa.ForeignKeyConstraint(['workspace_id'], ['workspace.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['user_id'], ['user.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('user_id', 'media_ref', name='uq_favourite_ref'),
    )
    op.create_index('ix_favourite_workspace_id', 'favourite', ['workspace_id'])
    op.create_index('ix_favourite_user_id', 'favourite', ['user_id'])

    op.create_table(
        'saved_filter',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('workspace_id', sa.String(length=36), nullable=False),
        sa.Column('user_id', sa.String(length=36), nullable=False),
        sa.Column('name', sa.String(length=80), nullable=False),
        sa.Column('query', sa.JSON(), nullable=False, server_default='{}'),
        *_stamps(),
        sa.Column('updated_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['workspace_id'], ['workspace.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['user_id'], ['user.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_saved_filter_workspace_id', 'saved_filter', ['workspace_id'])
    op.create_index('ix_saved_filter_user_id', 'saved_filter', ['user_id'])

    op.add_column('media_item', sa.Column('folder_id', sa.String(length=36), nullable=True))
    op.create_index('ix_media_item_folder_id', 'media_item', ['folder_id'])


def downgrade() -> None:
    op.drop_index('ix_media_item_folder_id', table_name='media_item')
    op.drop_column('media_item', 'folder_id')
    for table in ('saved_filter', 'favourite', 'folder_link', 'folder'):
        op.drop_table(table)
