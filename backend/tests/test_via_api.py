"""Made through the API (contract v34): token-made rows stay out of the studio app's lists, MCP and cookie rows
don't, the worker passes the flag on, the admin's ?via= view, the backfill and mark-api."""
import json
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest
from sqlalchemy import select

from app import worker
from app.db import SessionLocal
from app.models import Generation, Job, MediaItem, Membership, Project
from tests.test_api_tokens import _bearer, _mint, _user, flags, login  # noqa: F401  (fixtures)
from tests.test_mcp import Mcp
from tests.test_migrations import _alembic

ROOT = Path(__file__).resolve().parents[2]


def _image(client, prompt: str, headers: dict | None = None) -> dict:
    r = client.post("/api/images/generate", json={"prompt": prompt, "aspect": "1:1"}, headers=headers or {})
    assert r.status_code == 202, r.text
    return r.json()


def _titles(client, **query) -> set[str]:
    r = client.get("/api/media", params={"kind": "image", **query})
    assert r.status_code == 200, r.text
    return {i["title"] for i in r.json()["items"]}


def _drain(fast_driver):
    while worker.process_one(driver_factory=fast_driver):
        pass


@pytest.fixture
def token(client) -> dict:
    return _bearer(_mint(client, ["read", "generate"])["token"])


def test_cookie_rows_show_and_token_rows_stay_out_of_the_app(client, token, fast_driver):
    mine = _image(client, "a cookie kite")
    theirs = _image(client, "an api kite", token)
    p = client.post("/api/projects", json={"title": "From BCP", "authoring_mode": "scene_by_scene"}, headers=token)
    assert p.status_code == 201
    _drain(fast_driver)

    assert _titles(client) == {mine["items"][0]["title"]}
    assert "From BCP" not in {x["title"] for x in client.get("/api/projects").json()}
    app_jobs = {j["id"] for j in client.get("/api/jobs").json()}
    assert mine["jobs"][0]["id"] in app_jobs and theirs["jobs"][0]["id"] not in app_jobs
    dash = client.get("/api/dashboard").json()
    assert all(i["id"] != theirs["items"][0]["id"] for i in dash["recent_images"])

    # the API still lists and fetches its own work, and sees the studio's too
    assert _titles(client) | {theirs["items"][0]["title"]} == {i["title"] for i in client.get(
        "/api/media", params={"kind": "image"}, headers=token).json()["items"]}
    assert "From BCP" in {x["title"] for x in client.get("/api/projects", headers=token).json()}
    got = client.get(f"/api/media/{theirs['items'][0]['id']}", headers=token)
    assert got.status_code == 200 and got.json()["status"] == "ready"
    # by id the app can still open it (links in old toasts keep working)
    assert client.get(f"/api/media/{theirs['items'][0]['id']}").status_code == 200

    with SessionLocal() as db:
        item = db.get(MediaItem, theirs["items"][0]["id"])
        gen = db.get(Generation, item.generation_id)
        assert item.via_api and gen.via_api and db.get(Job, gen.job_id).via_api
        assert not db.get(MediaItem, mine["items"][0]["id"]).via_api


def test_other_lists_leave_token_rows_out(client, token):
    client.post("/api/characters", json={"name": "Api Ana"}, headers=token)
    client.post("/api/characters", json={"name": "Studio Sam"})
    client.post("/api/folders", json={"name": "api folder"}, headers=token)
    assert client.post("/api/scripts", json={"title": "api script"}, headers=token).status_code == 201
    assert [c["name"] for c in client.get("/api/characters").json()] == ["Studio Sam"]
    assert {c["name"] for c in client.get("/api/characters", headers=token).json()} == {"Api Ana", "Studio Sam"}
    assert client.get("/api/folders").json() == []
    assert [f["name"] for f in client.get("/api/folders", headers=token).json()] == ["api folder"]
    assert client.get("/api/scripts").json() == []
    assert [x["title"] for x in client.get("/api/scripts", headers=token).json()] == ["api script"]
    names = {m["label"] for m in client.get("/api/mentions", params={"types": "character"}).json()}
    assert "Api Ana" not in names


def test_mcp_rows_show_in_the_app(client, anon, fast_driver):
    m = Mcp(anon, _mint(client, ["read", "generate"])["token"])
    out = m.call_json("generate_image", prompt="an mcp lighthouse", aspect="1:1")
    _drain(fast_driver)
    assert out["items"][0]["media_id"] in {i["id"] for i in client.get("/api/media", params={"kind": "image"}).json()["items"]}
    with SessionLocal() as db:
        assert not db.get(MediaItem, out["items"][0]["media_id"]).via_api


def test_worker_results_and_child_jobs_inherit_the_flag(client, monkeypatch, fast_driver):
    def handler(ctx):
        db, job = ctx.db, ctx.job
        db.add(MediaItem(workspace_id=job.workspace_id, kind="audio", origin="generated", title=f"made by {job.id}"))
        db.add(Job(workspace_id=job.workspace_id, type="noop_child", payload={"parent_job_id": job.id}))
        db.commit()
        return {}

    monkeypatch.setitem(worker.HANDLERS, "via_test", handler)
    monkeypatch.setitem(worker.HANDLERS, "noop_child", lambda ctx: {})
    with SessionLocal() as db:
        ws = db.scalars(select(Membership.workspace_id)).first()
        api_job = Job(workspace_id=ws, type="via_test", via_api=True)
        app_job = Job(workspace_id=ws, type="via_test")
        db.add_all([api_job, app_job])
        db.commit()
        ids = api_job.id, app_job.id
    _drain(fast_driver)
    with SessionLocal() as db:
        for jid, flag in zip(ids, (True, False)):
            assert db.get(Job, jid).status == "done"
            item = db.scalars(select(MediaItem).where(MediaItem.title == f"made by {jid}")).one()
            child = [j for j in db.scalars(select(Job).where(Job.type == "noop_child"))
                     if j.payload.get("parent_job_id") == jid]
            assert item.via_api is flag and child[0].via_api is flag
        # the session flag doesn't leak into the next job's rows
        assert not db.scalars(select(Job).where(Job.id == ids[1])).one().via_api


def test_admin_via_filter_and_non_admins(client, token, login, fast_driver):
    _image(client, "studio picture")
    theirs = _image(client, "api picture", token)
    _drain(fast_driver)
    api_title = theirs["items"][0]["title"]
    assert _titles(client, via="api") == {api_title}
    assert api_title in _titles(client, via="all") and len(_titles(client, via="all")) == 2
    assert {j["id"] for j in client.get("/api/jobs", params={"via": "api"}).json()} == {theirs["jobs"][0]["id"]}
    assert client.get("/api/auth/me").json()["admin"] is True

    editor = login(_user("ed@test.local", "editor"))
    assert editor.get("/api/auth/me").json()["admin"] is False
    # ignored for anyone else: the default view
    assert api_title not in _titles(editor, via="api")
    assert api_title not in _titles(editor, via="all")


def test_sse_skips_api_rows_for_the_app(client, token):
    from app.api.events import collect_changes
    from app.models import utcnow
    from datetime import timedelta

    since = utcnow() - timedelta(seconds=5)
    _image(client, "app frame")
    theirs = _image(client, "api frame", token)
    ws = client.get("/api/auth/me").json()["workspace_id"]
    hidden = {theirs["items"][0]["id"], theirs["jobs"][0]["id"], theirs["items"][0]["generation_id"]}
    app_ids = {r[1] for r in collect_changes(ws, since, False)}
    assert app_ids and not hidden & app_ids
    assert hidden <= {r[1] for r in collect_changes(ws, since, None)}
    assert {r[1] for r in collect_changes(ws, since, True)} >= hidden
    assert not {r[1] for r in collect_changes(ws, since, True)} - hidden


def test_mark_api_route_dry_run_then_apply(client, login, fast_driver):
    mine = _image(client, "made before the column")
    _drain(fast_driver)
    item = mine["items"][0]["id"]
    r = client.post("/api/admin/mark-api", json={"ids": [item]})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["apply"] is False and body["counts"] == {"media": 1, "generation": 1, "job": 1}
    assert mine["items"][0]["title"] in _titles(client)  # a dry run writes nothing

    assert client.post("/api/admin/mark-api", json={"ids": [item], "apply": True}).json()["counts"]["media"] == 1
    assert mine["items"][0]["title"] not in _titles(client)
    again = client.post("/api/admin/mark-api", json={"ids": [item], "apply": True}).json()
    assert again["counts"]["media"] == 0 and again["already"]["media"] == 1

    assert client.post("/api/admin/mark-api", json={}).status_code == 422
    assert client.post("/api/admin/mark-api", json={"ids": [item], "kinds": ["nope"]}).status_code == 422
    editor = login(_user("ed2@test.local", "editor"))
    assert editor.post("/api/admin/mark-api", json={"ids": [item]}).status_code == 404
    tok = _bearer(_mint(client, ["read", "generate", "manage"])["token"])
    assert client.post("/api/admin/mark-api", json={"ids": [item]}, headers=tok).status_code == 403
    assert "/api/admin/mark-api" not in json.dumps(client.get("/api/openapi.json").json()) \
        if client.get("/api/openapi.json").status_code == 200 else True


def test_mark_api_window_takes_a_project_and_its_results(client):
    from app import visibility as vis
    from app.models import utcnow
    from datetime import timedelta

    p = client.post("/api/projects", json={"title": "Old run", "authoring_mode": "scene_by_scene"}).json()
    with SessionLocal() as db:
        res = vis.mark(db, since=utcnow() - timedelta(minutes=1), kinds=["project"])
        assert res["counts"] == {"project": 1} and not db.get(Project, p["id"]).via_api
        vis.mark(db, ids=[p["id"]], apply=True)
        assert db.get(Project, p["id"]).via_api
    assert "Old run" not in {x["title"] for x in client.get("/api/projects").json()}


def test_mark_script_dry_run_and_apply(client, fast_driver, tmp_path):
    mine = _image(client, "script target")
    _drain(fast_driver)
    item = mine["items"][0]["id"]
    from app import visibility as vis
    import importlib.util

    spec = importlib.util.spec_from_file_location("mark_api_items", ROOT / "scripts" / "mark-api-items.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    assert mod.main(["--ids", item]) == 0
    with SessionLocal() as db:
        assert not db.get(MediaItem, item).via_api
    assert mod.main(["--ids", item, "--kinds", "media", "--apply"]) == 0
    with SessionLocal() as db:
        assert db.get(MediaItem, item).via_api
        assert db.get(Generation, mine["items"][0]["generation_id"]).via_api
    with pytest.raises(SystemExit):
        mod.main([])
    assert vis.KINDS["media"] is MediaItem


def test_0022_marks_past_story_jobs_and_their_media(tmp_path):
    db = tmp_path / "prod-copy.db"
    _alembic(db, "upgrade", "0021")
    con = sqlite3.connect(db)
    now = "2026-10-14 10:00:00"
    con.execute("INSERT INTO workspace (id, name, created_at) VALUES ('w1', 'ws', ?)", (now,))

    def item(mid, gid, path):
        con.execute("INSERT INTO media_item (id, workspace_id, kind, origin, title, tags, generation_id, rating, flag,"
                    " label, caption, created_at, updated_at) VALUES (?, 'w1', 'image', 'upload', ?, '[]', ?, 0, '',"
                    " '', '', ?, ?)", (mid, mid, gid, now, now))
        con.execute("INSERT INTO generation (id, workspace_id, target_type, target_id, kind, version, status, prompt,"
                    " params, seed, file_path, created_at, updated_at) VALUES (?, 'w1', 'media', ?, 'image', 1, 'ready',"
                    " '', '{}', 0, ?, ?, ?)", (gid, mid, path, now, now))

    item("m_page", "g_page", "workspaces/w1/media/g_page.png")
    item("m_cover", "g_cover", "workspaces/w1/media/g_cover.png")
    item("m_music", "g_music", "workspaces/w1/media/g_music.flac")
    item("m_studio", "g_studio", "workspaces/w1/media/g_studio.png")

    def job(jid, type_, payload):
        con.execute("INSERT INTO job (id, workspace_id, type, payload, status, priority, progress, message, lane,"
                    " attempts, created_at, updated_at) VALUES (?, 'w1', ?, ?, 'done', 0, 1, '', 'general', 1, ?, ?)",
                    (jid, type_, json.dumps(payload), now, now))

    job("j_audio", "story_audio", {"music_generation_id": "g_music"})
    job("j_video", "story_video", {"audio_job": "j_audio", "pictures": {"p1": "workspaces/w1/media/g_page.png"},
                                   "title_card": {"title": "Pip", "file": "workspaces/w1/media/g_cover.png"}})
    job("j_other", "generate", {})
    con.commit()
    con.close()

    _alembic(db, "upgrade", "0022")
    con = sqlite3.connect(db)
    marked = lambda table: {r[0] for r in con.execute(f"SELECT id FROM {table} WHERE via_api = 1")}  # noqa: E731
    assert marked("job") == {"j_audio", "j_video"}
    assert marked("media_item") == {"m_page", "m_cover", "m_music"}
    assert marked("generation") == {"g_page", "g_cover", "g_music"}
    assert con.execute("SELECT count(*) FROM project WHERE via_api = 1").fetchone()[0] == 0
    con.close()

    _alembic(db, "downgrade", "0021")
    con = sqlite3.connect(db)
    assert "via_api" not in {r[1] for r in con.execute("PRAGMA table_info(project)")}
    assert con.execute("SELECT count(*) FROM media_item").fetchone()[0] == 4
    con.close()
    _alembic(db, "upgrade", "head")


def test_script_help_runs():
    r = subprocess.run([sys.executable, str(ROOT / "scripts" / "mark-api-items.py"), "--help"], capture_output=True,
                       text=True, timeout=60, cwd=ROOT / "backend")
    assert r.returncode == 0 and "--apply" in r.stdout
