from app.api.media import resolve_media_path
from app.config import REPO_ROOT, get_settings


def test_traversal_blocked(client):
    # make sure there is something juicy one level up
    secret = get_settings().data_dir.parent / "secret.txt"
    secret.write_text("nope", encoding="utf-8")
    for path in (
        "/api/media/..%2F..%2F.env",
        "/api/media/%2e%2e/%2e%2e/.env",
        "/api/media/..%2Fsecret.txt",
        "/api/media/workspaces/..%2F..%2Fsecret.txt",
        "/api/media/..\\secret.txt",
    ):
        assert client.get(path).status_code == 404, path


def test_resolver_rejects_outside_and_other_workspaces(tmp_path):
    data = tmp_path / "data"
    mine = data / "workspaces" / "ws1" / "a.png"
    theirs = data / "workspaces" / "ws2" / "b.png"
    for f in (mine, theirs):
        f.parent.mkdir(parents=True)
        f.write_bytes(b"x")
    (tmp_path / ".env").write_text("SECRET=1")

    assert resolve_media_path("workspaces/ws1/a.png", "ws1", data) == mine.resolve()
    assert resolve_media_path("workspaces/ws2/b.png", "ws1", data) is None
    assert resolve_media_path("../.env", "ws1", data) is None
    assert resolve_media_path("workspaces/ws1/../../../.env", "ws1", data) is None
    assert resolve_media_path(str(REPO_ROOT / ".env.example"), "ws1", data) is None
    assert resolve_media_path("workspaces/ws1/missing.png", "ws1", data) is None


def test_media_requires_session(anon):
    assert anon.get("/api/media/workspaces/x/y.png").status_code == 401
