"""Grid thumbnails, the /upscales list and deleting an upscaled version (P5)."""
import io

from PIL import Image

from app import manage, thumbs
from app.config import get_settings
from app.db import SessionLocal
from app.models import Generation, Job, MediaItem
from tests.test_library import png_bytes, upload
from tests.test_storyboard import _approved, _run_all
from tests.test_upscale import _source, film  # noqa: F401  (fixture)


def _src(gen_id):
    with SessionLocal() as db:
        return get_settings().data_dir / db.get(Generation, gen_id).file_path


def _webp(r):
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "image/webp"
    return Image.open(io.BytesIO(r.content))


# ------------------------------------------------------------------ thumbnails

def test_upload_gets_a_small_webp_thumb(client):
    item = upload(client, "big.png", png_bytes((2000, 1000)), "image/png").json()
    assert item["thumb_url"] == f"/api/media/thumb/{item['generation_id']}?w=512"
    assert item["media_url"] != item["thumb_url"]
    src = _src(item["generation_id"])
    assert thumbs.thumb_file(src, 512).is_file() and thumbs.thumb_file(src, 256).is_file()

    r = client.get(item["thumb_url"])
    assert _webp(r).size == (512, 256)
    assert "max-age" in r.headers["cache-control"] and r.headers["cache-control"].startswith("private")
    assert _webp(client.get(f"/api/media/thumb/{item['generation_id']}?w=256")).size == (256, 128)
    assert client.get(f"/api/media/thumb/{item['generation_id']}?w=300").status_code == 422
    assert client.get("/api/media/thumb/nope").status_code == 404


def test_thumb_made_on_demand_for_older_items(client):
    item = upload(client, "old.jpg", png_bytes((900, 900), fmt="JPEG"), "image/jpeg").json()
    src = _src(item["generation_id"])
    thumbs.remove_for(src)  # what a library from before thumbs looks like
    assert _webp(client.get(item["thumb_url"])).size == (512, 512)
    assert thumbs.thumb_file(src, 512).is_file()


def test_thumb_refuses_files_outside_the_workspace(client):
    outside = get_settings().data_dir / "secret.png"
    outside.write_bytes(png_bytes())
    item = upload(client, "a.png", png_bytes(), "image/png").json()
    with SessionLocal() as db:
        g = db.get(Generation, item["generation_id"])
        g.file_path = f"workspaces/{g.workspace_id}/../../secret.png"
        db.commit()
    assert client.get(item["thumb_url"]).status_code == 404
    assert not thumbs.thumb_file(outside, 512).exists()


def test_video_thumb_is_a_poster_frame(client, film):
    item = upload(client, "film.mp4", film.read_bytes(), "video/mp4").json()
    assert item["thumb_url"] == f"/api/media/thumb/{item['generation_id']}?w=512"
    im = _webp(client.get(item["thumb_url"]))
    assert im.size == (320, 180)  # never upscaled past the source
    # testsrc2 at 1 s isn't a black frame
    assert max(im.convert("L").getextrema()) > 40


def test_worker_makes_thumbs_and_list_returns_them(client, project, character, fast_driver):
    item = client.post("/api/images/generate", json={"prompt": "a lighthouse", "aspect": "1:1"}).json()["items"][0]
    assert item["thumb_url"] is None  # nothing to show while it's queued
    _run_all(fast_driver)
    row = client.get("/api/media").json()["items"][0]
    assert row["thumb_url"] == f"/api/media/thumb/{row['generation_id']}?w=512"
    assert thumbs.thumb_file(_src(row["generation_id"]), 512).is_file()

    portrait = _approved(client, fast_driver, "character", character["id"], "portrait", "grey-haired diver")
    rows = client.get("/api/media", params={"include": "project"}).json()["items"]
    prow = next(r for r in rows if r["id"] == portrait["id"])
    assert prow["thumb_url"] == f"/api/media/thumb/{portrait['id']}?w=512"
    assert client.get(f"/api/generations/{portrait['id']}").json()["thumb_url"] == prow["thumb_url"]


def test_project_render_rows_get_an_image_thumb(client, project, film):
    # renders used to have no thumb, so the grid drew a <video> whose first frame is black
    rid = _source(project["id"], film)
    rows = client.get("/api/media", params={"origin": "project", "kind": "video"}).json()["items"]
    assert rows[0]["id"] == rid and rows[0]["thumb_url"] == f"/api/media/thumb/{rid}?w=512"
    assert _webp(client.get(rows[0]["thumb_url"])).size == (320, 180)


def test_manage_thumbs_backfills(client, capsys):
    a = upload(client, "a.png", png_bytes((700, 400)), "image/png").json()
    src = _src(a["generation_id"])
    thumbs.remove_for(src)
    assert manage.main(["thumbs"]) == 0
    assert "1 made" in capsys.readouterr().out
    assert thumbs.thumb_file(src, 512).is_file() and thumbs.thumb_file(src, 256).is_file()
    assert manage.main(["thumbs"]) == 0  # nothing left to do
    assert "0 made, 0 failed" in capsys.readouterr().out


# ------------------------------------------------------------------ upscaled items in the library

def test_upscaled_item_has_badge_original_and_its_own_thumb(client, fast_driver):
    item = upload(client, "pic122.png", png_bytes((400, 300)), "image/png").json()
    assert item["upscale"] is None and item["original_generation_id"] is None
    client.post(f"/api/generations/{item['generation_id']}/upscale", json={"engine": "quick", "target": "4k"})
    _run_all(fast_driver)
    row = client.get("/api/media").json()["items"][0]
    assert row["upscale"] == {"target": "4k", "label": "4K", "engine": "quick"}
    assert row["original_generation_id"] == item["generation_id"]
    assert row["generation_id"] != item["generation_id"]
    # the tile asks for a 512 px webp of the upscale, not the 3840 px PNG
    assert row["thumb_url"] == f"/api/media/thumb/{row['generation_id']}?w=512"
    assert _webp(client.get(row["thumb_url"])).size == (512, 384)


# ------------------------------------------------------------------ /upscales

def test_upscales_list_covers_image_video_running_and_failed(client, project, film, fast_driver):
    up = upload(client, "pic.png", png_bytes((400, 300)), "image/png").json()
    r = client.post(f"/api/generations/{up['generation_id']}/upscale", json={"engine": "quick", "target": "2x"})
    _run_all(fast_driver)
    done_id = client.get(f"/api/media/{up['id']}").json()["generation_id"]

    gen = client.post("/api/images/generate", json={"prompt": "The Luminous Tree", "aspect": "1:1"}).json()["items"][0]
    _run_all(fast_driver)
    gid = client.get(f"/api/media/{gen['id']}").json()["generation_id"]
    queued = client.post(f"/api/generations/{gid}/upscale", json={"engine": "quick", "target": "2x"}).json()
    failing = client.post(f"/api/generations/{gid}/upscale", json={"engine": "quick", "target": "4x"}).json()
    with SessionLocal() as db:
        j = db.get(Job, failing["id"])
        j.status, j.error = "failed", "ComfyUI ran out of memory"
        db.get(Generation, j.generation_id).status = "failed"
        db.commit()
    rid = _source(project["id"], film)
    video = client.post(f"/api/generations/{rid}/upscale", json={"engine": "quick", "target": "1080p"}).json()

    rows = client.get("/api/upscales", params={"kind": "image"}).json()["items"]
    assert [x["result"]["id"] for x in rows][:1] == [failing["generation_id"]]
    by = {x["result"]["id"]: x for x in rows}
    assert set(by) == {done_id, queued["generation_id"], failing["generation_id"]}

    done = by[done_id]
    assert done["status"] == "ready" and done["kind"] == "image" and done["media_id"] == up["id"]
    assert done["source"]["id"] == up["generation_id"] and done["source"]["media_url"]
    assert done["result"]["thumb_url"] and done["result"]["media_url"]
    assert (done["width"], done["height"], done["label"], done["engine"]) == (800, 600, "2×", "quick")
    assert done["title"] == "pic"

    q = by[queued["generation_id"]]
    assert q["status"] == "queued" and q["job"]["id"] == queued["id"] and q["job"]["status"] == "queued"
    assert q["title"] == gen["title"] and q["result"]["media_url"] is None
    f = by[failing["generation_id"]]
    assert f["status"] == "failed" and f["error"] == "ComfyUI ran out of memory"

    vids = client.get("/api/upscales", params={"kind": "video"}).json()["items"]
    assert len(vids) == 1 and vids[0]["result"]["id"] == video["generation_id"]
    assert vids[0]["project_id"] == project["id"] and vids[0]["media_id"] is None
    assert vids[0]["title"] == "Full film" and vids[0]["label"] == "1080p" and vids[0]["source"]["id"] == rid

    # pages of two walk all four
    seen, cursor = [], None
    while True:
        page = client.get("/api/upscales", params={"limit": 2, **({"cursor": cursor} if cursor else {})}).json()
        seen += [x["result"]["id"] for x in page["items"]]
        cursor = page["next_cursor"]
        if not cursor:
            break
    assert len(seen) == 4 and len(set(seen)) == 4


def test_delete_upscale_keeps_the_original(client, fast_driver):
    item = upload(client, "keep.png", png_bytes((400, 300)), "image/png").json()
    client.post(f"/api/generations/{item['generation_id']}/upscale", json={"engine": "quick", "target": "2x"})
    _run_all(fast_driver)
    d = client.get(f"/api/media/{item['id']}").json()
    up_id = d["generation_id"]
    up_file = _src(up_id)
    assert up_file.is_file() and thumbs.thumb_file(up_file, 512).is_file()

    assert client.delete(f"/api/upscales/{item['generation_id']}").status_code == 404  # not an upscale
    assert client.delete(f"/api/upscales/{up_id}").status_code == 204
    d = client.get(f"/api/media/{item['id']}").json()
    assert d["generation_id"] == item["generation_id"] and (d["width"], d["height"]) == (400, 300)
    assert d["versions_count"] == 1 and d["upscale"] is None
    assert not up_file.exists() and not thumbs.thumb_file(up_file, 512).exists()
    assert _src(item["generation_id"]).is_file()
    assert client.get("/api/upscales").json()["items"] == []
    with SessionLocal() as db:
        assert db.get(MediaItem, item["id"]) is not None
