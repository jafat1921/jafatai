"""photo catalogue (M10 phase 1): marks + EXIF on media_item, client, album, album_item

Revision ID: 0011
Revises: 0010
Create Date: 2026-10-09 18:00:00

Additive only. Existing items read back unrated, unflagged, unlabelled, with no EXIF until
`python -m app.manage catalogue-backfill` fills captured_at / camera / hash from their files.
"""
from alembic import op
import sqlalchemy as sa


revision = '0011'
down_revision = '0010'
branch_labels = None
depends_on = None

COLUMNS = [
    sa.Column('rating', sa.Integer(), nullable=False, server_default=sa.text('0')),
    sa.Column('flag', sa.String(length=8), nullable=False, server_default=''),
    sa.Column('label', sa.String(length=10), nullable=False, server_default=''),
    sa.Column('caption', sa.Text(), nullable=False, server_default=''),
    sa.Column('captured_at', sa.DateTime(), nullable=True),
    sa.Column('camera', sa.String(length=120), nullable=True),
    sa.Column('lens', sa.String(length=160), nullable=True),
    sa.Column('focal_mm', sa.Float(), nullable=True),
    sa.Column('aperture', sa.Float(), nullable=True),
    sa.Column('shutter_s', sa.Float(), nullable=True),
    sa.Column('iso', sa.Integer(), nullable=True),
    sa.Column('gps_lat', sa.Float(), nullable=True),
    sa.Column('gps_lng', sa.Float(), nullable=True),
    sa.Column('exif', sa.JSON(), nullable=True),
    sa.Column('original_name', sa.String(length=300), nullable=True),
    sa.Column('bytes', sa.Integer(), nullable=True),
    sa.Column('content_hash', sa.String(length=64), nullable=True),
    sa.Column('source_path', sa.String(length=500), nullable=True),
    sa.Column('source_type', sa.String(length=40), nullable=True),
]
INDEXES = ['rating', 'flag', 'label', 'captured_at', 'camera', 'content_hash']


def upgrade() -> None:
    for col in COLUMNS:
        op.add_column('media_item', col)
    for name in INDEXES:
        op.create_index(f'ix_media_item_{name}', 'media_item', [name])

    op.create_table(
        'client',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('workspace_id', sa.String(length=36), nullable=False),
        sa.Column('name', sa.String(length=160), nullable=False),
        sa.Column('email', sa.String(length=200), nullable=False, server_default=''),
        sa.Column('phone', sa.String(length=60), nullable=False, server_default=''),
        sa.Column('notes', sa.Text(), nullable=False, server_default=''),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('updated_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['workspace_id'], ['workspace.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_client_workspace_id', 'client', ['workspace_id'])

    op.create_table(
        'album',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('workspace_id', sa.String(length=36), nullable=False),
        sa.Column('parent_id', sa.String(length=36), nullable=True),
        sa.Column('kind', sa.String(length=10), nullable=False, server_default='album'),
        sa.Column('name', sa.String(length=160), nullable=False),
        sa.Column('client_id', sa.String(length=36), nullable=True),
        sa.Column('shoot_date', sa.String(length=10), nullable=True),
        sa.Column('venue', sa.String(length=200), nullable=False, server_default=''),
        sa.Column('notes', sa.Text(), nullable=False, server_default=''),
        sa.Column('rules', sa.JSON(), nullable=True),
        sa.Column('cover_id', sa.String(length=36), nullable=True),
        sa.Column('sort', sa.Integer(), nullable=False, server_default=sa.text('0')),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('updated_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['workspace_id'], ['workspace.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['client_id'], ['client.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_album_workspace_id', 'album', ['workspace_id'])
    op.create_index('ix_album_parent_id', 'album', ['parent_id'])
    op.create_index('ix_album_client_id', 'album', ['client_id'])

    op.create_table(
        'album_item',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('workspace_id', sa.String(length=36), nullable=False),
        sa.Column('album_id', sa.String(length=36), nullable=False),
        sa.Column('media_id', sa.String(length=36), nullable=False),
        sa.Column('position', sa.Integer(), nullable=False, server_default=sa.text('0')),
        sa.Column('added_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['workspace_id'], ['workspace.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['album_id'], ['album.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['media_id'], ['media_item.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('album_id', 'media_id', name='uq_album_item'),
    )
    op.create_index('ix_album_item_album_id', 'album_item', ['album_id'])
    op.create_index('ix_album_item_media_id', 'album_item', ['media_id'])


def downgrade() -> None:
    for table in ('album_item', 'album', 'client'):
        op.drop_table(table)
    for name in INDEXES:
        op.drop_index(f'ix_media_item_{name}', table_name='media_item')
    with op.batch_alter_table('media_item') as b:
        for col in reversed(COLUMNS):
            b.drop_column(col.name)
