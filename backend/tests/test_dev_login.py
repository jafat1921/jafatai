from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import app


def _local():
    return TestClient(app, client=("127.0.0.1", 50000))


def test_prefill_offered_to_local_dev():
    with _local() as c:
        body = c.get("/api/auth/dev-login").json()
    assert body["enabled"] is True
    assert body["email"] == get_settings().admin_email


def test_prefill_hidden_behind_proxy():
    with _local() as c:
        body = c.get("/api/auth/dev-login", headers={"X-Forwarded-For": "203.0.113.9"}).json()
    assert body == {"enabled": False}


def test_prefill_hidden_for_remote_client(anon):
    # TestClient's default client host is "testclient", i.e. not loopback
    assert anon.get("/api/auth/dev-login").json() == {"enabled": False}


def test_prefill_hidden_outside_dev(monkeypatch):
    monkeypatch.setattr(get_settings(), "app_env", "prod")
    with _local() as c:
        assert c.get("/api/auth/dev-login").json() == {"enabled": False}


def test_prefill_can_be_switched_off(monkeypatch):
    monkeypatch.setattr(get_settings(), "dev_login_prefill", False)
    with _local() as c:
        assert c.get("/api/auth/dev-login").json() == {"enabled": False}
