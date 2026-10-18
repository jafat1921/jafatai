"""A weak planner and writer that ignore the brief (one long shot, English lines, a silent scene, a mixed-script
title) still make an Urdu film with the right number of shots."""
import json

import httpx
import pytest
from sqlalchemy import select

from app import aerab, ai_jobs
from app import film_language as fl
from app.config import get_settings
from app.db import SessionLocal
from app.llm import set_transport
from app.llm import translate as tr
from app.models import Project, Scene, Shot
from tests.test_ai import oa
from tests.test_autopilot import drive
from tests.test_character_sheet import studio_character, with_portrait
from tests.test_quick_feature import URDU, FeatureBrain, aerab_calls, mark  # noqa: F401 (fixture)

ENGLISH = "We have to make this perfect for them."
TITLE_UR = "رمضان کی روشنی"
LONG_UR = " ".join([URDU] * 14)  # 70 words: about 30 s at Urdu's pace


class StubbornBrain(FeatureBrain):
    def __init__(self, models=()):
        super().__init__(short_first=False)
        self.drafts = 0
        self.models = list(models)

    def outline(self, n):
        out = super().outline(n)
        return {**out, "title": "The Light of Ramadan", "title_local": "روشni (The Light of Ramadan)"}

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.method == "GET":  # the installed-models check
            return httpx.Response(200, json={"data": [{"id": m} for m in self.models]})
        body = json.loads(request.content)
        k = self.kind(body)
        if k == "ShotList":
            self.bodies.setdefault(k, []).append(body)
            n = len(self.bodies[k])
            if n <= 2:
                # broken JSON, and the client's own repair pass no better: the autopilot asks once more
                return httpx.Response(200, json=oa('{"shots": [{"shot_type": "wide", "duration_s": '))
            # one long shot every time, with nobody named in it; scene 1's drops its line, scene 2's is English
            line = [] if n <= 4 else [{"character": "Mara", "text": ENGLISH}]
            return httpx.Response(200, json=oa(json.dumps({"shots": [
                {"shot_type": "wide", "duration_s": 30, "description": "At the window", "camera": "static",
                 "characters": [], "start_visual": "A window", "end_visual": "A smile", "dialogue": line}]})))
        if k == "draft":
            self.bodies.setdefault(k, []).append(body)
            self.drafts += 1
            # the first scene comes back silent once, then in English, like the live run
            text = "Mara lights the lamps." if self.drafts == 1 else f"Mara lights the lamps.\n\nMARA\n{ENGLISH}"
            return httpx.Response(200, json=oa(text))
        return super().__call__(request)


@pytest.fixture(params=[True, False], ids=["film-model", "roles"])
def stubborn(request, monkeypatch):
    calls = []
    monkeypatch.setattr(get_settings(), "film_llm_model", "gemma4:26b")

    def translate(texts, source, target, tick=None, model=None):
        calls.append((list(texts), source, target))
        return [TITLE_UR if t == "The Light of Ramadan" else LONG_UR for t in texts]

    monkeypatch.setattr(tr, "translate", translate)
    b = StubbornBrain(models=["gemma4:26b", "qwen2.5:14b"] if request.param else ["qwen2.5:14b"])
    b.film = request.param
    set_transport(httpx.MockTransport(b))
    yield b, calls
    set_transport(None)


def test_a_stubborn_planner_still_makes_the_film_it_was_asked_for(client, stubborn, aerab_calls, fast_driver,
                                                                  monkeypatch):
    from app import autopilot as ap_mod

    monkeypatch.setattr(ap_mod.Autopilot, "audio_first", property(lambda self: False))  # the planner's path
    b, translated = stubborn
    mara = studio_character(client, name="Mara", description="Woman, 60s, grey braid")
    with_portrait(client, fast_driver, mara)
    r = client.post("/api/quick", json={"prompt": "Ramadan lamps in an old lane", "language": "ur",
                                        "cast_ids": [mara["id"]], "scenes": 2, "scene_seconds": 60,
                                        "title_intro": True})
    assert r.status_code == 201, r.text
    out = r.json()
    job = drive(out["job"]["id"], fast_driver, limit=800)
    assert job.status == "done", job.error

    drafts = [d["messages"][-1]["content"] for d in b.bodies["draft"]]
    # thin scenes asked again with a word count: silent first, then a single short English line
    assert "nobody speaking" in drafts[1] and "only 8 spoken words" in drafts[3]
    assert "about 83 spoken words" in drafts[0]  # 60 s x 60 % spoken x 2.3 words a second
    # the scripts ran ~31 s against 60 s each: rewritten once with the timing table, then the plan follows them
    assert len(drafts) == 8 and "Timing check" in drafts[4] and "needs about 60 s" in drafts[4]
    o = job.result["outline"]
    assert all(28 < s < 34 for s in o["content_seconds"].values())
    assert o["durations"] == {k: v for k, v in o["content_seconds"].items()}

    # the shot list: broken JSON re-asked with the failed answer as the assistant's turn; one shot each time,
    # so asked again with the count; then split into consecutive beats
    lists = b.bodies["ShotList"]
    assert len(lists) == 6 and lists[2]["messages"][-2]["role"] == "assistant"
    assert lists[2]["temperature"] == 0.3 and "It must have exactly 5 shots" in lists[3]["messages"][-1]["content"]
    with SessionLocal() as db:
        project = db.get(Project, out["project"]["id"])
        assert project.title == "The Light of Ramadan"
        assert job.result["outline"]["title_local"] == mark(TITLE_UR)
        scenes = db.scalars(select(Scene).where(Scene.project_id == project.id).order_by(Scene.order)).all()
        assert len(scenes) == 2
        for sc in scenes:
            assert ENGLISH not in sc.script_text and mark(LONG_UR) in sc.script_text
            shots = db.scalars(select(Shot).where(Shot.scene_id == sc.id).order_by(Shot.order)).all()
            assert len(shots) == 5 and max(s.duration_s for s in shots) <= 10
            # at least the scene's content; a lip-synced shot grows to fit its lines
            assert sum(s.duration_s for s in shots) >= o["durations"][sc.id] - 1.5
            assert len({s.shot_type for s in shots}) > 1
            # nobody named by the planner: the scene's speaker is in every shot
            assert all(s.character_ids == [mara["id"]] for s in shots)
            lines = [d for s in shots for d in s.dialogue or []]
            # the script's one speech, at its sentence breaks, each piece in exactly one shot (the planner
            # dropped it, or said it in English)
            assert len(lines) >= 3 and all(d["language"] == "ur" for d in lines)
            assert " ".join(aerab.strip(d["text"]) for d in lines).split() == LONG_UR.split()
    assert any("The Light of Ramadan" in t for t, _, _ in translated)
    # every writing / planning step on FILM_LLM_MODEL when it's installed; the eye keeps its own model
    written = [x for k in ("QuickOutline", "draft", "ShotList", "FramePrompts", "LocationList") for x in b.bodies[k]]
    assert written and all((x["model"] == "gemma4:26b") is b.film for x in written)
    assert all(x["model"] != "gemma4:26b" for x in b.bodies.get("VisionScore", []))
    assert job.result["film_model"] == ("gemma4:26b" if b.film else None)
    assert all(src == "en" and dst == "ur" for _, src, dst in translated)


def test_split_plans_spreads_beats_and_lines():
    plans = [{"shot_type": "wide", "duration_s": 60, "description": "Lamps", "dialogue": [{"text": str(i)}
              for i in range(4)], "character_ids": ["c"], "start_prompt": "s", "end_prompt": "e"}]
    out = ai_jobs.split_plans(plans, 8)
    assert len(out) == 8 and sum(p["duration_s"] for p in out) == pytest.approx(60)
    assert max(p["duration_s"] for p in out) <= 10
    assert [d["text"] for p in out for d in p["dialogue"]] == ["0", "1", "2", "3"]
    assert {p["shot_type"] for p in out} >= {"wide", "medium", "close_up"}
    # enough shots already, but one of them longer than one pass
    out = ai_jobs.split_plans([{"duration_s": 5, "dialogue": []}, {"duration_s": 50, "dialogue": []}], 2)
    assert len(out) == 9 and max(p["duration_s"] for p in out) <= 10
    assert sum(p["duration_s"] for p in out) == pytest.approx(55, abs=0.5)
    assert ai_jobs.split_plans([], 3) == []


def test_script_checks_and_titles(monkeypatch):
    assert fl.off_script(ENGLISH, "ur") and not fl.off_script(URDU, "ur") and not fl.off_script(ENGLISH, "en")
    assert not fl.pure("روشni", "ur") and fl.pure(TITLE_UR, "ur")
    monkeypatch.setattr(tr, "translate", lambda texts, *a, **k: [TITLE_UR for _ in texts])
    assert fl.clean_titles("The Light of Ramadan", "روشni (The Light of Ramadan)", "ur") == \
        ("The Light of Ramadan", TITLE_UR)
    assert fl.clean_titles("روشنی (The Light of Ramadan)", "روشنی", "ur") == ("The Light of Ramadan", "روشنی")
    assert fl.clean_titles("Storm", "Storm", "en") == ("Storm", "Storm")
    script = f"INT. LANE - NIGHT\nMara walks.\n\nMARA\n{ENGLISH}\n\nMARA\n{URDU}"
    monkeypatch.setattr(tr, "translate", lambda texts, *a, **k: [URDU for _ in texts])
    assert fl.localise_script(script, "ur") == f"INT. LANE - NIGHT\nMara walks.\n\nMARA\n{URDU}\n\nMARA\n{URDU}"


def test_title_card_never_draws_boxes():
    from types import SimpleNamespace

    from app import title_intro as ti

    for local in ("روشni (The Light of Ramadan)", "روشنی (The Light of Ramadan)", TITLE_UR):
        c = ti.card(SimpleNamespace(title="The Light of Ramadan"), local, "ur")
        assert "(" not in c["title"] and c["subtitle"] in ("", "The Light of Ramadan")
        title, sub = ti.layout(c)
        for text, path in [title] + ([sub] if sub else []):
            assert text and ti.draws(path, text), (text, path)
        assert (sub or title)[1] == ti.LATIN_DISPLAY
        ti.still(c, (160, 90), None)
    # an English line handed the Urdu face still gets a face with Latin letters
    text, path = ti._line("The Light of Ramadan", ti.st.NASTALIQ)
    assert path == ti.LATIN_DISPLAY and ti.draws(path, text)
    assert not ti.draws(ti.LATIN_DISPLAY, TITLE_UR)


def test_film_model_only_when_installed(monkeypatch):
    from app.llm import film

    s = get_settings()
    b = StubbornBrain(models=["gemma4:26b:latest"])
    set_transport(httpx.MockTransport(b))
    try:
        monkeypatch.setattr(s, "film_llm_model", "gemma4:26b")
        assert film.film_model() == "gemma4:26b"
        assert film.overrides("gemma4:26b", "reasoning") == {"model": "gemma4:26b", "keep_alive": "30s", "think": False}
        assert film.overrides("gemma4:26b", "vision") == {} and film.overrides(None, "creative") == {}
        monkeypatch.setattr(s, "film_llm_model", "off")
        assert film.film_model() is None
        set_transport(httpx.MockTransport(StubbornBrain(models=["qwen2.5:14b"])))
        monkeypatch.setattr(s, "film_llm_model", "gemma4:26b")
        assert film.film_model() is None
    finally:
        set_transport(None)
    assert type(s)(film_llm_model="  ").film_llm_model == "gemma4:26b"


def test_mcp_feature_quality_and_upscale(client, anon):
    from app.models import Job
    from tests.test_api_tokens import _mint
    from tests.test_mcp import Mcp

    m = Mcp(anon, _mint(client, ["read", "generate"])["token"])
    schema = next(t for t in m.rpc("tools/list")["tools"] if t["name"] == "create_project_from_idea")["inputSchema"]
    assert {"video_quality", "upscale"} <= set(schema["properties"])
    out = m.call_json("create_project_from_idea", idea="Lamps in an old lane", scenes=2, scene_seconds=30,
                      upscale={"engine": "best", "target": "1080p"})
    feature = m.call_json("create_project_from_idea", idea="Lamps in an old lane", scenes=2, video_quality="standard")
    short = m.call_json("create_project_from_idea", idea="A storm at sea", duration_s=10)
    with SessionLocal() as db:
        job = db.get(Job, out["job_id"])
        assert job.payload["upscale"] == {"engine": "best", "target": "1080p"}
        assert job.result["upscale_requested"] is True
        # a feature defaults to HQ; asked-for standard and a plain short stay as they were
        assert db.get(Project, out["project_id"]).settings["video_quality"] == "hq"
        assert db.get(Project, feature["project_id"]).settings["video_quality"] == "standard"
        assert "video_quality" not in (db.get(Project, short["project_id"]).settings or {})
