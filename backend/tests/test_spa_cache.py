"""The built frontend: index.html is never cached (an old copy points at build files a deploy removed), the
hashed build files are cached for good."""
import pytest

from app.main import FRONTEND_DIST


@pytest.mark.skipif(not (FRONTEND_DIST / "index.html").is_file(), reason="no frontend build")
def test_index_is_never_stale_and_assets_are_immutable(anon):
    for path in ("/", "/image/library", "/studio"):
        r = anon.get(path)
        assert r.status_code == 200 and r.headers["cache-control"] == "no-cache"
    asset = next((FRONTEND_DIST / "assets").glob("*.js"))
    r = anon.get(f"/assets/{asset.name}")
    assert r.status_code == 200 and "immutable" in r.headers["cache-control"]
