"""Two people, two studios (M17 step 1, plan F): nothing of A's is visible to B, by id, in lists, by link,
over the event stream or in the system status."""
from datetime import timedelta

import pytest
from sqlalchemy import select
from starlette.requests import Request

from app import accounts, file_links
from app.api.events import _auth_workspace, collect_changes
from app.db import SessionLocal
from app.models import AdCampaign, Generation, Job, PoetryShort, utcnow
from tests.test_api_tokens import _mint, flags, login  # noqa: F401  (fixtures)
from tests.test_library import png_bytes, upload
from tests.test_mcp import Mcp

PW = "b-long-password-1"


@pytest.fixture
def a_stuff(client):
    """The admin's studio (A) with one of everything in it."""
    project = client.post("/api/projects", json={"title": "A's film", "authoring_mode": "scene_by_scene"}).json()
    character = client.post("/api/characters", json={"name": "A's hero", "description": "tall"}).json()
    kit = client.post("/api/brand-kits", json={"name": "A's brand"})
    assert kit.status_code == 201, kit.text
    media = upload(client, "a.png", png_bytes(), "image/png", title="A's photo").json()
    batch = client.post("/api/images/generate", json={"prompt": "A's kite"}).json()
    ws = client.get("/api/auth/me").json()["workspace_id"]
    with SessionLocal() as db:
        poem = PoetryShort(workspace_id=ws, title="A's poem")
        ad = AdCampaign(workspace_id=ws, title="A's ad")
        db.add_all([poem, ad])
        db.commit()
        job = db.scalars(select(Job).where(Job.workspace_id == ws)).first()
        gen = db.get(Generation, media["generation_id"])
        file_path = gen.file_path
    return {"ws": ws, "project": project["id"], "character": character["id"], "kit": kit.json()["id"],
            "media": media["id"], "gen": media["generation_id"], "file": file_path, "job": job.id,
            "poem": poem.id, "ad": ad.id, "batch": batch}


@pytest.fixture
def b(login):  # noqa: F811
    with SessionLocal() as db:
        accounts.create_account(db, "bea@example.com", "Bea", PW, verified=True)
        db.commit()
    return login({"email": "bea@example.com", "password": PW})


def test_b_gets_404_on_everything_of_a(a_stuff, b, client):
    s = a_stuff
    assert b.get("/api/auth/me").json()["workspace_id"] != s["ws"]
    for path in (f"/api/projects/{s['project']}", f"/api/characters/{s['character']}",
                 f"/api/brand-kits/{s['kit']}", f"/api/media/{s['media']}", f"/api/generations/{s['gen']}",
                 f"/api/generations/{s['gen']}/download", f"/api/media/thumb/{s['gen']}",
                 f"/api/media/{s['file']}", f"/api/jobs/{s['job']}", f"/api/poetry/{s['poem']}",
                 f"/api/ads/{s['ad']}"):
        # A opens each one, so B's 404 is the studio wall and not a bad path
        assert client.get(path).status_code == 200, path
        assert b.get(path).status_code == 404, path
    # and can't change or delete them either
    assert b.patch(f"/api/projects/{s['project']}", json={"title": "mine now"}).status_code == 404
    assert b.patch(f"/api/characters/{s['character']}", json={"name": "mine"}).status_code == 404
    assert b.delete(f"/api/brand-kits/{s['kit']}").status_code == 404
    assert b.delete(f"/api/media/{s['media']}").status_code == 404
    assert b.post(f"/api/jobs/{s['job']}/cancel").status_code == 404
    assert b.delete(f"/api/poetry/{s['poem']}").status_code == 404
    assert b.delete(f"/api/ads/{s['ad']}").status_code == 404


def test_b_lists_are_empty(a_stuff, b):
    assert b.get("/api/projects").json() == []
    assert b.get("/api/characters").json() == []
    assert b.get("/api/brand-kits").json() == []
    assert b.get("/api/jobs").json() == []
    assert b.get("/api/media").json()["items"] == []
    assert b.get("/api/generations").json() == []
    poems = b.get("/api/poetry").json()
    ads = b.get("/api/ads").json()
    assert not (poems if isinstance(poems, list) else poems.get("items"))
    assert not (ads if isinstance(ads, list) else ads.get("items"))


def test_signed_links_and_mcp_stay_in_their_studio(a_stuff, b, anon, flags):  # noqa: F811
    flags(public_api=True)
    with SessionLocal() as db:
        g = db.get(Generation, a_stuff["gen"])
        good = file_links.sign(g)
        b_ws = b.get("/api/auth/me").json()["workspace_id"]
        # a link re-signed for B's studio doesn't open A's file
        forged = file_links._serializer().dumps({"g": g.id, "w": b_ws})
    assert anon.get(f"/api/files/{good}").status_code == 200
    assert anon.get(f"/api/files/{forged}").status_code == 404

    m = Mcp(anon, _mint(b, ["read", "generate"])["token"])
    for tool, args in (("get_media", {"id": a_stuff["media"]}), ("get_job", {"job_id": a_stuff["job"]}),
                       ("get_poetry_short", {"short_id": a_stuff["poem"]})):
        res = m.call(tool, **args)
        assert res["isError"], tool
    found = m.call_json("search_library", query="A's")
    assert not (found if isinstance(found, list) else found.get("items") or found.get("results"))


def test_event_stream_only_carries_b_events(a_stuff, b):
    since = utcnow() - timedelta(hours=1)
    b_ws = b.get("/api/auth/me").json()["workspace_id"]
    assert collect_changes(b_ws, since) == []
    assert collect_changes(a_stuff["ws"], since)
    req = Request({"type": "http", "method": "GET", "path": "/api/events", "query_string": b"",
                   "headers": [(b"cookie", f"mixai_session={b.cookies.get('mixai_session')}".encode())]})
    assert _auth_workspace(req) == b_ws


def test_system_status_hides_a_jobs_and_internals(a_stuff, b, client):
    with SessionLocal() as db:
        j = db.get(Job, a_stuff["job"])
        j.status, j.started_at = "running", utcnow()
        lane = j.lane
        db.commit()
    mine = client.get("/api/system/status").json()
    theirs = b.get("/api/system/status").json()
    assert mine["lanes"][lane]["job"]["id"] == a_stuff["job"]
    assert "ids" in mine["lanes"][lane]["worker"]
    assert theirs["lanes"][lane]["job"] is None
    assert all("ids" not in v["worker"] for v in theirs["lanes"].values())
    assert theirs["comfy"]["url"] == "" and theirs["llm"]["url"] == ""
    assert all(v["comfy"] is None or "urls" not in v["comfy"] for v in theirs["lanes"].values())
    # the queue length is shared: everyone waits on the same GPUs
    assert theirs["queue"] == mine["queue"] and theirs["queue"]["running"] == 1
