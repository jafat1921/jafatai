"""Character Studio and sheets (M12a), plus the two columns M12b's voices need

Revision ID: 0018
Revises: 0017
Create Date: 2026-10-14 10:00:00

character.project_id becomes nullable (NULL = a studio character) and project_cast links studio characters
into films. character.profile / sheet hold the identity block and the sheet state; character.voice_id and
shot.dialogue are for M12b and stay empty until then. shot.ref_panels keeps the user's reference panel picks.

The one-approved-per-kind index now leaves sheet_view out: each sheet panel has its own approved version.
"""
from alembic import op
import sqlalchemy as sa


revision = '0018'
down_revision = '0017'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # a table rebuild on SQLite; nothing has a foreign key into character, so nothing cascades
    with op.batch_alter_table('character') as batch:
        batch.alter_column('project_id', existing_type=sa.String(length=36), nullable=True)
        batch.add_column(sa.Column('profile', sa.JSON(), nullable=False, server_default='{}'))
        batch.add_column(sa.Column('voice_id', sa.String(length=80), nullable=True))
        batch.add_column(sa.Column('sheet', sa.JSON(), nullable=False, server_default='{}'))

    op.add_column('shot', sa.Column('ref_panels', sa.JSON(), nullable=False, server_default='{}'))
    op.add_column('shot', sa.Column('dialogue', sa.JSON(), nullable=False, server_default='[]'))

    op.create_table(
        'project_cast',
        sa.Column('project_id', sa.String(length=36), nullable=False),
        sa.Column('character_id', sa.String(length=36), nullable=False),
        sa.Column('added_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['project_id'], ['project.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['character_id'], ['character.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('project_id', 'character_id'),
    )
    op.create_index('ix_project_cast_character_id', 'project_cast', ['character_id'])

    op.drop_index('uq_generation_one_approved', table_name='generation')
    op.create_index('uq_generation_one_approved', 'generation', ['target_type', 'target_id', 'kind'], unique=True,
                    sqlite_where=sa.text("status = 'approved' AND kind != 'sheet_view'"),
                    postgresql_where=sa.text("status = 'approved' AND kind != 'sheet_view'"))


def downgrade() -> None:
    conn = op.get_bind()
    # keep the newest approved sheet view per character so the old index can come back
    conn.execute(sa.text(
        "UPDATE generation SET status = 'ready', approved_at = NULL WHERE kind = 'sheet_view' AND status = 'approved' "
        "AND id NOT IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY target_type, target_id "
        "ORDER BY approved_at DESC) AS n FROM generation WHERE kind = 'sheet_view' AND status = 'approved') "
        "WHERE n = 1)"))
    op.drop_index('uq_generation_one_approved', table_name='generation')
    op.create_index('uq_generation_one_approved', 'generation', ['target_type', 'target_id', 'kind'], unique=True,
                    sqlite_where=sa.text("status = 'approved'"), postgresql_where=sa.text("status = 'approved'"))

    op.drop_index('ix_project_cast_character_id', table_name='project_cast')
    # studio characters go back into the first film that used them; unused ones can't survive NOT NULL
    conn.execute(sa.text(
        "UPDATE character SET project_id = (SELECT project_id FROM project_cast WHERE character_id = character.id "
        "ORDER BY added_at LIMIT 1) WHERE project_id IS NULL"))
    conn.execute(sa.text("DELETE FROM character WHERE project_id IS NULL"))
    op.drop_table('project_cast')
    with op.batch_alter_table('shot') as batch:
        batch.drop_column('dialogue')
        batch.drop_column('ref_panels')
    with op.batch_alter_table('character') as batch:
        batch.drop_column('sheet')
        batch.drop_column('voice_id')
        batch.drop_column('profile')
        batch.alter_column('project_id', existing_type=sa.String(length=36), nullable=False)
