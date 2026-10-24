"""What Jafat won't picture: nothing sexual for anyone but admins, and no Prophet, Sahabi or other revered figure
for anyone. Words about them stay fine."""
import json

import httpx
import pytest
from sqlalchemy import select

from app import content_policy as cp
from app.db import SessionLocal
from app.llm import set_transport
from app.llm.client import with_house_rules
from app.models import AdminAudit, Generation, Job
from app.worker import process_one
from tests.test_ai import oa
from tests.test_implant import _client


class _Reviewer:
    """The writer and vision models: answers for the content checks, counted."""

    def __init__(self, depicts=False, nude=False):
        self.depicts, self.nude, self.asked, self.looked = depicts, nude, 0, 0

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            return httpx.Response(200, json={"data": [{"id": m} for m in ("fake-eye", "fake-writer", "fake-reasoner")]})
        text = json.dumps(json.loads(request.content).get("messages", []))
        if "depicts_revered_figure" in text:
            self.asked += 1
            return httpx.Response(200, json=oa(json.dumps({"depicts_revered_figure": self.depicts,
                                                           "sexual_or_revealing": False})))
        if "nudity_or_sexual" in text:
            self.looked += 1
            return httpx.Response(200, json=oa(json.dumps({"nudity_or_sexual": self.nude, "why": "test"})))
        return httpx.Response(500)


@pytest.fixture
def reviewer():
    def install(**kw):
        r = _Reviewer(**kw)
        set_transport(httpx.MockTransport(r))
        return r

    yield install
    set_transport(None)


@pytest.fixture
def member(client):
    with _client("sana@example.com") as c:
        yield c


def _run(fast_driver):
    for _ in range(20):
        if not process_one(driver_factory=fast_driver):
            return


def _last(_client):
    with SessionLocal() as db:
        g = db.scalars(select(Generation).where(Generation.kind == "image").order_by(Generation.created_at.desc())).first()
        j = db.scalars(select(Job).where(Job.generation_id == g.id)).first()
        return g, j


def test_the_words_catch_what_they_should_and_nothing_else():
    for bad in ("a naked woman", "Topless on a beach", "girl in a bikini", "NSFW art", "nangi larki", "ایک ننگی عورت",
                "she slowly undresses", "a woman without clothes"):
        assert cp.sexual_words(bad), bad
    for fine in ("Sussex countryside", "a comic strip about cats", "I saw a lion", "a woman in a red kameez",
                 "sextant on a ship's chart", "Christmas lights", "Mashallah written in gold"):
        assert not cp.sexual_words(fine), fine
    for named in ("Prophet Muhammad ﷺ on a hill", "Hazrat Ali with a sword", "the Sahaba praying", "Jesus walking",
                  "Imam Hussain at Karbala", "Muhammad (saw) speaking", "حضرت عمر"):
        assert cp.revered_words(named), named
    for fine in ("I saw a lion", "Muhammad Ali boxing", "a lighthouse at dusk", "the prophetic tone"):
        assert not cp.revered_words(fine), fine


def test_a_sexual_request_is_refused_at_once_except_for_an_admin(member, client):
    r = member.post("/api/images/generate", json={"prompt": "a naked woman on a bed"})
    assert r.status_code == 422 and "nude, sexual or revealing" in r.json()["detail"]
    with SessionLocal() as db:
        assert db.scalar(select(Generation).where(Generation.prompt.contains("naked"))) is None
    assert member.post("/api/images/generate", json={"prompt": "a red kite over Lahore"}).status_code == 202
    assert client.post("/api/images/generate", json={"prompt": "a naked woman on a bed"}).status_code == 202


def test_a_revered_figure_is_refused_for_everyone_but_calligraphy_is_fine(client, fast_driver, reviewer):
    rv = reviewer(depicts=True)
    # an admin too; the words alone don't refuse it, the worker asks the writer model
    assert client.post("/api/images/generate", json={"prompt": "a portrait of Prophet Muhammad ﷺ"}).status_code == 202
    _run(fast_driver)
    g, j = _last(client)
    assert g.status == "failed" and j.status == "failed" and "Prophets" in j.error and rv.asked == 1
    with SessionLocal() as db:
        assert db.scalar(select(AdminAudit).where(AdminAudit.action == "content_refused")) is not None

    reviewer(depicts=False)
    client.post("/api/images/generate", json={"prompt": "Muhammad ﷺ written in gold Thuluth calligraphy"})
    _run(fast_driver)
    g, _ = _last(client)
    assert g.status == "ready"


def test_a_revered_name_with_no_writer_model_is_refused(client, fast_driver):
    set_transport(httpx.MockTransport(lambda r: httpx.Response(500)))
    try:
        client.post("/api/images/generate", json={"prompt": "Hazrat Umar at dawn"})
        _run(fast_driver)
    finally:
        set_transport(None)
    g, j = _last(client)
    assert g.status == "failed" and "Prophets" in j.error


def test_the_finished_picture_is_looked_at_for_members_only(member, client, fast_driver, reviewer):
    rv = reviewer(nude=True)
    member.post("/api/images/generate", json={"prompt": "a woman on the beach at sunset"})
    _run(fast_driver)
    g, j = _last(member)
    assert g.status == "failed" and "nude, sexual or revealing" in j.error and rv.looked == 1

    client.post("/api/images/generate", json={"prompt": "a woman on the beach at sunset"})
    _run(fast_driver)
    g, _ = _last(client)
    assert g.status == "ready" and rv.looked == 1


def test_every_writer_gets_the_house_rules():
    msgs = with_house_rules([{"role": "system", "content": "You write films."}, {"role": "user", "content": "go"}])
    assert msgs[0]["content"].startswith("You write films.") and "Prophet Muhammad ﷺ" in msgs[0]["content"]
    assert "modestly dressed" in with_house_rules([{"role": "user", "content": "go"}])[0]["content"]


def test_a_members_render_carries_the_safety_negative(client):
    from types import SimpleNamespace

    with SessionLocal() as db:
        gen = SimpleNamespace(kind="image", target_type="library", prompt="a kite", params={"negative": "blurry"}, id="g")
        ctx = SimpleNamespace(db=db, job=SimpleNamespace(user_id=None), progress=lambda *a: None)
        params = {"negative": "blurry"}
        cp.check_before(ctx, gen, params)
    assert params["negative"] == f"blurry, {cp.SAFE_NEGATIVE}"
