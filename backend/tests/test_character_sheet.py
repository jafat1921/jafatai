"""Character Studio and sheets (M12a, contract v25)."""
import io
import json
import zipfile

import httpx
import pytest
from PIL import Image

from app import character_panels as cp
from app import character_sheet as cs
from app.db import SessionLocal
from app.drivers.comfy import plan_generation
from app.llm import set_transport
from app.models import Character, Generation, Job, Shot
from app.worker import process_one


@pytest.fixture(autouse=True)
def small_boards(monkeypatch):
    # the real boards are 4K; the layout maths is the same at a tenth of the size
    monkeypatch.setattr(cs, "LAYOUTS", {"dossier": (960, 540), "studio": (800, 800)})


def run_all(fast_driver, limit=200):
    for _ in range(limit):
        if not process_one(driver_factory=fast_driver):
            return
    raise AssertionError("the queue never emptied")


def png(colour=(120, 60, 30), size=(64, 64)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, colour).save(buf, "PNG")
    return buf.getvalue()


def studio_character(client, name="Maya", description="a marine biologist in a yellow raincoat"):
    r = client.post("/api/characters", json={"name": name, "description": description})
    assert r.status_code == 201, r.text
    return r.json()


def with_portrait(client, fast_driver, character):
    g = client.post("/api/generations", json={"target_type": "character", "target_id": character["id"],
                                              "kind": "portrait", "prompt": "portrait of a diver"}).json()
    run_all(fast_driver)
    assert client.post(f"/api/generations/{g['id']}/approve").json()["status"] == "approved"
    return g


def panels(client, character):
    return {p["key"]: p for p in client.get(f"/api/characters/{character['id']}/sheet").json()["panels"]}


# ---------------------------------------------------------------- catalogue

def test_panel_sets_per_preset():
    essential = cp.panel_keys("essential")
    assert len(essential) == 10 and essential[0] == "hero"
    assert set(cp.TURNAROUND) <= set(essential) and "closeup" in essential
    full = cp.panel_keys("full")
    assert len(full) == 30 and set(cp.HEAD_GRID) <= set(full) and "motion_walk" in full
    assert not set(cp.HEAD_LEVEL) - set(full) and len(cp.HEAD_GRID) == 15
    named = cp.panel_keys("full", lists={"outfits": ["field ops"], "props": ["a radio", "a torch"],
                                         "accessories": ["watch"] * 9})
    assert len(named) == 30 + 1 + 2 + 6  # accessories cap at six
    # custom counts snap down to what a section allows
    custom = cp.panel_keys("custom", {"turnaround": 4, "head": 9, "gestures": 2, "postures": 7})
    assert custom == ["hero", *cp.TURNAROUND, *cp.HEAD_LEVEL, "gesture_wave", "gesture_point",
                      "posture_relaxed", "posture_tense", "posture_confident"]
    assert cp.estimate(10) == {"panels": 10, "seconds_low": 200, "seconds_high": 400}


def test_panel_sources_and_prompts():
    assert cp.panel("hero").source == "portrait" and cp.panel("turn_back").source == "hero"
    assert cp.panel("expr_angry").source == "portrait" and cp.panel("head_up_l34").lora
    prop = cp.panel("prop_1", {"prop_1": "brass compass"})
    assert prop.source == "none" and "brass compass" in cp.instruction(prop) and "no person" in cp.instruction(prop)
    assert "near-black" in cp.instruction(cp.panel("closeup"), "dark")
    assert "exactly the same" in cp.instruction(cp.panel("turn_side"))
    assert cp.panel("prop_4") is None and cp.panel("nonsense") is None


class Lookup:
    def __init__(self, tmp_path):
        self.tmp = tmp_path

    def generation_file(self, gen_id):
        p = self.tmp / f"{gen_id}.png"
        p.write_bytes(b"png")
        return p

    def character_portrait(self, character_id):
        return "portrait-gen"

    def project_aspect(self, project_id):
        return None


def test_comfy_plans_panels(tmp_path):
    lk = Lookup(tmp_path)
    text = cp.instruction(cp.panel("turn_back"))
    p = plan_generation("sheet_view", text, {"panel": "turn_back", "view": "back", "reference_ids": ["hero-1"],
                                             "angles_lora": 1.0, "width": 768, "height": 1152}, 3, lk)
    assert p.inputs["prompt"] == text and p.sources["reference_ids"] == ["hero-1"]
    assert (p.inputs["width"], p.inputs["height"]) == (768, 1152) and p.loras[0][1] == 1.0
    # props are product shots from text, not edits
    p = plan_generation("sheet_view", "Product photograph of a brass compass", {"panel": "prop_1", "object": True,
                                                                               "width": 1024, "height": 1024}, 3, lk)
    assert "images" not in p.images and p.inputs["prompt"].startswith("Product photograph")


# ---------------------------------------------------------------- making a sheet

def test_essential_sheet_queues_hero_first_then_turnaround(client, fast_driver):
    c = studio_character(client)
    assert client.post(f"/api/characters/{c['id']}/sheet", json={"preset": "essential"}).status_code == 409
    portrait = with_portrait(client, fast_driver, c)

    r = client.post(f"/api/characters/{c['id']}/sheet", json={"preset": "essential", "backdrop": "dark"})
    assert r.status_code == 202, r.text
    sheet = r.json()
    assert sheet["queued"] == 6 and sheet["backdrop"] == "dark"
    state = {p["key"]: p["status"] for p in sheet["panels"]}
    assert state["hero"] == "queued" and state["turn_front"] == "waiting" and state["expr_smile"] == "queued"
    assert sheet["estimate"]["panels"] == 10

    run_all(fast_driver)
    got = panels(client, c)
    assert all(p["status"] == "ready" for p in got.values()), {k: p["status"] for k, p in got.items()}
    with SessionLocal() as db:
        hero = cs.hero(db, c["id"])
        turn = cs.panel_generation(db, c["id"], "turn_front")
        smile = cs.panel_generation(db, c["id"], "expr_smile")
        assert turn.params["reference_ids"] == [hero.id] and turn.params["angles_lora"] == 1.0
        assert smile.params["reference_ids"] == [portrait["id"]] and "near-black" in smile.prompt
        ch = db.get(Character, c["id"])
        assert len(ch.sheet["palette"]) >= 1 and ch.sheet["board"]["media_id"]

    sheet = client.get(f"/api/characters/{c['id']}/sheet").json()
    assert sheet["board"]["status"] == "ready" and sheet["board"]["generation"]["media_type"] == "image/png"
    r = client.get(f"/api/characters/{c['id']}/sheet/board/download")
    assert r.status_code == 200 and r.content[:8] == b"\x89PNG\r\n\x1a\n"
    with Image.open(io.BytesIO(r.content)) as im:
        assert im.size == (960, 540)
    r = client.get(f"/api/characters/{c['id']}/sheet/board/download?format=pdf")
    assert r.status_code == 200 and r.content.startswith(b"%PDF")
    # it's a Library image too
    media = client.get(f"/api/media/{sheet['board']['media_id']}")
    assert media.status_code == 200 and "character sheet" in media.json()["tags"]
    # ...a Character Studio part (contract v37): out of Create Image, still offered as a reference
    assert media.json()["home"] == "character"
    listed = lambda **q: {i["id"] for i in client.get("/api/media", params={"kind": "image", **q}).json()["items"]}  # noqa: E731
    assert sheet["board"]["media_id"] not in listed(origin="generated")
    assert sheet["board"]["media_id"] in listed(include="project", include_home="character")


def test_single_panel_regenerate_and_per_panel_approval(client, fast_driver):
    c = studio_character(client)
    with_portrait(client, fast_driver, c)
    client.post(f"/api/characters/{c['id']}/sheet", json={"preset": "essential"})
    run_all(fast_driver)
    before = panels(client, c)
    smile, serious = before["expr_smile"]["current"], before["expr_serious"]["current"]
    assert client.post(f"/api/generations/{smile['id']}/approve").json()["status"] == "approved"
    assert client.post(f"/api/generations/{serious['id']}/approve").json()["status"] == "approved"

    r = client.post(f"/api/characters/{c['id']}/sheet/panels/expr_smile/regenerate", json={"note": "bigger grin"})
    assert r.status_code == 201, r.text
    again = r.json()
    assert again["parent_id"] == smile["id"] and again["params"]["panel"] == "expr_smile"
    assert again["prompt"].endswith("bigger grin")
    run_all(fast_driver)
    assert client.post(f"/api/generations/{again['id']}/approve").json()["status"] == "approved"

    after = panels(client, c)
    assert after["expr_smile"]["current"]["id"] == again["id"] and after["expr_smile"]["versions"] == 2
    # one approved per panel: the other expression keeps its approval
    assert after["expr_serious"]["current"]["id"] == serious["id"]
    assert after["expr_serious"]["current"]["status"] == "approved"
    assert client.post(f"/api/characters/{c['id']}/sheet/panels/nope/regenerate").status_code == 404


def test_custom_sheet_with_props_and_text(client, fast_driver):
    c = studio_character(client)
    with_portrait(client, fast_driver, c)
    r = client.post(f"/api/characters/{c['id']}/sheet", json={
        "preset": "custom", "counts": {"expressions": 4, "gestures": 1},
        "lists": {"props": ["brass compass"], "accessories": ["dive watch", ""]}})
    assert r.status_code == 202, r.text
    keys = [p["key"] for p in r.json()["panels"]]
    assert keys == ["hero", *cp.EXPRESSIONS_4, "gesture_wave", "prop_1", "accessory_1"]
    run_all(fast_driver)
    with SessionLocal() as db:
        prop = cs.panel_generation(db, c["id"], "prop_1")
        assert prop.params["object"] and "reference_ids" not in prop.params and "brass compass" in prop.prompt

    r = client.patch(f"/api/characters/{c['id']}/sheet", json={
        "titles": {"expressions": "تاثرات", "bogus": "x"}, "labels": {"expr_smile": "مسکراہٹ"},
        "footer": {"team": "Reef Unit", "number": "Character sheet 01"}, "ruler": True})
    assert r.status_code == 200, r.text
    sheet = r.json()
    assert sheet["titles"] == {"expressions": "تاثرات"} and sheet["footer"]["team"] == "Reef Unit"
    p = next(x for x in sheet["panels"] if x["key"] == "expr_smile")
    assert p["label"] == "مسکراہٹ" and p["section_title"] == "تاثرات" and p["default_label"] == "Smile"
    run_all(fast_driver)
    assert client.get(f"/api/characters/{c['id']}/sheet").json()["board"]["status"] == "ready"


def test_board_composes_with_an_urdu_name(tmp_path):
    files = []
    for i, colour in enumerate([(200, 40, 40), (40, 40, 200), (40, 160, 60)]):
        p = tmp_path / f"p{i}.png"
        p.write_bytes(png(colour, (96, 128)))
        files.append(p)
    sections = [("turnaround", "Turnaround", [("Front", files[0]), ("Side", files[1])]),
                ("head", "زاویے", [(f"سر {i}", files[2]) for i in range(15)]),
                ("props", "Props", [("Compass", files[1])])]
    profile = {"role": "سمندری حیاتیات کی ماہر", "height": "172 cm", "age": "34", "languages": "اردو، انگریزی"}
    for layout, size in (("dossier", (960, 540)), ("studio", (800, 800))):
        img = cs.compose_board("مایا خان", profile, ["#c8a040", "#203050"], files[0], sections, layout,
                               footer={"team": "Reef Unit", "number": "01"}, ruler=True)
        assert img.size == size
        # something was drawn beyond the background
        assert len(img.resize((64, 64)).getcolors(4096) or []) > 10
    assert cs.height_cm("172 cm") == 172 and cs.height_cm("1.8 m") == 180 and round(cs.height_cm("5'10\"")) == 178
    assert cs.height_cm("tall") is None


def test_palette_leaves_out_the_backdrop(tmp_path):
    im = Image.new("RGB", (200, 300), (128, 128, 128))
    im.paste((200, 30, 30), (50, 50, 150, 150))
    im.paste((20, 40, 160), (50, 160, 150, 260))
    path = tmp_path / "hero.png"
    im.save(path)
    colours = cs.palette_of(path)
    assert colours and all(c.startswith("#") and len(c) == 7 for c in colours)
    rgbs = [cs._rgb(c) for c in colours]
    assert not any(abs(r - 128) < 20 and abs(g - 128) < 20 and abs(b - 128) < 20 for r, g, b in rgbs)
    assert any(r > 150 and g < 80 for r, g, b in rgbs) and any(b > 120 and r < 80 for r, g, b in rgbs)


# ---------------------------------------------------------------- shots

def test_pick_for_shot():
    assert cp.pick_for_shot("Maya walks along the pier", "wide", {})[0] == "motion_walk"
    assert cp.pick_for_shot("She stands on the pier", "medium", {"size": "ls"})[0] == "turn_front"
    assert cp.pick_for_shot("seen from behind as she leaves", "wide", {})[0] == "turn_back"
    assert cp.pick_for_shot("she smiles at him", "close_up", {})[:2] == ["expr_smile", "closeup"]
    assert cp.pick_for_shot("he is furious", "medium", {})[:2] == ["expr_angry", "portrait"]
    assert cp.pick_for_shot("talking", "over_shoulder", {})[0] == "head_level_lprofile"
    assert cp.pick_for_shot("talking", "medium", {"angle": "ots"})[0] == "head_level_lprofile"
    assert cp.pick_for_shot("looks at the sea", "close_up", {}) == ["closeup", "portrait"]
    assert cp.pick_for_shot("looks at the sea", "medium", {}) == ["portrait"]
    # "smiles" in a wide shot doesn't pick a face panel: the face is too small to read
    assert cp.pick_for_shot("she smiles", "wide", {})[0] == "turn_front"


def test_references_follow_the_shot_and_the_users_pick(client, project, fast_driver):
    c = studio_character(client)
    portrait = with_portrait(client, fast_driver, c)
    assert client.post(f"/api/projects/{project['id']}/cast", json={"character_id": c["id"]}).status_code == 201
    scene = client.post(f"/api/projects/{project['id']}/scenes", json={}).json()
    shot = client.post(f"/api/scenes/{scene['id']}/shots", json={
        "shot_type": "wide", "description": "Maya on the pier", "character_ids": [c["id"]]}).json()
    refs = client.get(f"/api/shots/{shot['id']}/refs").json()["refs"]
    # no sheet yet: the approved portrait
    assert refs[0]["panel"] == "portrait" and refs[0]["generation"]["id"] == portrait["id"] and refs[0]["used"]

    client.post(f"/api/characters/{c['id']}/sheet", json={"preset": "essential"})
    run_all(fast_driver)
    got = panels(client, c)
    refs = client.get(f"/api/shots/{shot['id']}/refs").json()["refs"]
    assert refs[0]["panel"] == "turn_front" and refs[0]["auto"]
    assert refs[0]["generation"]["id"] == got["turn_front"]["current"]["id"]
    assert {o["key"] for o in refs[0]["options"]} >= {"portrait", "turn_back", "expr_smile"}

    client.patch(f"/api/shots/{shot['id']}", json={"shot_type": "close_up", "description": "Maya smiles"})
    with SessionLocal() as db:
        from app import storyboard as sb

        ids, labels = sb.references_for(db, db.get(Shot, shot["id"]))
        assert ids == [got["expr_smile"]["current"]["id"]] and labels == ["Maya"]

    r = client.patch(f"/api/shots/{shot['id']}", json={"ref_panels": {c["id"]: "turn_back"}})
    assert r.json()["ref_panels"] == {c["id"]: "turn_back"}
    refs = client.get(f"/api/shots/{shot['id']}/refs").json()["refs"]
    assert refs[0]["panel"] == "turn_back" and not refs[0]["auto"]
    r = client.patch(f"/api/shots/{shot['id']}", json={"ref_panels": {c["id"]: "auto"}})
    assert r.json()["ref_panels"] == {}


# ---------------------------------------------------------------- the studio and films

def test_cast_union_link_unlink_and_delete(client, project, fast_driver):
    own = client.post(f"/api/projects/{project['id']}/characters", json={"name": "Diver"}).json()
    studio = studio_character(client)
    assert studio["studio"] and studio["project_id"] is None

    names = lambda: [x["name"] for x in client.get(f"/api/projects/{project['id']}/characters").json()]  # noqa: E731
    assert names() == ["Diver"]
    assert client.post(f"/api/projects/{project['id']}/cast", json={"character_id": studio["id"]}).status_code == 201
    assert names() == ["Diver", "Maya"]
    assert client.get(f"/api/projects/{project['id']}").json()["counts"]["characters"] == 2
    # a film's own character can't be linked into another film
    other = client.post("/api/projects", json={"title": "Two", "authoring_mode": "scene_by_scene"}).json()
    assert client.post(f"/api/projects/{other['id']}/cast", json={"character_id": own["id"]}).status_code == 409
    client.post(f"/api/projects/{other['id']}/cast", json={"character_id": studio["id"]})

    scene = client.post(f"/api/projects/{project['id']}/scenes", json={}).json()
    shot = client.post(f"/api/scenes/{scene['id']}/shots",
                       json={"character_ids": [studio["id"], own["id"]]}).json()
    assert shot["character_ids"] == [studio["id"], own["id"]]

    films = client.get(f"/api/characters/{studio['id']}").json()["films"]
    assert sorted(f["title"] for f in films) == ["Reef", "Two"]

    # deleting from a film only unlinks, and takes it off that film's shots
    assert client.delete(f"/api/characters/{studio['id']}?project_id={project['id']}").status_code == 204
    assert names() == ["Diver"]
    assert client.get(f"/api/shots/{shot['id']}").json()["character_ids"] == [own["id"]]
    assert client.get(f"/api/characters/{studio['id']}").status_code == 200

    # Save to Character Studio: still in this film, now shareable
    saved = client.post(f"/api/characters/{own['id']}/save-to-studio").json()
    assert saved["studio"] and [f["title"] for f in saved["films"]] == ["Reef"]
    assert names() == ["Diver"]
    assert {x["name"] for x in client.get("/api/characters").json()} == {"Diver", "Maya"}
    assert [x["name"] for x in client.get("/api/characters?q=div").json()] == ["Diver"]

    # deleting in the studio removes it everywhere
    assert client.delete(f"/api/characters/{studio['id']}").status_code == 204
    assert client.get(f"/api/projects/{other['id']}/characters").json() == []
    assert client.get(f"/api/characters/{studio['id']}").status_code == 404


def test_profile_patch_and_voice(client):
    c = studio_character(client)
    r = client.patch(f"/api/characters/{c['id']}", json={"profile": {"role": "Biologist", "height": "172 cm"}})
    assert r.json()["profile"] == {"role": "Biologist", "height": "172 cm"}
    r = client.patch(f"/api/characters/{c['id']}", json={"profile": {"role": "", "age": "34"}})
    assert r.json()["profile"] == {"height": "172 cm", "age": "34"}
    assert client.patch(f"/api/characters/{c['id']}", json={"profile": {"shoe": "9"}}).status_code == 422
    assert client.patch(f"/api/characters/{c['id']}", json={"voice_id": "nope"}).status_code == 422


def test_ai_profile_fills_only_empty_fields(client, fast_driver):
    answer = {"role": "Marine biologist", "nationality": "Pakistani", "height": "170 cm", "age": "34",
              "personality": "curious, stubborn", "props": ["dive slate"], "accessories": ["dive watch"],
              "details": ["raincoat toggles"]}
    seen = []

    def reply(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content))
        msg = {"role": "assistant", "content": json.dumps(answer)}
        return httpx.Response(200, json={"choices": [{"message": msg, "finish_reason": "stop"}],
                                         "usage": {"prompt_tokens": 5, "completion_tokens": 7}})

    set_transport(httpx.MockTransport(reply))
    try:
        c = studio_character(client)
        client.patch(f"/api/characters/{c['id']}", json={"profile": {"role": "Diver"}})
        job = client.post(f"/api/characters/{c['id']}/ai/profile").json()
        for _ in range(10):
            process_one(driver_factory=fast_driver)
            with SessionLocal() as db:
                if db.get(Job, job["id"]).status in ("done", "failed"):
                    break
        with SessionLocal() as db:
            done = db.get(Job, job["id"])
            assert done.status == "done", done.error
    finally:
        set_transport(None)
    got = client.get(f"/api/characters/{c['id']}").json()["profile"]
    assert got["role"] == "Diver" and got["nationality"] == "Pakistani" and got["height"] == "170 cm"
    assert "yellow raincoat" in seen[0]["messages"][1]["content"]
    lists = client.get(f"/api/characters/{c['id']}/sheet").json()["lists"]
    assert lists["props"] == ["dive slate"] and lists["accessories"] == ["dive watch"]


def test_create_from_photo_needs_consent(client):
    up = client.post("/api/media/upload", files={"file": ("me.png", png((180, 140, 120), (320, 400)), "image/png")})
    assert up.status_code == 201, up.text
    item = up.json()
    body = {"name": "Me", "media_id": item["id"], "consent": {"name": "Haris", "statement": "sure"}}
    r = client.post("/api/characters/from-photo", json=body)
    assert r.status_code == 422 and "consent statement" in r.text
    from app.api.characters import PHOTO_CONSENT

    body["consent"]["statement"] = PHOTO_CONSENT
    r = client.post("/api/characters/from-photo", json=body)
    assert r.status_code == 201, r.text
    c = r.json()
    assert c["studio"]
    with SessionLocal() as db:
        ch = db.get(Character, c["id"])
        assert ch.sheet["photo"]["consent"]["name"] == "Haris" and ch.sheet["photo"]["media_id"] == item["id"]
        g = db.query(Generation).filter_by(target_id=c["id"], kind="portrait").one()
        assert g.params["reference_ids"] == [item["generation_id"]] and g.status == "queued"
        assert "Picture 1 is a photo" in g.prompt


def test_pack_round_trip(client, fast_driver):
    c = studio_character(client, name="مایا", description="a diver")
    with_portrait(client, fast_driver, c)
    client.patch(f"/api/characters/{c['id']}", json={"profile": {"role": "Diver", "age": "34"},
                                                      "voice_id": "gallery:ur-lahore-narrator"})
    client.post(f"/api/characters/{c['id']}/sheet", json={"preset": "essential"})
    run_all(fast_driver)
    smile = panels(client, c)["expr_smile"]["current"]
    client.post(f"/api/generations/{smile['id']}/approve")
    run_all(fast_driver)

    r = client.get(f"/api/characters/{c['id']}/pack")
    assert r.status_code == 200 and r.headers["content-type"] == "application/zip"
    z = zipfile.ZipFile(io.BytesIO(r.content))
    meta = json.loads(z.read("character.json"))
    assert meta["name"] == "مایا" and meta["profile"]["role"] == "Diver" and len(meta["panels"]) == 10
    assert "portrait.png" in z.namelist() and "board.png" in z.namelist()

    r = client.post("/api/characters/import", files={"file": ("maya.mixchar.zip", r.content, "application/zip")})
    assert r.status_code == 201, r.text
    copy = r.json()
    assert copy["id"] != c["id"] and copy["name"] == "مایا" and copy["studio"] and copy["approved_portrait"]
    assert copy["profile"] == {"role": "Diver", "age": "34"} and copy["panels_ready"] == 10
    assert copy["voice_id"] == "gallery:ur-lahore-narrator" and meta["voice"] == {"gallery": "ur-lahore-narrator"}
    imported = panels(client, copy)
    assert imported["expr_smile"]["current"]["status"] == "approved"
    assert imported["turn_front"]["current"]["status"] == "ready"
    run_all(fast_driver)  # the board is redrawn rather than copied
    assert client.get(f"/api/characters/{copy['id']}/sheet").json()["board"]["status"] == "ready"

    bad = io.BytesIO()
    with zipfile.ZipFile(bad, "w") as zz:
        zz.writestr("readme.txt", "hello")
    r = client.post("/api/characters/import", files={"file": ("x.zip", bad.getvalue(), "application/zip")})
    assert r.status_code == 422
    r = client.post("/api/characters/import", files={"file": ("x.png", png(), "image/png")})
    assert r.status_code == 415


def test_podcast_picker_lists_studio_characters(client, db):
    c = studio_character(client)
    from app.podcast import video as vd

    class VP:
        workspace_id = db.get(Character, c["id"]).workspace_id
        project_id = "some-other-project"

    found = vd.other_characters(db, VP())
    assert [x["name"] for x in found] == ["Maya"] and found[0]["studio"] and found[0]["project_id"] is None


# ---------------------------------------------------------------- own images

def upload(client, data, name="mine.png"):
    r = client.post("/api/media/upload", files={"file": (name, data, "image/png")})
    assert r.status_code == 201, r.text
    return r.json()


def consent():
    from app.api.characters import PHOTO_CONSENT

    return {"name": "Haris", "statement": PHOTO_CONSENT}


def pixels(gen_id):
    with SessionLocal() as db:
        from app.services import generation_file

        with Image.open(generation_file(db.get(Generation, gen_id))) as im:
            return im.size, im.convert("RGB").getcolors(4096)


def sheet_image() -> bytes:
    # red left third, a blue block at (120, 40) 60x80, green everywhere else
    im = Image.new("RGB", (300, 200), (0, 160, 0))
    im.paste((200, 0, 0), (0, 0, 100, 200))
    im.paste((0, 0, 220), (120, 40, 180, 120))
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return buf.getvalue()


def own_sheet(client, c):
    item = upload(client, sheet_image(), "sheet.png")
    r = client.post(f"/api/characters/{c['id']}/sheet/upload", json={"media_id": item["id"]})
    assert r.status_code == 200, r.text
    return item, r.json()


def test_portrait_as_is_is_approved_and_used(client, project, fast_driver):
    item = upload(client, png((180, 140, 120), (320, 400)))
    body = {"name": "Me", "media_id": item["id"], "consent": consent(), "use": "as_is"}
    r = client.post("/api/characters/from-photo", json=body)
    assert r.status_code == 201, r.text
    c = r.json()
    g = c["approved_portrait"]
    assert g["params"]["source"] == "upload" and g["params"]["from_photo"] == item["id"]
    assert g["params"]["consent"]["name"] == "Haris"
    assert pixels(g["id"]) == ((320, 400), [(320 * 400, (180, 140, 120))])
    with SessionLocal() as db:
        assert not db.query(Job).filter(Job.generation_id == g["id"]).count()  # nothing was queued
        assert db.get(Character, c["id"]).sheet["photo"]["use"] == "as_is"

    assert client.post(f"/api/projects/{project['id']}/cast", json={"character_id": c["id"]}).status_code == 201
    scene = client.post(f"/api/projects/{project['id']}/scenes", json={}).json()
    shot = client.post(f"/api/scenes/{scene['id']}/shots", json={"description": "Me", "character_ids": [c["id"]]}).json()
    with SessionLocal() as db:
        from app import storyboard as sb

        assert sb.references_for(db, db.get(Shot, shot["id"]))[0] == [g["id"]]

    # a second picture from the Portrait tab waits for the user's approval; there's one approved already
    other = upload(client, png((10, 20, 30)))
    url = f"/api/characters/{c['id']}/portrait/upload"
    assert client.post(url, json={"media_id": other["id"], "consent": {"name": "Haris", "statement": "ok"}}).status_code == 422
    r = client.post(url, json={"media_id": other["id"]})
    assert r.status_code == 201 and r.json()["status"] == "ready" and r.json()["version"] == 2
    # an upload has no prompt to redo
    r = client.post(f"/api/generations/{g['id']}/regenerate", json={"mode": "same"})
    assert r.status_code == 422 and "nothing to regenerate" in r.text

    # a character with no approved portrait gets the upload approved straight away
    fresh = studio_character(client, name="Fresh")
    r = client.post(f"/api/characters/{fresh['id']}/portrait/upload", json={"media_id": other["id"], "consent": consent()})
    assert r.json()["status"] == "approved" and r.json()["params"]["consent"]["statement"]
    assert client.get(f"/api/characters/{fresh['id']}").json()["approved_portrait"]["id"] == r.json()["id"]


def test_own_sheet_stays_the_board_until_a_new_layout(client, fast_driver):
    c = studio_character(client)
    with_portrait(client, fast_driver, c)
    client.post(f"/api/characters/{c['id']}/sheet", json={"preset": "essential"})
    run_all(fast_driver)
    made = client.get(f"/api/characters/{c['id']}/sheet").json()["board"]
    assert made["status"] == "ready" and not made["uploaded"]

    item, sheet = own_sheet(client, c)
    assert sheet["board"]["uploaded"] and sheet["board"]["media_id"] == item["id"]
    assert sheet["board"]["status"] == "ready" and sheet["own_sheet"]["media_id"] == item["id"]
    assert (sheet["own_sheet"]["width"], sheet["own_sheet"]["height"]) == (300, 200)
    assert client.get(f"/api/characters/{c['id']}").json()["board_thumb_url"]

    # approving a panel or changing the board text would recompose; the uploaded board is left alone
    smile = panels(client, c)["expr_smile"]["current"]
    client.post(f"/api/generations/{smile['id']}/approve")
    client.patch(f"/api/characters/{c['id']}/sheet", json={"titles": {"hero": "Hero"}})
    run_all(fast_driver)
    board = client.get(f"/api/characters/{c['id']}/sheet").json()["board"]
    assert board["uploaded"] and board["media_id"] == item["id"]
    r = client.get(f"/api/characters/{c['id']}/sheet/board/download")
    assert r.status_code == 200 and r.content == sheet_image()

    # "Lay out a new board from panels" goes back to the board item the recomposes live on
    assert client.post(f"/api/characters/{c['id']}/sheet/board", json={"layout": "studio"}).status_code == 202
    run_all(fast_driver)
    sheet = client.get(f"/api/characters/{c['id']}/sheet").json()
    assert not sheet["board"]["uploaded"] and sheet["board"]["media_id"] == made["media_id"]
    assert sheet["board"]["status"] == "ready" and sheet["board"]["layout"] == "studio"
    assert sheet["own_sheet"]["media_id"] == item["id"]  # still there to cut panels from


def test_crops_are_cut_from_the_original(client, project, fast_driver):
    c = studio_character(client)
    url = f"/api/characters/{c['id']}/sheet/crops"
    assert client.post(url, json={"crops": [{"panel": "turn_front", "x": 0, "y": 0, "w": 50, "h": 50}]}).status_code == 409
    own_sheet(client, c)

    bad = [
        {"panel": "turn_front", "x": 260, "y": 0, "w": 60, "h": 80},  # off the right edge
        {"panel": "turn_front", "x": 0, "y": 0, "w": 10, "h": 80},  # too small
        {"panel": "nope", "x": 0, "y": 0, "w": 60, "h": 80},
        {"panel": "turn_front", "x": -1, "y": 0, "w": 60, "h": 80},
    ]
    for box in bad:
        ok_box = {"panel": "closeup", "x": 0, "y": 0, "w": 40, "h": 40}
        r = client.post(url, json={"crops": [ok_box, box]})
        assert r.status_code == 422, box
    assert client.post(url, json={"crops": []}).status_code == 422
    assert panels(client, c) == {}  # a bad box saves nothing, not even the good one before it

    r = client.post(url, json={"crops": [{"panel": "turn_front", "x": 120, "y": 40, "w": 60, "h": 80},
                                         {"panel": "portrait", "x": 0, "y": 0, "w": 100, "h": 200}]})
    assert r.status_code == 200, r.text
    assert r.json()["saved"] == 2
    front = panels(client, c)["turn_front"]
    g = front["current"]
    assert front["status"] == "approved" and not front["stale"]
    assert g["params"]["source"] == "upload" and g["params"]["crop"] == [120, 40, 60, 80]
    assert pixels(g["id"]) == ((60, 80), [(60 * 80, (0, 0, 220))])
    portrait = client.get(f"/api/characters/{c['id']}").json()["approved_portrait"]
    assert pixels(portrait["id"]) == ((100, 200), [(100 * 200, (200, 0, 0))])

    # crops are references like generated panels: a wide shot takes the turnaround front
    client.post(f"/api/projects/{project['id']}/cast", json={"character_id": c["id"]})
    scene = client.post(f"/api/projects/{project['id']}/scenes", json={}).json()
    shot = client.post(f"/api/scenes/{scene['id']}/shots", json={
        "shot_type": "wide", "description": "Maya on the pier", "character_ids": [c["id"]]}).json()
    refs = client.get(f"/api/shots/{shot['id']}/refs").json()["refs"]
    assert refs[0]["panel"] == "turn_front" and refs[0]["generation"]["id"] == g["id"]


def test_upload_a_single_panel(client, fast_driver):
    c = studio_character(client)
    first, second = upload(client, png((1, 2, 3))), upload(client, png((40, 50, 60), (90, 120)))
    url = f"/api/characters/{c['id']}/sheet/panels/closeup/upload"
    a = client.post(url, json={"media_id": first["id"]}).json()
    b = client.post(url, json={"media_id": second["id"]}).json()
    assert a["status"] == "approved" and b["status"] == "approved" and b["params"]["panel"] == "closeup"
    got = panels(client, c)["closeup"]
    assert got["current"]["id"] == b["id"] and got["versions"] == 2
    assert pixels(b["id"]) == ((90, 120), [(90 * 120, (40, 50, 60))])
    with SessionLocal() as db:
        assert db.get(Generation, a["id"]).status == "ready"  # one approved per panel
    assert client.post(f"/api/characters/{c['id']}/sheet/panels/nope/upload",
                       json={"media_id": first["id"]}).status_code == 404
    assert client.post(url, json={"media_id": "missing"}).status_code == 404
    # regenerating an uploaded panel draws it fresh, which needs a portrait
    assert client.post(f"/api/generations/{b['id']}/regenerate", json={"mode": "same"}).status_code == 409


def test_pack_round_trip_keeps_an_uploaded_board(client, fast_driver):
    c = studio_character(client)
    own_sheet(client, c)
    client.post(f"/api/characters/{c['id']}/sheet/crops", json={"crops": [
        {"panel": "portrait", "x": 0, "y": 0, "w": 100, "h": 200},
        {"panel": "expr_smile", "x": 120, "y": 40, "w": 60, "h": 80}]})

    r = client.get(f"/api/characters/{c['id']}/pack")
    z = zipfile.ZipFile(io.BytesIO(r.content))
    meta = json.loads(z.read("character.json"))
    assert meta["board_uploaded"] and meta["portrait"]["source"] == "upload"
    assert [p["source"] for p in meta["panels"]] == ["upload"]

    r = client.post("/api/characters/import", files={"file": ("maya.mixchar.zip", r.content, "application/zip")})
    assert r.status_code == 201, r.text
    copy = r.json()
    run_all(fast_driver)
    sheet = client.get(f"/api/characters/{copy['id']}/sheet").json()
    assert sheet["board"]["uploaded"] and sheet["board"]["status"] == "ready"
    assert sheet["own_sheet"]["media_id"] == sheet["board"]["media_id"]
    with SessionLocal() as db:
        assert not db.query(Job).filter(Job.type == cs.BOARD_JOB).count()  # nothing redrew it
    smile = panels(client, copy)["expr_smile"]["current"]
    assert smile["status"] == "approved" and smile["params"]["source"] == "upload"
    assert pixels(smile["id"]) == ((60, 80), [(60 * 80, (0, 0, 220))])
    r = client.get(f"/api/characters/{copy['id']}/sheet/board/download")
    with Image.open(io.BytesIO(r.content)) as im:
        assert im.size == (300, 200) and im.convert("RGB").getpixel((150, 80)) == (0, 0, 220)
