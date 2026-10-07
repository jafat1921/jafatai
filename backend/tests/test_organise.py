"""Polish P4: folders, links for project rows, favourites, saved filters, batch actions, generate into."""
import zipfile

from app.config import get_settings
from app.db import SessionLocal
from app.models import FolderLink, Job, MediaItem, Workspace
from app.worker import process_one
from tests.test_library import png_bytes, upload
from tests.test_storyboard import _approved, _run_all


def _up(client, title, colour=(10, 20, 30)):
    r = upload(client, f"{title}.png", png_bytes(colour=colour), "image/png", title=title)
    assert r.status_code == 201, r.text
    return r.json()


def _folder(client, name, **body):
    r = client.post("/api/folders", json={"name": name, **body})
    assert r.status_code == 201, r.text
    return r.json()


def _ids(client, **q):
    r = client.get("/api/media", params=q)
    assert r.status_code == 200, r.text
    return [m["id"] for m in r.json()["items"]]


def _portrait(client, fast_driver, character):
    return _approved(client, fast_driver, "character", character["id"], "portrait", prompt="a diver")


def test_folders_nest_move_and_delete_hands_contents_up(client):
    a, b = _up(client, "One"), _up(client, "Two")
    top = _folder(client, "Campaign")
    sub = _folder(client, "Drafts", parent_id=top["id"])
    assert sub["parent_id"] == top["id"] and sub["kind"] == "any"

    r = client.post("/api/media/move", json={"refs": [a["id"], b["id"], "nope"], "folder_id": sub["id"]})
    assert r.status_code == 200, r.text
    assert sorted(r.json()["done"]) == sorted([a["id"], b["id"]])
    assert r.json()["skipped"] == [{"ref": "nope", "reason": "Not found"}]
    assert sorted(_ids(client, folder_id=sub["id"])) == sorted([a["id"], b["id"]])
    assert _ids(client, folder_id=top["id"]) == []
    counts = {f["name"]: f["item_count"] for f in client.get("/api/folders").json()}
    assert counts == {"Campaign": 0, "Drafts": 2}
    item = client.get(f"/api/media/{a['id']}").json()
    assert item["folder_id"] == sub["id"]

    # no cycles, no strangers
    assert client.patch(f"/api/folders/{top['id']}", json={"parent_id": sub["id"]}).status_code == 422
    assert client.patch(f"/api/folders/{top['id']}", json={"name": "Spring"}).json()["name"] == "Spring"
    assert client.get("/api/media", params={"folder_id": "00000000-0000-0000-0000-000000000000"}).status_code == 404

    assert client.delete(f"/api/folders/{sub['id']}").status_code == 204
    assert sorted(_ids(client, folder_id=top["id"])) == sorted([a["id"], b["id"]])
    assert [f["name"] for f in client.get("/api/folders").json()] == ["Spring"]

    # out of every folder
    r = client.post("/api/media/move", json={"refs": [a["id"]], "folder_id": None})
    assert r.json()["done"] == [a["id"]] and _ids(client, folder_id=top["id"]) == [b["id"]]


def test_typed_folders_refuse_the_other_kind(client):
    pic = _up(client, "Pic")
    videos = _folder(client, "Clips", kind="video")
    sub = _folder(client, "Sub", parent_id=videos["id"], kind="any")
    assert sub["kind"] == "video"  # inherits the parent's type
    r = client.post("/api/media/move", json={"refs": [pic["id"]], "folder_id": videos["id"]})
    assert r.json()["done"] == [] and "only holds videos" in r.json()["skipped"][0]["reason"]
    assert [f["name"] for f in client.get("/api/folders", params={"kind": "image"}).json()] == []


def test_project_rows_are_filed_by_link_not_copied(client, fast_driver, character):
    g = _portrait(client, fast_driver, character)
    rows = client.get("/api/media", params={"kind": "image", "include": "project"}).json()["items"]
    assert [m["id"] for m in rows] == [g["id"]] and rows[0]["folder_id"] is None
    f = _folder(client, "Cast")

    r = client.post("/api/media/move", json={"refs": [g["id"]], "folder_id": f["id"]})  # bare id normalises
    assert r.json()["done"] == [f"gen:{g['id']}"]
    with SessionLocal() as db:
        assert db.query(MediaItem).count() == 0
        assert [(x.folder_id, x.media_ref) for x in db.query(FolderLink)] == [(f["id"], f"gen:{g['id']}")]
    listed = client.get("/api/media", params={"include": "project", "folder_id": f["id"]}).json()["items"]
    assert [(m["id"], m["folder_id"]) for m in listed] == [(g["id"], f["id"])]
    assert client.get("/api/folders").json()[0]["item_count"] == 1

    other = _folder(client, "Moodboard")
    client.post("/api/media/move", json={"refs": [f"gen:{g['id']}"], "folder_id": other["id"]})
    assert _ids(client, include="project", folder_id=f["id"]) == []
    assert _ids(client, include="project", folder_id=other["id"]) == [g["id"]]

    # deleting a top-level folder unfiles its project rows
    client.delete(f"/api/folders/{other['id']}")
    with SessionLocal() as db:
        assert db.query(FolderLink).count() == 0


def test_favourites_toggle_filter_and_import(client, fast_driver, character):
    a, b = _up(client, "A"), _up(client, "B")
    g = _portrait(client, fast_driver, character)
    r = client.post("/api/favourites/toggle", json={"ref": a["id"]})
    assert r.json() == {"ref": a["id"], "favourite": True}
    assert client.post("/api/favourites/toggle", json={"ref": f"gen:{g['id']}", "on": True}).json()["favourite"]
    assert client.post("/api/favourites/toggle", json={"ref": "missing"}).status_code == 404

    assert sorted(_ids(client, include="project", favourite=1)) == sorted([a["id"], g["id"]])
    assert _ids(client, favourite=1, origin="upload") == [a["id"]]
    flags = {m["id"]: m["favourite"] for m in client.get("/api/media", params={"include": "project"}).json()["items"]}
    assert flags == {a["id"]: True, b["id"]: False, g["id"]: True}

    # the old localStorage list: bare ids, duplicates and stale ones
    r = client.post("/api/favourites/import", json={"refs": [b["id"], a["id"], g["id"], "gone-for-good"]})
    assert r.json()["imported"] == 1 and r.json()["skipped"] == 1
    assert sorted(r.json()["refs"]) == sorted([a["id"], b["id"], f"gen:{g['id']}"])
    assert client.post("/api/favourites/toggle", json={"ref": a["id"]}).json()["favourite"] is False
    assert sorted(client.get("/api/favourites").json()["refs"]) == sorted([b["id"], f"gen:{g['id']}"])

    # a favourite inside a folder: both filters apply
    f = _folder(client, "Keep")
    client.post("/api/media/move", json={"refs": [a["id"], b["id"]], "folder_id": f["id"]})
    assert _ids(client, folder_id=f["id"], favourite=1) == [b["id"]]


def test_saved_filters_are_per_user_crud(client):
    r = client.post("/api/saved-filters", json={"name": "Sea uploads", "query": {"origin": "upload", "tag": "sea"}})
    assert r.status_code == 201, r.text
    sid = r.json()["id"]
    assert client.get("/api/saved-filters").json()[0]["query"] == {"origin": "upload", "tag": "sea"}
    r = client.patch(f"/api/saved-filters/{sid}", json={"name": "Sea"})
    assert r.json()["name"] == "Sea" and r.json()["query"]["tag"] == "sea"
    assert client.post("/api/saved-filters", json={"name": "x", "query": {"q": "y" * 5000}}).status_code == 422
    assert client.delete(f"/api/saved-filters/{sid}").status_code == 204
    assert client.get("/api/saved-filters").json() == []
    assert client.delete(f"/api/saved-filters/{sid}").status_code == 404


def test_batch_delete_tag_and_move_report_skips(client, fast_driver, character):
    a, b = _up(client, "A"), _up(client, "B")
    g = _portrait(client, fast_driver, character)
    client.post("/api/favourites/toggle", json={"ref": a["id"]})

    r = client.post("/api/media/batch", json={"action": "tag", "refs": [a["id"], g["id"]], "options": {"add": ["Sea", "sky"]}})
    assert r.json()["done"] == [a["id"]] and "inside their project" in r.json()["skipped"][0]["reason"]
    r = client.post("/api/media/batch", json={"action": "tag", "refs": [a["id"]], "options": {"remove": ["sky"]}})
    assert client.get(f"/api/media/{a['id']}").json()["tags"] == ["sea"]
    assert client.post("/api/media/batch", json={"action": "tag", "refs": [a["id"]]}).status_code == 422

    f = _folder(client, "Box")
    r = client.post("/api/media/batch", json={"action": "move", "refs": [a["id"], g["id"]], "options": {"folder_id": f["id"]}})
    assert len(r.json()["done"]) == 2

    r = client.post("/api/media/batch", json={"action": "delete", "refs": [a["id"], b["id"], f"gen:{g['id']}", "zzz"]})
    out = r.json()
    assert sorted(out["done"]) == sorted([a["id"], b["id"]])
    assert {s["ref"]: s["reason"] for s in out["skipped"]} == {
        "zzz": "Not found", f"gen:{g['id']}": "Project results are changed inside their project"}
    assert _ids(client, include="project") == [g["id"]]
    assert client.get("/api/favourites").json()["refs"] == []  # hearts on deleted items go too


def test_batch_upscale_queues_one_job_per_item(client, fast_driver, character):
    a, b = _up(client, "A"), _up(client, "B")
    r = client.post("/api/media/batch", json={"action": "upscale", "refs": [a["id"], b["id"]],
                                              "options": {"image": {"engine": "quick", "target": "2x"}}})
    assert r.status_code == 200, r.text
    jobs = r.json()["jobs"]
    assert len(jobs) == 2 and sorted(r.json()["done"]) == sorted([a["id"], b["id"]])
    with SessionLocal() as db:
        gens = [db.get(Job, j["id"]).generation_id for j in jobs]
        assert len(set(gens)) == 2
    # an engine that can't take the size is a skip, not a 422 for the whole batch
    r = client.post("/api/media/batch", json={"action": "upscale", "refs": [a["id"]],
                                              "options": {"image": {"engine": "quick", "target": "nope"}}})
    assert r.json()["jobs"] == [] and r.json()["skipped"][0]["ref"] == a["id"]


def test_batch_download_builds_a_zip_job(client, fast_driver, character):
    a, b = _up(client, "Same"), _up(client, "Same", colour=(200, 0, 0))
    g = _portrait(client, fast_driver, character)
    r = client.post("/api/media/batch", json={"action": "download", "refs": [a["id"], b["id"], g["id"]]})
    assert r.status_code == 200, r.text
    job = r.json()["jobs"][0]
    assert job["type"] == "media_zip" and job["status"] == "queued"
    assert client.get(f"/api/exports/{job['id']}/download").status_code == 409

    _run_all(fast_driver)
    done = next(j for j in client.get("/api/jobs").json() if j["id"] == job["id"])
    assert done["status"] == "done" and done["result"]["count"] == 3
    assert done["result"]["download_url"] == f"/api/exports/{job['id']}/download"
    r = client.get(done["result"]["download_url"])
    assert r.status_code == 200 and r.headers["content-type"] == "application/zip"
    assert "attachment" in r.headers["content-disposition"]
    zpath = get_settings().data_dir / done["result"]["file"]
    with zipfile.ZipFile(zpath) as zf:
        names = sorted(zf.namelist())
    assert names[1:] == ["Same-2.png", "Same.png"] and names[0].startswith("Diver")

    with SessionLocal() as db:
        other = Workspace(name="Other")
        db.add(other)
        db.flush()
        db.get(Job, job["id"]).workspace_id = other.id
        db.commit()
    assert client.get(f"/api/exports/{job['id']}/download").status_code == 404
    assert client.post("/api/media/batch", json={"action": "download", "refs": ["missing"]}).status_code == 422


def test_generate_into_a_folder(client):
    f = _folder(client, "Into")
    r = client.post("/api/images/generate", json={"prompt": "a red boat", "count": 2, "folder_id": f["id"]})
    assert r.status_code == 202, r.text
    assert {m["folder_id"] for m in r.json()["items"]} == {f["id"]}
    assert len(_ids(client, folder_id=f["id"])) == 2

    vids = _folder(client, "Clips", kind="video")
    r = client.post("/api/images/generate", json={"prompt": "a red boat", "folder_id": vids["id"]})
    assert r.status_code == 422 and "only holds videos" in r.json()["detail"]
    r = client.post("/api/videos/generate", json={"prompt": "waves at dusk", "folder_id": vids["id"]})
    assert r.status_code == 202, r.text
    assert r.json()["folder_id"] == vids["id"]
    assert client.post("/api/images/generate", json={"prompt": "x", "folder_id": "nope"}).status_code == 404


def test_zip_job_skips_unfinished_and_runs_on_worker(client, fast_driver):
    a = _up(client, "A")
    r = client.post("/api/images/generate", json={"prompt": "a cat"})
    pending = r.json()["items"][0]
    r = client.post("/api/media/batch", json={"action": "download", "refs": [a["id"], pending["id"]]})
    out = r.json()
    assert out["done"] == [a["id"]] and out["skipped"] == [{"ref": pending["id"], "reason": "Not finished yet"}]
    while process_one(driver_factory=fast_driver):
        pass
    job = next(j for j in client.get("/api/jobs").json() if j["id"] == out["jobs"][0]["id"])
    assert job["status"] == "done" and job["result"]["count"] == 1
