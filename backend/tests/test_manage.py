from app import manage
from app.config import get_settings


def test_reset_password_lets_admin_log_in_with_new_one(anon, monkeypatch):
    email = get_settings().admin_email
    anon.post("/api/auth/login", json={"email": email, "password": get_settings().admin_password})
    monkeypatch.setenv("MIXAI_NEW_PASSWORD", "a-brand-new-pass-123")
    assert manage.main(["reset-password", email]) == 0
    ok = anon.post("/api/auth/login", json={"email": email, "password": "a-brand-new-pass-123"})
    assert ok.status_code == 200


def test_reset_password_rejects_short_and_unknown(monkeypatch):
    monkeypatch.setenv("MIXAI_NEW_PASSWORD", "short")
    assert manage.main(["reset-password", get_settings().admin_email]) == 1
    monkeypatch.setenv("MIXAI_NEW_PASSWORD", "long-enough-password")
    assert manage.main(["reset-password", "nobody@example.com"]) == 1
