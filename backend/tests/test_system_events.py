from datetime import timedelta

from app.api.events import _frame, collect_changes
from app.models import utcnow


def test_status_shape(client, monkeypatch):
    from app.config import get_settings

    monkeypatch.setattr(get_settings(), "llm_base_url", "http://127.0.0.1:9/v1")
    body = client.get("/api/system/status").json()
    assert body["driver"] == "mock"
    assert body["comfy"]["ok"] is False and "error" in body["comfy"]
    assert body["llm"] == {"ok": False, "url": "http://127.0.0.1:9", "error": body["llm"]["error"]}
    assert body["worker"]["alive"] is False


def test_changes_feed_picks_up_jobs_and_generations(client, character):
    since = utcnow() - timedelta(seconds=1)
    me = client.get("/api/auth/me").json()
    client.post(
        "/api/generations",
        json={"target_type": "character", "target_id": character["id"], "kind": "portrait", "prompt": "p"},
    )
    kinds = sorted(k for k, *_ in collect_changes(me["workspace_id"], since))
    assert kinds == ["generation", "job"]
    assert collect_changes("someone-else", since) == []


def test_frame_format():
    assert _frame("job", {"id": "1"}, "t") == 'event: job\nid: t\ndata: {"id":"1"}\n\n'
