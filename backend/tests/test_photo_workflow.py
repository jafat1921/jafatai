"""Develop workflow (M10 phase 2 / D1): panel switches, Snapshots, Sync settings."""
import io

import numpy as np
from PIL import Image

from app.config import get_settings
from app.db import SessionLocal
from app.models import Generation, Job, MediaItem
from app.photo import develop as dv
from app.photo import workflow as wf
from app.worker import process_one


def upload(client, colour=(120, 90, 60)) -> str:
    buf = io.BytesIO()
    arr = np.full((60, 80, 3), colour, np.uint8)
    arr[20:40, 20:60] = (200, 60, 40)
    Image.fromarray(arr).save(buf, "PNG")
    r = client.post("/api/media/upload", files={"file": ("p.png", buf.getvalue(), "image/png")})
    assert r.status_code == 201, r.text
    return r.json()["id"]


def run_jobs():
    while process_one():
        pass


def test_switched_off_panels_are_bypassed_but_kept():
    img = np.full((8, 8, 3), 100, np.uint8)
    on = dv.develop(img, {"exposure": 60, "vignette": -50})
    off = dv.develop(img, {"exposure": 60, "vignette": -50, "off": ["basic"]})
    only_vignette = dv.develop(img, {"vignette": -50})
    assert not np.allclose(on, off) and np.allclose(off, only_vignette)
    p = dv.normalise({"exposure": 60, "off": ["basic", "geometry", "bogus"]})
    assert p["off"] == ["basic"] and p["exposure"] == 0.9  # crop & rotate has no switch; v1 60 = 0.9 EV
    assert dv.sparse(p) == {"version": 2, "exposure": 0.9, "off": ["basic"]}


def test_schema_lists_switchable_groups(client):
    s = client.get("/api/photo/schema").json()
    assert "geometry" not in s["switchable"] and "basic" in s["switchable"]


def test_merge_groups_keeps_everything_not_ticked():
    mine = dv.normalise({"exposure": 10, "crop": {"x": 1, "y": 1, "width": 20, "height": 20}, "vignette": 30})
    theirs = dv.normalise({"exposure": -40, "temperature": 25, "vignette": -10, "off": ["effects"]})
    out = wf.merge_groups(mine, theirs, ["basic", "effects"])
    assert out["exposure"] == -0.6 and out["temperature"] == 25 and out["vignette"] == -10
    assert out["crop"] == mine["crop"] and out["off"] == ["effects"]


def test_sync_renders_each_picture_from_its_own_base(client):
    a, b = upload(client), upload(client, (40, 80, 160))
    # b already has a develop with a crop: syncing Basic must keep it
    r = client.post(f"/api/photo/{b}/render", json={"params": {"crop": {"x": 0, "y": 0, "width": 40, "height": 30}, "vignette": 20}})
    assert r.status_code == 202
    run_jobs()
    r = client.post("/api/photo/sync", json={"ids": [a, b, "missing"], "params": {"exposure": 30, "vignette": -80},
                                            "groups": ["basic"]})
    assert r.status_code == 202, r.text
    res = {x["id"]: x for x in r.json()["results"]}
    assert r.json()["queued"] == 2 and res["missing"]["error"]
    run_jobs()
    with SessionLocal() as db:
        gb = db.get(Generation, db.get(Job, res[b]["job_id"]).generation_id)
        d = gb.params["develop"]
        assert d["params"]["exposure"] == 0.45 and d["params"]["vignette"] == 20 and d["params"]["crop"]["width"] == 40
        # the new version develops the original upload, not the previous render
        assert db.get(Generation, d["base"]).kind == "upload"
        assert Image.open(get_settings().data_dir / gb.file_path).size == (40, 30)
        assert db.get(MediaItem, b).generation_id == gb.id
    assert client.post("/api/photo/sync", json={"ids": [a], "params": {}, "groups": ["nope"]}).status_code == 422
    # a picture already carrying exactly these settings gets no new version
    again = client.post("/api/photo/sync", json={"ids": [a], "params": {"exposure": 30, "vignette": -80},
                                                "groups": ["basic"]}).json()
    assert again["results"][0].get("unchanged") is True and again["queued"] == 0


def test_snapshots_crud(client):
    a = upload(client)
    r = client.post(f"/api/photo/{a}/snapshots", json={"name": "Warm v1", "params": {"temperature": 30}})
    assert r.status_code == 201, r.text
    sid = r.json()["id"]
    assert r.json()["params"] == {"version": 2, "temperature": 30.0}
    lst = client.get(f"/api/photo/{a}/snapshots").json()
    assert [s["name"] for s in lst] == ["Warm v1"]
    client.patch(f"/api/photo/snapshots/{sid}", json={"name": "Warm v2", "params": {"temperature": 40}})
    got = client.get(f"/api/photo/{a}/snapshots").json()[0]
    assert (got["name"], got["params"]) == ("Warm v2", {"version": 2, "temperature": 40.0})
    assert client.delete(f"/api/photo/snapshots/{sid}").status_code == 204
    assert client.get(f"/api/photo/{a}/snapshots").json() == []
    assert client.delete(f"/api/photo/snapshots/{sid}").status_code == 404
