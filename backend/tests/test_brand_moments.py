"""Milestone 8 final backend: brand moments inside adverts, image-to-image and the image-to-video entry."""
import json
import math
from pathlib import Path

import httpx
import pytest
from PIL import Image
from sqlalchemy import select

from app import ai_jobs, brand as br, brand_moments as bm, reel as rl, storyboard as sb
from app.config import get_settings
from app.db import SessionLocal
from app.drivers.comfy import plan_generation
from app.llm import set_transport
from app.models import Generation, Job, Project, Shot, new_id
from app.services import generation_file
from app.workflows import build
from app.worker import process_one

from tests.test_ai import fake_llm, oa, run_job, schema_title  # noqa: F401  (fake_llm is a fixture)
from tests.test_autopilot import Brain, drive, stages
from tests.test_brand import asset, make_kit, media_frame, png, run_jobs
from tests.test_comfy import FakeLookup

PLACED = [{"asset_id": "product1", "surface": "cafe counter", "prominence": "hero"},
          {"asset_id": "logo", "surface": "cup sleeve", "prominence": "background"},
          {"asset_id": "product7", "surface": "nowhere", "prominence": "hero"}]  # not in the kit: dropped


def kit_with_product(client, **extra) -> dict:
    prod = asset(client, "product", "can.png", png(mode="RGB")).json()["item"]
    return make_kit(client, products=[{"media_id": prod["id"], "name": "Leaf Cold Brew",
                                       "description": "matte black 330 ml can"}], **extra)


def use_kit(client, project_id, kit_id):
    r = client.put(f"/api/projects/{project_id}/brand-kit", json={"kit_id": kit_id})
    assert r.status_code == 200, r.text


def scene_with_script(client, project_id, text="Maya orders a coffee and smiles."):
    r = client.post(f"/api/projects/{project_id}/scenes", json={"heading": "INT. CAFE - DAY", "script_text": text})
    assert r.status_code == 201, r.text
    return r.json()


def finished_still(db, ws, project_id, target_type, target_id, kind, status="approved") -> Generation:
    g = Generation(id=new_id(), workspace_id=ws, project_id=project_id, target_type=target_type, target_id=target_id,
                   kind=kind, version=1, status=status, prompt="p", params={}, seed=1, media_type="image/png")
    rel = f"workspaces/{ws}/projects/{project_id}/generations/{g.id}.png"
    path = get_settings().data_dir / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (64, 36), "grey").save(path)
    g.file_path = rel
    db.add(g)
    db.commit()
    return g


def answer(shots_payload=None, moments=None, seen=None):
    def reply(body):
        if seen is not None:
            seen.append(body)
        title = schema_title(body)
        if title == "ShotList":
            return oa(json.dumps(shots_payload))
        if title == "BrandMoments":
            return oa(json.dumps(moments))
        return oa("A short summary.")
    return reply


# ------------------------------------------------------------------ planner

def test_suggest_shots_with_kit_places_brand_and_closes_on_packshot(client, project, fake_llm):
    kit = kit_with_product(client)
    use_kit(client, project["id"], kit["id"])
    sc = scene_with_script(client, project["id"])
    seen = []
    fake_llm(answer({"shots": [
        {"shot_type": "wide", "description": "Maya walks in", "start_visual": "door", "end_visual": "counter"},
        {"shot_type": "close_up", "description": "The can on the counter", "brand_placements": PLACED},
    ]}, seen=seen))
    job = client.post(f"/api/scenes/{sc['id']}/ai/suggest-shots", json={"max_shots": 4}).json()
    done = run_job(job["id"])
    assert done.status == "done", done.error
    brief = next(b for b in seen if schema_title(b) == "ShotList")["messages"][1]["content"]
    assert "Brand assets you can place" in brief and "product1: Leaf Cold Brew (matte black 330 ml can)" in brief
    assert "logo: the Leaf Coffee logo (round green leaf)" in brief and "never a watermark" in brief

    shots = client.get(f"/api/scenes/{sc['id']}/shots").json()
    assert [s["brand_closing"] for s in shots] == [None, None, "ai_packshot"]
    assert [s["closing"] for s in shots] == [None, None, "ai_packshot"]
    assert not any(s["brand_placements_locked"] for s in shots)
    prod_id = kit["products"][0]["media_id"]
    logo_id = kit["logos"]["primary"]["media_id"]
    assert shots[0]["brand_placements"] == []
    assert shots[1]["brand_placements"] == [
        {"asset_id": prod_id, "asset_type": "product", "surface": "cafe counter", "prominence": "hero", "source": "ai"},
        {"asset_id": logo_id, "asset_type": "logo", "surface": "cup sleeve", "prominence": "background",
         "source": "ai"}]
    closing = shots[2]
    assert closing["duration_s"] == bm.PACKSHOT_S and closing["shot_type"] == "insert"
    assert "Leaf Cold Brew" in closing["start_prompt"] and "push-in" in closing["motion_prompt"]
    assert {p["asset_type"] for p in closing["brand_placements"]} == {"product", "logo"}
    assert done.result["closing_shot_id"] == closing["id"]

    # re-planning keeps exactly one closing shot, still last
    job = client.post(f"/api/scenes/{sc['id']}/ai/suggest-shots", json={"max_shots": 4}).json()
    assert run_job(job["id"]).status == "done"
    again = client.get(f"/api/scenes/{sc['id']}/shots").json()
    assert [s["brand_closing"] for s in again] == [None, None, "ai_packshot"] and again[2]["id"] == closing["id"]


def test_no_kit_means_no_brand_moments(client, project, fake_llm):
    sc = scene_with_script(client, project["id"])
    seen = []
    fake_llm(answer({"shots": [{"description": "Maya", "brand_placements": PLACED}]}, seen=seen))
    job = client.post(f"/api/scenes/{sc['id']}/ai/suggest-shots", json={}).json()
    assert run_job(job["id"]).status == "done"
    shots = client.get(f"/api/scenes/{sc['id']}/shots").json()
    assert len(shots) == 1 and shots[0]["brand_placements"] == [] and shots[0]["brand_closing"] is None
    assert "Brand assets" not in seen[0]["messages"][1]["content"]


def test_closing_mode_rules(client, db, project):
    with_product = kit_with_product(client)
    logo_only = make_kit(client)
    p = db.get(Project, project["id"])
    k1, k2 = db.get(br.BrandKit, with_product["id"]), db.get(br.BrandKit, logo_only["id"])
    assert bm.closing_mode(k1, p) == "ai_packshot" and bm.closing_mode(k2, p) == "logo_reveal"
    p.settings = {"brand_closing": "logo_reveal"}
    assert bm.closing_mode(k1, p) == "logo_reveal"
    p.settings = {"brand_closing": "ai_packshot"}
    assert bm.closing_mode(k2, p) == "logo_reveal"  # no product to shoot: falls back to the exact reveal
    p.settings = {"brand_closing": "none"}
    assert bm.closing_mode(k1, p) is None
    k1.settings = {**(k1.settings or {}), "closing": "logo_reveal"}
    p.settings = {}
    assert bm.closing_mode(k1, p) == "logo_reveal"
    # the kit setting goes through the normal settings PATCH
    r = client.patch(f"/api/brand-kits/{logo_only['id']}", json={"settings": {"closing": "none"}})
    assert r.status_code == 200 and r.json()["settings"]["closing"] == "none"
    assert client.patch(f"/api/brand-kits/{logo_only['id']}", json={"settings": {"closing": "boom"}}).status_code == 422
    url = f"/api/projects/{project['id']}"
    assert client.patch(url, json={"settings": {"brand_closing": "boom"}}).status_code == 422
    r = client.patch(url, json={"settings": {"brand_closing": "logo_reveal", "brand_closing_shot": {"shot_id": "x"}}})
    assert r.status_code == 200 and r.json()["settings"] == {"brand_closing": "logo_reveal"}


# ------------------------------------------------------------------ locks

def test_user_placements_are_never_overwritten(client, project, fake_llm):
    kit = kit_with_product(client)
    use_kit(client, project["id"], kit["id"])
    sc = scene_with_script(client, project["id"])
    a = client.post(f"/api/scenes/{sc['id']}/shots", json={"description": "Maya at the door"}).json()
    b = client.post(f"/api/scenes/{sc['id']}/shots", json={"description": "The can"}).json()
    mine = [{"asset_id": kit["logos"]["primary"]["media_id"], "asset_type": "logo", "surface": "apron",
             "prominence": "hero"}]
    assert client.patch(f"/api/shots/{a['id']}", json={"brand_placements": mine}).status_code == 200

    fake_llm(answer(moments={"shots": [
        {"shot": 1, "brand_placements": [{"asset_id": "product1", "surface": "table", "prominence": "background"}]},
        {"shot": 2, "brand_placements": [{"asset_id": "product1", "surface": "counter", "prominence": "hero"}]}]}))
    job = client.post(f"/api/projects/{project['id']}/ai/brand-moments").json()
    done = run_job(job["id"])
    assert done.status == "done", done.error
    assert done.result["shot_ids"] == [b["id"]] and len(done.result["suggestion_ids"]) == 1

    shots = {s["id"]: s for s in client.get(f"/api/scenes/{sc['id']}/shots").json()}
    assert shots[a["id"]]["brand_placements"] == [{**mine[0], "source": "user"}]  # untouched
    assert shots[b["id"]]["brand_placements"][0]["surface"] == "counter"
    assert any(s["brand_closing"] == "ai_packshot" for s in shots.values())

    sug = client.get(f"/api/projects/{project['id']}/suggestions").json()
    [s] = [x for x in sug if x["field"] == "brand_placements"]
    assert s["target_type"] == "shot" and json.loads(s["proposed_text"])[0]["surface"] == "table"
    r = client.post(f"/api/suggestions/{s['id']}/accept")
    assert r.status_code == 200, r.text
    accepted = r.json()["shot"]["brand_placements"]
    assert accepted[0]["surface"] == "table" and accepted[0]["source"] == "user"


def test_shot_plan_with_user_placements_becomes_a_suggestion(client, project, fake_llm):
    kit = kit_with_product(client)
    use_kit(client, project["id"], kit["id"])
    sc = scene_with_script(client, project["id"])
    fake_llm(answer({"shots": [{"description": "Maya", "brand_placements": PLACED[:1]}]}))
    assert run_job(client.post(f"/api/scenes/{sc['id']}/ai/suggest-shots", json={}).json()["id"]).status == "done"
    first = client.get(f"/api/scenes/{sc['id']}/shots").json()[0]
    assert first["source"] == "ai" and not first["locked"]
    mine = [{**first["brand_placements"][0], "surface": "tote bag", "source": "user"}]  # as the UI sends an edit
    client.patch(f"/api/shots/{first['id']}", json={"brand_placements": mine})
    done = run_job(client.post(f"/api/scenes/{sc['id']}/ai/suggest-shots", json={}).json()["id"])
    assert done.result["outcome"] == "suggested"
    assert client.get(f"/api/shots/{first['id']}").json()["brand_placements"][0]["surface"] == "tote bag"


def test_patch_keeps_the_source_and_extra_keys(client, project, fake_llm):
    kit = kit_with_product(client)
    use_kit(client, project["id"], kit["id"])
    sc = scene_with_script(client, project["id"])
    shot = client.post(f"/api/scenes/{sc['id']}/shots", json={"description": "the can"}).json()
    prod = kit["products"][0]["media_id"]
    ai = {"asset_id": prod, "asset_type": "product", "surface": "shelf", "prominence": "background", "source": "ai",
          "ui_key": "p-1"}
    r = client.patch(f"/api/shots/{shot['id']}", json={"brand_placements": [ai]})
    assert r.json()["brand_placements"] == [ai] and r.json()["brand_placements_locked"] is False
    # an AI-sourced placement sent back unchanged isn't a lock: a re-plan writes over it
    fake_llm(answer(moments={"shots": [{"shot": 1, "brand_placements": [
        {"asset_id": "product1", "surface": "counter", "prominence": "hero"}]}]}))
    done = run_job(client.post(f"/api/projects/{project['id']}/ai/brand-moments").json()["id"])
    assert done.result["shot_ids"] == [shot["id"]] and done.result["suggestion_ids"] == []
    user = {**ai, "source": "user"}
    r = client.patch(f"/api/shots/{shot['id']}", json={"brand_placements": [user]})
    assert r.json()["brand_placements"] == [user] and r.json()["brand_placements_locked"] is True
    no_source = {k: v for k, v in ai.items() if k != "source"}
    r = client.patch(f"/api/shots/{shot['id']}", json={"brand_placements": [no_source]})
    assert r.json()["brand_placements"][0]["source"] == "user" and r.json()["brand_placements_locked"] is True


# ------------------------------------------------------------------ keyframes

def _branded_shot(client, db, project, placements, *, chars=1, with_location=False):
    kit = kit_with_product(client)
    use_kit(client, project["id"], kit["id"])
    sc = scene_with_script(client, project["id"])
    ws = kit["workspace_id"]
    cids = []
    for i in range(chars):
        c = client.post(f"/api/projects/{project['id']}/characters", json={"name": f"Maya{i}"}).json()
        finished_still(db, ws, project["id"], "character", c["id"], "portrait")
        cids.append(c["id"])
    loc_id = None
    if with_location:
        loc = client.post(f"/api/projects/{project['id']}/locations", json={"name": "Cafe"}).json()
        finished_still(db, ws, project["id"], "location", loc["id"], "establishing")
        loc_id = loc["id"]
    shot = client.post(f"/api/scenes/{sc['id']}/shots", json={"description": "the cup", "character_ids": cids,
                                                               "location_id": loc_id}).json()
    resolved = []
    for p in placements:
        aid = kit["logos"]["primary"]["media_id"] if p["asset_type"] == "logo" else kit["products"][0]["media_id"]
        resolved.append({**p, "asset_id": aid})
    client.patch(f"/api/shots/{shot['id']}", json={"brand_placements": resolved, "start_prompt": "Maya at the counter"})
    db.expire_all()
    return kit, db.get(Shot, shot["id"])


def test_keyframe_uses_edit_model_with_logo_and_product_refs(client, db, project):
    kit, shot = _branded_shot(client, db, project, [
        {"asset_type": "logo", "surface": "cup sleeve", "prominence": "hero"},
        {"asset_type": "product", "surface": "counter", "prominence": "background"}])
    prompt, params = sb.prepare_shot_generation(db, shot, "keyframe_start", "", {})
    logo_gen = db.get(br.MediaItem, kit["logos"]["primary"]["media_id"]).generation_id
    prod_gen = db.get(br.MediaItem, kit["products"][0]["media_id"]).generation_id
    refs = params["reference_ids"]
    assert len(refs) == 3 and refs[0] == logo_gen and refs[2] == prod_gen  # hero, character, background
    assert params["reference_labels"] == ["the Leaf Coffee logo", "Maya0", "the Leaf Cold Brew"]
    assert params["edit_model"] == "qwen_image_edit_2511"
    assert prompt.startswith("Maya at the counter")
    assert "the Leaf Coffee logo (round green leaf) printed on the cup sleeve, front-facing, sharp, legible" in prompt
    assert params["brand_check"]["logo_media_id"] == kit["logos"]["primary"]["media_id"]
    assert params["brand_check"]["surface"] == "cup sleeve"

    # the comfy driver turns it into a Qwen edit with the "Picture N" preamble
    p = plan_generation("keyframe_start", prompt, params, 3, FakeLookup(Path(get_settings().data_dir)))
    assert p.template == "qwen_edit" and len(p.images["images"]) == 3
    assert p.inputs["prompt"].startswith("Picture 1 shows the Leaf Coffee logo")

    # the take for a hero shot asks for a calm camera
    finished_still(db, shot.workspace_id, shot.project_id, "shot", shot.id, "keyframe_start")
    shot.motion_prompt = "She lifts the cup."
    tprompt, tparams = sb.prepare_shot_generation(db, shot, "take", "", {})
    assert "Slow, steady camera move" in tprompt and "the logo stays sharp" in tprompt
    assert tparams["brand_prompt"] in tprompt


def test_max_refs_drops_background_placements_but_keeps_them_in_words(client, db, project):
    _kit, shot = _branded_shot(client, db, project, [
        {"asset_type": "logo", "surface": "cup sleeve", "prominence": "hero"},
        {"asset_type": "product", "surface": "shelf", "prominence": "background"}], chars=1, with_location=True)
    prompt, params = sb.prepare_shot_generation(db, shot, "keyframe_start", "", {"edit_model": "flux2_klein_edit"})
    assert len(params["reference_ids"]) == 3  # logo + character + location; the product has no slot left
    assert params["reference_labels"][0] == "the Leaf Coffee logo" and "the location (Cafe)" in params["reference_labels"]
    assert "Leaf Cold Brew (matte black 330 ml can) on the shelf" in prompt
    assert params["brand"]["dropped"] and params["edit_model"] == "flux2_klein_edit"


def test_compile_first_keyframe_gets_the_brand_fragment(client, db, project, fast_driver, monkeypatch):
    _kit, shot = _branded_shot(client, db, project, [
        {"asset_type": "product", "surface": "counter", "prominence": "hero"}])
    shot.start_prompt = ""
    shot.prompt_mode = "manual"
    shot.description = "Maya picks up the can"
    db.commit()
    [g] = [x for x in ai_jobs.queue_frames(db, shot) if x.kind == "keyframe_start"]
    db.commit()
    assert g.params["compile_first"] and g.params["brand_prompt"]
    run_job(g.job_id, fast_driver)
    db.refresh(g)
    assert g.status == "ready" and "Leaf Cold Brew (matte black 330 ml can) on the counter" in g.prompt


def test_studio_logo_check_flags_the_frame(client, db, project, fast_driver, monkeypatch):
    _kit, shot = _branded_shot(client, db, project, [
        {"asset_type": "logo", "surface": "cup sleeve", "prominence": "hero"}])
    calls = []

    def bad(image, logo, surface=None, **kw):
        calls.append(surface)
        return {"checked": True, "passed": False, "present": True, "legible": False, "distorted": True,
                "score": 3, "issues": ["warped letters"], "call": {}}

    monkeypatch.setattr(br, "check_logo", bad)
    gens = ai_jobs.queue_frames(db, shot)
    db.commit()
    for g in gens:
        run_job(g.job_id, fast_driver)
    db.expire_all()
    for g in gens:
        lc = db.get(Generation, g.id).params["logo_check"]
        assert lc["needs_review"] and lc["issues"] == ["warped letters"] and lc["score"] == 3
    assert calls == ["cup sleeve", "cup sleeve"]


def test_regenerate_with_logo_note_keeps_the_brand_references(client, db, project, fast_driver, fake_llm,
                                                              monkeypatch):
    kit, shot = _branded_shot(client, db, project, [
        {"asset_type": "logo", "surface": "cup sleeve", "prominence": "hero"}])
    monkeypatch.setattr(br, "check_logo", lambda *a, **k: {"checked": True, "passed": False, "score": 2,
                                                           "issues": ["logo missing"]})
    [g] = [x for x in ai_jobs.queue_frames(db, shot) if x.kind == "keyframe_start"]
    db.commit()
    run_job(g.job_id, fast_driver)
    db.refresh(g)
    assert g.params["logo_check"]["needs_review"]
    # the rewrite comes back without the surface phrase; the server puts it back
    fake_llm(lambda body: oa("Maya at the counter holding a coffee cup, logo clearly visible"))
    r = client.post(f"/api/generations/{g.id}/regenerate",
                    json={"mode": "note", "note": "Logo issues: logo missing. Show the logo on the cup sleeve."})
    assert r.status_code == 201, r.text
    with SessionLocal() as s:
        new = s.get(Generation, r.json()["id"])
        logo_gen = s.get(br.MediaItem, kit["logos"]["primary"]["media_id"]).generation_id
        assert new.params["reference_ids"][0] == logo_gen and new.params["edit_model"] == "qwen_image_edit_2511"
        assert new.params["brand_check"]["surface"] == "cup sleeve" and "logo_check" not in new.params
        assert new.prompt.startswith("Maya at the counter holding a coffee cup")
        assert "printed on the cup sleeve" in new.prompt and new.note.startswith("Logo issues")


# ------------------------------------------------------------------ logo check in the autopilot

def _quick_autopilot(client, db, fast_driver, kit):
    from app import autopilot as ap_mod
    from app.models import Character
    from app.worker import JobContext

    out = client.post("/api/quick", json={"prompt": "A coffee advert", "duration_s": 10,
                                          "brand_kit_id": kit["id"]}).json()
    job = db.get(Job, out["job"]["id"])
    job.status = "running"
    db.commit()
    a = ap_mod.Autopilot(JobContext(db, job, fast_driver))
    a.current = "cast"
    ch = Character(workspace_id=job.workspace_id, project_id=out["project"]["id"], name="Mara", description="x")
    db.add(ch)
    db.commit()
    return a, ch


def _settle_logo(a, ch, kit, fast_driver):
    from app.services import enqueue_generation

    check = {"kit_id": kit["id"], "logo_media_id": kit["logos"]["primary"]["media_id"], "surface": "apron"}

    def make():
        return enqueue_generation(a.db, workspace_id=ch.workspace_id, project_id=ch.project_id,
                                  target_type="character", target_id=ch.id, kind="portrait", prompt="p",
                                  params={"brand_check": check})

    for _ in range(12):
        waits = a.image_slot("character", ch.id, "portrait", make, "apron with logo", None, "portrait")
        a.db.commit()
        if not waits:
            return
        for _ in waits:
            process_one(driver_factory=fast_driver)
    raise AssertionError("never settled")


@pytest.fixture
def brain():
    holder = {}

    def install(**kw):
        b = Brain(**kw)
        set_transport(httpx.MockTransport(b))
        holder["b"] = b
        return b

    yield install
    set_transport(None)


def test_autopilot_rerolls_when_the_logo_check_fails(client, db, brain, fast_driver, monkeypatch):
    brain(vision_scores=(9,))
    kit = make_kit(client)
    verdicts = iter([False, True])
    monkeypatch.setattr(br, "check_logo", lambda *a, **k: (lambda ok: {
        "checked": True, "passed": ok, "score": 8 if ok else 2, "issues": [] if ok else ["no logo"]})(next(verdicts)))
    a, ch = _quick_autopilot(client, db, fast_driver, kit)
    _settle_logo(a, ch, kit, fast_driver)
    gens = db.scalars(select(Generation).where(Generation.target_id == ch.id).order_by(Generation.created_at)).all()
    assert [g.params["logo_check"]["passed"] for g in gens] == [False, True]
    assert gens[1].status == "approved" and gens[1].params["auto_check"] == "passed"
    assert "vision" not in (gens[0].score or {})  # a frame with a bad logo isn't worth scoring


def test_autopilot_flags_when_every_logo_try_fails(client, db, brain, fast_driver, monkeypatch):
    brain(vision_scores=(9,))
    kit = make_kit(client)
    scores = iter([2, 4, 3, 1, 1])
    monkeypatch.setattr(br, "check_logo", lambda *a, **k: (lambda s: {
        "checked": True, "passed": False, "score": s, "issues": [f"score {s}"]})(next(scores)))
    a, ch = _quick_autopilot(client, db, fast_driver, kit)
    _settle_logo(a, ch, kit, fast_driver)
    gens = db.scalars(select(Generation).where(Generation.target_id == ch.id).order_by(Generation.created_at)).all()
    assert len(gens) == 1 + get_settings().auto_retries
    [best] = [g for g in gens if g.status == "approved"]
    assert best.params["auto_check"] == "logo_flagged" and best.params["auto_issues"] == ["score 4"]


# ------------------------------------------------------------------ closing logo reveal

def test_logo_reveal_closing_take_is_inserted_and_stitched(client, db, project, fake_llm):
    kit = make_kit(client)  # no products: auto closing is the exact reveal
    use_kit(client, project["id"], kit["id"])
    sc = scene_with_script(client, project["id"])
    fake_llm(answer({"shots": [{"description": "Maya", "duration_s": 2}]}))
    assert run_job(client.post(f"/api/scenes/{sc['id']}/ai/suggest-shots", json={}).json()["id"]).status == "done"
    shots = client.get(f"/api/scenes/{sc['id']}/shots").json()
    reveal = shots[-1]
    assert reveal["brand_closing"] == "logo_reveal" and reveal["duration_s"] == bm.REVEAL_S
    run_jobs()
    reveal = client.get(f"/api/shots/{reveal['id']}").json()
    assert reveal["status"] == "approved"
    with SessionLocal() as s:
        tg = s.get(Generation, reveal["approved_take"]["id"])
        take = {"params": tg.params, "file_path": tg.file_path}
    assert take["params"]["source"] == "logo_reveal" and take["params"]["approved_by"] == "brand_closing"
    info = media_frame(get_settings().data_dir / take["file_path"])
    assert info["size"] == sb.draft_size(project["aspect_ratio"]) and info["fps"] == 24 and info["has_audio"]
    assert info["duration"] == pytest.approx(3.0, abs=0.1)

    # no frames for it, and a "render takes" click re-uses the reveal instead of LTX
    with SessionLocal() as s:
        with pytest.raises(Exception) as e:
            sb.prepare_shot_generation(s, s.get(Shot, reveal["id"]), "keyframe_start", "", {})
        assert getattr(e.value, "status_code", None) == 409
    r = client.post(f"/api/shots/{reveal['id']}/takes", json={})
    assert r.status_code == 202 and r.json()[0]["type"] == "brand_reveal"

    # give the story shot a take too, then stitch: the reveal closes the film
    with SessionLocal() as s:
        first = s.get(Shot, shots[0]["id"])
        clip = finished_still(s, kit["workspace_id"], project["id"], "shot", first.id, "keyframe_start")
        src = Path(get_settings().data_dir / take["file_path"])
        g = Generation(id=new_id(), workspace_id=clip.workspace_id, project_id=project["id"], target_type="shot",
                       target_id=first.id, kind="take", version=1, status="approved", prompt="p",
                       params={"duration_s": 3.0}, seed=1, media_type="video/mp4", file_path=take["file_path"])
        s.add(g)
        s.commit()
        assert src.is_file()
    r = client.post(f"/api/projects/{project['id']}/reel/assemble", json={"quality": "draft"})
    assert r.status_code == 202, r.text
    run_jobs()
    with SessionLocal() as s:
        j = s.get(Job, r.json()["id"])
        assert j.status == "done", j.error
        film = s.get(Generation, j.generation_id)
        assert rl.probe(generation_file(film)).duration == pytest.approx(6.0, abs=0.3)


# ------------------------------------------------------------------ advert templates + Quick Create

class AdBrain(Brain):
    def __init__(self, **kw):
        super().__init__(**kw)
        self.bodies: list[dict] = []

    def __call__(self, request):
        body = json.loads(request.content)
        self.bodies.append(body)
        title = schema_title(body)
        if title == "SceneFrames":
            self.seen.append(title)
            return httpx.Response(200, json=oa(json.dumps({
                "shot_type": "medium", "description": "Mara sips cold brew", "camera": "slow push",
                "characters": ["Mara"], "start_prompt": "A woman at a cafe counter", "end_prompt": "She smiles",
                "motion_prompt": "She lifts the can", "brand_placements": PLACED})))
        if title == "LogoCheck":
            self.seen.append(title)
            return httpx.Response(200, json=oa(json.dumps({"present": True, "legible": True, "distorted": False,
                                                          "score": 8, "issues": []})))
        return super().__call__(request)


def test_templates_flag_adverts(client):
    rows = {t["id"]: t for t in client.get("/api/templates?type=video").json()}
    assert {k for k, t in rows.items() if t["requires_brand"]} == {
        "video-product-ad-30s", "video-brand-story-60s", "video-vertical-teaser-15s"}
    start = client.post("/api/templates/video-product-ad-30s/start").json()
    assert start["target"] == "quick" and start["prefill"]["requires_brand"] is True
    assert "requires_brand" not in client.post("/api/templates/video-documentary-2min/start").json()["prefill"]
    assert client.post("/api/quick", json={"prompt": "x" * 5, "template_id": "nope"}).status_code == 404


@pytest.mark.parametrize("closing", ["auto", "logo_reveal"])
def test_ad_template_quick_create_end_to_end(client, fast_driver, closing):
    b = AdBrain(vision_scores=(9,))
    set_transport(httpx.MockTransport(b))
    try:
        kit = kit_with_product(client)
        r = client.post("/api/quick", json={"prompt": "Leaf Cold Brew for busy mornings", "duration_s": 10,
                                            "style": "commercial", "dialogue": False, "brand_kit_id": kit["id"],
                                            "template_id": "video-product-ad-30s", "brand_closing": closing})
        assert r.status_code == 201, r.text
        out = r.json()
        job = drive(out["job"]["id"], fast_driver, limit=150)
    finally:
        set_transport(None)
    assert job.status == "done", job.error
    assert stages(job)["render"] == "done" and stages(job)["stitch"] == "done"

    outline = next(x for x in b.bodies if schema_title(x) == "QuickOutline")["messages"][1]["content"]
    assert "Format notes: A 30-second product advert" in outline and "Brand: Leaf Coffee" in outline
    frames = next(x for x in b.bodies if schema_title(x) == "SceneFrames")["messages"][1]["content"]
    assert "Brand assets you can place" in frames

    pid = out["project"]["id"]
    with SessionLocal() as db:
        shots = sb.project_shots(db, pid)
        mode = "ai_packshot" if closing == "auto" else "logo_reveal"
        assert len(shots) == 2 and bm.closing_of(db, shots[-1]) == mode
        story, last = shots
        # the closing comes out of the planned 10 s
        assert story.duration_s + last.duration_s == pytest.approx(10)
        assert [p["asset_type"] for p in story.brand_placements] == ["product", "logo"]
        start = sb.approved(db, "shot", story.id, "keyframe_start")
        prod_gen = db.get(br.MediaItem, kit["products"][0]["media_id"]).generation_id
        assert start.params["reference_ids"][0] == prod_gen and "on the cafe counter" in start.prompt
        take = sb.approved(db, "shot", last.id, "take")
        assert take is not None
        if mode == "logo_reveal":
            assert take.params["source"] == "logo_reveal"
        else:
            lc = sb.approved(db, "shot", last.id, "keyframe_start").params["logo_check"]
            assert lc["passed"] and not lc["needs_review"]
            assert "LogoCheck" in b.seen
        final = db.get(Generation, job.result["final_render_id"])
        assert rl.probe(generation_file(final)).duration == pytest.approx(10, abs=0.7)


# ------------------------------------------------------------------ image to image

def upload(client, size=(300, 200), name="photo.png") -> dict:
    buf = png(size=size, mode="RGB")
    r = client.post("/api/media/upload", files={"file": (name, buf, "image/png")})
    assert r.status_code == 201, r.text
    return r.json()


def test_img2img_endpoint_from_an_upload(client, fast_driver):
    src = upload(client)
    r = client.post("/api/images/img2img", json={"source_id": src["id"], "prompt": "as a watercolour",
                                                 "strength": 0.6, "model": "flux2_klein", "count": 2})
    assert r.status_code == 202, r.text
    items = r.json()["items"]
    assert len(items) == 2
    with SessionLocal() as db:
        g = db.get(Generation, items[0]["generation_id"])
        assert g.params["img2img_of"] == {"media_id": src["id"], "generation_id": src["generation_id"],
                                          "strength": 0.6}
        assert (g.params["width"], g.params["height"]) == (1280, 832)  # 3:2 kept at ~1 MP
        assert g.params["model"] == "flux2_klein"
    run_job(r.json()["jobs"][0]["id"], fast_driver)
    assert client.get(f"/api/media/{items[0]['id']}").json()["status"] == "ready"

    # a generation id works as the source too, and an aspect overrides the source's shape
    r = client.post("/api/images/img2img", json={"source_id": src["generation_id"], "prompt": "night",
                                                 "aspect": "1:1", "brand_kit_id": None})
    assert r.status_code == 202
    with SessionLocal() as db:
        g = db.get(Generation, r.json()["items"][0]["generation_id"])
        assert g.params["img2img_of"]["strength"] == 0.45 and (g.params["width"], g.params["height"]) == (1024, 1024)


def test_img2img_validation(client):
    src = upload(client)
    body = {"source_id": src["id"], "prompt": "x"}
    assert client.post("/api/images/img2img", json={**body, "strength": 0.05}).status_code == 422
    assert client.post("/api/images/img2img", json={**body, "strength": 0.95}).status_code == 422
    assert client.post("/api/images/img2img", json={**body, "model": "qwen_image_edit_2511"}).status_code == 422
    assert client.post("/api/images/img2img", json={**body, "count": 5}).status_code == 422
    assert client.post("/api/images/img2img", json={**body, "source_id": "missing"}).status_code == 404
    assert client.post("/api/images/img2img", json={**body, "model": "zimage_turbo", "speed": "turbo"}).status_code == 422


@pytest.mark.parametrize("model,template,steps", [("zimage_turbo", "zimage_i2i", None),
                                                  ("flux2_klein", "flux2_klein_i2i", math.ceil(4 / 0.3)),
                                                  ("qwen_image_2512", "qwen_image_i2i", 4)])
def test_img2img_routing_per_model(tmp_path, model, template, steps):
    params = {"model": model, "width": 1024, "height": 768,
              "img2img_of": {"generation_id": "src-gen", "strength": 0.3}}
    p = plan_generation("image", "a fox in snow", params, 9, FakeLookup(tmp_path))
    assert p.template == template and p.inputs["denoise"] == 0.3
    assert p.images["image"].name == "src-gen.png" and p.sources["img2img_of"] == "src-gen"
    if steps is not None:
        assert p.inputs["steps"] == steps
    if model == "qwen_image_2512":
        assert p.inputs["speed_lora"]  # default speed is Lightning
    graph, resolved = build(p.template, {**p.inputs, "image": "uploaded.png"})
    titles = {n["_meta"]["title"]: n for n in graph.values()}
    assert titles["Source"]["inputs"]["image"] == "uploaded.png"
    assert titles["Resize"]["inputs"]["width"] == 1024 and titles["Resize"]["inputs"]["height"] == 768
    assert resolved["denoise"] == 0.3
    if template == "flux2_klein_i2i":
        assert titles["Sampler"]["inputs"]["sigmas"] == [next(k for k, n in graph.items()
                                                              if n["_meta"]["title"] == "Strength"), 1]


def test_catalog_lists_i2i(client):
    rows = {m["id"]: m for m in client.get("/api/models?type=image").json()}
    assert all("i2i" in rows[m]["capabilities"] for m in ("zimage_turbo", "flux2_klein", "qwen_image_2512"))


# ------------------------------------------------------------------ image to video

def test_i2v_with_start_and_end_image(client, tmp_path, fast_driver):
    a, z = upload(client, name="a.png"), upload(client, name="z.png")
    r = client.post("/api/videos/generate", json={"prompt": "the cup turns", "image_id": a["id"],
                                                  "end_image_id": z["generation_id"], "duration_s": 4})
    assert r.status_code == 202, r.text
    with SessionLocal() as db:
        g = db.get(Generation, r.json()["generation_id"])
        assert g.params["first_frame_id"] == a["generation_id"] and g.params["last_frame_id"] == z["generation_id"]
        params = dict(g.params)
    p = plan_generation("video", "the cup turns", params, 1, FakeLookup(tmp_path))
    assert p.template == "ltx23_i2v" and set(p.images) == {"first_image", "last_image"}
    graph, _ = build(p.template, {**p.inputs, "first_image": "a.png", "last_image": "z.png"})
    assert any(n["_meta"]["title"] == "LastImage" for n in graph.values())
    run_job(r.json()["job"]["id"], fast_driver)
    assert client.get(f"/api/media/{r.json()['id']}").json()["status"] == "ready"

    hq = client.post("/api/videos/generate", json={"prompt": "x", "model": "ltx23_hq", "image_id": a["id"],
                                                   "end_image_id": z["id"], "duration_s": 5})
    assert hq.status_code == 202
    with SessionLocal() as db:
        hp = db.get(Generation, hq.json()["generation_id"]).params
    p = plan_generation("video", "x", hp, 1, FakeLookup(tmp_path))
    assert p.template == "ltx23_two_stage" and "last_image" in p.images

    long = client.post("/api/videos/generate", json={"prompt": "x", "image_id": a["id"], "end_image_id": z["id"],
                                                     "duration_s": 20})
    assert long.status_code == 202
    with SessionLocal() as db:
        lp = db.get(Generation, long.json()["generation_id"]).params
        assert lp.get("longtake") and lp["last_frame_id"] == z["generation_id"]


def test_i2v_aspect_follows_the_start_image(client):
    tall = upload(client, size=(200, 320), name="tall.png")
    r = client.post("/api/videos/generate", json={"prompt": "x", "image_id": tall["id"]})
    assert r.status_code == 202, r.text
    assert r.json()["width"] < r.json()["height"]
    square = upload(client, size=(300, 290), name="sq.png")
    plain = client.post("/api/videos/generate", json={"prompt": "x"})
    asked = client.post("/api/videos/generate", json={"prompt": "x", "image_id": tall["id"], "aspect": "16:9"})
    sq = client.post("/api/videos/generate", json={"prompt": "x", "image_id": square["id"]})
    with SessionLocal() as db:
        aspect = {k: db.get(Generation, v.json()["generation_id"]).params["aspect_ratio"]
                  for k, v in (("tall", r), ("plain", plain), ("asked", asked), ("sq", sq))}
    assert aspect == {"tall": "9:16", "plain": "16:9", "asked": "16:9", "sq": "1:1"}


def test_i2v_refusals(client):
    a = upload(client)
    wan = client.post("/api/videos/generate", json={"prompt": "x", "model": "wan22_t2v", "image_id": a["id"]})
    assert wan.status_code == 422 and "text only" in wan.json()["detail"]
    wan_end = client.post("/api/videos/generate", json={"prompt": "x", "model": "wan22_t2v", "image_id": a["id"],
                                                        "end_image_id": a["id"]})
    assert wan_end.status_code == 422
    assert client.post("/api/videos/generate", json={"prompt": "x", "end_image_id": a["id"]}).status_code == 422
    assert client.post("/api/videos/generate", json={"prompt": "x", "image_id": a["id"],
                                                     "end_image_id": "missing"}).status_code == 404


# ------------------------------------------------------------------ uploads everywhere

def test_source_endpoints_take_media_or_generation_ids(client):
    up = upload(client)
    for sid in (up["id"], up["generation_id"]):
        r = client.post("/api/images/edit", json={"source_ids": [sid], "instruction": "add a hat"})
        assert r.status_code == 202, r.text
        r = client.post(f"/api/generations/{sid}/upscale", json={"engine": "quick", "target": "2x"})
        assert r.status_code == 202, r.text
    kit = make_kit(client, settings={"watermark": {"enabled": True}})
    r = client.post(f"/api/generations/{up['id']}/brand", json={"kit_id": kit["id"]})
    assert r.status_code == 202, r.text
