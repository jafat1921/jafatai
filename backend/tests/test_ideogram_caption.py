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
    assert data["compositional_deconstruction"]["elements"][0]["text"] == "OPEN"
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
    assert "bbox" not in text
    assert "subject" not in text["desc"].lower()
    assert "precise neoclassical serif typography" in text["desc"]
    assert "blueprint cyan" not in text["desc"]  # only the lettering clauses travel


def test_a_wide_text_box_is_kept():
    assert ic._text_box([70, 100, 230, 900], "Daily Bread", "2:3") == [70, 100, 230, 900]
    assert ic._text_box([300, 100, 700, 200], "Daily Bread", "1:1") is None
