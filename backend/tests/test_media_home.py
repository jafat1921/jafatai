"""Studio parts (contract v37): items with a home stay out of the general lists, part_of from outside callers,
and the 0026 backfill."""
import importlib.util
import json
import sqlite3
from pathlib import Path

import pytest

from app.db import SessionLocal
from app.models import MediaItem
from tests.test_api_tokens import _bearer, _mint, _user, flags, login  # noqa: F401  (fixtures)
from tests.test_mcp import Mcp
from tests.test_migrations import _alembic


def _image(client, prompt: str, **extra) -> dict:
    r = client.post("/api/images/generate", json={"prompt": prompt, "aspect": "1:1", **extra})
    assert r.status_code == 202, r.text
    return r.json()["items"][0]


def _ids(client, **query) -> set[str]:
    r = client.get("/api/media", params=query)
    assert r.status_code == 200, r.text
    return {i["id"] for i in r.json()["items"]}


def _set_home(item_id: str, home: str | None) -> None:
    with SessionLocal() as db:
        db.get(MediaItem, item_id).home = home
        db.commit()


def test_parts_are_hidden_unless_asked_for(client):
    final = _image(client, "a lighthouse")["id"]
    board = _image(client, "a sheet")["id"]
    song = _image(client, "a poem")["id"]
    _set_home(board, "character")
    _set_home(song, "poetry")

    assert _ids(client, kind="image", origin="generated") == {final}
    assert _ids(client, kind="image", include="project") == {final}
    assert _ids(client, kind="image", include_home="character") == {final, board}
    assert _ids(client, kind="image", include_home="character,poetry") == {final, board, song}
    assert _ids(client, kind="image", home="character") == {board}
    assert _ids(client, kind="image", home="any", include="project") == {board, song}
    # home wins over include_home
    assert _ids(client, kind="image", home="poetry", include_home="character") == {song}
    # by id it's an ordinary item
    got = client.get(f"/api/media/{board}").json()
    assert got["home"] == "character"
    assert all(i["home"] is None for i in client.get("/api/media", params={"kind": "image"}).json()["items"])
    assert board not in {i["id"] for i in client.get("/api/dashboard").json()["recent_images"]}


def test_part_of_on_rest_image_and_video(client):
    pic = _image(client, "page one", part_of="  story:abc  ")
    assert pic["home"] == "story:abc"
    r = client.post("/api/videos/generate", json={"prompt": "Waves at the lighthouse", "duration_s": 2,
                                                  "part_of": "story:abc"})
    assert r.status_code == 202, r.text
    clip = r.json()
    assert clip["home"] == "story:abc"
    assert clip["id"] not in _ids(client, kind="video") and pic["id"] not in _ids(client, kind="image")
    assert _ids(client, kind="video", home="story:abc") == {clip["id"]}
    assert not _ids(client, kind="video", home="story:other")
    blank = _image(client, "no part", part_of="   ")
    assert blank["home"] is None and blank["id"] in _ids(client, kind="image")
    r = client.post("/api/images/generate", json={"prompt": "x", "part_of": "x" * 81})
    assert r.status_code == 422


def test_part_of_on_speak(client):
    r = client.post("/api/audio/speak", json={"text": "Hello, my name is Mira.", "engine": "auto",
                                              "language": "en", "part_of": "character"})
    assert r.status_code == 202, r.text
    item = r.json()["items"][0]
    assert item["home"] == "character"
    assert item["id"] not in _ids(client, kind="audio")
    assert item["id"] in _ids(client, kind="audio", home="character")


def test_part_of_on_mcp_generate_video_and_image(client, anon):
    m = Mcp(anon, _mint(client, ["read", "generate"])["token"])
    vid = m.call_json("generate_video", prompt="Rain on the window, slow push in", duration_s=2, part_of="story:9")
    pic = m.call_json("generate_image", prompt="A rainy window", part_of="story:9")
    plain = m.call_json("generate_image", prompt="A sunny window")
    vid_id, pic_id = vid["items"][0]["media_id"], pic["items"][0]["media_id"]
    with SessionLocal() as db:
        assert db.get(MediaItem, vid_id).home == "story:9" and db.get(MediaItem, pic_id).home == "story:9"
    # MCP rows are shown in the app (contract v34), parts still aren't
    assert vid_id not in _ids(client, kind="video")
    assert _ids(client, kind="image") == {plain["items"][0]["media_id"]}
    assert _ids(client, kind="video", home="story:9") == {vid_id}


ROWS = [
    # id, kind, origin, title, tags, flow, expected home
    ("m1", "image", "generated", "Mira · character sheet", ["character sheet"], None, "character"),
    ("m2", "video", "generated", "Mira · test clip", ["test clip"], "character_test_clip", "character"),
    ("m3", "audio", "generated", "Mira · voice preview", [], "speak", "character"),
    ("m4", "audio", "generated", "Moon · song", ["poetry"], "poetry_short", "poetry"),
    ("m5", "video", "generated", "Moon", ["poetry", "short"], None, None),
    ("m6", "audio", "generated", "Story music · soft", ["story"], "story_music", "story"),
    ("m7", "audio", "generated", "Reef · Ali (voice sample)", ["dub"], "dub_sample", "dub"),
    ("m8", "audio", "generated", "Reef · Urdu", ["dub"], "dub", None),
    ("m9", "audio", "generated", "Voice design · deep", [], "voice_design", "voice"),
    ("m10", "image", "upload", "logo", ["brand", "logo"], None, "brand"),
    ("m11", "video", "generated", "Acme · logo reveal", ["brand", "logo reveal"], None, None),
    ("m12", "video", "generated", "BlogCreatorPro The Fox p3 9:16", [], "video_generate", "story"),
    ("m13", "image", "generated", "A lighthouse", [], "image_generate", None),
    ("m14", "image", "generated", "An ad", ["ad", "ad-studio", "1:1"], None, None),
]


def test_0026_backfills_homes(tmp_path):
    db = tmp_path / "prod-copy.db"
    _alembic(db, "upgrade", "0025")
    con = sqlite3.connect(db)
    now = "2026-10-16 10:00:00"
    con.execute("INSERT INTO workspace (id, name, created_at) VALUES ('w1', 'ws', ?)", (now,))
    for id_, kind, origin, title, tags, flow, _ in ROWS:
        gid = f"g-{id_}"
        params = {"created_by": {"flow": flow}} if flow else {}
        con.execute("INSERT INTO generation (id, workspace_id, target_type, target_id, kind, version, status, prompt,"
                    " params, seed, created_at, updated_at) VALUES (?, 'w1', 'media', ?, 'image', 1, 'ready', '',"
                    " ?, 1, ?, ?)", (gid, id_, json.dumps(params), now, now))
        con.execute("INSERT INTO media_item (id, workspace_id, kind, origin, title, tags, generation_id, created_at,"
                    " updated_at) VALUES (?, 'w1', ?, ?, ?, ?, ?, ?, ?)",
                    (id_, kind, origin, title, json.dumps(tags), gid, now, now))
    # an item whose current version is gone still gets its tag rule
    con.execute("INSERT INTO media_item (id, workspace_id, kind, origin, title, tags, generation_id, created_at,"
                " updated_at) VALUES ('m15', 'w1', 'audio', 'generated', 'x', '[\"story\"]', 'nope', ?, ?)", (now, now))
    con.commit()
    con.close()

    _alembic(db, "upgrade", "0026")
    con = sqlite3.connect(db)
    homes = dict(con.execute("SELECT id, home FROM media_item"))
    assert homes == {**{r[0]: r[6] for r in ROWS}, "m15": "story"}
    assert "ix_media_item_home" in {r[1] for r in con.execute("PRAGMA index_list(media_item)")}
    con.close()

    _alembic(db, "downgrade", "0025")
    con = sqlite3.connect(db)
    assert "home" not in {r[1] for r in con.execute("PRAGMA table_info(media_item)")}
    assert con.execute("SELECT count(*) FROM media_item").fetchone()[0] == 15
    con.close()
    _alembic(db, "upgrade", "head")


def _migration():
    spec = importlib.util.spec_from_file_location("m0026", Path(__file__).resolve().parents[1] / "alembic" /
                                                  "versions" / "0026_media_home.py")
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


@pytest.mark.parametrize("title", ["BlogCreatorPro", "My BlogCreatorPro clip"])
def test_backfill_only_takes_the_prefix(title):
    assert _migration().home_for("video", "generated", title, [], None) is None
