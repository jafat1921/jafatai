"""Token API (M12c, contract v27): tokens, scopes, the PUBLIC_API gate, docs and the hardening that came with it."""
import re
from datetime import timedelta

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import select
from starlette.requests import Request

from app.api.events import _auth_workspace
from app.config import get_settings
from app.db import SessionLocal
from app.main import app, warn_weak_secret
from app.models import ApiToken, Membership, User, utcnow
from app.security import hash_password, hash_token, resolve_token
from app.worker import process_one

TOKEN_RE = re.compile(r"^mxa_[0-9a-f]{8}_[A-Za-z0-9_-]{40,}$")


def _user(email: str, role: str) -> dict:
    with SessionLocal() as db:
        ws = db.scalars(select(Membership.workspace_id)).first()
        u = User(email=email, display_name=email.split("@")[0], password_hash=hash_password("pw-other-1"))
        db.add(u)
        db.flush()
        db.add(Membership(user_id=u.id, workspace_id=ws, role=role))
        db.commit()
    return {"email": email, "password": "pw-other-1"}


@pytest.fixture
def login():
    opened = []

    def make(creds: dict) -> TestClient:
        c = TestClient(app)
        c.__enter__()
        opened.append(c)
        assert c.post("/api/auth/login", json=creds).status_code == 200
        return c

    yield make
    for c in opened:
        c.__exit__(None, None, None)


@pytest.fixture
def flags(monkeypatch):
    s = get_settings()

    def set_(**kw):
        for k, v in kw.items():
            monkeypatch.setattr(s, k, v)
    return set_


def _mint(client, scopes=("read", "generate"), expires_days=90, name="script") -> dict:
    r = client.post("/api/tokens", json={"name": name, "scopes": list(scopes), "expires_days": expires_days})
    assert r.status_code == 201, r.text
    return r.json()


def _bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


# ---------------------------------------------------------------- tokens

def test_token_is_shown_once_and_stored_hashed(client):
    made = _mint(client, ["read"], 30)
    assert TOKEN_RE.match(made["token"])
    assert made["prefix"] == made["token"][4:12] and made["scopes"] == ["read"] and made["status"] == "active"
    assert made["expires_at"].endswith("Z")

    listed = client.get("/api/tokens").json()
    assert [t["id"] for t in listed] == [made["id"]]
    assert "token" not in listed[0]
    with SessionLocal() as db:
        row = db.get(ApiToken, made["id"])
        assert row.token_hash == hash_token(made["token"]) and made["token"] not in (row.token_hash, row.prefix)
        assert timedelta(days=29) < row.expires_at - row.created_at <= timedelta(days=30)


def test_never_expiring_token_and_bad_requests(client):
    assert _mint(client, ["read"], None)["expires_at"] is None
    assert client.post("/api/tokens", json={"name": "x", "scopes": [], "expires_days": 30}).status_code == 422
    assert client.post("/api/tokens", json={"name": "x", "scopes": ["admin"]}).status_code == 422
    assert client.post("/api/tokens", json={"name": "x", "scopes": ["read"], "expires_days": 7}).status_code == 422
    assert client.post("/api/tokens", json={"name": "   ", "scopes": ["read"]}).status_code == 422


def test_bearer_works_without_a_cookie_until_revoked(client, anon):
    made = _mint(client)
    r = anon.get("/api/jobs", headers=_bearer(made["token"]))
    assert r.status_code == 200, r.text

    assert client.delete(f"/api/tokens/{made['id']}").status_code == 204
    r = anon.get("/api/jobs", headers=_bearer(made["token"]))
    assert r.status_code == 401 and r.headers["www-authenticate"] == "Bearer"
    assert client.get("/api/tokens").json()[0]["status"] == "revoked"
    assert client.delete("/api/tokens/nope").status_code == 404


def test_expired_wrong_and_malformed_tokens_are_401(client, anon):
    made = _mint(client)
    with SessionLocal() as db:
        db.get(ApiToken, made["id"]).expires_at = utcnow() - timedelta(seconds=1)
        db.commit()
    assert anon.get("/api/jobs", headers=_bearer(made["token"])).status_code == 401
    assert client.get("/api/tokens").json()[0]["status"] == "expired"

    fresh = _mint(client)["token"]
    forged = fresh[:13] + ("A" if fresh[13] != "A" else "B") + fresh[14:]
    for bad in (forged, "mxa_short", "nonsense", fresh + "x"):
        assert anon.get("/api/jobs", headers=_bearer(bad)).status_code == 401, bad


def test_last_used_is_written_at_most_once_a_minute(client, anon):
    made = _mint(client)
    anon.get("/api/jobs", headers=_bearer(made["token"]))
    with SessionLocal() as db:
        first = db.get(ApiToken, made["id"]).last_used_at
    assert first is not None
    anon.get("/api/jobs", headers=_bearer(made["token"]))
    with SessionLocal() as db:
        row = db.get(ApiToken, made["id"])
        assert row.last_used_at == first
        row.last_used_at = first - timedelta(minutes=2)
        db.commit()
    anon.get("/api/jobs", headers=_bearer(made["token"]))
    with SessionLocal() as db:
        assert db.get(ApiToken, made["id"]).last_used_at > first - timedelta(minutes=2)


def test_resolve_token_is_usable_outside_a_request(client):
    # the MCP server resolves its Bearer header the same way
    made = _mint(client, ["read", "manage"])
    with SessionLocal() as db:
        cur = resolve_token(db, made["token"])
        assert cur.via_token and cur.scopes == {"read", "manage"} and cur.role == "owner"
        assert cur.can("read") and not cur.can("generate")
        assert resolve_token(db, "mxa_00000000_" + "x" * 43) is None


# ---------------------------------------------------------------- scopes

def test_scope_matrix(client, anon, project):
    read = _mint(client, ["read"])["token"]
    gen = _mint(client, ["generate"])["token"]
    manage = _mint(client, ["manage"])["token"]
    body = {"prompt": "a lighthouse at dusk"}

    assert anon.get("/api/projects", headers=_bearer(read)).status_code == 200
    r = anon.post("/api/images/generate", json=body, headers=_bearer(read))
    assert r.status_code == 403 and "'generate' scope" in r.json()["detail"]
    assert anon.delete(f"/api/projects/{project['id']}", headers=_bearer(read)).status_code == 403

    assert anon.get("/api/projects", headers=_bearer(gen)).status_code == 403
    assert anon.post("/api/images/generate", json=body, headers=_bearer(gen)).status_code == 202
    assert anon.delete(f"/api/projects/{project['id']}", headers=_bearer(gen)).status_code == 403

    assert anon.post("/api/images/generate", json=body, headers=_bearer(manage)).status_code == 403
    assert anon.delete(f"/api/projects/{project['id']}", headers=_bearer(manage)).status_code == 204


def test_read_only_posts_take_a_read_token(client, anon):
    # photo histogram/auto only look at the picture; the override lets a read token call them
    from app.api.photo import auto, histogram_post, preview

    assert auto.token_scope == histogram_post.token_scope == preview.token_scope == "read"


def test_a_viewer_token_cannot_generate(client, anon, login, flags):
    flags(public_api=True)
    ed = login(_user("ed@test.local", "editor"))
    token = _mint(ed, ["read", "generate"])["token"]
    with SessionLocal() as db:
        u = db.scalars(select(User).where(User.email == "ed@test.local")).one()
        db.scalars(select(Membership).where(Membership.user_id == u.id)).one().role = "viewer"
        db.commit()
    r = anon.post("/api/images/generate", json={"prompt": "x"}, headers=_bearer(token))
    assert r.status_code == 403 and "Viewers" in r.json()["detail"]
    assert anon.get("/api/jobs", headers=_bearer(token)).status_code == 200


def test_tokens_cannot_reach_auth_or_token_routes(client, anon):
    token = _mint(client, ["read", "generate", "manage"])
    h = _bearer(token["token"])
    for method, path, body in (("GET", "/api/auth/me", None), ("POST", "/api/auth/logout", None),
                               ("GET", "/api/tokens", None),
                               ("POST", "/api/tokens", {"name": "child", "scopes": ["read"]}),
                               ("DELETE", f"/api/tokens/{token['id']}", None)):
        r = anon.request(method, path, json=body, headers=h)
        assert r.status_code == 403, (method, path, r.status_code)
    assert len(client.get("/api/tokens").json()) == 1  # nothing minted, nothing revoked


# ---------------------------------------------------------------- PUBLIC_API

def test_public_api_off_hides_tokens_and_docs_from_everyone_but_the_admin(client, anon, login, flags):
    flags(public_api=False, api_docs=True)
    ed = login(_user("ed@test.local", "editor"))
    for path in ("/api/tokens", "/api/docs", "/api/redoc", "/api/openapi.json"):
        assert ed.get(path).status_code == 404, path
        assert anon.get(path).status_code == 404, path
        assert client.get(path).status_code == 200, path
    assert ed.post("/api/tokens", json={"name": "x", "scopes": ["read"]}).status_code == 404

    me = ed.get("/api/auth/me").json()
    assert me["api_access"] is False and me["api_docs"] is False
    me = client.get("/api/auth/me").json()
    assert me["api_access"] is True and me["api_docs"] is True


def test_public_api_off_admin_token_opens_the_docs_and_api(client, anon, flags):
    flags(public_api=False)
    token = _mint(client, ["read"])["token"]
    assert anon.get("/api/openapi.json", headers=_bearer(token)).status_code == 200
    assert "swagger-ui" in anon.get("/api/docs", headers=_bearer(token)).text


def test_public_api_on_lets_owners_and_editors_mint(client, login, flags):
    flags(public_api=True)
    ed = login(_user("ed@test.local", "editor"))
    viewer = login(_user("vi@test.local", "viewer"))
    assert ed.get("/api/auth/me").json()["api_access"] is True
    assert _mint(ed, ["read", "generate"])["scopes"] == ["read", "generate"]
    assert [t["name"] for t in ed.get("/api/tokens").json()] == ["script"]
    assert client.get("/api/tokens").json() == []  # each user sees only their own

    assert viewer.get("/api/tokens").status_code == 404
    assert viewer.get("/api/docs").status_code == 200  # the docs open to any signed-in user
    assert viewer.get("/api/auth/me").json()["api_docs"] is True


def test_api_docs_off_closes_them_for_the_admin_too(client, flags):
    flags(api_docs=False)
    for path in ("/api/docs", "/api/redoc", "/api/openapi.json"):
        assert client.get(path).status_code == 404
    assert client.get("/api/auth/me").json()["api_docs"] is False
    assert client.get("/api/tokens").status_code == 200


# ---------------------------------------------------------------- clients

def test_get_one_job(client, anon):
    jobs = client.post("/api/images/generate", json={"prompt": "a lighthouse"}).json()["jobs"]
    token = _mint(client, ["read"])["token"]
    r = anon.get(f"/api/jobs/{jobs[0]['id']}", headers=_bearer(token))
    assert r.status_code == 200 and r.json()["status"] == "queued" and r.json()["id"] == jobs[0]["id"]
    assert client.get("/api/jobs/not-a-job").status_code == 404


def test_submit_poll_download_with_a_token(client, anon, fast_driver):
    token = _mint(client, ["read", "generate"])["token"]
    h = _bearer(token)
    batch = anon.post("/api/images/generate", json={"prompt": "a red kite"}, headers=h).json()
    while process_one(driver_factory=fast_driver):
        pass
    assert anon.get(f"/api/jobs/{batch['jobs'][0]['id']}", headers=h).json()["status"] == "done"
    item = anon.get(f"/api/media/{batch['items'][0]['id']}", headers=h).json()

    r = anon.get(f"/api/generations/{item['generation_id']}/download", headers=h)
    assert r.status_code == 200 and r.content
    assert anon.get(item["media_url"], headers=h).status_code == 200
    assert anon.get(item["media_url"]).status_code == 401


def test_event_stream_accepts_a_bearer_token(client, anon):
    made = _mint(client, ["read"])
    no_read = _mint(client, ["generate"])["token"]
    ws = client.get("/api/auth/me").json()["workspace_id"]

    def req(headers: dict) -> Request:
        return Request({"type": "http", "method": "GET", "path": "/api/events", "query_string": b"",
                        "headers": [(k.lower().encode(), v.encode()) for k, v in headers.items()]})

    assert _auth_workspace(req(_bearer(made["token"]))) == ws
    with pytest.raises(HTTPException) as e:
        _auth_workspace(req(_bearer(no_read)))
    assert e.value.status_code == 403
    with pytest.raises(HTTPException) as e:
        _auth_workspace(req({}))
    assert e.value.status_code == 401
    assert anon.get("/api/events", headers=_bearer("mxa_bad")).status_code == 401


# ---------------------------------------------------------------- docs

def test_openapi_has_bearer_auth_areas_and_no_internal_routes(client):
    spec = client.get("/api/openapi.json").json()
    assert spec["components"]["securitySchemes"]["bearerAuth"]["scheme"] == "bearer"
    assert spec["security"] == [{"bearerAuth": []}]
    paths = spec["paths"]
    for hidden in ("/api/auth/dev-login", "/api/auth/login", "/api/events", "/api/tokens", "/api/system/status",
                   "/api/system/llm-check", "/api/docs", "/api/openapi.json"):
        assert hidden not in paths, hidden
    assert "/api/jobs/{job_id}" in paths

    tags = {t for p in paths.values() for op in p.values() for t in op["tags"]}
    assert tags <= {"Image", "Video", "Film", "Characters", "Audio", "Voice", "Podcast", "Photo", "Library", "Jobs"}
    assert paths["/api/images/generate"]["post"]["tags"] == ["Image"]
    assert paths["/api/audio/speak"]["post"]["tags"] == ["Voice"]
    assert paths["/api/characters/{character_id}/sheet"]["post"]["tags"] == ["Characters"]

    upload = paths["/api/media/upload"]["post"]["requestBody"]["content"]["multipart/form-data"]["schema"]
    assert upload["properties"]["file"]["format"] == "binary"
    assert "$ref" in str(paths["/api/transcribe"]["post"]["responses"]["202"])

    gen = spec["components"]["schemas"]["ImageGenerateIn"]
    assert gen["properties"]["prompt"]["description"] and gen["examples"]


# ---------------------------------------------------------------- hardening

def test_login_is_rate_limited_per_ip(anon):
    from tests.conftest import ADMIN

    for _ in range(5):
        assert anon.post("/api/auth/login", json={**ADMIN, "password": "nope"}).status_code == 401
    r = anon.post("/api/auth/login", json=ADMIN)  # even the right password waits now
    assert r.status_code == 429 and int(r.headers["retry-after"]) >= 1
    assert "Try again" in r.json()["detail"]


def test_good_logins_do_not_count_toward_the_limit(anon):
    from tests.conftest import ADMIN

    for _ in range(8):
        assert anon.post("/api/auth/login", json=ADMIN).status_code == 200


def test_weak_secret_warning(caplog):
    assert warn_weak_secret("change-me") and warn_weak_secret("short")
    assert "APP_SECRET" in caplog.text
    assert not warn_weak_secret("a-long-random-secret-of-decent-length")
