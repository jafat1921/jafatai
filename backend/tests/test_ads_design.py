"""Ad Studio M16b (contract v36 §9): the new layouts, smart placement, best-of photos, upscale, the key word,
the QA retry, style references and seeded shapes."""
import json
import re

import httpx
import numpy as np
import pytest
from PIL import Image, ImageDraw

from app.ads import layout as lay
from app.ads import placement
from app.ads import shapes
from app.ads import vision as eye
from app.db import SessionLocal
from app.llm import set_transport
from app.models import BrandKit, Generation
from tests.test_ads import CONTACT, OFFERS, ZABAR, _concepts, kit, photo, run_all  # noqa: F401
from tests.test_api_tokens import login  # noqa: F401  (fixture)
from tests.test_brand import asset, png

TEXTS = {"kicker": "Höstmys", "headline": "Veckostädning\nutan krångel", "body": "Ingen bindningstid.",
         "offers": ["Från 215 kr/timme", "Ingen bindningstid"], "cta": "Boka nu!", "badge_big": "15%",
         "badge_small": "RABATT", "highlight": "Veckostädning",
         "quote": "Bästa städningen vi haft, alltid i tid.", "quote_by": "Anna, Solna"}
NEW = ("cutout_blob", "arch_mask", "circle_mask", "big_price", "editorial", "before_after", "quote")


def person_mask(size=(900, 1200), right=True) -> Image.Image:
    w, h = size
    m = Image.new("L", size, 0)
    x0 = int(w * (0.55 if right else 0.1))
    d = ImageDraw.Draw(m)
    d.ellipse((x0 + 60, int(h * 0.15), x0 + 230, int(h * 0.32)), fill=255)
    d.rectangle((x0, int(h * 0.3), x0 + 290, h), fill=255)
    return m


class Fake:
    """The LLM server, scripted per schema: lists are answered in turn, the last answer repeats."""

    def __init__(self, **answers):
        self.answers = {k: list(v) if isinstance(v, list) else [v] for k, v in answers.items()}
        self.calls = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        title = (((body.get("response_format") or {}).get("json_schema") or {}).get("schema") or {}).get("title")
        user = body["messages"][-1]["content"]
        text = user if isinstance(user, str) else " ".join(p.get("text", "") for p in user if isinstance(p, dict))
        self.calls.append({"schema": title, "user": text, "model": body.get("model")})
        if title == "AdConcepts":
            n = int(re.search(r"with exactly (\d+) concepts", text)[1])
            content = _concepts(n)
            if "fix_layout" in self.answers:
                for row in content["concepts"]:
                    row["layout"] = self.answers["fix_layout"][0]
        elif title in self.answers:
            q = self.answers[title]
            content = q.pop(0) if len(q) > 1 else q[0]
        else:
            content = {}
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(content, ensure_ascii=False)},
                                                      "finish_reason": "stop"}], "usage": {}})


@pytest.fixture
def fake():
    holder = {}

    def install(**answers):
        f = Fake(**answers)
        set_transport(httpx.MockTransport(f))
        holder["f"] = f
        return f
    yield install
    set_transport(None)


def create(client, **over) -> dict:
    body = {"subject": "Weekly home cleaning", "language": "sv", "market": "Sweden", "offers": OFFERS[:2],
            "formats": ["4:5"], "variants": 2, "review": False, **over}
    r = client.post("/api/ads", json=body)
    assert r.status_code == 201, r.text
    run_all()
    return client.get(f"/api/ads/{r.json()['id']}").json()


# ---------------------------------------------------------------- layouts

@pytest.mark.parametrize("style", NEW)
def test_new_layouts_render_in_every_format_without_overflow(style):
    assets = lay.AdAssets(photo=photo(), mask=person_mask(), before=photo((120, 110, 100)))
    for fmt in lay.FORMATS:
        img, rep = lay.render({"format": fmt, "style": style, "texts": TEXTS, "contact": CONTACT, "language": "sv",
                               "shape": {"seed": 5}}, assets)
        assert img.size == lay.FORMATS[fmt] and rep["layout"] == style and not rep["fallback"], (style, fmt)
        x0, y0, x1, y1 = rep["copy_box"]
        for role, (bx0, by0, bx1, by1) in rep["boxes"].items():
            assert 0 <= bx0 and bx1 <= img.width and 0 <= by0 and by1 <= img.height, (style, fmt, role)
            if role not in ("cta",):
                assert bx0 >= x0 - 1 and bx1 <= x1 + 1 and by1 <= y1 + 1, (style, fmt, role)
        if rep.get("footer"):
            assert all(b[3] <= rep["footer"]["box"][1] + 1 for r, b in rep["boxes"].items()), (style, fmt)
        for role, ratio_ in rep["contrast"].items():
            assert ratio_ >= lay.NEED.get(role, lay.AA_TEXT) - 0.01, (style, fmt, role, ratio_)


def test_layout_specifics():
    a = lay.AdAssets(photo=photo(), mask=person_mask())
    _, rep = lay.render({"format": "4:5", "style": "big_price", "texts": TEXTS, "contact": CONTACT}, a)
    # the number is about three times the words around it, all in one band
    p = rep["price"]
    assert (p["pre"], p["number"], p["post"]) == ("Från", "215", "kr/timme") and p["number_px"] >= 2.3 * p["words_px"]
    assert "price" in rep["boxes"] and "plain" in rep["boxes"] and "offer" not in rep["boxes"]
    _, rep = lay.render({"format": "4:5", "style": "cutout_blob", "texts": TEXTS}, a)
    assert "cutout" in rep["treatment"] and rep["shape"]["kind"] == "blob"
    # no cut-out yet: the photo fills the blob and the report says so
    _, rep = lay.render({"format": "4:5", "style": "cutout_blob", "texts": TEXTS}, lay.AdAssets(photo=photo()))
    assert "cutout" not in rep["treatment"] and "photo fills the shape" in rep["fallback"]
    _, rep = lay.render({"format": "4:5", "style": "arch_mask", "texts": TEXTS, "shape": {"mask": "teardrop"}}, a)
    assert rep["shape"]["kind"] == "teardrop"
    _, rep = lay.render({"format": "4:5", "style": "before_after", "texts": TEXTS, "language": "sv"},
                        lay.AdAssets(photo=photo(), before=photo((90, 80, 70))))
    assert rep["labels"] == ["Före", "Efter"]
    _, rep = lay.render({"format": "4:5", "style": "before_after", "texts": TEXTS, "language": "ur", "rtl": True},
                        lay.AdAssets(photo=photo(), before=photo((90, 80, 70))))
    assert rep["labels"][0].startswith("پ") and ZABAR in rep["labels"][0]
    # what a layout needs and hasn't got falls back, and says why
    t = {k: v for k, v in TEXTS.items() if k != "quote"}
    assert lay.render({"format": "4:5", "style": "quote", "texts": t}, a)[1]["layout"] == "editorial"
    assert lay.render({"format": "4:5", "style": "before_after", "texts": t}, a)[1]["layout"] == "split"
    t2 = {**t, "offers": ["Ingen bindningstid"]}
    _, rep = lay.render({"format": "4:5", "style": "big_price", "texts": t2}, a)
    assert rep["layout"] == "side_wash" and rep["fallback"].startswith("Big price needs")


def test_quote_is_set_from_the_texts_only():
    _, rep = lay.render({"format": "4:5", "style": "quote", "texts": TEXTS}, lay.AdAssets(photo=photo()))
    assert rep["lines"]["quote"] and "headline" not in rep["boxes"] and "quote_by" in rep["boxes"]
    assert " ".join(rep["lines"]["quote"]).replace("  ", " ") == TEXTS["quote"]


def test_blobs_are_deterministic_by_seed():
    a = np.asarray(shapes.mask("blob", (300, 300), seed=42))
    b = np.asarray(shapes.mask("blob", (300, 300), seed=42))
    c = np.asarray(shapes.mask("blob", (300, 300), seed=43))
    assert (a == b).all() and (a != c).any()
    assert shapes.blob_points(7, 0, 0, 10, 10) == shapes.blob_points(7, 0, 0, 10, 10)
    assert shapes.dots(3, (0, 0, 100, 100), 5, 2, 4) == shapes.dots(3, (0, 0, 100, 100), 5, 2, 4)
    # anti-aliased: the edge has the in-between values a hard polygon wouldn't
    edge = np.asarray(shapes.mask("circle", (200, 200)))
    assert ((edge > 10) & (edge < 245)).sum() > 100
    for kind in shapes.MASKS:
        m = np.asarray(shapes.mask(kind, (240, 320), seed=1))
        assert m.max() == 255 and m[0, -1] == 0, kind  # filled, but not the top end corner
    # a re-render of the same ad draws the same blob
    a = lay.AdAssets(photo=photo())
    i1, _ = lay.render({"format": "1:1", "style": "cutout_blob", "texts": TEXTS, "shape": {"seed": 9}}, a)
    i2, _ = lay.render({"format": "1:1", "style": "cutout_blob", "texts": TEXTS, "shape": {"seed": 9}}, a)
    i3, _ = lay.render({"format": "1:1", "style": "cutout_blob", "texts": TEXTS, "shape": {"seed": 10}}, a)
    assert np.array_equal(np.asarray(i1), np.asarray(i2)) and not np.array_equal(np.asarray(i1), np.asarray(i3))


# ---------------------------------------------------------------- placement

def test_placement_keeps_the_copy_off_the_subject():
    pic = photo(size=(1600, 1200))
    texts = {"kicker": "Höst", "headline": "Leran stannar utanför dörren", "body": "Varje vecka", "cta": "Boka"}
    # the subject on the left, where the side wash would set its copy
    subject = {"box": [0.05, 0.1, 0.42, 1.0], "face": [0.15, 0.1, 0.3, 0.3], "source": "vision"}
    _, rep = lay.render({"format": "4:5", "style": "side_wash", "texts": texts, "subject": subject, "footer": False},
                        lay.AdAssets(photo=pic))
    pl = rep["placement"]
    assert pl["auto"] and pl["overlap"] <= 0.05, pl
    # with the copy forced back onto the subject's side, the box clears it or a panel goes behind the copy
    _, rep = lay.render({"format": "4:5", "style": "side_wash", "texts": texts, "subject": subject, "footer": False,
                         "placement": {"flip": False}, "focus": {"x": 0.0, "y": 0.5}}, lay.AdAssets(photo=pic))
    assert rep["placement"].get("clipped") or "subject_panel" in rep["treatment"]
    # the subject mask works the same way, and the badge keeps off the face
    m = person_mask(size=(900, 1200), right=False)
    _, rep = lay.render({"format": "4:5", "style": "frosted", "texts": texts, "footer": False},
                        lay.AdAssets(photo=photo(), mask=m))
    assert rep["placement"]["source"] == "mask" and rep["placement"]["overlap"] <= 0.05
    # a focus the user dragged is never moved
    _, rep = lay.render({"format": "4:5", "style": "frosted", "texts": texts, "focus": {"x": 0.2, "y": 0.8}},
                        lay.AdAssets(photo=photo(), mask=m))
    assert rep["placement"]["focus"] == {"x": 0.2, "y": 0.8} and not rep["placement"]["auto"]


def test_subject_from_mask_and_box_maths():
    s = placement.subject_from_mask(person_mask(right=True))
    assert s["box"][0] > 0.5 and s["face"][1] == s["box"][1] and s["face"][3] < 0.5
    assert placement.subject_from_mask(Image.new("L", (100, 100), 0)) is None
    win = placement.crop_window(1000, 1000, 500, 1000, 0.0, 0.5)
    assert win == (0.0, 0.0, 0.5, 1.0)


# ---------------------------------------------------------------- the key word

def test_key_word_is_set_in_the_accent():
    texts = {"headline": "Släpp in höstljuset", "highlight": "höstljuset"}
    spec = {"format": "1:1", "style": "minimal", "texts": texts, "footer": False,
            "palette": [{"hex": "#22223B"}, {"hex": "#C0392B"}]}
    img, rep = lay.render(spec, lay.AdAssets(photo=photo((245, 243, 240))))
    hi = rep["highlight"]
    assert hi["found"] and hi["contrast"] >= lay.AA_LARGE
    x0, y0, x1, y1 = rep["boxes"]["headline"]
    px = np.asarray(img.crop((x0, y0, x1, y1))).astype(int)
    red = np.all(np.abs(px - lay.rgb(hi["colour"])) < 40, axis=2).sum()
    assert red > 200
    img2, rep2 = lay.render({**spec, "texts": {"headline": texts["headline"]}}, lay.AdAssets(photo=photo((245, 243, 240))))
    px2 = np.asarray(img2.crop((x0, y0, x1, y1))).astype(int)
    assert "highlight" not in rep2 and np.all(np.abs(px2 - lay.rgb(hi["colour"])) < 40, axis=2).sum() < red / 10
    # a word that isn't in the headline highlights nothing; RTL lines work too
    _, rep = lay.render({**spec, "texts": {**texts, "highlight": "vinter"}}, lay.AdAssets(photo=photo()))
    assert not rep["highlight"]["found"]
    _, rep = lay.render({"format": "4:5", "style": "frosted", "language": "ur", "rtl": True,
                         "texts": {"headline": "گھر کو چَمکائیں", "highlight": "چَمکائیں"}}, lay.AdAssets(photo=photo()))
    assert rep["highlight"]["found"]


def test_headline_is_tracked_tighter_and_on_the_grid():
    g = lay.geometry("frosted", "4:5", footer_h=0, logo_pos="tl", rtl=False)
    assert g.m % 8 == 0 and g.pad % 8 == 0
    assert lay.LEADING["headline"] < 1.0 and lay.TRACK["sans"] < 0


# ---------------------------------------------------------------- best of, upscale, QA

def test_vision_model_comes_from_api_show():
    caps = {"eye:7b": ["completion", "vision"], "writer:26b": ["completion"]}
    assert eye.pick_model(["", "writer:26b", "eye:7b"], caps.get, set()) == "eye:7b"
    assert eye.pick_model(["writer:26b"], caps.get, set()) is None
    # an OpenAI-compatible server can't say: the configured vision model is trusted, the writer isn't
    assert eye.pick_model(["fake-eye", "writer"], lambda n: None, {"fake-eye"}) == "fake-eye"
    assert eye.pick_model(["writer"], lambda n: None, {"fake-eye"}) is None
    assert eye.best({"a": {"score": 7}, "b": {"score": 9}, "c": {"score": 9}}, ["a", "b", "c"]) == "b"


def test_best_of_three_picks_the_highest_score(client, fake):
    f = fake(AdPhotoScore=[{"score": 4}, {"score": 9, "subject_box": [0.5, 0.2, 0.9, 1.0],
                                           "face_box": [0.6, 0.2, 0.75, 0.35]}, {"score": 6}],
             AdQA={"score": 9})
    c = create(client, variants=2, formats=["1:1"])
    assert c["status"] == "done", c["stages"]
    con = c["concepts"][0]
    ph = con["photos"]["square"]
    assert len(ph["candidates"]) == 3 and ph["pick"]["by"] == "vision" and ph["pick"]["model"] == "fake-eye"
    picked = next(x for x in ph["candidates"] if x["picked"])
    assert picked["id"] == ph["candidates"][1]["id"] and picked["score"] == 9
    assert ph["subject"]["source"] == "vision"
    assert sum(1 for x in f.calls if x["schema"] == "AdPhotoScore") == 6
    assert c["ads"][0]["report"]["quality"]["qa"]["by"] == "vision"


def test_no_vision_falls_back_to_heuristics(client, fake, monkeypatch):
    fake()
    monkeypatch.setattr(eye, "vision_model", lambda writer=None: None)
    c = create(client, variants=2, formats=["1:1"])
    ph = c["concepts"][0]["photos"]["square"]
    assert c["status"] == "done" and ph["pick"]["by"] == "heuristic"
    assert all(x["score"] is not None for x in ph["candidates"])
    assert c["ads"][0]["report"]["quality"]["qa"]["by"] == "heuristic"
    # the heuristic prefers the calm copy area and breaks ties on the first candidate
    calm, busy = photo((230, 228, 225)), photo(noise=True)
    assert placement.heuristic_score(calm, "frosted") > placement.heuristic_score(busy, "frosted")
    assert eye.best({"a": {"score": 5}, "b": {"score": 5}}, ["a", "b"]) == "a"


def test_draft_skips_best_of_and_the_upscale(client, fake):
    f = fake()
    c = create(client, quality="draft", formats=["4:5", "9:16"])
    assert c["status"] == "done"
    with SessionLocal() as db:
        roles = [g.params.get("photo_role") for g in db.query(Generation).filter(Generation.target_type == "ad_photo")]
    assert "upscale" not in roles and roles.count("candidate") == 2
    assert all(con["photos"]["portrait"]["pick"]["by"] == "only" for con in c["concepts"])
    assert not any(x["schema"] in ("AdPhotoScore", "AdQA") for x in f.calls)
    # cut-outs only for the layout that needs one
    assert "cutout" not in roles


def test_qa_failure_retries_another_placement(client, fake):
    fake(AdPhotoScore={"score": 8}, AdQA=[{"score": 3, "overlap": True, "issues": ["headline over the face"]},
                                          {"score": 9}])
    c = create(client, variants=2, formats=["4:5"])
    qa = [a["report"]["quality"]["qa"] for a in c["ads"]]
    first = next(q for q in qa if q["retried"])
    assert not first["flagged"] and first["score"] == 9 and len(first["retried"]) == 1
    ad = next(a for a in c["ads"] if a["report"]["quality"]["qa"]["retried"])
    assert ad["auto"] and ad["version"] >= 2
    # nothing ever passes: the best try is kept and flagged
    fake(AdPhotoScore={"score": 8}, AdQA={"score": 2, "legible": False, "issues": ["unreadable"]})
    c = create(client, variants=2, formats=["1:1"])
    q = c["ads"][0]["report"]["quality"]["qa"]
    assert q["flagged"] and len(q["retried"]) >= 1 and q["issues"] == ["unreadable"]


def test_headline_round_and_key_word(client, fake):
    f = fake(AdHeadlines={"concepts": [
        {"concept": 1, "options": [{"headline": "Höstrent\nhela veckan", "key_word": "Höstrent", "score": 9},
                                   {"headline": "Damm? Inte här", "key_word": "Damm", "score": 7}]},
        {"concept": 2, "options": [{"headline": "Spara 50% nu", "key_word": "50%", "score": 10}]}]})
    c = create(client, quality="draft")
    one, two = c["concepts"]
    assert one["headline"] == "Höstrent\nhela veckan" and one["key_word"] == "Höstrent"
    assert [o["headline"] for o in one["headline_options"]][:2] == ["Höstrent\nhela veckan", "Damm? Inte här"]
    # an invented number in the winner is guarded like everything else
    assert "50" not in two["headline"]
    asked = next(x for x in f.calls if x["schema"] == "AdHeadlines")["user"]
    assert "12 different headlines" in asked
    ad = next(a for a in c["ads"] if a["concept_id"] == one["id"])
    assert ad["spec"]["texts"]["highlight"] == "Höstrent"
    # the editor's highlight edit is a CPU re-render
    r = client.patch(f"/api/ads/{c['id']}/ads/{ad['id']}", json={"texts": {"highlight": ""},
                                                                 "shape": {"mask": "circle", "seed": 7},
                                                                 "placement": {"flip": True}})
    assert r.status_code == 200, r.text
    sp = r.json()["spec"]
    assert sp["texts"]["highlight"] == "" and sp["shape"]["mask"] == "circle" and sp["placement"]["flip"] is True


def test_layouts_spread_and_quotes_are_the_clients(client, fake):
    f = fake(fix_layout=["quote"])
    quotes = [{"text": "Bästa städningen vi haft.", "by": "Anna"}]
    c = create(client, quality="draft", variants=3, quotes=quotes)
    layouts = [x["layout"] for x in c["concepts"]]
    assert len(set(layouts)) == 3 and layouts[0] == "quote"
    ad = next(a for a in c["ads"] if a["concept_id"] == c["concepts"][0]["id"])
    assert ad["spec"]["texts"]["quote"] == quotes[0]["text"] and ad["spec"]["texts"]["quote_by"] == "Anna"
    asked = next(x for x in f.calls if x["schema"] == "AdConcepts")["user"]
    assert "never write a quote yourself" in asked and "Bästa städningen" in asked
    # no quotes: the quote layout isn't offered at all
    f = fake(fix_layout=["quote"])
    c = create(client, quality="draft", variants=2)
    assert "quote" not in [x["layout"] for x in c["concepts"]]
    assert "- quote:" not in next(x for x in f.calls if x["schema"] == "AdConcepts")["user"]


# ---------------------------------------------------------------- style references

def test_style_references_are_read_and_applied(client, fake):
    k = kit(client)
    refs = [asset(client, "reference", f"ad{i}.png", png((400, 500), (200, 120, 110, 255), "RGB")).json()["item"]["id"]
            for i in range(3)]
    read = {"layout": "cutout_blob", "shapes": ["blob", "dots"], "headline_weight": "black",
            "headline_case": "upper", "serif": False, "colour_usage": "bold", "background": "light",
            "density": "airy", "badge": True, "notes": "Cut-out people on coral blobs."}
    f = fake(AdStyleRead=[read, {**read, "layout": "Cutout Blob"}, {**read, "layout": "arch_mask", "shapes": ["arch"]}])
    r = client.put(f"/api/brand-kits/{k['id']}/ad-style", json={"references": refs})
    assert r.status_code == 200 and r.json()["ad_style"]["status"] == "working"
    run_all()
    st = client.get(f"/api/brand-kits/{k['id']}").json()["ad_style"]
    assert st["status"] == "ready" and len(st["references"]) == 3 and st["references"][0]["media_url"]
    rules = st["rules"]
    assert rules["layouts"] == ["cutout_blob", "arch_mask"] and rules["pinned"]
    assert rules["headline_case"] == "upper" and rules["headline_weight"] == "black" and rules["density"] == "airy"
    assert "blob" in rules["shapes"] and rules["badge"] and len(rules["per_reference"]) == 3
    assert sum(1 for x in f.calls if x["schema"] == "AdStyleRead") == 3

    f = fake()
    c = create(client, brand_kit_id=k["id"], quality="draft", variants=2)
    assert c["brand_kit"]["ad_style"]["active"] and "cutout blob" in c["brand_kit"]["ad_style"]["summary"]
    # pinned: only the brand's own layouts, spread across the concepts
    assert sorted(x["layout"] for x in c["concepts"]) == ["arch_mask", "cutout_blob"]
    asked = next(x for x in f.calls if x["schema"] == "AdConcepts")["user"]
    assert "- cutout_blob:" in asked and "- frosted:" not in asked and "Cut-out people on coral blobs" in asked
    sp = c["ads"][0]["spec"]
    assert sp["style_ref"]["headline_case"] == "upper"
    # turned off for one campaign
    c = create(client, brand_kit_id=k["id"], quality="draft", variants=2, use_style=False)
    assert not c["brand_kit"]["ad_style"]["active"] and c["ads"][0]["spec"]["style_ref"] is None

    # clearing the references clears the rules; bad ids are refused
    assert client.put(f"/api/brand-kits/{k['id']}/ad-style", json={"references": ["nope"]}).status_code == 422
    r = client.put(f"/api/brand-kits/{k['id']}/ad-style", json={"references": []})
    assert r.json()["ad_style"]["status"] == "none" and r.json()["ad_style"]["rules"] is None
    assert client.post(f"/api/brand-kits/{k['id']}/ad-style/extract").status_code == 409


def test_style_merge_and_schema():
    d = eye.AdStyleRead.model_validate({"layout": "Big Price", "shapes": ["ARCH", "stars"], "headline_case": "Loud",
                                        "notes": "x " * 300})
    assert d.layout == "big_price" and d.shapes == ["arch"] and d.headline_case == "" and len(d.notes) <= 400
    rules = eye.merge([{"layout": "arch_mask", "shapes": ["arch"], "serif": True, "density": "airy"},
                       {"layout": "editorial", "shapes": [], "serif": True, "density": "dense"}])
    assert rules["layouts"] == ["arch_mask", "editorial"] and rules["mask"] == "arch" and rules["serif"]
    assert rules["density"] == "airy"  # the first reference breaks the tie
    assert not eye.merge([{"layout": "quote"}])["pinned"]
    with SessionLocal() as db:
        assert hasattr(BrandKit, "ad_style") and db is not None


def test_options_list_the_new_layouts(client):
    o = client.get("/api/ads/options").json()
    ids = [s["id"] for s in o["styles"]]
    assert set(NEW) <= set(ids) and o["mask_shapes"] == ["arch", "circle", "teardrop", "blob"]
    assert next(s for s in o["styles"] if s["id"] == "big_price")["needs"] == "offer_number"
    assert o["candidates"]["default"] == 3
    assert client.post("/api/ads", json={"subject": "x", "candidates": 9}).status_code == 422
    assert client.post("/api/ads", json={"subject": "x", "quality": "best"}).status_code == 422


@pytest.mark.parametrize("style", lay.STYLES)
def test_type_never_goes_below_phone_sizes(style):
    """At 1080 wide: headline 72 px, body 30, offer pill 34, footer 26; scaled to the short side elsewhere."""
    assets = lay.AdAssets(photo=photo(), mask=person_mask(), before=photo((120, 110, 100)))
    for fmt in lay.FORMATS:
        img, rep = lay.render({"format": fmt, "style": style, "texts": TEXTS, "contact": CONTACT, "language": "sv",
                               "socials": [{"platform": "instagram", "handle": "@ixperts.se"}]}, assets)
        k = min(img.size) / 1080
        fonts = rep["fonts"]
        # only a single word wider than the column may take the headline below 72 px (down to 70 %)
        head_min = 72 * (0.7 if rep["fit"].get("word_floor") else 1)
        assert fonts.get("headline", 99) >= round(head_min * k) - 1, (style, fmt, fonts)
        assert fonts.get("body", 99) >= round(30 * k) - 1, (style, fmt, fonts)
        assert fonts.get("offer", 99) >= round(34 * k) - 1, (style, fmt, fonts)
        if rep.get("footer", {}).get("size"):
            assert rep["footer"]["size"] >= round(26 * k) - 1, (style, fmt, rep["footer"])


@pytest.mark.parametrize("fmt", ["4:5", "1:1", "9:16"])
def test_arch_copy_is_big_and_the_logo_on_plain_ground(fmt):
    img, rep = lay.render({"format": fmt, "style": "arch_mask", "texts": TEXTS, "contact": CONTACT,
                           "language": "sv"}, lay.AdAssets(photo=photo(), mask=person_mask(), logo=None))
    assert rep["fonts"]["headline"] >= 0.07 * img.height or rep["fonts"]["headline"] >= 95
    shape = rep["shape"]["box"]
    g = lay.geometry("arch_mask", fmt, footer_h=120, logo_pos="bl", rtl=False)
    # the logo's box never touches the photo shape
    assert placement.inter(g.logo, shape) == 0
    if rep.get("footer", {}).get("card"):
        assert shape[3] <= rep["footer"]["box"][1]


@pytest.mark.parametrize("style", lay.STYLES)
def test_logo_never_touches_text(style, tmp_path):
    logo = Image.new("RGBA", (400, 120), (0, 0, 0, 0))
    ImageDraw.Draw(logo).rectangle((10, 10, 390, 110), fill=(38, 36, 63, 255))
    logo.save(tmp_path / "logo.png")
    assets = lay.AdAssets(photo=photo(), mask=person_mask(), before=photo((120, 110, 100)), logo=tmp_path / "logo.png")
    for fmt in lay.FORMATS:
        _, rep = lay.render({"format": fmt, "style": style, "texts": TEXTS, "contact": CONTACT, "language": "sv"},
                            assets)
        lb = rep["logo"]["box"]
        for role, box in rep["boxes"].items():
            if role != "logo_slot":
                assert placement.inter(lb, box) == 0, (style, fmt, role, lb, box)
        if rep.get("footer"):
            assert placement.inter(lb, rep["footer"]["box"]) == 0, (style, fmt)
        if style == "big_price":
            x0, _, x1, _ = rep["copy_box"]
            assert x1 - x0 >= 0.5 * min(rep["size"][0], 1.2 * rep["size"][1]) or fmt in ("16:9", "1.91:1", "yt")
