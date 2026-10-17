"""3D Studio part 3 (M20, contract v40 §7): the turntable upload and the model's thumbnail."""
import io
from pathlib import Path

import pytest
from PIL import Image

from app import model3d as m3
from app import reel as rl
from app.config import get_settings
from app.db import SessionLocal
from app.models import Generation, MediaItem
from tests.test_3d import _drain, _photo
from tests.test_accounts import PW, make_user
from tests.test_api_tokens import _user, login  # noqa: F401  (fixtures)
from tests.test_library import png_bytes


@pytest.fixture
def clip(tmp_path) -> bytes:
    path = tmp_path / "spin.webm"
    try:
        rl.run_ff(["-f", "lavfi", "-i", "color=c=red:s=128x128:r=24:d=1", "-c:v", "libvpx", "-b:v", "200k", str(path)])
    except rl.FFmpegError:
        pytest.skip("this ffmpeg build has no libvpx")
    return path.read_bytes()


def _model(client, fast_driver) -> dict:
    src = _photo(client)
    out = client.post("/api/3d/make", json={"source_id": src["id"], "quality": "draft"}).json()
    _drain(fast_driver)
    return client.get(f"/api/media/{out['item']['id']}").json()


def _glb(model: dict) -> Path:
    with SessionLocal() as db:
        return get_settings().data_dir / db.get(Generation, model["generation_id"]).file_path


def _thumb_colour(client, url: str) -> tuple:
    r = client.get(url)
    assert r.status_code == 200
    with Image.open(io.BytesIO(r.content)) as im:
        return im.convert("RGB").getpixel((im.width // 2, im.height // 2))


def _send(client, model_id, data, name="turntable.webm", ctype="video/webm"):
    return client.post(f"/api/3d/{model_id}/turntable", files={"file": (name, data, ctype)})


def test_turntable_becomes_a_linked_mp4_and_the_thumb(client, fast_driver, clip):
    model = _model(client, fast_driver)
    before = model["thumb_url"]
    r = _send(client, model["id"], clip)
    assert r.status_code == 201, r.text
    out = r.json()
    video = out["item"]
    assert out["transcoded"] is True
    assert video["kind"] == "video" and video["media_type"] == "video/mp4" and video["origin"] == "generated"
    assert video["title"] == "Teapot · 3D · turntable" and video["media_url"].endswith(".mp4")
    assert client.get(video["media_url"]).content[4:8] == b"ftyp"
    with SessionLocal() as db:
        item = db.get(MediaItem, video["id"])
        tg = db.get(Generation, item.generation_id)
        mg = db.get(Generation, model["generation_id"])
        assert item.home is None
        assert tg.params["model3d_of"] == model["id"] and tg.params["created_by"]["flow"] == "make_3d:turntable"
        assert mg.params["turntable_id"] == video["id"] and mg.params["thumb_from"] == "turntable"
        assert mg.params["turntables"] == [video["id"]]
    # the model's own answer lists them for the frontend's delete dialog
    assert client.get(f"/api/media/{model['id']}").json()["params"]["turntables"] == [video["id"]]
    # a final output: it shows in the Library grid, unlike the model's working parts
    assert video["id"] in {i["id"] for i in client.get("/api/media").json()["items"]}
    # the model's thumb is now the red first frame, under a new URL so week-long caches let go
    assert out["model"]["thumb_url"] != before and "&v=" in out["model"]["thumb_url"]
    red, green, blue = _thumb_colour(client, out["model"]["thumb_url"])
    assert red > 200 and green < 60 and blue < 60


def test_webm_is_kept_when_ffmpeg_cannot_convert(client, fast_driver, clip, monkeypatch):
    model = _model(client, fast_driver)
    real = rl.run_ff

    def broken(args, timeout=900):
        if "libx264" in args:
            raise rl.FFmpegError("ffmpeg failed: no encoder")
        return real(args, timeout)

    monkeypatch.setattr(rl, "run_ff", broken)
    out = _send(client, model["id"], clip).json()
    assert out["transcoded"] is False and out["item"]["media_type"] == "video/webm"
    assert not list(get_settings().data_dir.rglob(".turntable-*"))


def test_turntable_checks_type_size_state_and_owner(client, fast_driver, clip, login, monkeypatch):  # noqa: F811
    model = _model(client, fast_driver)
    assert _send(client, model["id"], png_bytes(), "spin.png", "image/png").status_code == 415
    assert _send(client, model["id"], b"not a video at all" * 8, "spin.webm").status_code == 415

    from app.api import model3d as api3d

    # a real 60 MB body is slow to build; a 1000-byte limit takes the same path
    monkeypatch.setattr(api3d, "TURNTABLE", api3d.uploads.Profile(
        api3d._sniff_turntable, lambda _t: 1000, api3d.TURNTABLE.too_big, api3d.TURNTABLE.allowed, 1000))
    r = _send(client, model["id"], clip)
    assert r.status_code == 413 and "60 MB" in r.json()["detail"]
    monkeypatch.undo()

    # only a finished model takes one; a picture isn't a model
    pic = _photo(client)
    assert _send(client, pic["id"], clip).status_code == 404
    queued = client.post("/api/3d/make", json={"source_id": pic["id"]}).json()["item"]
    assert _send(client, queued["id"], clip).status_code == 409

    make_user("bea@example.com", "Bea")
    bea = login({"email": "bea@example.com", "password": PW})
    assert _send(bea, model["id"], clip).status_code == 404
    assert bea.post(f"/api/3d/{model['id']}/thumbnail",
                    files={"file": ("v.png", png_bytes(), "image/png")}).status_code == 404

    viewer = login(_user("vi@test.local", "viewer"))
    assert _send(viewer, model["id"], clip).status_code == 403
    with SessionLocal() as db:
        assert db.query(MediaItem).filter(MediaItem.kind == "video").count() == 0


def test_snapshot_sets_the_thumb_and_outranks_a_later_turntable(client, fast_driver, clip):
    model = _model(client, fast_driver)
    snap = png_bytes((600, 600), (20, 40, 200))
    r = client.post(f"/api/3d/{model['id']}/thumbnail", files={"file": ("view.png", snap, "image/png")})
    assert r.status_code == 200, r.text
    url = r.json()["thumb_url"]
    assert url != model["thumb_url"]
    assert _thumb_colour(client, url)[2] > 150
    glb = _glb(model)
    with Image.open(glb.with_name(f"{glb.stem}.thumb256.webp")) as im:
        assert im.size == (256, 256)

    # the person picked that view by hand, so the turntable's first frame doesn't replace it
    out = _send(client, model["id"], clip).json()
    assert out["model"]["thumb_url"] == url
    with SessionLocal() as db:
        assert db.get(Generation, model["generation_id"]).params["thumb_from"] == "snapshot"

    bad = client.post(f"/api/3d/{model['id']}/thumbnail", files={"file": ("v.webm", clip, "video/webm")})
    assert bad.status_code == 415
    # the listing uses the same new URL as the item
    assert {m["id"]: m["thumb_url"] for m in client.get("/api/media?kind=model").json()["items"]}[model["id"]] == url


def test_mp4_turntable_is_stored_as_is(client, fast_driver, tmp_path):
    model = _model(client, fast_driver)
    path = tmp_path / "spin.mp4"
    rl.run_ff(["-f", "lavfi", "-i", "color=c=green:s=128x128:r=24:d=1", *m3.TURNTABLE_ENC, str(path)])
    out = _send(client, model["id"], path.read_bytes(), "spin.mp4", "video/mp4").json()
    assert out["transcoded"] is False and out["item"]["media_type"] == "video/mp4"
