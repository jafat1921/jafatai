"""Exact English lettering: blank surfaces in the caption, real type set into them afterwards."""
import json

from PIL import Image

from app import ideogram_caption as ic
from app import ideogram_text as it
from app.ads.layout import lum, mean_lum, ratio

ANNOUNCEMENT = ('golden Islamic archway, elegant calligraphy above arch "Alhamdulillah A Grandson Is Born", '
                'ornate pillars left reads "Mr and Mrs Saadat Ali" right reads "Proud Grandparents", '
                'flowing ribbon beneath "Son of Adeel and Fatima 3rd October 2026"')


def test_only_three_or_more_english_lines_go_exact():
    assert ic.exact_lines(ANNOUNCEMENT) == ["Alhamdulillah A Grandson Is Born", "Mr and Mrs Saadat Ali",
                                            "Proud Grandparents", "Son of Adeel and Fatima 3rd October 2026"]
    assert ic.exact_lines('a neon sign "Chai & Chill" and "Open late"') == []
    assert ic.exact_lines('"One" "Two" "صبر"') == []


def test_blank_out_swaps_words_for_blank_surfaces(monkeypatch):
    monkeypatch.setattr(ic, "chat_sync", lambda *a, **k: (_ for _ in ()).throw(ic.LLMError("down")))
    caption, _ = ic.write(ANNOUNCEMENT, 832, 1280, aspect_ratio="2:3")
    blanked, layout = ic.blank_out(caption, ANNOUNCEMENT)
    data = json.loads(blanked)
    els = data["compositional_deconstruction"]["elements"]
    assert not any(e["type"] == "text" for e in els)
    assert all(ln["text"] not in blanked for ln in layout)  # nothing left for the model to paint
    assert [ln["text"] for ln in layout] == ic.exact_lines(ANNOUNCEMENT)
    assert all(len(ln["bbox"]) == 4 for ln in layout)
    descs = " ".join(e["desc"] for e in els)
    assert "ribbon" in descs and "plaque" in descs
    by_text = {ln["text"]: ln["hint"] for ln in layout}
    assert "calligraphy" in by_text["Alhamdulillah A Grandson Is Born"]


def test_faces_follow_the_look_words():
    assert it.face_for("elegant calligraphy above arch")[0].name == "GreatVibes-Regular.ttf"
    assert it.face_for("playful hand-drawn title lettering")[0].name.startswith("DancingScript")
    assert it.face_for("precise neoclassical serif")[0].name.startswith("PlayfairDisplay")
    assert it.face_for("")[0].name.startswith("Montserrat")
    for path, _ in [(p, w) for _, p, w in it.FACES]:
        assert path.is_file(), path


def test_ink_reads_on_light_and_dark(tmp_path):
    for bg in ((245, 238, 220), (20, 24, 40)):
        img = Image.new("RGB", (400, 200), bg)
        ink = it.ink_for(img, (0, 0, 400, 200), "")
        assert ratio(lum(ink), mean_lum(img, (0, 0, 400, 200))) >= 4.5


def test_set_text_draws_inside_its_box_and_keeps_the_art(tmp_path):
    path = tmp_path / "pic.png"
    Image.new("RGB", (800, 1200), (240, 230, 210)).save(path)
    layout = [{"text": "Son of Adeel and Fatima 3rd October 2026", "bbox": [850, 100, 950, 900],
               "hint": "serif on a ribbon"}]
    rep = it.set_text(path, layout)
    assert (tmp_path / "pic_art.png").is_file() and rep["art"] == "pic_art.png"
    with Image.open(path) as im:
        px = im.convert("L")
        inside = px.crop((80, 1020, 720, 1140))
        above = px.crop((0, 0, 800, 980))
        assert inside.getextrema()[0] < 120  # dark ink went down in the box
        assert above.getextrema()[0] > 200  # and nowhere else
