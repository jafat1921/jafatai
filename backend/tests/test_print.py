"""Print Studio (M21, contract v41): sizes and pixels, layout families by ratio, the distance minimum, contrast,
a 106 x 160 cm render inside a memory budget, the PDF boxes and marks, DPI metadata, the SVG and the layers
ZIP, admin-only access (REST and MCP), home="print" out of the lists, and copy that keeps the owner's words."""
import io
import json
import re
import subprocess
import sys
import zipfile
from pathlib import Path

import httpx
import numpy as np
import pypdf
import pytest
from PIL import Image

from app.db import SessionLocal
from app.drivers.mock import MockDriver
from app.llm import set_transport
from app.models import AdCampaign, Generation, MediaItem
from app.print_studio import export as ex
from app.print_studio import gamut
from app.print_studio import layout as pl
from app.print_studio import raster
from app.print_studio import sizes as sz
from app.worker import process_one
from tests.test_api_tokens import _bearer, _mint, _user, flags, login  # noqa: F401  (fixtures)
from tests.test_mcp import Mcp

ZABAR = "َ"
# the sample brief: a placeholder Swedish mini market; phone and address are marked as placeholders
LINES = {"name": "Stjärnans Livs", "tagline": "Frukt & Grönt", "opening_hours": "Öppet alla dagar 08–22",
         "phone": "[Telefonnummer]", "address": "[Gatuadress 1, Ort]", "offers": ["Bananer 19,90 kr/kg"]}
TEXTS = {"name": "Stjärnans Livs", "tagline": "Frukt & Grönt", "headline": "Färskt varje dag",
         "offers": ["Bananer 19,90 kr/kg", "Kaffe 2 för 89 kr"], "hours": "Öppet alla dagar 08–22",
         "phone": "[Telefonnummer]", "address": "[Gatuadress 1, Ort]", "website": "", "cta": "Välkommen in!"}
GREEN = {"ground": "#FFF8E1", "ink": "#1B5E20", "accent": "#F9A825"}


def spec(w=250, h=700, job="sign", layout=None, design="typographic", **over) -> dict:
    return {"size": {"width_mm": w, "height_mm": h, "bleed_mm": 3, "dpi": 150}, "job": job, "layout": layout,
            "design": design, "font_preset": "condensed", "language": "sv", "texts": TEXTS, "colours": GREEN,
            "distance": "street", **over}


def photo(size=(700, 900)) -> Image.Image:
    rng = np.random.default_rng(3)
    return Image.fromarray(rng.integers(0, 256, (size[1], size[0], 3), dtype=np.uint8), "RGB")


def art() -> Image.Image:
    im = Image.new("RGBA", (400, 300), (0, 0, 0, 0))
    im.paste((60, 160, 60, 255), (50, 50, 350, 250))
    return im


# ---------------------------------------------------------------- the fake copywriter

def _concepts(user: str) -> dict:
    n = int(re.search(r"with exactly (\d+) concepts", user)[1])
    rows = []
    for i in range(n):
        # an invented price, an invented phone number and a rewritten owner line: the guard and the layout
        # must keep only the owner's own words
        rows.append({"insight": f"idea {i}", "family": "photo", "layout": "stack", "hero": "name",
                     "headline": "" if i == 0 else ("Bara 5 kr idag" if i == 1 else "Färskt varje dag"),
                     "cta": "Ring 08-123 45 67" if i == 1 else "Välkommen in!",
                     "offers": ["Bananer 19,90 kr/kg", "Gratis kaffe"], "ground": "#FFF8E1", "ink": "#C8E6C9",
                     "accent": "#F9A825", "font": ["condensed", "bold", "impact"][i % 3], "caps": True,
                     "decor": "awning" if i == 0 else "none", "photo_prompt": "a crate of fresh fruit in morning light",
                     "art_prompt": "a basket of fruit and vegetables"})
    if "Urdu" in user or "اردو" in user:
        for r in rows:
            r["headline"], r["cta"] = "تازہ پھل", "خوش آمدید"
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
        if title == "PrintConcepts":
            content = _concepts(user)
        elif title == "AdCopyCheck":
            content = {"lines": []}
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


def make(client, **over) -> dict:
    body = {"job": "sign", "width_cm": 25, "height_cm": 70, "business_type": "livs / mini market",
            "lines": LINES, "language": "sv", "style": "fresh & bright: greens, warm yellows, bold clean lettering",
            "variants": 3, "quality": "draft", **over}
    r = client.post("/api/print", json=body)
    assert r.status_code == 201, r.text
    run_all()
    return client.get(f"/api/print/{r.json()['id']}").json()


# ---------------------------------------------------------------- sizes

def test_size_and_pixel_maths():
    c = sz.canvas(25, 70, 150, 3)
    assert c.full_mm == (256, 706) and c.trim_px == (1476, 4134) and c.size_px == (1512, 4169)
    assert c.label() == "25 × 70 cm · 150 dpi · 1476 × 4134 px"
    board = sz.canvas(106, 160, 150, 3)
    assert board.size_px == (6295, 9484) and round(board.megapixels) == 60 and not sz.too_big(board)
    assert sz.too_big(sz.canvas(106, 160, 300)) and sz.best_dpi(106, 160, 300) == 200
    assert sz.min_cap_mm("street") == 15.0 and sz.min_cap_mm("near") == 1.8 and sz.min_cap_mm("road") == 60.0


@pytest.mark.parametrize("w,h,job,fam", [(25, 70, "sign", "tall"), (70, 25, "sign", "wide"), (106, 160, "board", "tall"),
                                         (30, 30, "sticker", "square"), (21, 29.7, "flyer", "sheet"),
                                         (50, 45, "board", "square")])
def test_layout_family_by_ratio(w, h, job, fam):
    assert sz.family(job, w, h) == fam


# ---------------------------------------------------------------- layout

CASES = [(w, h, job, lay_, d) for w, h, job in ((250, 700, "sign"), (700, 250, "sign"), (1060, 1600, "board"),
                                                (210, 297, "flyer"), (300, 300, "sticker"))
         for lay_ in pl.LAYOUTS[sz.family(job, w, h)] for d in ("typographic", "illustration")]


@pytest.mark.parametrize("w,h,job,layout,design", CASES)
def test_every_layout_keeps_to_the_distance_minimum_and_aa(w, h, job, layout, design):
    sp = spec(w, h, job, layout, design, distance="near" if job in ("flyer", "sticker") else "street",
              # a poor pair from the writer: the ink is nudged until it reads
              colours={"ground": "#FFF8E1", "ink": "#E8F5E9", "accent": "#FFEB3B"})
    sc = pl.build(sp, pl.Assets(photo=photo(), art=art()))
    rep = sc.report
    assert rep["min_text"]["pass"], rep
    assert rep["all_pass"], rep["contrast"]
    texts = [e for e in sc.els if e.kind == "text"]
    assert texts and all(e.cap >= sz.min_cap_mm(sp["distance"]) - 0.05 for e in texts)
    # nothing outside the trim but background and pictures (the bleed): text stays in the safe area
    for e in texts:
        x0, y0, x1, y1 = e.box
        assert -0.01 <= x0 and x1 <= w + 0.01 and -0.01 <= y0 and y1 <= h + 0.01, (e.role, e.box)
    assert any(e.role == "name" for e in texts), "the name is never dropped"
    img = raster.render(sc, pl.Assets(photo=photo(), art=art()), raster.k_for(sc, 600))
    assert max(img.size) == 600


def test_owner_words_set_exactly_and_lines_drop_in_order():
    sc = pl.build(spec(700, 250, "sign", "band", font_preset="bold"), pl.Assets())
    words = {e.role: " ".join(e.lines) for e in sc.els if e.kind == "text"}
    assert words["name"] == "STJÄRNANS LIVS" and words["tagline"] == "Frukt & Grönt"
    assert words["hours"] == "Öppet alla dagar 08–22"
    # a 25 cm tall fascia read from the street has no room for everything: the address goes before the hours
    assert "address" in sc.report["dropped"] and "hours" not in sc.report["dropped"]


def test_photo_layout_without_a_photo_falls_back():
    sc = pl.build(spec(1060, 1600, "board", "hero_top", "photo"), pl.Assets())
    assert sc.report["layout"] == "stack" and sc.report["fallback"]["asked"] == "hero_top"


def test_rtl_mirrors_and_sets_urdu():
    texts = {**TEXTS, "name": "سِتارہ جنرل سٹور", "tagline": "تازہ پھل اور سبزیاں", "headline": ""}
    sp = spec(700, 250, "sign", "band", "illustration", language="ur", rtl=True, texts=texts)
    sc = pl.build(sp, pl.Assets(art=art()))
    name = next(e for e in sc.els if e.role == "name")
    emblem = next(e for e in sc.els if e.src == "art")
    assert name.rtl and name.align == "right" and emblem.box[0] > name.box[0]
    assert sc.report["min_text"]["pass"]
    raster.render(sc, pl.Assets(art=art()), raster.k_for(sc, 800))


def test_gamut_flags_and_print_safe_tones_down():
    assert gamut.check("#00FF00")["out"] and gamut.check("#0000FF")["out"]
    assert not gamut.check("#2E7D32")["out"] and not gamut.check("#F9C74F")["out"]
    assert not gamut.check(gamut.safe("#00FF00"))["out"]
    sc = pl.build(spec(colours={"ground": "#FFFFFF", "ink": "#111111", "accent": "#00FF00"}), pl.Assets())
    assert [g["role"] for g in sc.report["gamut"]] == ["accent"]
    safe = pl.build(spec(colours={"ground": "#FFFFFF", "ink": "#111111", "accent": "#00FF00"}, print_safe=True),
                    pl.Assets())
    assert safe.report["gamut"] == [] and safe.report["colours"]["accent"] != "#00FF00"


def test_shape_masks_are_antialiased_without_supersampling():
    m = np.asarray(raster.shape_mask(200, 200, "circle"))
    assert m[100, 100] == 255 and m[0, 0] == 0 and ((m > 0) & (m < 255)).sum() > 100
    # the coverage adds up to the disc's area, so the edge is anti-aliased rather than stepped
    assert abs(m.sum() / 255 - np.pi * 100 ** 2) / (np.pi * 100 ** 2) < 0.005
    ring = np.asarray(raster.shape_mask(200, 200, "rect", 10, stroke=6))
    assert ring[100, 100] == 0 and ring[100, 2] == 255


# ---------------------------------------------------------------- the big render

MEASURE = r"""
import ctypes, json, sys, time
sys.path.insert(0, sys.argv[1])
def peak():
    try:
        import resource
        return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
    except ImportError:
        from ctypes import wintypes
        class P(ctypes.Structure):
            _fields_ = [("cb", wintypes.DWORD), ("faults", wintypes.DWORD)] + [(n, ctypes.c_size_t) for n in
                ("peak", "ws", "a", "b", "c", "d", "e", "f")]
        p = P(); p.cb = ctypes.sizeof(P)
        k = ctypes.WinDLL("kernel32"); k.GetCurrentProcess.restype = wintypes.HANDLE
        f = k.K32GetProcessMemoryInfo; f.argtypes = [wintypes.HANDLE, ctypes.POINTER(P), wintypes.DWORD]
        f(k.GetCurrentProcess(), ctypes.byref(p), p.cb)
        return p.peak / 2**20
import numpy as np
from PIL import Image
from app.print_studio import layout as pl, raster
rng = np.random.default_rng(0)
# a 4x Real-ESRGAN photo, the largest the pictures stage makes
photo = Image.fromarray(rng.integers(0, 256, (7680, 5120, 3), dtype=np.uint8), "RGB")
before = peak()
texts = json.loads(sys.argv[2])
spec = {"size": {"width_mm": 1060, "height_mm": 1600, "bleed_mm": 3, "dpi": 150}, "job": "board",
        "layout": "hero_top", "design": "photo", "language": "sv", "texts": texts, "distance": "street"}
t = time.perf_counter()
sc = pl.build(spec, pl.Assets(photo=photo))
img = raster.render(sc, pl.Assets(photo=photo), sc.canvas.k)
print(json.dumps({"size": img.size, "s": round(time.perf_counter() - t, 2), "peak_mb": round(peak()),
                  "before_mb": round(before)}))
"""


def test_board_106x160_at_150dpi_renders_inside_a_memory_budget():
    root = Path(__file__).resolve().parents[1]
    out = subprocess.run([sys.executable, "-c", MEASURE, str(root), json.dumps(TEXTS)], capture_output=True,
                         text=True, timeout=300, cwd=root)
    assert out.returncode == 0, out.stderr[-2000:]
    got = json.loads(out.stdout.strip().splitlines()[-1])
    assert got["size"] == [6295, 9484]
    # the page (180 MB) plus the photo's resize and the picture itself: well under a gigabyte on top of the
    # photo already in memory, where a 4x supersampled mask alone would be about a gigabyte
    assert got["peak_mb"] - got["before_mb"] < 900, got
    assert got["s"] < 60, got


# ---------------------------------------------------------------- files

def test_pdf_png_svg_and_zip(tmp_path):
    sp = spec(250, 700, "sign", "hero_top", "photo", size={"width_mm": 250, "height_mm": 700, "bleed_mm": 3,
                                                          "dpi": 100})
    a = pl.Assets(photo=photo(), logo=art())
    sc = pl.build(sp, a)
    pv = raster.render(sc, a, raster.k_for(sc, 800))
    res = ex.make_all(sc, a, tmp_path, "sign", "Stjärnans Livs · option 1", sp, pv)
    f = res["files"]
    pdf = pypdf.PdfReader(f["pdf"])
    assert len(pdf.pages) == 2
    page = pdf.pages[0]
    mm = 25.4 / 72
    trim = [float(v) * mm for v in page.trimbox]
    bleed = [float(v) * mm for v in page.bleedbox]
    assert round(trim[2] - trim[0], 1) == 250.0 and round(trim[3] - trim[1], 1) == 700.0
    assert round(bleed[2] - bleed[0], 1) == 256.0 and round(bleed[3] - bleed[1], 1) == 706.0
    media = [float(v) * mm for v in page.mediabox]
    assert media[2] - media[0] > bleed[2] - bleed[0]  # the slug, where the marks are
    content = page.get_contents().get_data().decode("cp1252")
    assert content.count(" l S") == 8 and "1 1 1 1 K" in content  # eight crop-mark lines in registration
    assert pdf.metadata.title == "Stjärnans Livs · option 1"
    with Image.open(f["png"]) as im:
        assert round(im.info["dpi"][0]) == 100 and im.info.get("icc_profile") and im.size == sc.canvas.size_px
    with Image.open(f["jpg"]) as im:
        assert im.info["dpi"] == (100, 100)
    svg = f["svg"].read_text(encoding="utf-8")
    assert svg.count("<text ") >= 4 and "@font-face{font-family:'Bebas Neue'" in svg and "Stjärnans".upper() in svg
    assert 'width="256mm"' in svg and 'inkscape:label="Text"' in svg and "clip-path" not in svg
    names = zipfile.ZipFile(f["zip"]).namelist()
    assert {"1-background.png", "2-photo.png", "3-logo.png", "4-text.png", "design.json"} <= set(names)
    with zipfile.ZipFile(f["zip"]) as z, Image.open(io.BytesIO(z.read("4-text.png"))) as t:
        assert t.mode == "RGBA" and t.size == sc.canvas.size_px and t.getchannel("A").getextrema()[0] == 0


# ---------------------------------------------------------------- the API and the job

def test_only_admins_see_print_studio(client, login, anon):
    member = login(_user("member@test.local", "editor"))
    for path in ("/api/print", "/api/print/options"):
        assert member.get(path).status_code == 404
    assert member.post("/api/print", json={"width_cm": 25, "height_cm": 70,
                                            "lines": {"name": "X"}}).status_code == 404
    # an admin's API token isn't a signed-in session
    tok = _mint(client, ["read", "generate"])["token"]
    assert anon.get("/api/print", headers=_bearer(tok)).status_code == 403
    assert client.get("/api/print/options").status_code == 200
    assert "/api/print" not in json.dumps(client.get("/api/openapi.json").json() if client.get(
        "/api/openapi.json").status_code == 200 else {})


def test_a_sign_job_end_to_end(client, llm):
    j = make(client)
    assert j["status"] == "done", j["stages"]
    assert j["size"]["label"] == "25 × 70 cm · 150 dpi · 1476 × 4134 px" and j["size"]["family"] == "tall"
    asked = next(x for x in llm if x["schema"] == "PrintConcepts")["user"]
    assert "Stjärnans Livs" in asked and "livs / mini market" in asked and "fresh & bright" in asked
    assert "Design 1: typographic" in asked and "Design 2: illustration" in asked
    fams = [c["family"] for c in j["concepts"]]
    assert fams == ["typographic", "illustration", "typographic"]  # a sign leans typographic
    second = j["concepts"][1]
    assert "5" not in second["headline"] and "08-123" not in second["cta"]  # no invented numbers
    assert second["offers"] == ["Bananer 19,90 kr/kg"] and "Gratis kaffe" in second["guard"]["offers_dropped"]
    assert j["concepts"][0]["headline"] == ""  # no hero line is allowed on a sign
    assert len(j["designs"]) == 3 and all(d["status"] == "ready" for d in j["designs"])
    d = j["designs"][0]
    assert d["spec"]["texts"]["name"] == "Stjärnans Livs" and d["spec"]["texts"]["hours"] == LINES["opening_hours"]
    assert d["report"]["min_text"]["pass"] and d["report"]["all_pass"]
    assert d["files"]["status"] == "none" and max(d["width"], d["height"]) == 2400
    with SessionLocal() as db:
        assert db.query(Generation).filter(Generation.target_type == "ad_photo").count() == 1  # the one illustration
        items = db.query(MediaItem).filter(MediaItem.home == "print").all()
        assert len(items) == 3 and all("print" in i.tags for i in items)

    # the files, on demand
    r = client.post(f"/api/print/{j['id']}/files", json={"design_ids": [d["id"]]})
    assert r.status_code == 202, r.text
    run_all()
    d = client.get(f"/api/print/{j['id']}").json()["designs"][0]
    assert d["files"]["status"] == "ready" and set(d["files"]["files"]) == set(ex.FORMATS)
    got = client.get(d["files"]["files"]["pdf"]["url"])
    assert got.status_code == 200 and got.content.startswith(b"%PDF-1.6")
    assert "stjarnans-livs-option-1-25x70cm.pdf" in got.headers["content-disposition"]

    # an edit lays the design out again and the files go stale
    r = client.patch(f"/api/print/{j['id']}/designs/{d['id']}", json={"colours": {"accent": "#C62828"},
                                                                       "texts": {"headline": "Välkommen"}})
    assert r.status_code == 200, r.text
    assert r.json()["files"]["status"] == "stale" and r.json()["version"] == 2
    assert r.json()["spec"]["texts"]["headline"] == "Välkommen"
    pv = client.post(f"/api/print/{j['id']}/designs/{d['id']}/preview", json={"decor": "frame"})
    assert pv.status_code == 200 and pv.headers["content-type"] == "image/png"
    assert client.patch(f"/api/print/{j['id']}/designs/{d['id']}", json={"layout": "hero_top"}).status_code == 200
    assert client.patch(f"/api/print/{j['id']}/designs/{d['id']}", json={"layout": "menu"}).status_code == 422


def test_print_jobs_stay_out_of_the_general_lists(client, llm):
    j = make(client, variants=1)
    assert all(i["id"] != j["designs"][0]["media_id"] for i in client.get("/api/media").json()["items"])
    assert client.get("/api/ads").json() == []
    assert client.get(f"/api/ads/{j['id']}").status_code == 404
    assert [x["id"] for x in client.get("/api/print").json()] == [j["id"]]


def test_board_with_photos_and_another_size(client, llm):
    j = make(client, job="board", width_cm=106, height_cm=160, variants=2, quality="final")
    assert j["status"] == "done" and [c["family"] for c in j["concepts"]] == ["photo", "typographic"]
    pic = j["concepts"][0]["pictures"]["photo"]
    assert pic["upscaled"], pic
    with SessionLocal() as db:
        up = db.get(Generation, pic["final"])
        assert up.params["upscale"]["width"] <= 8192 and up.params["upscale"]["scale"] <= 4.0
    d = j["designs"][0]
    assert d["report"]["layout"] in pl.PHOTO_LAYOUTS and d["report"]["used"]["photo"]
    r = client.post(f"/api/print/{j['id']}/designs/{d['id']}/resize", json={"width_cm": 70, "height_cm": 25,
                                                                           "job": "sign"})
    assert r.status_code == 201, r.text
    run_all()
    small = client.get(f"/api/print/{r.json()['id']}").json()
    assert small["status"] == "done" and small["size"]["family"] == "wide"
    assert small["concepts"][0]["pictures"]["photo"]["base"]["id"] == pic["base"]["id"]  # the same photo
    assert small["designs"][0]["report"]["layout"] == "photo_side"


def test_too_many_pixels_is_refused(client):
    r = client.post("/api/print", json={"job": "board", "width_cm": 106, "height_cm": 160, "dpi": 300,
                                        "lines": {"name": "X"}})
    assert r.status_code == 422 and "200 dpi" in r.text


def test_urdu_copy_gets_aerab_and_arabic_is_rtl(client, llm):
    j = make(client, language="ur", variants=1, lines={**LINES, "name": "سِتارہ جنرل سٹور"})
    assert j["rtl"] and ZABAR in j["concepts"][0]["cta"]
    assert j["designs"][0]["spec"]["rtl"] and j["designs"][0]["spec"]["texts"]["name"] == "سِتارہ جنرل سٹور"
    a = make(client, language="ar", variants=1)
    assert a["rtl"] and a["designs"][0]["status"] == "ready"


# ---------------------------------------------------------------- MCP

def test_mcp_tools_are_admin_only(client, login, anon, flags):
    flags(public_api=True)  # so a member can hold a token at all
    admin = Mcp(anon, _mint(client, ["read", "generate"])["token"])
    assert {"make_print_design", "get_print_design", "print_other_size"} <= admin.tools()
    member = login(_user("member2@test.local", "editor"))
    other = Mcp(anon, _mint(member, ["read", "generate"])["token"])
    assert not {"make_print_design", "get_print_design", "print_other_size"} & other.tools()
    res = other.call("make_print_design", width_cm=25, height_cm=70, lines={"name": "X"})
    assert res["isError"] and res["content"][0]["text"] == "Unknown tool: make_print_design"
    # even a broken call reads the same as a tool that isn't there
    res = other.call("get_print_design")
    assert res["content"][0]["text"] == "Unknown tool: get_print_design"


def test_mcp_makes_a_sample_with_files(client, anon, llm):
    m = Mcp(anon, _mint(client, ["read", "generate"])["token"])
    out = m.call_json("make_print_design", width_cm=25, height_cm=70, job="sign", lines=LINES, language="sv",
                      business_type="livs / mini market", style="fresh & bright", options=1, dpi=100)
    assert out["size"].startswith("25 × 70 cm · 100 dpi")
    run_all()
    got = m.call_json("get_print_design", design_id=out["design_id"])
    assert got["status"] == "done" and len(got["options"]) == 1
    opt = got["options"][0]
    assert opt["files_status"] == "ready" and set(opt["files"]) == set(ex.FORMATS) and opt["preview_url"]
    link = opt["files"]["pdf"].split("/api/files/")[1]
    r = anon.get(f"/api/files/{link}")
    assert r.status_code == 200 and r.content.startswith(b"%PDF")
    # made through MCP: still the owner's, in Print Studio
    assert [x["id"] for x in client.get("/api/print").json()] == [out["design_id"]]
    more = m.call_json("print_other_size", design_id=out["design_id"], option=1, width_cm=106, height_cm=160,
                       job="board", dpi=100)
    run_all()
    assert m.call_json("get_print_design", design_id=more["design_id"])["status"] == "done"
    with SessionLocal() as db:
        assert db.query(AdCampaign).filter(AdCampaign.kind == "print").count() == 2
