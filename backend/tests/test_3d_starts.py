"""3D Studio part 2 (M20, contract v40 addendum): the text, character and four-view starts, the four-view
template, the picture a text start waits for, packages and MCP."""
import io
import json
from pathlib import Path

from PIL import Image
from sqlalchemy import select

from app import model3d as m3
from app import models_catalog as mc
from app.config import get_settings
from app.db import SessionLocal
from app.drivers.comfy import ComfyDriver, plan_generation
from app.models import Character, Generation, Job, MediaItem, new_id
from app.workflows import build, check_template, load
from app.worker import process_one
from tests.test_3d import FIX, FakeLookup, GlbClient, _drain, _info, _titled
from tests.test_accounts import PW, make_user
from tests.test_api_tokens import _mint, flags, login  # noqa: F401  (fixtures)
from tests.test_library import png_bytes, upload
from tests.test_mcp import Mcp

MV = m3.MULTIVIEW_TEMPLATE
VIEW_NODES = {v: (f"{v.title()} picture", f"{v.title()} cut-out", f"Switch: {v.title()} background", f"{v.title()} crop")
              for v in m3.VIEWS}


def _pic(client, name: str, colour=(200, 120, 40)) -> dict:
    b = io.BytesIO()
    Image.new("RGB", (128, 128), colour).save(b, "PNG")
    r = upload(client, f"{name}.png", b.getvalue(), "image/png", title=name.title())
    assert r.status_code == 201, r.text
    return r.json()


def _character(client, name="Maya") -> dict:
    r = client.post("/api/characters", json={"name": name, "description": "a diver in a yellow suit"})
    assert r.status_code == 201, r.text
    return r.json()


def _panel(character_id: str, kind: str, panel: str | None = None, status="ready") -> str:
    """A finished character picture straight in the DB; the sheet's own queueing is tested elsewhere."""
    with SessionLocal() as db:
        ws = db.get(Character, character_id).workspace_id
        gid = new_id()
        rel = Path("workspaces") / ws / "characters" / f"{gid}.png"
        f = get_settings().data_dir / rel
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_bytes(png_bytes((96, 128)))
        db.add(Generation(id=gid, workspace_id=ws, target_type="character", target_id=character_id, kind=kind,
                          version=1, status=status, prompt=f"{panel or kind} of Maya", seed=1,
                          params={"panel": panel} if panel else {}, file_path=rel.as_posix(), media_type="image/png"))
        db.commit()
    return gid


def _rec(gen_id: str) -> dict:
    with SessionLocal() as db:
        return db.get(Generation, gen_id).params


# ---------------------------------------------------------------- the four-view template

def test_four_view_template_checks_and_drops_unused_views():
    res = check_template(MV, _info())
    assert res["ok"], res
    assert res["features"] == {"measure_fov": {"ok": True, "problems": []}}
    # the multi-view node came over verbatim from the 3D dump
    dump = json.loads((FIX / "object_info_3d.json").read_text())
    assert _info()["Pixal3DMultiViewConditioning"]["input"] == dump["Pixal3DMultiViewConditioning"]["input"]

    info = _info()
    info["UNETLoader"]["input"]["required"]["unet_name"][0].remove("pixal3d_multiview_int8_convrot.safetensors")
    assert check_template(MV, info)["missing_models"] == ["pixal3d_multiview_int8_convrot.safetensors"]
    m = mc.MODELS["pixal3d"]
    av = mc.availability(m, info)
    # the single-picture engine stays up; only the views capability goes
    assert av["available"] and av["dropped"] == ["multiview"]
    assert mc.availability(m, _info())["dropped"] == []

    g, res = build(MV, {"front": "f.png", "back": "b.png",
                        **m3.inputs_for({"views": {"front": "a", "back": "b"}, "quality": "draft"}, 7)})
    t = _titled(g)
    cond = t["Pixal3D multi-view conditioning"]["inputs"]
    ids = {n["_meta"]["title"]: k for k, n in g.items()}
    assert set(cond) == {"clip_vision_model", "fov", "front", "back"} and cond["fov"] == 20.0
    assert cond["front"] == [ids["Front crop"], 0] and cond["back"] == [ids["Back crop"], 0]
    for v in ("left", "right"):
        assert not set(VIEW_NODES[v]) & set(t)
    assert not any(n["class_type"] in ("ComfySwitchNode", "MoGeInference", "Pixal3DConditioning",
                                       "Trellis2Conditioning") for n in g.values())
    assert t["Model Pixal3D multi-view"]["inputs"]["unet_name"] == "pixal3d_multiview_int8_convrot.safetensors"
    assert "Model TRELLIS.2" not in t
    # each view is cut out and cropped square on black, padded 1.1, like the node asks
    for v in ("Front", "Back"):
        crop = t[f"{v} crop"]["inputs"]
        assert (crop["width"], crop["height"], crop["pad_factor"], crop["background"]) == (1024, 1024, 1.1, "#000000")
        assert crop["masks"] == [ids[f"{v} cut-out"], 0] and crop["images"] == [ids[f"{v} picture"], 0]
    assert t["Front picture"]["inputs"]["image"] == "f.png"
    assert (t["Upsample"]["inputs"]["target_resolution"], t["Bake texture"]["inputs"]["texture_size"]) == (1024, 2048)
    assert {t[s]["inputs"]["seed"] for s in ("Sampler: structure", "Sampler: shape", "Sampler: upsample",
                                             "Sampler: texture")} == {7}
    assert res["remove_background"] is True and res["left"] is None

    g, _ = build(MV, {"front": "f", "left": "l", "back": "b", "right": "r", "measure_fov": True,
                      "remove_background": False})
    t = _titled(g)
    ids = {n["_meta"]["title"]: k for k, n in g.items()}
    cond = t["Pixal3D multi-view conditioning"]["inputs"]
    assert cond["fov"] == [ids["Field of view"], 0] and t["MoGe"]["inputs"]["image"] == [ids["Front crop"], 0]
    assert set(cond) == {"clip_vision_model", "fov", *m3.VIEWS}
    # background kept: each crop goes by its own picture's alpha
    assert t["Left crop"]["inputs"]["masks"] == [ids["Left picture"], 1] and "Left cut-out" not in t

    # the shared passes are the single-picture template's own
    single = {n["_meta"]["title"]: n for n in load(m3.TEMPLATE).graph.values()}
    for title in ("Sampler: structure", "Sampler: shape", "Remesh", "Bake normals", "Save 3D"):
        mine = load(MV).graph[load(MV).node_id(title)]["inputs"]
        assert {k: v for k, v in mine.items() if k not in ("positive", "negative")} == \
            {k: v for k, v in single[title]["inputs"].items() if k not in ("positive", "negative")}, title


def test_plan_for_views():
    lk = FakeLookup(get_settings().data_dir)
    rec = {"engine": "pixal3d", "quality": "final", "views": {"front": "f1", "back": "b1"}, "source_id": "f1",
           "measure_fov": True}
    p = plan_generation("model3d", "", {"model3d": rec}, 3, lk)
    assert p.template == MV and set(p.images) == {"front", "back"} and p.images["back"].name == "b1.png"
    assert p.inputs["measure_fov"] is True and "trellis2" not in p.inputs and p.inputs["pad_factor"] == 1.1
    assert p.sources == {"views": {"front": "f1", "back": "b1"}, "engine": "pixal3d", "quality": "final"}


# ---------------------------------------------------------------- four views

def test_four_views_route_and_comfy_run(client, tmp_path):
    front, back, left = _pic(client, "front"), _pic(client, "back", (40, 90, 200)), _pic(client, "left")
    r = client.post("/api/3d/make", json={"views": {"front": front["id"], "back": back["generation_id"],
                                                    "left": left["id"]}, "quality": "draft", "seed": 4})
    assert r.status_code == 202, r.text
    out = r.json()
    assert out["start"] == "views" and out["views_used"] == ["front", "left", "back"]
    assert out["item"]["title"] == "Front · 3D" and out["engine_note"] is None and out["picture"] is None
    rec = _rec(out["item"]["generation_id"])["model3d"]
    assert rec["views"] == {"front": front["generation_id"], "left": left["generation_id"],
                            "back": back["generation_id"]}
    assert rec["view_media"] == {"front": front["id"], "left": left["id"]}
    assert rec["source_id"] == front["generation_id"] and rec["measure_fov"] is True and rec["engine"] == "pixal3d"

    made = []

    async def factory():
        c = GlbClient()
        made.append(c)
        return c

    assert process_one(driver_factory=lambda: ComfyDriver(client_factory=factory, lookup=FakeLookup(tmp_path)))
    with SessionLocal() as db:
        g = db.get(Generation, out["item"]["generation_id"])
        assert g.status == "ready" and g.params["comfy"]["template"] == MV
    cond = next(n for n in made[0].graphs[0].values() if n["class_type"] == "Pixal3DMultiViewConditioning")
    assert set(cond["inputs"]) == {"clip_vision_model", "fov", "front", "left", "back"}
    assert client.get(f"/api/media/{out['item']['id']}").json()["thumb_url"]


def test_four_views_rules(client):
    front, back = _pic(client, "front"), _pic(client, "back")
    post = lambda body: client.post("/api/3d/make", json=body)  # noqa: E731
    r = post({"views": {"front": front["id"], "back": back["id"]}, "engine": "trellis2"})
    assert r.status_code == 422 and "TRELLIS.2 takes one picture" in r.json()["detail"]
    assert "at least one more view" in post({"views": {"front": front["id"]}}).json()["detail"]
    assert "its own picture" in post({"views": {"front": front["id"], "back": front["generation_id"]}}).json()["detail"]
    assert post({"views": {"back": back["id"]}}).status_code == 422  # front is required
    assert post({"views": {"front": front["id"], "back": "nope"}}).status_code == 404
    # one start only, and at least one
    assert post({"source_id": front["id"], "prompt": "a lamp"}).status_code == 422
    assert post({"quality": "draft"}).status_code == 422
    assert post({"prompt": "   "}).status_code == 422

    out = post({"views": {"front": front["id"], "back": back["id"]}, "remove_background": False}).json()
    assert "Not every view" in out["background_note"]
    assert _rec(out["item"]["generation_id"])["model3d"]["remove_background"] is True


def test_options_say_whether_views_work(client):
    v = client.get("/api/3d/options").json()["views"]
    assert v == {"ids": ["front", "left", "back", "right"], "required": ["front"], "min": 2, "engine": "pixal3d",
                 "available": True, "reason": None}
    row = next(m for m in client.get("/api/models?type=model3d").json() if m["id"] == "pixal3d")
    assert "multiview" in row["capabilities"]


# ---------------------------------------------------------------- text

def test_text_start_makes_a_picture_part_then_the_model(client, fast_driver):
    r = client.post("/api/3d/make", json={"prompt": "  A brass oil lamp with a glass chimney. ", "quality": "draft"})
    assert r.status_code == 202, r.text
    out = r.json()
    assert out["start"] == "text" and out["model_resolved"] == "pixal3d"
    assert out["item"]["title"] == "A brass oil lamp with a glass… · 3D"
    pic = out["picture"]
    assert pic["kind"] == "image" and pic["home"] == "3d" and out["picture_job"]["status"] == "queued"
    model_gen = out["item"]["generation_id"]
    with SessionLocal() as db:
        child = db.get(Generation, pic["generation_id"])
        assert child.prompt == ("A brass oil lamp with a glass chimney. Single object, centred, whole object in "
                                "frame, plain light background, soft studio lighting, product photo")
        assert child.params["user_prompt"] == "A brass oil lamp with a glass chimney"
        assert child.params["magic_prompt"] == {"mode": "off", "status": "off"}
        assert child.params["model_resolved"] == mc.default_for("image").id and child.params["width"] == child.params["height"]
        assert "text" in child.params["negative"] and child.params["created_by"]["flow"] == "make_3d:text"
        rec = db.get(Generation, model_gen).params["model3d"]
        assert rec["picture"] == {"generation_id": child.id, "media_id": pic["id"], "status": "pending"}
        assert "source_id" not in rec and rec["start"] == "text" and rec["remove_background"] is True
        # the model's job goes first so it has to wait
        job = db.get(Job, out["job"]["id"])
        job.priority = 5
        db.commit()

    assert process_one(driver_factory=fast_driver)
    with SessionLocal() as db:
        job = db.get(Job, out["job"]["id"])
        assert job.status == "queued" and job.priority < 0 and job.message == "Making the picture first"
        assert job.attempts == 0 and job.result == {"waiting_on": [out["picture_job"]["id"]]}
        assert db.get(Job, out["picture_job"]["id"]).payload["parent_job_id"] == job.id

    _drain(fast_driver)
    with SessionLocal() as db:
        g = db.get(Generation, model_gen)
        assert g.status == "ready" and g.media_type == "model/gltf-binary"
        assert g.params["model3d"]["source_id"] == pic["generation_id"]
        assert g.params["model3d"]["picture"]["status"] == "done"
        assert db.get(Job, out["job"]["id"]).status == "done"
    item = client.get(f"/api/media/{out['item']['id']}").json()
    assert item["status"] == "ready" and item["thumb_url"]
    # the picture is a working part: out of the Library grid, still in the 3D Studio's own list
    assert pic["id"] not in {i["id"] for i in client.get("/api/media").json()["items"]}
    assert pic["id"] in {i["id"] for i in client.get("/api/media", params={"home": "3d"}).json()["items"]}


def test_text_start_magic_prompt_keeps_the_brief(client):
    from app.prompt_enhance import splice

    out = client.post("/api/3d/make", json={"prompt": "a lamp", "magic_prompt": "on"}).json()
    with SessionLocal() as db:
        child = db.get(Generation, out["picture"]["generation_id"])
        assert child.params["magic_prompt"]["status"] == "pending"
        new = splice(child.prompt, child.params["user_prompt"], "An ornate brass oil lamp, engraved.")
    assert new == f"An ornate brass oil lamp, engraved. {m3.OBJECT_BRIEF}"
    out = client.post("/api/3d/make", json={"prompt": "An ornate lamp", "prompt_enhanced": True}).json()
    assert _rec(out["picture"]["generation_id"])["magic_prompt"]["status"] == "client"


def test_text_start_fails_when_its_picture_does(client, fast_driver):
    out = client.post("/api/3d/make", json={"prompt": "a teapot"}).json()
    with SessionLocal() as db:
        child = db.get(Job, out["picture_job"]["id"])
        child.status, child.error = "failed", "out of memory"
        db.get(Generation, out["picture"]["generation_id"]).status = "failed"
        db.commit()
    _drain(fast_driver)
    with SessionLocal() as db:
        job = db.get(Job, out["job"]["id"])
        assert job.status == "failed" and "couldn't be made (out of memory)" in job.error
        assert db.get(Generation, out["item"]["generation_id"]).params["model3d"]["picture"]["status"] == "failed"


def test_text_start_takes_a_brand_kits_look_but_no_logo_pass(client, fast_driver):
    kit = client.post("/api/brand-kits", json={"name": "Brassworks", "palette": [{"hex": "#B08D57"}]})
    assert kit.status_code == 201, kit.text
    out = client.post("/api/3d/make", json={"prompt": "a lamp", "brand_kit_id": kit.json()["id"]}).json()
    with SessionLocal() as db:
        child = db.get(Generation, out["picture"]["generation_id"])
        assert child.params["brand"] == {"kit_id": kit.json()["id"], "auto": False}
    assert client.post("/api/3d/make", json={"prompt": "a lamp", "brand_kit_id": "nope"}).status_code == 404
    assert client.post("/api/3d/make", json={"prompt": "a lamp", "image_model": "trellis2"}).status_code == 422


def test_the_text_steps_picture_counts_against_the_package(client, login):  # noqa: F811
    uid = make_user()
    ben = login({"email": "ben@example.com", "password": PW})
    pid = client.post("/api/admin/packages", json={"name": "3D, no images", "features": {"image": False}}).json()["id"]
    client.post(f"/api/admin/users/{uid}/subscription", json={"package_id": pid})
    r = ben.post("/api/3d/make", json={"prompt": "a lamp"})
    assert r.status_code == 403 and "Image" in r.json()["detail"]

    pid = client.post("/api/admin/packages", json={"name": "Pixal only", "models": ["pixal3d"]}).json()["id"]
    client.post(f"/api/admin/users/{uid}/subscription", json={"package_id": pid})
    r = ben.post("/api/3d/make", json={"prompt": "a lamp"})
    assert r.status_code == 403 and mc.default_for("image").id in r.json()["detail"]
    with SessionLocal() as db:
        # nothing was left half-made
        assert not db.scalars(select(MediaItem).where(MediaItem.kind == "model")).all()

    pid = client.post("/api/admin/packages", json={"name": "Both", "models": ["pixal3d", mc.default_for("image").id]}).json()["id"]
    client.post(f"/api/admin/users/{uid}/subscription", json={"package_id": pid})
    assert ben.post("/api/3d/make", json={"prompt": "a lamp"}).status_code == 202


# ---------------------------------------------------------------- characters

def test_character_with_turnaround_panels_uses_them_as_views(client, fast_driver):
    c = _character(client)
    _panel(c["id"], "portrait")
    front = _panel(c["id"], "sheet_view", "turn_front")
    side = _panel(c["id"], "sheet_view", "turn_side")
    back = _panel(c["id"], "sheet_view", "turn_back")
    _panel(c["id"], "sheet_view", "turn_three_quarter")
    r = client.post("/api/3d/make", json={"character_id": c["id"], "engine": "trellis2", "quality": "draft"})
    assert r.status_code == 202, r.text
    out = r.json()
    assert out["start"] == "character" and out["model_resolved"] == "pixal3d"
    assert out["engine_note"] and "Pixal3D" in out["engine_note"]
    # the side panel is the left view; there's no right panel, so no right view is made up
    assert out["views_used"] == ["front", "left", "back"]
    assert out["item"]["title"] == "Maya · 3D" and out["item"]["home"] is None
    params = _rec(out["item"]["generation_id"])
    assert params["character_id"] == c["id"] and params["model3d"]["character_id"] == c["id"]
    assert params["model3d"]["views"] == {"front": front, "left": side, "back": back}
    assert params["model3d"]["measure_fov"] is False and params["model3d"]["source_media_id"] is None
    _drain(fast_driver)
    item = client.get(f"/api/media/{out['item']['id']}").json()
    assert item["status"] == "ready" and item["thumb_url"]
    assert out["item"]["id"] in {i["id"] for i in client.get("/api/media?kind=model").json()["items"]}


def test_character_without_a_sheet_uses_its_best_picture(client, fast_driver):
    c = _character(client)
    r = client.post("/api/3d/make", json={"character_id": c["id"]})
    assert r.status_code == 422 and "portrait first" in r.json()["detail"]

    portrait = _panel(c["id"], "portrait")
    out = client.post("/api/3d/make", json={"character_id": c["id"], "engine": "trellis2"}).json()
    assert out["views_used"] is None and out["model_resolved"] == "trellis2" and out["engine_note"] is None
    assert _rec(out["item"]["generation_id"])["model3d"]["source_id"] == portrait

    # a front panel alone isn't a turnaround; the full-body hero beats the portrait
    _panel(c["id"], "sheet_view", "turn_front")
    hero = _panel(c["id"], "sheet_view", "hero")
    out = client.post("/api/3d/make", json={"character_id": c["id"]}).json()
    rec = _rec(out["item"]["generation_id"])["model3d"]
    assert out["views_used"] is None and rec["source_id"] == hero and "views" not in rec
    _drain(fast_driver)
    assert client.get(f"/api/media/{out['item']['id']}").json()["status"] == "ready"


def test_another_studios_character_is_not_found(client, login):  # noqa: F811
    c = _character(client)
    _panel(c["id"], "portrait")
    make_user("bea@example.com", "Bea")
    bea = login({"email": "bea@example.com", "password": PW})
    assert bea.post("/api/3d/make", json={"character_id": c["id"]}).status_code == 404
    front, back = _pic(client, "front"), _pic(client, "back")
    assert bea.post("/api/3d/make", json={"views": {"front": front["id"], "back": back["id"]}}).status_code == 404


# ---------------------------------------------------------------- MCP

def test_mcp_make_3d_model_from_each_start(client, anon, fast_driver):
    m = Mcp(anon, _mint(client, ["read", "generate"])["token"])
    out = m.call_json("make_3d_model", prompt="a copper kettle", quality="draft")
    assert out["start"] == "text" and out["picture"]["kind"] == "image" and out["picture"]["job_id"]
    assert len(out["jobs"]) == 1 and out["items"][0]["kind"] == "model"

    front, back = _pic(client, "front"), _pic(client, "back")
    out = m.call_json("make_3d_model", view_ids={"front": front["id"], "back": back["id"]}, engine="pixal3d")
    assert out["start"] == "views" and out["views"] == ["front", "back"]

    c = _character(client)
    _panel(c["id"], "portrait")
    out = m.call_json("make_3d_model", character_id=c["id"])
    assert out["start"] == "character" and out["items"][0]["title"] == "Maya · 3D"

    _drain(fast_driver)
    done = m.call_json("wait_for_job", job_id=out["jobs"][0]["job_id"], timeout_s=5)
    assert done["status"] == "done" and done["media_type"] == "model/gltf-binary"

    bad = m.call("make_3d_model", prompt="a kettle", image_id=front["id"])
    assert bad["isError"] and "exactly one" in json.dumps(bad)
    assert m.call("make_3d_model")["isError"]
    bad = m.call("make_3d_model", view_ids={"front": front["id"]})
    assert bad["isError"] and "one more view" in json.dumps(bad)
