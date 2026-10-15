"""Brand templates (contract v35): kit-filled logo slots, the dark-surface rule, and the scene -> logo chain."""
import json
import re
from pathlib import Path

import pytest

from app import brand_templates as bt
from app.api import library as lib_api
from app.db import SessionLocal
from app.library import ASPECTS
from app.models import Generation, Job, MediaItem
from tests.test_brand import asset, png, run_jobs

DIR = Path(lib_api.TEMPLATE_DIR)
SLOT = re.compile(r"\[([^\[\]]{1,60})\]")
KNOWN = {"brand", "logo", "logo_colours", "colours", "palette", "tagline", "tagline_clause", "product_clause"}
CAT = "Brand & marketing"


def _cards():
    data = json.loads((DIR / "image.json").read_text(encoding="utf-8"))
    return [t for t in data["templates"] if t.get("target") == "image-brand"]


def _kit(client, light=False, **extra):
    logos = {"primary": {"media_id": asset(client, "logo", "logo.png", png(colour=(34, 34, 59, 255))).json()["item"]["id"],
                         "description": "a bold X in a circle"}}
    if light:
        logos["light"] = {"media_id": asset(client, "logo", "light.png", png()).json()["item"]["id"], "description": ""}
    body = {"name": "iXperts", "tagline": "Clean done right",
            "palette": [{"hex": "#22223B", "name": "navy"}, {"hex": "#E48C84", "name": "coral"}], "logos": logos, **extra}
    r = client.post("/api/brand-kits", json=body)
    assert r.status_code == 201, r.text
    return r.json()


def _photo(client):
    return client.post("/api/media/upload", files={"file": ("van.png", png((320, 240), (240, 240, 240, 255), "RGB"),
                                                            "image/png")}).json()


def _logo_gen(kit, variant):
    with SessionLocal() as db:
        return db.get(MediaItem, kit["logos"][variant]["media_id"]).generation_id


def _gen(gid) -> Generation:
    with SessionLocal() as db:
        return db.get(Generation, gid)


def test_brand_cards_are_sound():
    rows = _cards()
    assert len(rows) >= 16 and all(t["category"] == CAT for t in rows)
    titles = {t["title"] for t in rows}
    assert {"Vehicle wrap", "Uniform embroidery", "Product label", "Before & after", "Website hero banner"} <= titles
    for t in rows:
        assert t["id"].startswith("image-brand-") and t["brand_refs"][0] == "logo" and t["surface"] in bt.SURFACES
        scene, instr = t["scene"]["prompt_scaffold"], t["defaults"]["instruction_scaffold"]
        assert t["scene"]["aspect"] in ASPECTS and t["defaults"]["model"] == "qwen_image_edit_2511"
        assert "picture 1" in instr and "{logo}" in instr and "{logo_colours}" in instr
        assert "exactly the same" in instr, t["id"]
        # the scene leaves the surface blank on purpose, so the logo edit has somewhere to go
        assert re.search(r"\b(no logo|blank|empty)\b", scene), t["id"]
        for text in (scene, instr, t["preview_prompt"]):
            assert set(bt.TOKEN.findall(text)) <= KNOWN, t["id"]
            assert not set(SLOT.findall(text)) - set(t["examples"]), t["id"]
        slots = set(SLOT.findall(scene)) | set(SLOT.findall(instr))
        for o in t.get("options", []):
            assert o["slot"] in slots and len(o["choices"]) >= 2
            assert all(c.get("surface") in (None, *bt.SURFACES) and "[" not in c["value"] for c in o["choices"])
    uniform = next(t for t in rows if t["id"] == "image-brand-uniform")
    assert uniform["surface"] == "dark" and uniform["light_ink"] == "white thread"
    assert "No patch" in uniform["defaults"]["instruction_scaffold"]
    assert next(t for t in rows if t["id"] == "image-brand-product-label")["brand_refs"] == ["logo", "product"]
    # text-heavy cards make their scene on Qwen-Image 2512
    assert next(t for t in rows if t["id"] == "image-brand-flyer")["scene"]["model"] == "qwen_image_2512"


def test_gallery_filter_and_start(client):
    rows = client.get("/api/prompt-templates", params={"type": "image", "category": CAT}).json()
    assert len(rows) == len(_cards()) and {t["category"] for t in rows} == {CAT}
    assert all(t["target"] == "image-brand" and t["brand_refs"] and t["scene"] for t in rows)
    everything = client.get("/api/prompt-templates", params={"type": "image"}).json()
    assert CAT in {t["category"] for t in everything} and len(everything) > len(rows)

    r = client.post("/api/prompt-templates/image-brand-uniform/start").json()
    assert r["target"] == "image-brand"
    p = r["prefill"]
    assert p["brand_refs"] == ["logo"] and p["surface"] == "dark" and p["ref_labels"] == ["Garment or person"]
    assert "{logo}" in p["instruction"] and "[garment]" in p["scene_prompt"]
    assert set(p["placeholders"]) == {"garment", "fabric", "spot"}


def test_photo_mode_fills_logo_from_default_kit(client):
    kit = _kit(client, light=True)
    photo = _photo(client)
    body = {"template_id": "image-brand-uniform", "mode": "photo", "source_id": photo["id"],
            "instruction": "Embroider {logo} from picture 2 on the left chest of the polo shirt in picture 1. "
                           "{logo_colours} Keep everything else the same."}
    r = client.post("/api/images/brand", json=body)
    assert r.status_code == 202, r.text
    out = r.json()
    assert out["brand_template"]["kit_name"] == "iXperts" and out["brand_template"]["logo_variant"] == "light"
    g = _gen(out["items"][0]["generation_id"])
    # the user added one photo; the light logo (dark fabric) rode along as picture 2
    assert g.params["reference_ids"] == [photo["generation_id"], _logo_gen(kit, "light")]
    assert "the iXperts logo" in g.params["instruction"] and "light version of the logo" in g.params["instruction"]
    assert "{" not in g.params["instruction"] and g.params["brand"] == {"kit_id": kit["id"]}

    # light fabric: the ordinary logo, no re-inking
    body["surface"] = "light"
    g = _gen(client.post("/api/images/brand", json=body).json()["items"][0]["generation_id"])
    assert g.params["reference_ids"][1] == _logo_gen(kit, "primary")
    assert "exact letters, shapes and colours" in g.params["instruction"]


def test_dark_surface_without_light_logo_asks_for_light_thread(client):
    kit = _kit(client)
    photo = _photo(client)
    r = client.post("/api/images/brand", json={"template_id": "image-brand-uniform", "source_id": photo["id"],
                                               "instruction": "Stitch {logo} on picture 1. {logo_colours}"})
    assert r.status_code == 202, r.text
    g = _gen(r.json()["items"][0]["generation_id"])
    text = g.params["instruction"]
    assert g.params["reference_ids"][1] == _logo_gen(kit, "primary")
    assert "white thread" in text and "coral #E48C84" in text and "navy #22223B" not in text
    assert "(a bold X in a circle)" in text


def test_instruction_and_scene_carry_palette_and_tagline(client):
    _kit(client)
    photo = _photo(client)
    r = client.post("/api/images/brand", json={"template_id": "image-brand-billboard", "source_id": photo["id"]})
    g = _gen(r.json()["items"][0]["generation_id"])
    assert "in the brand colours navy #22223B and coral #E48C84" in g.params["instruction"]

    r = client.post("/api/images/brand", json={
        "template_id": "image-brand-flyer", "mode": "scene",
        "scene_prompt": 'A flyer for "{brand}"{tagline_clause}, in {colours}, call "[phone]".'})
    assert r.status_code == 422 and "[phone]" in r.json()["detail"]
    r = client.post("/api/images/brand", json={
        "template_id": "image-brand-flyer", "mode": "scene",
        "scene_prompt": 'A flyer for "{brand}"{tagline_clause}, in {colours}, call "0300 123 4567".'})
    assert r.status_code == 202, r.text
    scene = _gen(r.json()["items"][0]["generation_id"])
    assert scene.prompt == ('A flyer for "iXperts" with the tagline "Clean done right", in navy #22223B and coral '
                            '#E48C84, call "0300 123 4567".')
    assert scene.params["model"] == "qwen_image_2512"

    # no tagline in the kit: the clause goes without leaving a gap
    kit2 = client.post("/api/brand-kits", json={"name": "Plain Co", "logos": {"primary": {
        "media_id": asset(client, "logo", "p.png", png()).json()["item"]["id"]}}}).json()
    r = client.post("/api/images/brand", json={"template_id": "image-brand-flyer", "mode": "scene",
                                               "brand_kit_id": kit2["id"], "scene_prompt": 'Say "{brand}"{tagline_clause}.'})
    assert _gen(r.json()["items"][0]["generation_id"]).prompt == 'Say "Plain Co".'


def test_no_kit_no_logo_and_bad_requests(client):
    photo = _photo(client)
    body = {"template_id": "image-brand-vehicle-wrap", "source_id": photo["id"]}
    r = client.post("/api/images/brand", json=body)
    assert r.status_code == 409 and "Brand Kits" in r.json()["detail"] and "No brand kit" in r.json()["detail"]

    client.post("/api/brand-kits", json={"name": "Logo-less"})
    r = client.post("/api/images/brand", json=body)
    assert r.status_code == 409 and "has no logo" in r.json()["detail"]

    kit = _kit(client)
    assert client.post("/api/images/brand", json={**body, "brand_kit_id": kit["id"], "source_id": None}).status_code == 422
    assert client.post("/api/images/brand", json={**body, "template_id": "image-edit-headshot"}).status_code == 422
    # a product on a card that has no product slot
    r = client.post("/api/images/brand", json={**body, "brand_kit_id": kit["id"], "product_id": photo["id"]})
    assert r.status_code == 422 and "product" in r.json()["detail"]


def test_product_rides_along_as_picture_3(client):
    prod = asset(client, "product", "spray.png", png()).json()["item"]
    kit = _kit(client, products=[{"media_id": prod["id"], "name": "Fresh Spray", "description": ""}])
    photo = _photo(client)
    card = next(t for t in _cards() if t["id"] == "image-brand-product-label")
    words = card["defaults"]["instruction_scaffold"].replace("[container]", "white trigger spray bottle")
    r = client.post("/api/images/brand", json={"template_id": card["id"], "source_id": photo["id"],
                                               "product_id": prod["id"], "instruction": words})
    assert r.status_code == 202, r.text
    g = _gen(r.json()["items"][0]["generation_id"])
    assert len(g.params["reference_ids"]) == 3 and g.params["reference_ids"][1] == _logo_gen(kit, "primary")
    assert "Picture 3 is the Fresh Spray" in g.params["instruction"]


@pytest.mark.parametrize("via_api", [False, True])
def test_scene_mode_chains_into_one_item(client, via_api):
    kit = _kit(client)
    r = client.post("/api/images/brand", json={
        "template_id": "image-brand-vehicle-wrap", "mode": "scene",
        "scene_prompt": "A clean white panel van on a quiet street, plain white side panel, no logo.",
        "instruction": "Print {logo} from picture 2 on the side of the white panel van in picture 1. {logo_colours} "
                       "Keep everything else the same."})
    assert r.status_code == 202, r.text
    item = r.json()["items"][0]
    with SessionLocal() as db:
        before = db.query(MediaItem).count()
        if via_api:
            g = db.get(Generation, item["generation_id"])
            for row in (g, db.get(Job, g.job_id), db.get(MediaItem, item["id"])):
                row.via_api = True
            db.commit()
    run_jobs()
    with SessionLocal() as db:
        assert db.query(MediaItem).count() == before  # still one Library item
        gens = db.query(Generation).filter(Generation.target_id == item["id"]).order_by(Generation.version).all()
        assert [g.version for g in gens] == [1, 2] and all(g.status == "ready" for g in gens)
        scene, final = gens
        assert db.get(MediaItem, item["id"]).generation_id == final.id
        assert final.parent_id == scene.id and final.params["edit_of"][0]["generation_id"] == scene.id
        assert final.params["reference_ids"] == [scene.id, _logo_gen(kit, "primary")]
        assert final.params["model"] == "qwen_image_edit_2511" and "the iXperts logo" in final.prompt
        assert final.params["brand_template"]["mode"] == "scene"
        assert scene.params[bt.CHAIN]["state"] == "queued" and scene.params[bt.CHAIN]["edit_generation_id"] == final.id
        assert final.via_api is via_api and db.get(Job, final.job_id).via_api is via_api
        assert db.get(Job, final.job_id).payload["chain_of"] == scene.job_id

    seen = {m["id"] for m in client.get("/api/media", params={"kind": "image"}).json()["items"]}
    assert (item["id"] in seen) is (not via_api)
