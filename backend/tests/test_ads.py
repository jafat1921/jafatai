"""Ad Studio (contract v36): the concept schema and the offer guard, layout fitting and contrast, RTL, every
format, CPU re-renders, the product photo path, brand-kit contact and claims, via_api, the zip."""
import io
import json
import re
import zipfile

import httpx
import numpy as np
import pytest
from PIL import Image

from app.ads import copy as cp
from app.ads import layout as lay
from app.db import SessionLocal
from app.drivers.mock import MockDriver
from app.llm import set_transport
from app.models import AdCampaign, Generation, Job, MediaItem
from app.worker import process_one
from tests.test_api_tokens import _bearer, _mint, flags, login  # noqa: F401  (fixtures)
from tests.test_brand import asset, png

ZABAR = "َ"
OFFERS = ["Från 215 kr/timme", "Ingen bindningstid", "15% rabatt på flyttstädning"]
CONTACT = {"phone": "+46 72 846 7394", "website": "https://www.ixperts.se", "location": "Stockholm, Sverige"}


def _concepts(n: int, urdu: bool = False) -> dict:
    rows = []
    for i in range(n):
        if urdu:
            rows.append({"insight": "شام", "kicker": "خزاں کی صفائی", "headline": "گھر کو چمکائیں\nہم دھول ہٹائیں",
                         "body": "ہفتہ وار صفائی", "offers": [], "cta": "ابھی بک کریں", "layout": "frosted",
                         "photo_prompt": "a cosy living room at dusk", "placement": "right", "logo_surface": ""})
            continue
        rows.append({"insight": f"idea {i}", "kicker": "Höstmys börjar hemma",
                     # an invented 25% and a made-up price: the guard has to take both out
                     "headline": "Tänd ljusen.\nVi tar dammet." if i else "Spara 25% i höst",
                     "body": "Veckostädning från 215 kr/timme. Nu bara 199 kr!", "cta": "Boka nu",
                     "offers": ["Från 215 kr/timme", "Gratis första städningen", "ingen bindningstid."],
                     "layout": ["frosted", "badge", "side_wash", "split"][i % 4],
                     "photo_prompt": "A warm Swedish living room in autumn, candles, a soft blanket on the sofa",
                     "placement": "right third", "logo_surface": "the cleaner's apron" if i == 1 else ""})
    return {"concepts": rows}


@pytest.fixture
def llm():
    calls = []

    def answer(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        schema = ((body.get("response_format") or {}).get("json_schema") or {}).get("schema") or {}
        title = schema.get("title")
        user = body["messages"][-1]["content"]
        calls.append({"schema": title, "user": user})
        if title == "AdConcepts":
            n = int(re.search(r"with exactly (\d+) concepts", user)[1])
            content = _concepts(n, urdu="Urdu" in user)
        elif title == "Marked":
            rows = [re.sub(r"^\d+\.\s*", "", ln) for ln in user.split("\n")]
            content = {"lines": [r[:1] + ZABAR + r[1:] if r else r for r in rows]}
        else:
            content = {}
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(content, ensure_ascii=False)},
                                                      "finish_reason": "stop"}], "usage": {}})

    set_transport(httpx.MockTransport(answer))
    yield calls
    set_transport(None)


def run_all():
    while process_one(driver_factory=lambda: MockDriver(step_seconds=0)):
        pass


def kit(client, **extra) -> dict:
    logo = asset(client, "logo", "logo.png", png(colour=(34, 34, 59, 255))).json()["item"]["id"]
    body = {"name": "iXperts", "palette": [{"hex": "#22223B"}, {"hex": "#E8857B"}],
            "logos": {"primary": {"media_id": logo}}, "contact": CONTACT, "claims": OFFERS, **extra}
    r = client.post("/api/brand-kits", json=body)
    assert r.status_code == 201, r.text
    return r.json()


def make(client, headers=None, **over) -> dict:
    body = {"subject": "Weekly home cleaning", "language": "sv", "market": "Sweden", "occasion": "autumn",
            "offers": OFFERS[:2], "formats": ["4:5", "9:16"], "variants": 2, **over}
    r = client.post("/api/ads", json=body, headers=headers or {})
    assert r.status_code == 201, r.text
    run_all()
    return client.get(f"/api/ads/{r.json()['id']}", headers=headers or {}).json()


def go_on(client, c: dict) -> dict:
    r = client.post(f"/api/ads/{c['id']}/continue")
    assert r.status_code == 202, r.text
    run_all()
    return client.get(f"/api/ads/{c['id']}").json()


def photo(colour=(200, 190, 180), size=(900, 1200), noise=False) -> Image.Image:
    if noise:
        rng = np.random.default_rng(7)
        return Image.fromarray(rng.integers(0, 256, (size[1], size[0], 3), dtype=np.uint8), "RGB")
    return Image.new("RGB", size, colour)


# ---------------------------------------------------------------- the copy guard

def test_guard_keeps_only_approved_offers_and_numbers():
    c, rep = cp.guard({"kicker": "Spara 20% i höst", "headline": "Nu 30 % billigare", "cta": "Boka",
                       "body": "Från 215 kr/timme. Bara 199 kr idag!",
                       "offers": ["Från 215 kr/timme", "25% rabatt", "ingen bindningstid."]}, OFFERS)
    assert c["offers"] == ["Från 215 kr/timme", "Ingen bindningstid"]
    assert rep["offers_dropped"] == ["25% rabatt"]
    assert "20" not in c["kicker"] and "30" not in c["headline"] and "199" not in c["body"]
    assert "215 kr/timme" in c["body"]  # an approved number stays where it is
    # no offers at all: every number goes, and an emptied headline is filled from the kicker
    c, _ = cp.guard({"kicker": "Höst", "headline": "50%", "body": "", "cta": "", "offers": ["50% off"]}, [])
    assert c["offers"] == [] and c["headline"] == "Höst" and not re.search(r"\d", json.dumps(c, ensure_ascii=False))
    # Arabic-Indic digits count as the same number
    assert "215" in cp.numbers("۲۱۵ روپے") and "15%" in cp.numbers("15 % rabatt")


def test_badge_comes_from_an_offer():
    assert cp.badge_from(["Ingen bindningstid", "15% rabatt på flyttstädning"]) == ("15%", "RABATT")
    assert cp.badge_from(["Från 215 kr/timme"])[0] == "215 kr"
    assert cp.badge_from(["No lock-in"]) == ("", "")


def test_concepts_obey_the_offers_and_stop_for_review(client, llm):
    k = kit(client)
    c = make(client, brand_kit_id=k["id"])
    assert c["status"] == "review" and c["review"] == "concepts" and len(c["concepts"]) == 2
    asked = next(x for x in llm if x["schema"] == "AdConcepts")["user"]
    assert "Från 215 kr/timme" in asked and "Sweden" in asked and "Never write a price" in asked
    first = c["concepts"][0]
    assert first["offers"] == ["Från 215 kr/timme", "Ingen bindningstid"]
    assert "25" not in first["headline"] and "199" not in first["body"]
    assert "Gratis första städningen" in first["guard"]["offers_dropped"]
    assert c["brand_kit"]["claims"] == OFFERS and c["brand_kit"]["missing_contact"] == []
    # nothing was made on a GPU before the OK
    with SessionLocal() as db:
        assert db.query(Generation).filter(Generation.target_type == "ad_photo").count() == 0


# ---------------------------------------------------------------- layout

@pytest.mark.parametrize("fmt", list(lay.FORMATS))
@pytest.mark.parametrize("style", lay.STYLES)
def test_every_style_in_every_format(fmt, style):
    texts = {"kicker": "Höstmys", "headline": "Tänd ljusen.\nVi tar dammet.", "body": "Veckostädning varje vecka.",
             "offers": ["Från 215 kr/timme", "Ingen bindningstid"], "cta": "Boka nu!", "badge_big": "15%",
             "badge_small": "RABATT"}
    img, rep = lay.render({"format": fmt, "style": style, "texts": texts, "contact": CONTACT, "language": "sv"},
                          lay.AdAssets(photo=photo()))
    assert img.size == lay.FORMATS[fmt]
    assert rep["contrast"]["body"] >= lay.AA_TEXT and rep["contrast"]["headline"] >= lay.AA_LARGE
    assert rep["contrast"]["footer"] >= lay.AA_TEXT
    x0, y0, x1, y1 = rep["copy_box"]
    for role, (bx0, by0, bx1, by1) in rep["boxes"].items():
        assert 0 <= bx0 and bx1 <= img.width and 0 <= by0 and by1 <= img.height, role


def test_story_keeps_copy_out_of_the_safe_zones():
    _, rep = lay.render({"format": "9:16", "style": "frosted", "contact": CONTACT,
                         "texts": {"headline": "Tänd ljusen", "body": "Varje vecka", "cta": "Boka"}},
                        lay.AdAssets(photo=photo()))
    top, bottom = 1920 * 0.13, 1920 * (1 - 0.18)
    for box in rep["boxes"].values():
        assert box[1] >= top and box[3] <= bottom


@pytest.mark.parametrize("words", [
    "Fensterreinigungsdienstleistungen für Donaudampfschifffahrtsgesellschaften",
    "Höststorstädningserbjudandet gäller flyttstädningsuppdrag",
])
def test_long_words_never_overflow(words):
    texts = {"kicker": "Herbst", "headline": words, "body": ("Rechtsschutzversicherungsgesellschaften " * 8).strip(),
             "offers": ["Ab 215 kr/Stunde"], "cta": "Jetzt buchen"}
    for fmt in lay.FORMATS:
        img, rep = lay.render({"format": fmt, "style": "frosted", "texts": texts, "contact": CONTACT},
                              lay.AdAssets(photo=photo()))
        x0, y0, x1, y1 = rep["copy_box"]
        for role, (bx0, by0, bx1, by1) in rep["boxes"].items():
            if role == "cta":
                continue
            assert bx0 >= x0 - 1 and bx1 <= x1 + 1 and by1 <= y1 + 1, (fmt, role)
        assert rep["fonts"]["headline"] >= lay.FLOOR["headline"]


def test_low_contrast_gets_a_panel():
    texts = {"headline": "Släpp in höstljuset", "body": "Skinande rena fönster varje vecka", "cta": "Boka"}
    _, rep = lay.render({"format": "4:5", "style": "minimal", "texts": texts, "footer": False},
                        lay.AdAssets(photo=photo(noise=True)))
    assert "panel" in rep["treatment"] and rep["contrast"]["body"] >= lay.AA_TEXT
    # a calm light photo needs nothing added
    _, rep = lay.render({"format": "4:5", "style": "minimal", "texts": texts, "footer": False},
                        lay.AdAssets(photo=photo((245, 243, 240))))
    assert "panel" not in rep["treatment"] and rep["contrast"]["headline"] >= lay.AA_LARGE


def test_logo_white_background_is_keyed_and_light_variant_used_on_dark(tmp_path):
    logo = Image.new("RGB", (400, 160), "white")
    logo.paste((34, 34, 59), (60, 40, 340, 120))
    logo.save(tmp_path / "logo.png")
    light = Image.new("RGBA", (400, 160), (0, 0, 0, 0))
    light.paste((255, 255, 255, 255), (60, 40, 340, 120))
    light.save(tmp_path / "light.png")
    keyed = lay.prepare_logo(tmp_path / "logo.png")
    assert keyed.size == (280, 80) and keyed.getpixel((0, 0))[3] == 255
    assets = lay.AdAssets(photo=photo((20, 20, 30)), logo=tmp_path / "logo.png", logo_light=tmp_path / "light.png")
    _, rep = lay.render({"format": "1:1", "style": "bottom_bar", "texts": {"headline": "Hej"}}, assets)
    assert rep["logo"]["variant"] == "light"
    _, rep = lay.render({"format": "1:1", "style": "bottom_bar", "texts": {"headline": "Hej"}},
                        lay.AdAssets(photo=photo((20, 20, 30)), logo=tmp_path / "logo.png"))
    assert rep["logo"]["variant"] == "primary" and rep["logo"]["plate"]


def test_palette_roles():
    r = lay.roles([{"hex": "#F2E9E4"}, {"hex": "#22223B"}, {"hex": "#E8857B"}])
    assert r["text"] == "#22223B" and r["footer"] == "#22223B" and r["accent"] == "#E8857B"
    assert lay.roles([])["text"] == lay.DEFAULT_TEXT


def test_rtl_urdu_ad_is_right_aligned():
    texts = {"kicker": "خِزاں کی صَفائی", "headline": "گھر کو چَمکائیں\nہم دُھول ہَٹائیں",
             "body": "ہَفتہ وار صَفائی", "offers": ["۲۱۵ روپے فی گھنٹہ سے"], "cta": "اَبھی بُک کریں"}
    img, rep = lay.render({"format": "4:5", "style": "frosted", "texts": texts, "language": "ur", "rtl": True,
                           "contact": CONTACT}, lay.AdAssets(photo=photo()))
    assert rep["rtl"] and rep["script"] == "urdu"
    x0, _, x1, _ = rep["copy_box"]
    assert x1 > img.width * 0.5  # the copy column sits on the right
    for role in ("headline", "body", "kicker"):
        assert abs(rep["boxes"][role][2] - x1) <= 2, role
    assert rep["contrast"]["body"] >= lay.AA_TEXT


# ---------------------------------------------------------------- the pipeline

def test_pipeline_makes_library_ads_and_ad_json(client, llm):
    k = kit(client)
    c = go_on(client, make(client, brand_kit_id=k["id"]))
    assert c["status"] == "done", c["stages"]
    assert len(c["ads"]) == 4 and all(a["status"] == "ready" for a in c["ads"])
    ad = next(a for a in c["ads"] if a["format"] == "9:16")
    assert (ad["width"], ad["height"]) == (1080, 1920) and ad["image_url"] and ad["version"] == 1
    assert ad["spec"]["contact"]["phone"] == CONTACT["phone"] and ad["spec"]["texts"]["headline"]
    with SessionLocal() as db:
        item = db.get(MediaItem, ad["media_id"])
        assert item.kind == "image" and "ad" in item.tags
        photos = db.query(Generation).filter(Generation.target_type == "ad_photo").all()
        # one portrait photo per concept serves 4:5 and 9:16; concept 2's logo goes on the apron
        base = [g for g in photos if not g.params.get("logo_on_surface")]
        assert len(base) == 2 and {g.params["aspect"] for g in base} == {"9:16"}
        assert all(g.params["model"] == "zimage_turbo" and "text" in (g.params.get("negative") or "text") for g in base)
        logo = [g for g in photos if g.params.get("logo_on_surface")]
        assert len(logo) == 1 and logo[0].params["reference_ids"][0] in {g.id for g in base}
    got = client.get(c["ad_json_url"])
    assert got.status_code == 200 and len(got.json()["ads"]) == 4

    z = client.get(c["zip_url"])
    assert z.status_code == 200 and z.headers["content-type"] == "application/zip"
    names = zipfile.ZipFile(io.BytesIO(z.content)).namelist()
    assert "ad.json" in names and len([n for n in names if n.endswith(".png")]) == 4

    lst = client.get("/api/ads").json()
    assert lst[0]["id"] == c["id"] and lst[0]["ads"] == 4 and lst[0]["thumb_url"]


def test_patch_rerenders_on_the_cpu_only(client, llm):
    c = go_on(client, make(client, formats=["1:1"], brand_kit_id=kit(client)["id"]))
    ad = c["ads"][0]
    with SessionLocal() as db:
        jobs = db.query(Job).count()
    r = client.post(f"/api/ads/{c['id']}/ads/{ad['id']}/preview", json={"style": "split"})
    assert r.status_code == 200 and r.headers["content-type"] == "image/png"
    r = client.patch(f"/api/ads/{c['id']}/ads/{ad['id']}", json={
        "texts": {"headline": "Ny rubrik här"}, "style": "minimal", "font_preset": "elegant",
        "colours": {"accent": "#3a7d44"}, "logo": {"position": "tr"}, "footer": False})
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["version"] == 2 and out["spec"]["style"] == "minimal" and out["spec"]["texts"]["headline"] == "Ny rubrik här"
    assert out["spec"]["colours"]["accent"] == "#3A7D44" and out["spec"]["logo"]["position"] == "tr"
    assert out["spec"]["footer"] is False and out["media_id"] == ad["media_id"]
    with SessionLocal() as db:
        assert db.query(Job).count() == jobs  # no GPU (or any) job for an edit
    assert client.patch(f"/api/ads/{c['id']}/ads/{ad['id']}", json={"colours": {"accent": "teal"}}).status_code == 422
    r = client.patch(f"/api/ads/{c['id']}/ads/{ad['id']}", json={"reset": True})
    assert r.json()["spec"]["style"] != "minimal" and r.json()["version"] == 3

    # a different layout for the whole concept, also on the spot
    r = client.post(f"/api/ads/{c['id']}/concepts/{ad['concept_id']}/regenerate", json={"what": "layout",
                                                                                         "layout": "bottom_bar"})
    assert r.status_code == 200 and r.json()["ads"][0]["spec"]["style"] == "bottom_bar"
    # an edited concept line lays its ads out again too
    r = client.patch(f"/api/ads/{c['id']}/concepts/{ad['concept_id']}", json={"cta": "Ring oss"})
    assert r.json()["ads"][0]["spec"]["texts"]["cta"] == "Ring oss" and r.json()["concepts"][0]["edited"]
    with SessionLocal() as db:
        assert db.query(Job).count() == jobs


def test_new_copy_keeps_the_photo_and_new_photo_keeps_the_copy(client, llm):
    c = go_on(client, make(client, formats=["4:5"]))
    con = c["concepts"][1]
    photo_before = con["photos"]["portrait"]["final"]
    client.patch(f"/api/ads/{c['id']}/concepts/{con['id']}", json={"headline": "Egen rubrik"})
    r = client.post(f"/api/ads/{c['id']}/concepts/{con['id']}/regenerate", json={"what": "copy"})
    assert r.status_code == 200
    run_all()
    c = client.get(f"/api/ads/{c['id']}").json()
    con = c["concepts"][1]
    assert con["photos"]["portrait"]["final"] == photo_before and con["headline"] != "Egen rubrik"
    assert c["status"] == "done"
    r = client.post(f"/api/ads/{c['id']}/concepts/{con['id']}/regenerate", json={"what": "photo"})
    run_all()
    c = client.get(f"/api/ads/{c['id']}").json()
    assert c["concepts"][1]["photos"]["portrait"]["final"] != photo_before
    assert c["concepts"][1]["headline"] == con["headline"]
    ad = next(a for a in c["ads"] if a["concept_id"] == con["id"])
    assert ad["version"] >= 3


def test_product_photos_go_through_the_edit_model(client, llm):
    prod = client.post("/api/media/upload", files={"file": ("bottle.png", png((300, 400), (30, 90, 160, 255), "RGB"),
                                                            "image/png")}).json()
    c = go_on(client, make(client, formats=["1:1"], product_media_ids=[prod["id"]], review=True))
    assert c["status"] == "done"
    with SessionLocal() as db:
        ref = db.get(MediaItem, prod["id"]).generation_id
        g = db.query(Generation).filter(Generation.target_type == "ad_photo").first()
        assert g.params["model"] == "qwen_image_edit_2511" and g.params["reference_ids"] == [ref]
        assert "picture 1" in g.params["instruction"] and "label" in g.params["instruction"]
    bad = client.post("/api/ads", json={"subject": "x", "product_media_ids": ["nope"]})
    assert bad.status_code == 422


def test_urdu_campaign_gets_aerab_and_rtl(client, llm):
    c = make(client, language="ur", offers=[], review=False, formats=["4:5"])
    assert c["rtl"] and c["status"] == "done"
    assert all(ZABAR in x["headline"] for x in c["concepts"])
    assert c["ads"][0]["spec"]["rtl"] and c["ads"][0]["spec"]["logo"]["position"] == "tl"
    assert "Urdu" in next(x for x in llm if x["schema"] == "AdConcepts")["user"]


def test_untick_and_validation(client, llm):
    c = make(client)
    for con in c["concepts"]:
        client.patch(f"/api/ads/{c['id']}/concepts/{con['id']}", json={"approved": False})
    assert client.post(f"/api/ads/{c['id']}/continue").status_code == 422
    client.patch(f"/api/ads/{c['id']}/concepts/{c['concepts'][0]['id']}", json={"approved": True})
    c = go_on(client, c)
    assert {a["concept_id"] for a in c["ads"]} == {c["concepts"][0]["id"]}
    assert client.post("/api/ads", json={"subject": "x", "variants": 9}).status_code == 422
    assert client.post("/api/ads", json={"subject": "x", "formats": ["3:2"]}).status_code == 422
    assert client.post("/api/ads", json={"subject": "x", "image_model": "qwen_image_edit_2511"}).status_code == 422
    assert client.post("/api/ads", json={"subject": "x", "brand_kit_id": "nope"}).status_code == 404
    opts = client.get("/api/ads/options").json()
    assert {s["id"] for s in opts["styles"]} == set(lay.STYLES) and len(opts["formats"]) == 4
    assert client.delete(f"/api/ads/{c['id']}").status_code == 204
    assert client.get(f"/api/ads/{c['id']}").status_code == 404


# ---------------------------------------------------------------- brand kit, visibility

def test_brand_kit_contact_and_claims(client):
    k = kit(client)
    assert k["contact"] == CONTACT and k["claims"] == OFFERS
    r = client.patch(f"/api/brand-kits/{k['id']}", json={"contact": {"phone": " +46  70 ", "email": "hej@x.se"},
                                                         "claims": ["No lock-in", "No lock-in", "  "]})
    assert r.status_code == 200
    assert r.json()["contact"] == {"phone": "+46 70", "email": "hej@x.se"} and r.json()["claims"] == ["No lock-in"]
    assert client.patch(f"/api/brand-kits/{k['id']}", json={"claims": ["x" * 161]}).status_code == 422


def test_api_campaigns_stay_out_of_the_app(client, llm):
    token = _bearer(_mint(client, ["read", "generate"])["token"])
    theirs = make(client, headers=token, review=False, formats=["1:1"])
    mine = make(client, formats=["1:1"])
    assert [x["id"] for x in client.get("/api/ads").json()] == [mine["id"]]
    assert {x["id"] for x in client.get("/api/ads", headers=token).json()} == {mine["id"], theirs["id"]}
    with SessionLocal() as db:
        camp = db.get(AdCampaign, theirs["id"])
        assert camp.via_api and not db.get(AdCampaign, mine["id"]).via_api
        assert all(db.get(MediaItem, a["media_id"]).via_api for a in theirs["ads"])
        assert all(g.via_api for g in db.query(Generation).filter(Generation.target_type == "ad_photo",
                                                                   Generation.target_id.in_(
                                                                       [x["id"] for x in camp.concepts])))
