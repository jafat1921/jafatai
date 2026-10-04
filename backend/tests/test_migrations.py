import os
import sqlite3
import subprocess
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]


def _alembic(db_path: Path, *args: str) -> None:
    env = {**os.environ, "DATABASE_URL": f"sqlite:///{db_path.as_posix()}"}
    r = subprocess.run([sys.executable, "-m", "alembic", *args], cwd=BACKEND, env=env, capture_output=True,
                       text=True, timeout=120)
    assert r.returncode == 0, r.stderr[-2000:]


def test_0003_upgrades_a_populated_0002_database(tmp_path):
    db = tmp_path / "prod-copy.db"
    _alembic(db, "upgrade", "0002")

    con = sqlite3.connect(db)
    con.execute("PRAGMA foreign_keys=ON")
    now = "2026-10-01 10:00:00"
    con.execute("INSERT INTO workspace (id, name, created_at) VALUES ('w1', 'ws', ?)", (now,))
    con.execute(
        "INSERT INTO project (id, workspace_id, title, logline, brief, authoring_mode, aspect_ratio, target_runtime_s,"
        " quality, takes_per_shot, overnight, status, created_at, updated_at)"
        " VALUES ('p1', 'w1', 'Reef', '', '', 'scene_by_scene', '16:9', 120, 'draft', 3, 0, 'draft', ?, ?)",
        (now, now),
    )
    con.execute(
        "INSERT INTO scene (id, workspace_id, project_id, sort_order, heading, logline, script_text, summary, mood,"
        " lighting, source, locked, version, stale, created_at, updated_at)"
        " VALUES ('s1', 'w1', 'p1', 1, 'EXT. REEF', '', 'Maya dives.', '', '', '', 'user', 1, 2, 0, ?, ?)",
        (now, now),
    )
    for v in (1, 2):
        con.execute(
            "INSERT INTO scene_version (id, workspace_id, scene_id, version, heading, logline, script_text, source,"
            " created_at) VALUES (?, 'w1', 's1', ?, 'EXT. REEF', '', 'Maya dives.', 'user', ?)",
            (f"v{v}", v, now),
        )
    con.commit()
    con.close()

    _alembic(db, "upgrade", "head")

    con = sqlite3.connect(db)
    assert con.execute("SELECT version_num FROM alembic_version").fetchone()[0] == "0003"
    assert con.execute("SELECT script_text, location_id FROM scene").fetchall() == [("Maya dives.", None)]
    assert con.execute("SELECT count(*) FROM scene_version").fetchone()[0] == 2  # nothing cascaded away
    assert con.execute("SELECT style_bible FROM project").fetchone()[0] == ""
    assert con.execute("SELECT count(*) FROM shot").fetchone()[0] == 0
    assert con.execute("SELECT count(*) FROM location").fetchone()[0] == 0
    con.close()

    _alembic(db, "downgrade", "0002")
    _alembic(db, "upgrade", "head")
