"""Ideogram 4 gets a JSON caption written for it; the user's quoted words survive whatever the LLM does."""
import json

from app import ideogram_caption as ic
from app.drivers.comfy import plan_generation
from app.llm.client import ChatResult, LLMError
from app.workflows import build, find_node


class Ctx:
    class DB:
        commits = 0

        def commit(self):
            self.commits += 1

    def __init__(self):
        self.db = self.DB()

    def progress(self, *_):
        pass


class Gen:
    def __init__(self, prompt, params):
        self.prompt, self.params = prompt, params


def llm_says(monkeypatch, cap: dict | Exception):
    def fake(role, msgs, **kw):
        if isinstance(cap, Exception):
            raise cap
        assert kw["schema"] is ic.Caption and "Aspect ratio: 2:3" in msgs[1]["content"]
        return ChatResult(content="", thinking="", model="x", data=ic.Caption.model_validate(cap))
    monkeypatch.setattr(ic, "chat_sync", fake)


def test_quoted_words_win_over_a_paraphrase(monkeypatch):
    llm_says(monkeypatch, {
        "high_level_description": "A coffee shop poster with a latte.",
        "style_description": {"medium": "graphic_design", "color_palette": ["#F3E9DC"]},
        "background": "Cream backdrop over an oak table.",
        "elements": [
            {"type": "text", "bbox": [60, 80, 200, 920], "text": "Fresh Coffee!", "desc": "Bold headline."},
            {"type": "obj", "bbox": [380, 220, 900, 780], "desc": "A white cup of latte on a saucer."},
            {"type": "obj", "bbox": [900, 0, 100, 50], "desc": "A spoon."},  # upside-down box: dropped
        ]})
    cap, by_llm = ic.write('A poster that says "FRESH COFFEE" and "Öppet 08–22"', 832, 1248)
    data = json.loads(cap)
    assert by_llm and data["aspect_ratio"] == "2:3"
    texts = [e["text"] for e in data["compositional_deconstruction"]["elements"] if e["type"] == "text"]
    assert texts == ["FRESH COFFEE", "Öppet 08–22"]  # the paraphrased headline is replaced, accents kept
    spoon = data["compositional_deconstruction"]["elements"][-3]
    assert "bbox" not in spoon
    assert "Öppet" in cap  # not \u-escaped


def test_no_llm_still_sends_a_caption(monkeypatch):
    llm_says(monkeypatch, LLMError("down"))
    cap, by_llm = ic.write('a sign "OPEN"', 832, 1248)
    data = json.loads(cap)
    assert not by_llm and data["high_level_description"] == 'a sign "OPEN"'
    assert data["compositional_deconstruction"]["elements"][-1]["text"] == "OPEN"
    assert ic.is_caption(cap)


def test_job_only_touches_ideogram_and_never_twice(monkeypatch):
    llm_says(monkeypatch, LLMError("down"))
    other = Gen("a fox", {"model": "zimage_turbo"})
    ic.run_in_job(Ctx(), other)
    assert "ideogram_caption" not in other.params
    pasted = Gen('{"high_level_description": "a fox"}', {"model": "ideogram4"})
    ic.run_in_job(Ctx(), pasted)
    assert "ideogram_caption" not in pasted.params
    gen = Gen("a fox", {"model": "ideogram4", "width": 832, "height": 1248})
    ic.run_in_job(Ctx(), gen)
    assert gen.prompt == "a fox" and gen.params["ideogram_caption_by"] == "fallback"
    first = gen.params["ideogram_caption"]
    ic.run_in_job(Ctx(), gen)
    assert gen.params["ideogram_caption"] == first


def test_driver_renders_the_caption_not_the_prose(tmp_path):
    cap = ic.fallback("a fox", "1:1")
    p = plan_generation("image", "a fox", {"model": "ideogram4", "ideogram_caption": cap}, 1, None)
    g, _ = build(p.template, p.inputs)
    assert g[find_node(g, "Positive")]["inputs"]["text"] == cap


def test_the_sideways_subject_logo_is_repaired(monkeypatch):
    # the caption gemma wrote for the Ouroboros logo on 22 Oct: a tall thin text box printed the name on end,
    # and "Text logo for the subject." put the word "Subject" on the logo
    llm_says(monkeypatch, {
        "high_level_description": "An ouroboros serpent forms a grand spiral staircase.",
        "style_description": {"medium": "Graphic Design"},
        "background": "Midnight charcoal backdrop",
        "elements": [
            {"type": "obj", "bbox": [200, 100, 800, 900], "desc": "Ouroboros serpent coiled in a spiral."},
            {"type": "text", "bbox": [300, 100, 700, 200], "text": "Ouroboros Architectonica",
             "desc": "Text logo for the subject."}]})
    prompt = ('Visionary logo for "Ouroboros Architectonica", architectural white and blueprint cyan, '
              'precise neoclassical serif typography, centred composition')
    data = json.loads(ic.write(prompt, 832, 1248)[0])
    assert data["style_description"]["medium"] == "graphic_design"
    text = data["compositional_deconstruction"]["elements"][1]
    y1, x1, y2, x2 = text["bbox"]  # the tall box is gone; the name sits in a wide band under the emblem
    assert x2 - x1 > (y2 - y1) * 3
    assert "subject" not in text["desc"].lower()
    assert "precise neoclassical serif typography" in text["desc"]
    assert "blueprint cyan" not in text["desc"]  # only the lettering clauses travel


def test_a_wide_text_box_is_kept():
    assert ic._text_box([70, 100, 230, 900], "Daily Bread", "2:3") == [70, 100, 230, 900]
    assert ic._text_box([300, 100, 700, 200], "Daily Bread", "1:1") is None


def test_unplaced_name_gets_a_band_under_the_emblem(monkeypatch):
    # the second Ouroboros try: emblem across the whole canvas, the name with no box, printed tiny in the middle
    llm_says(monkeypatch, {
        "high_level_description": "A logo of an ouroboros staircase.",
        "background": "A solid midnight charcoal backdrop.",
        "elements": [{"type": "obj", "bbox": [100, 100, 900, 900], "desc": "An ouroboros serpent staircase."},
                     {"type": "text", "text": "Ouroboros Architectonica", "desc": "Neoclassical serif capitals."}]})
    data = json.loads(ic.write('Logo for "Ouroboros Architectonica", serif typography', 832, 1248)[0])
    emblem, name = data["compositional_deconstruction"]["elements"]
    assert name["bbox"][0] >= 560 and name["bbox"][2] <= 1000
    assert emblem["bbox"][2] < name["bbox"][0]
    w, h = emblem["bbox"][3] - emblem["bbox"][1], emblem["bbox"][2] - emblem["bbox"][0]
    assert abs(w - h) <= 2  # still square


def test_no_pictures_placed_leaves_the_words_free(monkeypatch):
    llm_says(monkeypatch, LLMError("down"))
    data = json.loads(ic.write('a sign "OPEN"', 832, 1248)[0])
    assert "bbox" not in data["compositional_deconstruction"]["elements"][0]


ANNOUNCEMENT = ('golden Islamic archway, elegant calligraphy above arch "Alhamdulillah A Grandson Is Born", '
                'ornate pillars left reads "Mr and Mrs Saadat Ali" right reads "Proud Grandparents", '
                'flowing ribbon beneath "Son of Adeel and Fatima 3rd October 2026", precise serif typography')


def test_each_line_carries_its_own_place_and_only_shared_type_words():
    assert ic._type_hint(ANNOUNCEMENT) == "precise serif typography"
    where = ic._placements(ANNOUNCEMENT)
    assert where["Mr and Mrs Saadat Ali"] == "ornate pillars left"
    assert where["Proud Grandparents"] == "ornate pillars right"
    assert where["Son of Adeel and Fatima 3rd October 2026"] == "flowing ribbon beneath"


def test_the_picked_aspect_beats_the_pixel_ratio(monkeypatch):
    llm_says(monkeypatch, LLMError("down"))
    data = json.loads(ic.write(ANNOUNCEMENT, 832, 1280, aspect_ratio="2:3")[0])
    assert data["aspect_ratio"] == "2:3"
    texts = {e["text"]: e["desc"] for e in data["compositional_deconstruction"]["elements"] if e["type"] == "text"}
    assert "ribbon beneath" in texts["Son of Adeel and Fatima 3rd October 2026"]
    assert "above arch" not in texts["Proud Grandparents"]


def test_a_word_drawn_as_an_object_is_not_drawn_twice(monkeypatch):
    llm_says(monkeypatch, {
        "high_level_description": "Gold calligraphy of the word on emerald.",
        "background": "A deep emerald wall with faint geometric patterns.",
        "elements": [{"type": "obj", "bbox": [300, 200, 700, 800],
                      "desc": 'The Arabic word "صبر" in flowing gold Thuluth calligraphy, centred.'},
                     {"type": "text", "text": "صبر", "desc": "Flowing gold Thuluth calligraphy, centred."}]})
    data = json.loads(ic.write('Arabic calligraphy of the word "صبر" in gold Thuluth script', 832, 1248)[0])
    els = data["compositional_deconstruction"]["elements"]
    assert [e["type"] for e in els] == ["obj", "text"]  # the stand-in frame, not the word as a picture
    assert "صبر" not in els[0]["desc"]
    assert "bbox" not in els[1]  # nothing placed, so no lockup band pushing it to the bottom


def test_no_marker_words_reach_the_picture(monkeypatch):
    # "THIS LINE" was printed on the announcement: descs carry plain lowercase location words only
    llm_says(monkeypatch, LLMError("down"))
    cap = ic.write(ANNOUNCEMENT, 832, 1280, aspect_ratio="2:3")[0]
    assert "THIS LINE" not in cap and "another line" not in cap
    assert ic._placements(ANNOUNCEMENT)["Alhamdulillah A Grandson Is Born"] == "elegant calligraphy above arch"
    assert ic._placements('a sign titled “Chai & Chill”')["Chai & Chill"] == "a sign"


def test_a_words_only_caption_gets_a_picture_element(monkeypatch):
    llm_says(monkeypatch, {
        "high_level_description": "A Swiss typographic poster.",
        "style_description": {"aesthetics": "Swiss style, paper collage"},
        "background": "A cream paper sheet.",
        "elements": [{"type": "text", "text": "STAY CURIOUS", "desc": "Giant condensed sans-serif capitals."}]})
    els = json.loads(ic.write('Swiss poster with the words "STAY CURIOUS"', 832, 1248)[0])[
        "compositional_deconstruction"]["elements"]
    assert els[0]["type"] == "obj" and "paper collage" in els[0]["desc"]
    assert "STAY CURIOUS" not in els[0]["desc"]
    assert els[1]["text"] == "STAY CURIOUS"
