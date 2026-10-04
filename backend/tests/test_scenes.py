from sqlalchemy import select

from app.models import Scene, SceneVersion


def _scene(client, project_id, **body):
    r = client.post(f"/api/projects/{project_id}/scenes", json=body)
    assert r.status_code == 201, r.text
    return r.json()


def test_project_crud_and_counts(client, project):
    pid = project["id"]
    assert project["counts"] == {"scenes": 0, "shots": 0, "characters": 0}
    assert project["aspect_ratio"] == "16:9" and project["takes_per_shot"] == 3

    _scene(client, pid, heading="INT. BOAT")
    r = client.patch(f"/api/projects/{pid}", json={"logline": "A reef dies", "status": "in_progress"})
    assert r.status_code == 200
    assert r.json()["counts"]["scenes"] == 1
    assert r.json()["status"] == "in_progress"

    assert [p["id"] for p in client.get("/api/projects").json()] == [pid]
    assert client.delete(f"/api/projects/{pid}").status_code == 204
    assert client.get(f"/api/projects/{pid}").status_code == 404


def test_create_with_text_is_user_locked(client, project):
    s = _scene(client, project["id"], heading="EXT. REEF - DAY", script_text="The diver drifts.")
    assert s["source"] == "user" and s["locked"] is True and s["version"] == 1
    empty = _scene(client, project["id"])
    assert empty["locked"] is False


def test_lock_rule_on_ai_scene(client, project, db):
    s = _scene(client, project["id"])
    # pretend the AI wrote it
    row = db.get(Scene, s["id"])
    row.source, row.locked = "ai", False
    db.commit()

    # non-script field: no version bump, no lock
    r = client.patch(f"/api/scenes/{s['id']}", json={"mood": "eerie"}).json()
    assert r["version"] == 1 and r["locked"] is False and r["source"] == "ai"

    r = client.patch(f"/api/scenes/{s['id']}", json={"script_text": "The diver drifts over pale coral."}).json()
    assert r["source"] == "ai_edited" and r["locked"] is True and r["version"] == 2

    # same text again is not an edit
    r = client.patch(f"/api/scenes/{s['id']}", json={"script_text": "The diver drifts over pale coral."}).json()
    assert r["version"] == 2

    r = client.patch(f"/api/scenes/{s['id']}", json={"heading": "EXT. REEF - DUSK"}).json()
    assert r["version"] == 3 and r["source"] == "ai_edited"

    db.expire_all()
    versions = db.scalars(
        select(SceneVersion.version).where(SceneVersion.scene_id == s["id"]).order_by(SceneVersion.version)
    ).all()
    assert versions == [1, 2, 3]


def test_user_scene_stays_user(client, project):
    s = _scene(client, project["id"], heading="A")
    r = client.patch(f"/api/scenes/{s['id']}", json={"logline": "new"}).json()
    assert r["source"] == "user" and r["version"] == 2


def test_insert_after_and_reorder(client, project):
    pid = project["id"]
    a = _scene(client, pid, heading="A")
    c = _scene(client, pid, heading="C")
    b = _scene(client, pid, heading="B", after_scene_id=a["id"])
    listed = client.get(f"/api/projects/{pid}/scenes").json()
    assert [s["heading"] for s in listed] == ["A", "B", "C"]
    assert [s["order"] for s in listed] == [1, 2, 3]

    r = client.post(f"/api/projects/{pid}/scenes/reorder", json={"scene_ids": [c["id"], a["id"], b["id"]]})
    assert [s["heading"] for s in r.json()] == ["C", "A", "B"]

    bad = client.post(f"/api/projects/{pid}/scenes/reorder", json={"scene_ids": [c["id"], a["id"]]})
    assert bad.status_code == 422

    assert client.delete(f"/api/scenes/{c['id']}").status_code == 204
    listed = client.get(f"/api/projects/{pid}/scenes").json()
    assert [(s["heading"], s["order"]) for s in listed] == [("A", 1), ("B", 2)]
