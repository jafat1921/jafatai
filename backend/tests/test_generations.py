from app.worker import process_one


def _gen(client, character, **extra):
    body = {"target_type": "character", "target_id": character["id"], "kind": "portrait", "prompt": "a diver", **extra}
    r = client.post("/api/generations", json=body)
    assert r.status_code == 201, r.text
    return r.json()


def _run_all(fast_driver):
    while process_one(driver_factory=fast_driver):
        pass


def test_create_queues_job(client, character):
    g = _gen(client, character)
    assert g["status"] == "queued" and g["version"] == 1 and g["job_id"]
    jobs = client.get("/api/jobs").json()
    assert jobs[0]["id"] == g["job_id"] and jobs[0]["status"] == "queued"


def test_unknown_target_404(client):
    r = client.post(
        "/api/generations",
        json={"target_type": "character", "target_id": "nope", "kind": "portrait", "prompt": "x"},
    )
    assert r.status_code == 404


def test_worker_makes_it_ready_with_media(client, character, fast_driver):
    g = _gen(client, character)
    _run_all(fast_driver)
    [ready] = client.get(f"/api/generations?target_id={character['id']}").json()
    assert ready["status"] == "ready" and ready["media_type"] == "image/png"
    r = client.get(ready["media_url"])
    assert r.status_code == 200 and r.content[:8] == b"\x89PNG\r\n\x1a\n"

    job = next(j for j in client.get("/api/jobs").json() if j["id"] == g["job_id"])
    assert job["status"] == "done" and job["progress"] == 1.0 and job["gpu_seconds"] is not None


def test_single_approved_per_target_kind(client, character, fast_driver):
    a = _gen(client, character)
    b = _gen(client, character)
    sheet = _gen(client, character, kind="sheet_view")
    _run_all(fast_driver)

    assert client.post(f"/api/generations/{a['id']}/approve").json()["status"] == "approved"
    assert client.post(f"/api/generations/{sheet['id']}/approve").json()["status"] == "approved"
    assert client.post(f"/api/generations/{b['id']}/approve").json()["status"] == "approved"

    gens = {g["id"]: g for g in client.get(f"/api/generations?target_id={character['id']}").json()}
    assert gens[a["id"]]["status"] == "ready" and gens[a["id"]]["approved_at"] is None
    assert gens[b["id"]]["status"] == "approved"
    # a different kind on the same target is unaffected
    assert gens[sheet["id"]]["status"] == "approved"

    portrait = client.get(f"/api/projects/{character['project_id']}/characters").json()[0]["approved_portrait"]
    assert portrait["id"] == b["id"]

    assert client.post(f"/api/generations/{b['id']}/unapprove").json()["status"] == "ready"


def test_cannot_approve_queued(client, character):
    g = _gen(client, character)
    assert client.post(f"/api/generations/{g['id']}/approve").status_code == 409


def test_regenerate_builds_version_chain(client, character, fast_driver):
    v1 = _gen(client, character, params={"seed": 42, "steps": 8})
    assert v1["seed"] == 42

    v2 = client.post(f"/api/generations/{v1['id']}/regenerate", json={"mode": "same"}).json()
    assert v2["version"] == 2 and v2["parent_id"] == v1["id"] and v2["prompt"] == "a diver"
    assert v2["params"] == {"steps": 8} and v2["job_id"] != v1["job_id"]

    v3 = client.post(
        f"/api/generations/{v2['id']}/regenerate", json={"mode": "note", "note": "grey hair, less smiling"}
    ).json()
    assert v3["version"] == 3 and v3["parent_id"] == v2["id"]
    assert v3["prompt"].startswith("a diver") and "grey hair, less smiling" in v3["prompt"]
    assert v3["note"] == "grey hair, less smiling"

    v4 = client.post(
        f"/api/generations/{v3['id']}/regenerate",
        json={"mode": "edit", "prompt": "a diver at dusk", "params": {"seed": 7, "steps": 20}},
    ).json()
    assert v4["prompt"] == "a diver at dusk" and v4["seed"] == 7 and v4["params"]["steps"] == 20

    missing_note = client.post(f"/api/generations/{v1['id']}/regenerate", json={"mode": "note"})
    assert missing_note.status_code == 422

    listed = client.get(f"/api/generations?target_id={character['id']}").json()
    assert [g["version"] for g in listed] == [4, 3, 2, 1]
    assert len(client.get("/api/jobs?status=queued").json()) == 4


def test_reject_hides_and_restore(client, character, fast_driver):
    g = _gen(client, character)
    _run_all(fast_driver)
    client.post(f"/api/generations/{g['id']}/approve")
    r = client.post(f"/api/generations/{g['id']}/reject", json={"reason": "wrong face"}).json()
    assert r["status"] == "rejected" and r["approved_at"] is None

    assert client.get(f"/api/generations?target_id={character['id']}").json() == []
    assert len(client.get(f"/api/generations?target_id={character['id']}&include_rejected=true").json()) == 1

    assert client.post(f"/api/generations/{g['id']}/restore").json()["status"] == "ready"


def test_other_kinds_produce_video_and_text(client, project, fast_driver):
    pid = project["id"]
    scene = client.post(f"/api/projects/{pid}/scenes", json={"heading": "EXT. REEF"}).json()
    txt = client.post(
        "/api/generations", json={"target_type": "scene", "target_id": scene["id"], "kind": "scene_text", "prompt": "draft"}
    ).json()
    vid = client.post(
        "/api/generations",
        json={"target_type": "project", "target_id": pid, "kind": "render", "prompt": "film", "params": {"duration_s": 1}},
    ).json()
    _run_all(fast_driver)
    gens = {g["id"]: g for g in client.get(f"/api/generations?project_id={pid}").json()}
    assert gens[txt["id"]]["media_type"] == "text/plain"
    assert gens[vid["id"]]["status"] == "ready", client.get("/api/jobs").json()
    assert gens[vid["id"]]["media_type"] == "video/mp4"
    assert client.get(gens[vid["id"]]["media_url"]).status_code == 200
