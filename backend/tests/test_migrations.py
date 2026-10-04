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

    _alembic(db, "upgrade", "0003")

    con = sqlite3.connect(db)
    assert con.execute("SELECT version_num FROM alembic_version").fetchone()[0] == "0003"
    assert con.execute("SELECT script_text, location_id FROM scene").fetchall() == [("Maya dives.", None)]
    assert con.execute("SELECT count(*) FROM scene_version").fetchone()[0] == 2  # nothing cascaded away
    assert con.execute("SELECT style_bible FROM project").fetchone()[0] == ""
    assert con.execute("SELECT count(*) FROM shot").fetchone()[0] == 0
    assert con.execute("SELECT count(*) FROM location").fetchone()[0] == 0
    con.close()

    _alembic(db, "downgrade", "0002")
    _alembic(db, "upgrade", "0003")


def test_0004_upgrades_a_populated_0003_database(tmp_path):
    db = tmp_path / "prod-copy.db"
    _alembic(db, "upgrade", "0003")

    con = sqlite3.connect(db)
    con.execute("PRAGMA foreign_keys=ON")
    now = "2026-10-04 10:00:00"
    con.execute("INSERT INTO workspace (id, name, created_at) VALUES ('w1', 'ws', ?)", (now,))
    con.execute(
        "INSERT INTO project (id, workspace_id, title, logline, brief, authoring_mode, aspect_ratio, target_runtime_s,"
        " quality, takes_per_shot, overnight, status, style_bible, created_at, updated_at)"
        " VALUES ('p1', 'w1', 'Reef', '', '', 'scene_by_scene', '16:9', 120, 'draft', 3, 0, 'draft', '', ?, ?)",
        (now, now),
    )
    con.execute(
        "INSERT INTO scene (id, workspace_id, project_id, sort_order, heading, logline, script_text, summary, mood,"
        " lighting, source, locked, version, stale, created_at, updated_at)"
        " VALUES ('s1', 'w1', 'p1', 1, 'EXT. REEF', '', 'Maya dives.', '', '', '', 'user', 0, 1, 0, ?, ?)",
        (now, now),
    )
    con.execute(
        "INSERT INTO scene_version (id, workspace_id, scene_id, version, heading, logline, script_text, source,"
        " created_at) VALUES ('v1', 'w1', 's1', 1, 'EXT. REEF', '', 'Maya dives.', 'user', ?)",
        (now,),
    )
    con.execute(
        "INSERT INTO shot (id, workspace_id, project_id, scene_id, sort_order, shot_type, duration_s, description,"
        " camera, prompt, prompt_mode, start_prompt, end_prompt, motion_prompt, character_ids, seam_in, handoff_text,"
        " stale, source, locked, created_at, updated_at) VALUES ('sh1', 'w1', 'p1', 's1', 1, 'wide', 4.0, 'Dive',"
        " '', '', 'auto', '', '', '', '[]', 'cut', '', 0, 'user', 0, ?, ?)",
        (now, now),
    )
    con.execute(
        "INSERT INTO generation (id, workspace_id, project_id, target_type, target_id, kind, version, status, prompt,"
        " params, seed, created_at, updated_at) VALUES ('g1', 'w1', 'p1', 'shot', 'sh1', 'take', 1, 'approved', '',"
        " '{}', 1, ?, ?)",
        (now, now),
    )
    con.commit()
    con.close()

    _alembic(db, "upgrade", "head")

    con = sqlite3.connect(db)
    assert con.execute("SELECT version_num FROM alembic_version").fetchone()[0] == "0004"
    assert con.execute("SELECT id, description, beats FROM shot").fetchall() == [("sh1", "Dive", "[]")]
    assert con.execute("SELECT count(*) FROM scene_version").fetchone()[0] == 1
    assert con.execute("SELECT status FROM generation").fetchall() == [("approved",)]
    assert con.execute("SELECT count(*) FROM reel").fetchone()[0] == 0
    # new rows pick up server defaults, so raw inserts from older code paths still work
    con.execute("PRAGMA foreign_keys=ON")
    con.execute("INSERT INTO reel (id, workspace_id, project_id, created_at, updated_at) VALUES ('r1', 'w1', 'p1', ?, ?)",
                (now, now))
    con.execute("INSERT INTO reel_clip (id, workspace_id, reel_id, shot_id, scene_id, generation_id, created_at,"
                " updated_at) VALUES ('c1', 'w1', 'r1', 'sh1', 's1', 'g1', ?, ?)", (now, now))
    row = con.execute("SELECT trim_in_s, transition_in, transition_s, enabled, changed FROM reel_clip").fetchone()
    assert row == (0, "cut", 0.5, 1, 0)
    con.commit()
    con.close()

    _alembic(db, "downgrade", "0003")
    con = sqlite3.connect(db)
    assert con.execute("SELECT id, description FROM shot").fetchall() == [("sh1", "Dive")]
    con.close()
    _alembic(db, "upgrade", "head")
