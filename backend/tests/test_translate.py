"""TranslateGemma as the translation path (app.llm.translate) and the dub routed through it."""
import json
import logging

import httpx
import pytest

from app.config import get_settings
from app.dub import text as tx
from app.llm import set_transport
from app.llm import translate as tl
from tests.test_dub import URDU, FakeLLM, get, make_dub, statuses
from tests.test_storyboard import _run_all

GEMMA = "translategemma:27b"

UR_PROMPT = (
    "You are a professional English (en) to Urdu (ur-PK) translator. Your goal is to accurately convey the meaning "
    "and nuances of the original English text while adhering to Urdu grammar, vocabulary, and cultural "
    "sensitivities.\n"
    "Produce only the Urdu translation, without any additional explanations or commentary. Please translate the "
    "following English text into Urdu:\n\n\n"
    "The river remembers."
)


def plain(text: str) -> httpx.Response:
    return httpx.Response(200, json={"choices": [{"message": {"content": text}, "finish_reason": "stop"}],
                                     "usage": {}})


def source_of(user: str) -> str:
    return user.split("\n\n\n", 1)[1]


class Gemma(FakeLLM):
    """The dub's fake LLM plus a model list and TranslateGemma's plain-text answers."""

    def __init__(self, installed=(GEMMA, "fake-writer")):
        super().__init__()
        self.installed = list(installed)
        self.bodies: list[dict] = []
        self.renumber = False

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            return httpx.Response(200, json={"data": [{"id": m} for m in self.installed]})
        body = json.loads(request.content)
        first = body["messages"][0]["content"]
        if not first.startswith("You are a professional"):
            return super().__call__(request)
        self.calls.append("gemma")
        self.bodies.append(body)
        urdu = "(ur-PK) translator" in first
        rows = source_of(first).split("\n")
        if len(rows) == 1:
            return plain(URDU if urdu else f"linea {rows[0]}")
        if self.renumber:
            return plain("\n".join(f"{k + 2}. {URDU}" for k in range(len(rows))))
        # the model writes Urdu digits and the Urdu full stop
        return plain("\n".join(f"{str(k).translate(str.maketrans('0123456789', '۰۱۲۳۴۵۶۷۸۹'))}۔ {URDU}"
                               if urdu else f"{k}. linea {r.split('. ', 1)[1]}" for k, r in enumerate(rows, 1)))


@pytest.fixture
def gemma(monkeypatch):
    monkeypatch.setattr(get_settings(), "translate_llm_model", GEMMA)
    fake = Gemma()
    set_transport(httpx.MockTransport(fake))
    tl._said.clear()
    yield fake
    set_transport(None)


# ------------------------------------------------------------------ the prompt and the parsing

def test_prompt_is_the_model_card_template():
    assert tl.prompt("The river remembers.", "en", "ur") == UR_PROMPT
    assert tl.lang_tag("pa-Arab") == ("pa-Arab", "Punjabi") and tl.lang_tag("es") == ("es", "Spanish")
    assert tl.lang_tag("zh") == ("zh-Hans", "Chinese")


def test_parse_numbered_is_strict():
    assert tl.parse_numbered("1. one\n\n2) two\n۳۔ تین", 3) == ["one", "two", "تین"]
    assert tl.parse_numbered("1. one two", 2) is None  # merged
    assert tl.parse_numbered("1. one\n3. two", 2) is None
    assert tl.parse_numbered("Here you go:\n1. one", 1) is None
    assert tl.parse_numbered("1. one\n2. ", 2) is None


def test_chunks_keep_multiline_texts_alone_and_cap_the_size():
    items = list(enumerate(["a"] * 10 + ["two\nlines", "b"]))
    sizes = [len(c) for c in tl.chunks(items)]
    assert sizes == [8, 2, 1, 1]
    assert [i for i, _ in tl.chunks(items)[2]] == [10]
    assert [len(c) for c in tl.chunks(list(enumerate(["x" * 500] * 3)))] == [1, 1, 1]


# ------------------------------------------------------------------ the call

def test_translate_numbers_a_chunk_and_sends_plain_text(gemma):
    out = tl.translate(["Hello.", "", "Where were you?"], "en", "ur")
    assert out == [URDU, "", URDU]
    assert gemma.calls == ["gemma"]
    body = gemma.bodies[0]
    assert body["model"] == GEMMA and len(body["messages"]) == 1 and body["messages"][0]["role"] == "user"
    assert "response_format" not in body and body["temperature"] == 0.0
    assert source_of(body["messages"][0]["content"]) == "1. Hello.\n2. Where were you?"


def test_a_garbled_chunk_is_asked_line_by_line(gemma):
    gemma.renumber = True
    assert tl.translate(["Hello.", "Where were you?"], "en", "ur") == [URDU, URDU]
    assert gemma.calls == ["gemma"] * 3
    assert [source_of(b["messages"][0]["content"]) for b in gemma.bodies[1:]] == ["Hello.", "Where were you?"]


def test_not_installed_falls_back_to_the_creative_model_and_says_so_once(gemma, caplog):
    gemma.installed = ["fake-writer"]
    caplog.set_level(logging.INFO, "mixai.llm")
    assert tl.translator("en", "ur") is None and tl.translator("en", "ur") is None
    assert sum("isn't installed" in r.getMessage() for r in caplog.records) == 1
    assert tl.translate(["Hello."], "en", "ur") == [URDU]
    assert gemma.bodies[0]["model"] == "fake-writer"


def test_translator_needs_both_languages_and_the_setting(gemma, monkeypatch):
    assert tl.translator("en", "ur") == GEMMA
    assert tl.translator("en", "ur-PK") == GEMMA
    assert tl.translator("en", "skr") is None and tl.translator(None, "ur") is None
    assert tl.translator("ur", "ur") is None
    monkeypatch.setattr(get_settings(), "translate_llm_model", "")
    assert tl.translator("en", "ur") is None


# ------------------------------------------------------------------ the dub

BATCH = [{"id": "a", "start": 0.0, "end": 2.0, "text": "Hello there.", "speaker": "Nadia"},
         {"id": "b", "start": 2.0, "end": 4.0, "text": "Meet me at the Reef.", "speaker": "Omar"},
         {"id": "c", "start": 4.0, "end": 4.6, "text": "Fine, I will come, I promise you that.", "speaker": "Nadia"}]
GLOSSARY = [{"source": "Reef", "target": {"ur": "ریف"}}]


def test_dub_translates_faithfully_then_the_editor_fixes_only_what_needs_it(gemma):
    seen = []
    real = gemma.__call__

    def spy(request):
        if request.method == "POST":
            seen.append(json.loads(request.content)["messages"][-1]["content"])
        return real(request)

    set_transport(httpx.MockTransport(spy))
    gemma.long_ids = set()
    out = tx.translate_batch(BATCH, "en", "ur", GLOSSARY, careful=False)
    assert out == {"a": URDU, "b": URDU, "c": URDU}
    assert gemma.calls == ["gemma", "review"]
    # b has a glossary term, c's 0.6 s slot holds ~2 words: only those reach the editor
    editor = seen[-1].split("\n")
    assert [r.split(" | ")[0] for r in editor] == ["b", "c"] and f"draft: {URDU}" in editor[0]

    gemma.calls.clear()
    tx.translate_batch(BATCH[:1], "en", "ur", [], careful=False)
    assert gemma.calls == ["gemma"]
    tx.translate_batch(BATCH[:1], "en", "ur", [], careful=True)
    assert gemma.calls == ["gemma", "gemma", "review"]


def test_dub_keeps_the_old_prompt_without_translategemma(gemma):
    gemma.installed = ["fake-writer"]
    assert tx.translate_batch(BATCH[:1], "en", "ur", [], careful=False) == {"a": URDU}
    assert gemma.calls == ["translate"]


def test_a_failing_translategemma_falls_back_for_the_batch(gemma):
    real = gemma.__call__

    def broken(request):
        if request.method == "POST" and json.loads(request.content)["messages"][0]["content"].startswith("You are a"):
            return httpx.Response(500, json={"error": "out of memory"})
        return real(request)

    set_transport(httpx.MockTransport(broken))
    assert tx.translate_batch(BATCH[:1], "en", "ur", [], careful=False) == {"a": URDU}
    assert gemma.calls == ["translate"]


def test_the_dub_stage_routes_through_translategemma_and_still_marks_urdu(client, tmp_path, fast_driver, gemma):
    d = make_dub(client, tmp_path)
    _run_all(fast_driver)
    assert statuses(get(client, d["id"]))["speakers"] == "review"
    assert client.post(f"/api/dubs/{d['id']}/continue").status_code == 202
    _run_all(fast_driver)
    d = get(client, d["id"])
    assert statuses(d)["translate"] == "review"
    first = d["segments"][0]
    assert first["target"]["ur"]["text"] == "یَہ ایک لائن ہے"  # aerab after TranslateGemma, as before
    assert first["target"]["es"]["text"] == f"linea {first['source_text']}"
    assert "gemma" in gemma.calls and "aerab" in gemma.calls and "translate" not in gemma.calls
