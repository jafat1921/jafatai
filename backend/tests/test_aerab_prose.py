"""Aerab on prose (contract v23 addendum): the tolerant letter alignment, sentence units, the time budget on
/api/text/aerab, the jobs route and the admin-only debug replies."""
import asyncio
import json
import random
import time

import httpx
import pytest

from app import aerab
from app.config import get_settings
from app.llm import set_transport
from app.main import app
from tests.test_api_tokens import _user, login  # noqa: F401  (login is a fixture)
from tests.test_storyboard import _run_all

ORIG = "بچوں نے صبر سے کہانی سنی"
GOOD = "بَچّوں نے صَبْر سے کَہانی سُنی"


def bare(text: str) -> str:
    return "".join(ch for ch in text if not aerab.is_mark(ch))


def reply(lines: list[str]) -> httpx.Response:
    content = json.dumps({"lines": lines}, ensure_ascii=False)
    return httpx.Response(200, json={"choices": [{"message": {"content": content}, "finish_reason": "stop"}],
                                     "usage": {}})


class Fake:
    """Async fake LLM: `fn` runs over each numbered line; `delay(n)` seconds before the n-th answer."""

    def __init__(self, fn, delay=None):
        self.fn, self.delay = fn, delay
        self.sent: list[list[str]] = []
        self.bodies: list[dict] = []

    async def __call__(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        self.bodies.append(body)
        lines = [row.split(". ", 1)[1] for row in body["messages"][-1]["content"].split("\n")]
        self.sent.append(lines)
        if self.delay:
            await asyncio.sleep(self.delay(len(self.sent)))
        return reply([self.fn(x) for x in lines])


@pytest.fixture
def fake():
    def install(fn, delay=None):
        f = Fake(fn, delay)
        set_transport(httpx.MockTransport(f))
        return f
    yield install
    set_transport(None)


def marks_from(marked: str):
    """An LLM that answers ORIG with GOOD and leaves anything else as it was."""
    return lambda x: marked if x == ORIG else x


# ---------------------------------------------------------------- tolerant transfer

def test_exact_answer_still_transfers():
    assert aerab.transfer(ORIG, GOOD) == GOOD


def test_a_swapped_letter_loses_only_its_own_mark():
    # the model "corrected" ص to س: everything around it still gets its marks, ص stays bare
    out = aerab.transfer(ORIG, "بَچّوں نے سَبْر سے کَہانی سُنی")
    assert out == "بَچّوں نے صبْر سے کَہانی سُنی"


def test_arabic_lookalikes_and_hamza_and_bari_ye_fold():
    # Arabic keyboard: ي for ے and ی, ك for ک, ه for ہ
    out = aerab.transfer(ORIG, "بَچّوں ني صَبْر سے كَهاني سُنی")
    assert out == GOOD
    # the izafat hamza dropped (ۂ written ہ) and a ۂ spelt ہ + hamza: same letter either way
    assert aerab.transfer("حلقۂ احباب", "حَلْقَہ اَحباب") == "حَلْقَۂ اَحباب"
    assert aerab.transfer("حلقۂ احباب", "حَلْقَۂ اَحباب") == "حَلْقَۂ اَحباب"


def test_dropped_zwnj_and_added_tatweel():
    orig = "کہانی‌کار نے لکھا"
    out = aerab.transfer(orig, "کَہـانی کار نے لِکھا")
    assert out == "کَہانی‌کار نے لِکھا"


def test_presentation_forms_digits_and_full_stop():
    # ﻻ is lam-alef as one glyph; 3 and . for ۳ and ۔
    out = aerab.transfer("لاہور میں سبق ۳ ختم ہوا۔", "ﻻہَور مِیں سَبَق 3 خَتْم ہُوا.")
    assert out == "لاہَور مِیں سَبَق ۳ خَتْم ہُوا۔"


def test_a_madda_never_turns_alif_into_alif_madda():
    assert aerab.transfer("اب جاؤ", "آب جاؤ") == "اب جاؤ"


def test_writers_marks_still_win():
    assert aerab.transfer("بُچوں نے صبر سے کہانی سنی", GOOD) == "بُچّوں نے صَبْر سے کَہانی سُنی"


def test_below_the_threshold_is_refused():
    text, ratio = aerab.align(ORIG, "بَچّوں کو اَچّھی کَہانی پَسَند ہے")
    assert text is None and ratio < aerab.MIN_ALIGNED
    assert aerab.transfer(ORIG, "") is None


def test_original_letters_never_change():
    rng = random.Random(7)
    letters = list("بپتٹثجچحخدڈذرڑزسشصضطظعغفقکگلمنوہھیے")
    marks = list("َُِّْ")
    texts = [ORIG, "ننھی گڑیا نے بارش میں چھتری کھولی۔", "دل کی بات", "حلقۂ احباب کا جلسہ"]
    for _ in range(400):
        orig = rng.choice(texts)
        noisy = []
        for ch in orig:
            r = rng.random()
            if r < 0.06:
                continue  # dropped
            if r < 0.12:
                ch = rng.choice(letters)  # swapped
            noisy.append(ch)
            if ch != " " and rng.random() < 0.6:
                noisy.append(rng.choice(marks))
            if rng.random() < 0.04:
                noisy.append(rng.choice(letters))  # added
        out = aerab.transfer(orig, "".join(noisy))
        assert out is None or bare(out) == bare(orig)


# ---------------------------------------------------------------- prose

BOOK = ("ایک دن ننھی گڑیا باغ میں گئی۔ وہاں اس نے ایک تتلی دیکھی!  تتلی نے پوچھا: تم کون ہو؟ "
        "گڑیا مسکرائی اور بولی کہ میں تمہاری دوست ہوں۔\n\n"
        "پھر دونوں نے مل کر پھولوں کے گیت گائے۔  شام ہوئی تو گڑیا گھر لوٹ آئی۔ ")


def test_sentences_round_trip_exactly():
    parts = aerab.units(BOOK)
    assert "".join(parts) == BOOK
    spoken = [p for p in parts if aerab.needs_marks(p)]
    # the long first paragraph goes as four sentences, the short second one whole
    assert len(spoken) == 5 and max(map(len, spoken[:4])) < 50
    # short lines (lyrics, dialogue) stay whole
    assert aerab.units("دل کی بات۔ ہے نا؟") == ["دل کی بات۔ ہے نا؟"]


def test_prose_unchanged_when_no_marks_come_back(fake):
    f = fake(lambda x: x)
    r = aerab.mark_sync(BOOK, "ur")
    assert r.text == BOOK and r.complete and r.remaining_chars == 0 and r.marked == 0
    assert max(len(line) for batch in f.sent for line in batch) < 80


def test_prose_is_marked_sentence_by_sentence(fake):
    first = "ایک دن ننھی گڑیا باغ میں گئی۔"
    fake(lambda x: "ایک دِن ننھی گُڑیا باغ مَیں گَئی۔" if x == first else x)
    r = aerab.mark_sync(BOOK, "ur")
    assert r.text == BOOK.replace(first, "ایک دِن ننھی گُڑیا باغ مَیں گَئی۔")
    assert r.marked == 1 and r.kept == 0 and 0 < r.coverage < 1


def test_batches_stay_small_and_carry_a_sized_token_budget(fake, monkeypatch):
    monkeypatch.setattr(aerab, "BATCH_CHARS", 80)
    f = fake(lambda x: x)
    aerab.mark_sync(BOOK, "ur")
    assert len(f.sent) >= 3 and all(sum(map(len, b)) <= 80 or len(b) == 1 for b in f.sent)
    assert all(b["max_tokens"] < 1000 for b in f.bodies)


def test_aerab_llm_model_setting(fake, monkeypatch):
    monkeypatch.setattr(get_settings(), "aerab_llm_model", "gemma4:26b")
    f = fake(marks_from(GOOD))
    assert aerab.mark_sync(ORIG, "ur").text == GOOD
    assert {b["model"] for b in f.bodies} == {"gemma4:26b"}


# ---------------------------------------------------------------- the routes

def test_time_budget_returns_partial(client, fake, monkeypatch):
    monkeypatch.setattr(aerab, "SYNC_BUDGET_S", 1.0)
    monkeypatch.setattr(aerab, "MIN_CALL_S", 0.05)
    monkeypatch.setattr(aerab, "BATCH_CHARS", 10)  # one sentence a call
    first = "ایک دن ننھی گڑیا باغ میں گئی۔"
    fake(lambda x: x.replace("دن", "دِن"), delay=lambda n: 0 if n == 1 else 5)
    t0 = time.monotonic()
    r = client.post("/api/text/aerab", json={"text": BOOK, "language": "ur"})
    assert time.monotonic() - t0 < 3
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["complete"] is False and body["remaining_chars"] > 100
    assert body["text"] == BOOK.replace(first, first.replace("دن", "دِن")) and body["marked"] == 1


def test_complete_answer_says_so(client, fake):
    fake(marks_from(GOOD))
    body = client.post("/api/text/aerab", json={"text": ORIG}).json()
    assert body["text"] == GOOD and body["complete"] is True and body["remaining_chars"] == 0
    assert body["coverage"] == 1.0 and "debug" not in body


def test_jobs_route(client, fake, fast_driver):
    fake(marks_from(GOOD))
    r = client.post("/api/text/aerab/jobs", json={"text": f"Chapter 1\n{ORIG}", "language": "ur"})
    assert r.status_code == 202, r.text
    assert r.json()["type"] == "text_aerab" and r.json()["lane"] == "general"
    _run_all(fast_driver)
    job = client.get(f"/api/jobs/{r.json()['id']}").json()
    assert job["status"] == "done", job
    res = job["result"]
    assert res["text"] == f"Chapter 1\n{GOOD}" and res["complete"] is True and res["marked"] == 1
    assert set(res) >= {"text", "marked", "kept", "low_coverage", "language", "complete", "remaining_chars"}
    assert client.post("/api/text/aerab/jobs", json={"text": "only English"}).status_code == 422


def test_jobs_route_fails_cleanly_when_the_llm_is_away(client, fast_driver):
    set_transport(None)
    r = client.post("/api/text/aerab/jobs", json={"text": ORIG})
    _run_all(fast_driver)
    job = client.get(f"/api/jobs/{r.json()['id']}").json()
    assert job["status"] == "failed" and "offline" in (job["error"] or "")


def test_debug_is_admin_only(client, fake, login):  # noqa: F811
    fake(marks_from(GOOD))
    body = client.post("/api/text/aerab?debug=1", json={"text": ORIG}).json()
    assert body["text"] == GOOD
    [call] = body["debug"]
    assert call["sent"] == [ORIG] and GOOD in call["reply"] and call["aligned"] == [1.0]
    editor = login(_user("ed@test.local", "editor"))
    r = editor.post("/api/text/aerab?debug=1", json={"text": ORIG})
    assert r.status_code == 403
    assert editor.post("/api/text/aerab", json={"text": ORIG}).status_code == 200
    params = app.openapi()["paths"]["/api/text/aerab"]["post"].get("parameters", [])
    assert all(p["name"] != "debug" for p in params)
