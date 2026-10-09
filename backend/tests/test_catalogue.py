"""Photo catalogue (M10 phase 1, contract v11): EXIF, RAW/HEIC/TIFF import, duplicates, marks, filters,
facets, albums, smart albums, shoots and clients."""
import io
from datetime import datetime

import numpy as np
import pytest
from PIL import Image

from app.catalogue import convert, exif as ex
from app.config import get_settings
from app.db import SessionLocal
from app.models import AlbumItem, Generation, MediaItem

rng = np.random.default_rng(11)


def jpeg(colour=(120, 80, 40), size=(320, 200), *, when="2026:05:01 10:30:00", model="NIKON Z 8",
         make="NIKON CORPORATION", f=1.8, iso=400, focal=85.0, lens="NIKKOR Z 85mm f/1.8 S", gps=True,
         noise=True) -> bytes:
    arr = np.full((size[1], size[0], 3), colour, np.uint8)
    if noise:  # every file different, so the duplicate check doesn't fire by accident
        arr = np.clip(arr + rng.integers(-3, 4, arr.shape), 0, 255).astype(np.uint8)
    e = Image.Exif()
    e[0x010F], e[0x0110] = make, model
    sub = e.get_ifd(0x8769)
    if when:
        sub[0x9003] = when
    sub[0x829D], sub[0x8827], sub[0x920A], sub[0x829A], sub[0xA434] = f, iso, focal, 1 / 250, lens
    if gps:
        g = e.get_ifd(0x8825)
        g[1], g[2], g[3], g[4] = "N", (24.0, 51.0, 36.0), "E", (67.0, 0.0, 36.0)
    buf = io.BytesIO()
    Image.fromarray(arr).save(buf, "JPEG", exif=e.tobytes(), quality=90)
    return buf.getvalue()


def upload(client, name, data, **fields):
    r = client.post("/api/media/upload", files={"file": (name, data, "application/octet-stream")},
                    data=fields or None)
    assert r.status_code in (200, 201), r.text
    return r.json()


def photos(client, **params):
    r = client.get("/api/photos", params=params)
    assert r.status_code == 200, r.text
    return r.json()


def titles(page) -> list[str]:
    return [i["title"] for i in page["items"]]


# ------------------------------------------------------------------ import

def test_exif_lands_in_columns(client):
    item = upload(client, "DSC_0412.jpg", jpeg())
    assert item["camera"] == "NIKON Z 8" and item["lens"] == "NIKKOR Z 85mm f/1.8 S"
    assert item["aperture"] == 1.8 and item["iso"] == 400 and item["focal_mm"] == 85.0
    assert abs(item["shutter_s"] - 1 / 250) < 1e-6
    assert item["captured_at"].startswith("2026-05-01T10:30:00") and item["original_name"] == "DSC_0412.jpg"
    meta = client.get(f"/api/photos/{item['id']}/exif").json()
    assert meta["shutter"] == "1/250" and meta["gps"] == {"lat": 24.86, "lng": 67.01}
    assert meta["tags"]["Image Model"] == "NIKON Z 8"
    assert ex.camera_name("Canon", "EOS R5") == "Canon EOS R5"


def test_offset_time_is_converted_to_utc(tmp_path):
    e = Image.Exif()
    sub = e.get_ifd(0x8769)
    sub[0x9003], sub[0x9011] = "2026:05:01 10:30:00", "+05:00"
    p = tmp_path / "a.jpg"
    Image.new("RGB", (8, 8)).save(p, exif=e.tobytes())
    assert ex.read(p).captured_at == datetime(2026, 5, 1, 5, 30)


def test_duplicates_are_skipped_when_the_import_asks(client):
    data = jpeg()
    a = upload(client, "a.jpg", data)
    b = upload(client, "copy of a.jpg", data, on_duplicate="skip")
    assert b["id"] == a["id"] and b["duplicate"] is True
    c = upload(client, "keep.jpg", data, on_duplicate="keep")
    # plain uploads (no on_duplicate) keep the old behaviour: always a new item
    d = upload(client, "plain.jpg", data)
    assert c["id"] != a["id"] and d["id"] not in (a["id"], c["id"]) and not c["duplicate"]
    with SessionLocal() as db:
        assert db.query(MediaItem).count() == 3


def test_import_into_an_album_and_shoot(client):
    shoot = client.post("/api/albums", json={"name": "Mehndi", "kind": "shoot"}).json()
    item = upload(client, "x.jpg", jpeg(), album_id=shoot["id"])
    assert item["album_ids"] == [shoot["id"]]
    # a duplicate import into another album still files the existing photo there
    other = client.post("/api/albums", json={"name": "Portfolio"}).json()
    again = upload(client, "x again.jpg", jpeg(noise=False), album_id=other["id"], on_duplicate="skip")
    again2 = upload(client, "x again.jpg", jpeg(noise=False), album_id=other["id"], on_duplicate="skip")
    assert again2["duplicate"] and other["id"] in again2["album_ids"] and again["id"] == again2["id"]
    smart = client.post("/api/albums", json={"name": "S", "kind": "smart",
                                             "rules": {"rules": [{"field": "rating", "op": ">=", "value": 4}]}}).json()
    r = client.post("/api/media/upload", files={"file": ("y.jpg", jpeg(), "image/jpeg")}, data={"album_id": smart["id"]})
    assert r.status_code == 422


def test_heic_upload_keeps_the_original_and_makes_a_jpeg(client):
    import pillow_heif

    pillow_heif.register_heif_opener()
    buf = io.BytesIO()
    Image.new("RGB", (200, 120), (30, 140, 200)).save(buf, "HEIF", quality=90)
    item = upload(client, "IMG_0001.HEIC", buf.getvalue())
    assert item["source_type"] == "image/heic" and item["media_type"] == "image/jpeg"
    assert (item["width"], item["height"]) == (200, 120)
    r = client.get(f"/api/photos/{item['id']}/source")
    assert r.status_code == 200 and r.content == buf.getvalue()
    assert "IMG_0001.HEIC" in r.headers["content-disposition"]
    px = Image.open(io.BytesIO(client.get(item["media_url"]).content)).convert("RGB").getpixel((100, 60))
    assert abs(px[2] - 200) < 12


def test_16bit_tiff_scan_and_broken_heic(client):
    buf = io.BytesIO()
    Image.fromarray(np.tile(np.linspace(0, 65535, 300, dtype=np.uint16), (100, 1))).save(buf, "TIFF")
    item = upload(client, "scan.tif", buf.getvalue())
    assert item["source_type"] == "image/tiff" and (item["width"], item["height"]) == (300, 100)
    px = np.asarray(Image.open(io.BytesIO(client.get(item["media_url"]).content)).convert("L"))
    assert px[50, 0] < 10 and px[50, -1] > 245  # scaled by range, not clipped at 255
    r = client.post("/api/media/upload", files={"file": ("bad.heic", b"\0\0\0\x18ftypheic" + b"\0" * 100, "image/heic")})
    assert r.status_code == 415


def test_raw_upload_decodes_with_rawpy(client, monkeypatch):
    import rawpy

    class FakeRaw:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def postprocess(self, **kw):
            assert kw["use_camera_wb"] is True
            return np.full((90, 160, 3), (200, 100, 50), np.uint8)

    monkeypatch.setattr(rawpy, "imread", lambda p: FakeRaw())
    nef = b"II*\x00\x08\x00\x00\x00" + b"\0" * 400
    item = upload(client, "DSC_1.NEF", nef)
    assert item["source_type"] == "image/x-raw" and (item["width"], item["height"]) == (160, 90)
    assert convert.sniff(nef[:64], "x.tif") == "image/tiff" and convert.sniff(nef[:64], "x.nef") == "image/x-raw"
    assert convert.sniff(b"\0\0\0\x18ftypcrx " + b"\0" * 40, "a.CR3") == "image/x-raw"
    assert convert.sniff(b"FUJIFILMCCD-RAW 0201" + b"\0" * 40, "a.raf") == "image/x-raw"
    # brand product uploads still refuse photo-catalogue-only formats
    from app import brand

    assert brand.sniff_photo(nef[:64]) is None


# ------------------------------------------------------------------ marks, filters, sort, facets

@pytest.fixture
def shoot_set(client):
    ids = {}
    spec = [("a", "2026:05:01 10:00:00", "NIKON Z 8", 85.0), ("b", "2026:05:01 11:00:00", "NIKON Z 8", 35.0),
            ("c", "2026:06:02 09:00:00", "Canon EOS R5", 50.0), ("d", None, "Canon EOS R5", 50.0)]
    for name, when, model, focal in spec:
        make = "Canon" if model.startswith("Canon") else "NIKON CORPORATION"
        ids[name] = upload(client, f"{name}.jpg", jpeg(when=when, model=model, make=make, focal=focal),
                           title=name)["id"]
    return ids


def test_marks_and_attribute_filters(client, shoot_set):
    s = shoot_set
    assert client.post("/api/photos/marks", json={"ids": [s["a"], s["b"]], "rating": 4}).json()["updated"] == 2
    client.post("/api/photos/marks", json={"ids": [s["a"]], "flag": "pick", "label": "red"})
    client.post("/api/photos/marks", json={"ids": [s["c"]], "flag": "reject"})
    assert client.post("/api/photos/marks", json={"ids": [s["a"]]}).status_code == 422
    assert client.post("/api/photos/marks", json={"ids": [s["a"]], "rating": 6}).status_code == 422
    assert sorted(titles(photos(client, rating_min=4))) == ["a", "b"]
    assert titles(photos(client, flag="pick")) == ["a"]
    assert sorted(titles(photos(client, flag="none"))) == ["b", "d"]
    assert titles(photos(client, label="red")) == ["a"]
    assert sorted(titles(photos(client, camera="Canon EOS R5"))) == ["c", "d"]
    assert titles(photos(client, date_from="2026-06-01", date_to="2026-06-02")) == ["c"]
    assert len(photos(client, added_from="2000-01-01")["items"]) == 4 and not photos(client, added_from="2999-01-01")["items"]
    client.patch(f"/api/photos/{s['b']}", json={"caption": "Bride with henna", "keywords": ["Bride", "henna"]})
    assert titles(photos(client, keyword="bride")) == ["b"] and titles(photos(client, q="henna")) == ["b"]
    assert client.get("/api/photos", params={"flag": "maybe"}).status_code == 422


def test_sorts(client, shoot_set):
    # "d" has no capture date: it sorts by when it was added (the newest), like Lightroom does
    assert titles(photos(client)) == ["d", "c", "b", "a"]
    assert titles(photos(client, order="asc")) == ["a", "b", "c", "d"]
    client.post("/api/photos/marks", json={"ids": [shoot_set["b"]], "rating": 5})
    assert titles(photos(client, sort="rating"))[0] == "b"
    assert titles(photos(client, sort="name", order="asc")) == ["a", "b", "c", "d"]
    assert client.get("/api/photos", params={"sort": "manual"}).status_code == 422
    page = photos(client, limit=3)
    assert page["total"] == 4 and page["next_offset"] == 3 and len(photos(client, offset=3)["items"]) == 1


def test_facets_count_the_other_filters(client, shoot_set):
    s = shoot_set
    client.post("/api/photos/marks", json={"ids": [s["a"], s["c"]], "flag": "pick"})
    f = client.get("/api/photos/facets", params={"flag": "pick"}).json()
    # the flag facet ignores the flag filter itself, the camera facet doesn't
    assert f["flag"] == {"pick": 2, "none": 2}
    assert {c["value"]: c["count"] for c in f["camera"]} == {"NIKON Z 8": 1, "Canon EOS R5": 1}
    assert f["total"] == 2
    years = {y["year"]: y for y in client.get("/api/photos/facets").json()["date"]}
    assert years["2026"]["count"] == 4


def test_neighbours_for_the_filmstrip(client, shoot_set):
    s = shoot_set
    n = client.get(f"/api/photos/{s['b']}/neighbours").json()
    assert n["prev"] == s["c"] and n["next"] == s["a"] and n["total"] == 4 and n["position"] == 3


# ------------------------------------------------------------------ albums

def test_albums_are_many_to_many_with_manual_order(client, shoot_set):
    s = shoot_set
    folder = client.post("/api/albums", json={"name": "2026 Weddings", "kind": "folder"}).json()
    a1 = client.post("/api/albums", json={"name": "Best", "parent_id": folder["id"]}).json()
    a2 = client.post("/api/albums", json={"name": "Print"}).json()
    r = client.post(f"/api/albums/{a1['id']}/items", json={"ids": [s["a"], s["b"], s["c"]]})
    assert r.json()["changed"] == 3 and r.json()["album"]["count"] == 3
    client.post(f"/api/albums/{a2['id']}/items", json={"ids": [s["a"]]})
    assert set(photos(client, album_id=a1["id"])["items"][0]["album_ids"]) <= {a1["id"], a2["id"]}
    assert sorted(titles(photos(client, album_id=folder["id"]))) == ["a", "b", "c"]
    tree = {a["name"]: a for a in client.get("/api/albums").json()}
    assert tree["2026 Weddings"]["count"] == 3 and tree["Best"]["cover_url"]
    client.post(f"/api/albums/{a1['id']}/order", json={"ids": [s["c"], s["a"]]})
    assert titles(photos(client, album_id=a1["id"], sort="manual", order="asc")) == ["c", "a", "b"]
    client.post(f"/api/albums/{a1['id']}/items", json={"ids": [s["a"]], "action": "remove"})
    assert sorted(titles(photos(client, album_id=a1["id"]))) == ["b", "c"]
    # can't add to a folder or a smart album
    assert client.post(f"/api/albums/{folder['id']}/items", json={"ids": [s["a"]]}).status_code == 422


def test_album_folders_nest_without_cycles_and_delete_keeps_children(client):
    top = client.post("/api/albums", json={"name": "Top", "kind": "folder"}).json()
    mid = client.post("/api/albums", json={"name": "Mid", "kind": "folder", "parent_id": top["id"]}).json()
    leaf = client.post("/api/albums", json={"name": "Leaf", "parent_id": mid["id"]}).json()
    assert client.patch(f"/api/albums/{top['id']}", json={"parent_id": mid["id"]}).status_code == 422
    assert client.post("/api/albums", json={"name": "X", "parent_id": leaf["id"]}).status_code == 422
    assert client.delete(f"/api/albums/{mid['id']}").status_code == 204
    assert {a["name"]: a["parent_id"] for a in client.get("/api/albums").json()}["Leaf"] == top["id"]


def test_smart_albums(client, shoot_set):
    s = shoot_set
    client.post("/api/photos/marks", json={"ids": [s["a"], s["c"]], "rating": 5})
    rules = {"match": "all", "rules": [{"field": "rating", "op": ">=", "value": 4},
                                       {"field": "camera", "op": "contains", "value": "nikon"}]}
    smart = client.post("/api/albums", json={"name": "Nikon picks", "kind": "smart", "rules": rules}).json()
    assert smart["count"] == 1 and titles(photos(client, album_id=smart["id"])) == ["a"]
    # live: rating b makes it join
    client.post("/api/photos/marks", json={"ids": [s["b"]], "rating": 4})
    assert sorted(titles(photos(client, album_id=smart["id"]))) == ["a", "b"]
    best = client.post("/api/albums", json={"name": "Best"}).json()
    client.post(f"/api/albums/{best['id']}/items", json={"ids": [s["d"]]})
    anyof = client.post("/api/albums", json={"name": "Either", "kind": "smart", "rules": {
        "match": "any", "rules": [{"field": "album", "op": "in", "value": smart["id"]},
                                  {"field": "album", "op": "in", "value": best["id"]}]}}).json()
    assert anyof["count"] == 3
    bad = [{"rules": []}, {"rules": [{"field": "colour", "op": "=", "value": 1}]},
           {"rules": [{"field": "rating", "op": "contains", "value": 1}]}, {"match": "some", "rules": [
               {"field": "rating", "op": "=", "value": 1}]}]
    for r in bad:
        assert client.post("/api/albums", json={"name": "Bad", "kind": "smart", "rules": r}).status_code == 422
    assert client.post("/api/albums", json={"name": "No rules", "kind": "smart"}).status_code == 422
    assert client.post("/api/albums", json={"name": "Plain", "rules": rules}).status_code == 422


def test_clients_and_shoots(client, shoot_set):
    c = client.post("/api/clients", json={"name": "Ayesha & Omar", "email": "ayesha@example.com"}).json()
    shoot = client.post("/api/albums", json={"name": "Mehndi", "kind": "shoot", "client_id": c["id"],
                                             "shoot_date": "2026-05-01", "venue": "Karachi"}).json()
    assert shoot["client_name"] == "Ayesha & Omar"
    client.post(f"/api/albums/{shoot['id']}/items", json={"ids": [shoot_set["a"], shoot_set["b"]]})
    got = client.get("/api/clients").json()[0]
    assert (got["shoots"], got["photos"]) == (1, 2)
    assert sorted(titles(photos(client, client_id=c["id"]))) == ["a", "b"]
    assert client.post("/api/albums", json={"name": "Plain", "client_id": c["id"]}).status_code == 422
    assert client.delete(f"/api/clients/{c['id']}").status_code == 204
    left = {a["name"]: a for a in client.get("/api/albums").json()}["Mehndi"]
    assert left["client_id"] is None and left["count"] == 2


def test_backfill_reads_exif_for_old_uploads(client):
    from app.manage import catalogue_backfill

    item = upload(client, "old.jpg", jpeg())
    with SessionLocal() as db:
        m = db.get(MediaItem, item["id"])
        m.content_hash = m.camera = m.captured_at = None
        db.commit()
    assert catalogue_backfill() == 0
    with SessionLocal() as db:
        m = db.get(MediaItem, item["id"])
        assert m.content_hash and m.camera == "NIKON Z 8" and m.captured_at


def test_deleting_a_photo_leaves_albums_clean(client, shoot_set):
    a = client.post("/api/albums", json={"name": "Best"}).json()
    client.post(f"/api/albums/{a['id']}/items", json={"ids": [shoot_set["a"]]})
    assert client.delete(f"/api/media/{shoot_set['a']}").status_code == 204
    with SessionLocal() as db:
        assert db.query(AlbumItem).count() == 0
    assert {x["name"]: x for x in client.get("/api/albums").json()}["Best"]["count"] == 0
