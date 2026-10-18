"""Quick Create for a feature (contract v4a): the film's language, a cast from Character Studio, scene count and
length with many shots a scene, and the opening title card."""
import json
from types import SimpleNamespace

import httpx
import pytest
from sqlalchemy import select

from app import aerab, ai_jobs, title_intro
from app import autopilot as ap_mod
from app import reel as rl
from app import subtitles as st
from app.api import quick
from app.db import SessionLocal
from app.llm import prompts as P
from app.llm import set_transport
from app.models import Character, Generation, Job, Project, ProjectCast, Scene, Shot
from app.services import generation_file
from tests.test_ai import oa, schema_title
from tests.test_autopilot import drive, stages
from tests.test_character_sheet import studio_character, with_portrait
from tests.test_mcp import Mcp
from tests.test_api_tokens import _mint

URDU = "سمندر آج بہت خاموش ہے۔"
TITLE_UR = "خاموش سمندر"


def mark(text: str) -> str:
    # a stand-in aerab pass: a pesh after the first letter of every Urdu line, so it shows it ran
    return "\n".join(ln[0] + "ُ" + ln[1:] if aerab.has_script(ln[:1]) else ln for ln in text.split("\n"))


@pytest.fixture
def aerab_calls(monkeypatch):
    calls = []

    def finish(text, language=None, tick=None, what="text"):
        calls.append((what, language))
        return SimpleNamespace(text=mark(text))

    def lines(texts, language=None, tick=None, what="lines"):
        calls.append((what, language))
        return [mark(t) for t in texts]

    monkeypatch.setattr(aerab, "finish_sync", finish)
    monkeypatch.setattr(aerab, "finish_lines_sync", lines)
    return calls


class FeatureBrain:
    """Fake LLM for a two-scene Urdu film with one cast member; records every request by schema."""

    def __init__(self, cast_name="Mara", short_first=True):
        self.cast_name, self.short_first = cast_name, short_first
        self.bodies: dict[str, list[dict]] = {}

    def kind(self, body) -> str:
        title = schema_title(body)
        if title:
            return title
        system = body["messages"][0]["content"]
        if system.startswith("You are a screenwriter"):
            return "draft"
        if "photorealistic image models" in system:
            return "portrait"
        return "other"

    def outline(self, n):
        return {"title": "The Quiet Sea", "title_local": TITLE_UR, "logline": "A keeper says goodbye to the sea.",
                "characters": [{"name": self.cast_name, "role": "keeper"}, {"name": "Shopkeeper", "role": "walk-on"}],
                "scenes": [{"heading": f"EXT. HARBOUR {i} - DUSK", "logline": "Mara watches the sea", "duration_s": 20,
                            "characters": [self.cast_name], "mood": "quiet", "time_of_day": "dusk"}
                           for i in range(1, n + 1)]}

    def __call__(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        k = self.kind(body)
        self.bodies.setdefault(k, []).append(body)
        if k == "VisionScore":
            return httpx.Response(200, json=oa(json.dumps({"score": 8, "issues": []})))
        shot = {"shot_type": "medium", "duration_s": 4, "description": "Mara at the rail", "camera": "slow push",
                "characters": [self.cast_name], "start_visual": "A woman at a rail", "end_visual": "She turns",
                "dialogue": []}
        answer = {
            "QuickOutline": lambda: json.dumps(self.outline(1 if self.short_first and len(self.bodies[k]) == 1
                                                            else 2)),
            "LocationList": lambda: json.dumps({"locations": [{"name": "Harbour", "description": "Stone quay",
                                                               "time_of_day_variants": ["dusk"], "scenes": [1, 2]}]}),
            "ShotList": lambda: json.dumps({"shots": [
                {**shot, "dialogue": [{"character": self.cast_name, "text": URDU},
                                      {"character": "Shopkeeper", "text": "یہ لو"}]},
                {**shot, "continuous": True}, {**shot, "continuous": True}]}),
            "FramePrompts": lambda: json.dumps({"start_prompt": "A grey-haired woman at a harbour rail at dusk",
                                                "end_prompt": "She turns from the sea",
                                                "motion_prompt": "She speaks quietly, then turns"}),
            "draft": lambda: f"Mara watches the sea.\n\n{self.cast_name.upper()}\n{URDU}",
        }.get(k, lambda: "ok")()
        return httpx.Response(200, json=oa(answer))


@pytest.fixture
def feature_brain():
    holder = {}

    def install(**kw):
        b = FeatureBrain(**kw)
        set_transport(httpx.MockTransport(b))
        holder["b"] = b
        return b

    yield install
    set_transport(None)


def _user_text(body) -> str:
    return "\n".join(m["content"] for m in body["messages"] if isinstance(m["content"], str))


# ---------------------------------------------------------------- the request

def test_scene_fields_set_the_runtime():
    def plan(**kw):
        return quick.film_plan(quick.QuickIn(prompt="A storm at sea", **kw))

    assert plan(scenes=4, scene_seconds=150) == (600, 4, 150)
    assert plan(duration_s=600, scenes=5) == (600, 5, 120)
    assert plan(duration_s=600, scene_seconds=200) == (600, 3, 200)
    # more scenes than the cap: the scenes get longer instead
    assert plan(duration_s=600, scene_seconds=20) == (600, 12, 50)


def test_validation_cast_and_ten_minutes(client):
    c = studio_character(client, name="Mara", description="Woman, 60s, grey braid")
    r = client.post("/api/quick", json={"prompt": "A keeper's farewell", "language": "ur", "cast_ids": [c["id"]],
                                        "scenes": 4, "scene_seconds": 150})
    assert r.status_code == 201, r.text
    out = r.json()
    p, payload = out["project"], out["job"]
    assert p["target_runtime_s"] == 600
    with SessionLocal() as db:
        job = db.get(Job, payload["id"])
        assert job.payload["duration_s"] == 600 and job.payload["scenes"] == 4
        assert job.payload["scene_seconds"] == 150 and job.payload["language"] == "ur"
        assert job.payload["cast_ids"] == [c["id"]] and job.payload["title_intro"] is True
        project = db.get(Project, p["id"])
        assert project.settings["language"] == "ur"
        assert db.get(ProjectCast, (p["id"], c["id"])) is not None

    # twenty minutes is the ceiling; a stranger's or a film-owned character is refused
    assert client.post("/api/quick", json={"prompt": "Too long", "scenes": 12, "scene_seconds": 600}).status_code == 422
    r = client.post("/api/quick", json={"prompt": "Who?", "cast_ids": ["not-a-character"]})
    assert r.status_code == 404 and "Character not found" in r.json()["detail"]
    film = client.post("/api/projects", json={"title": "Other", "authoring_mode": "scene_by_scene"}).json()
    own = client.post(f"/api/projects/{film['id']}/characters", json={"name": "Local"}).json()
    r = client.post("/api/quick", json={"prompt": "Borrowed", "cast_ids": [own["id"]]})
    assert r.status_code == 409 and "Character Studio" in r.json()["detail"]
    # an English short keeps its old shape: no intro, nothing extra on the project
    short = client.post("/api/quick", json={"prompt": "A storm at sea", "duration_s": 10}).json()
    with SessionLocal() as db:
        assert db.get(Job, short["job"]["id"]).payload["title_intro"] is False
        assert "language" not in (db.get(Project, short["project"]["id"]).settings or {})
    titled = client.post("/api/quick", json={"prompt": "A storm at sea", "title": "Storm", "title_intro": False}).json()
    assert titled["project"]["title"] == "Storm"


def test_outline_and_writer_prompts_carry_the_language_and_cast():
    cast = [SimpleNamespace(name="Mara", description="Woman, 60s, grey braid", profile={"role": "keeper"})]
    project = SimpleNamespace(brief="A keeper's farewell", title="T", logline="", target_runtime_s=600,
                              settings={"language": "ur"})
    msgs = ap_mod.outline_messages(project, "cinematic", True, 600, scenes=4, cast=cast, language="ur")
    user = msgs[1]["content"]
    assert "exactly 4 scenes (about 150 seconds each)" in user and "many shots of 5-10 seconds" in user
    assert "- Mara: Woman, 60s, grey braid (role: keeper)" in user and "invent no other speaking part" in user
    assert "The film is in Urdu" in user and "title_local" in user and "FULL aerab" in user
    assert "ONE continuous shot" not in user

    scene = SimpleNamespace(heading="EXT. HARBOUR - DUSK", logline="", mood="", summary="", script_text="",
                            order=1)
    d = P.draft_scene_messages(project, cast, [scene], 0, plan={"duration_s": 150})
    assert "FULL aerab" in d[0]["content"] and "The film is in Urdu" in d[1]["content"]
    ask = P.dialogue_ask(SimpleNamespace(script_text="MARA\nHello"), True, "ur")
    assert "in Urdu" in ask and "aerab" in ask
    assert "Always in English" in P.FRAME_RULES
    # English films are untouched
    assert P.language_note("en") == "" and "aerab" not in P.writer_system("A storm at sea", "en")


def test_planned_lines_are_tagged_and_marked(aerab_calls):
    run = SimpleNamespace(ctx=SimpleNamespace(progress=lambda *a: None))
    plans = [{"dialogue": [{"character_id": "c1", "text": URDU}]}]
    ai_jobs._mark_dialogue(run, plans, 0.5, "ur")
    row = plans[0]["dialogue"][0]
    assert row["language"] == "ur" and row["text"] == mark(URDU) and aerab_calls == [("shot dialogue", "ur")]


def test_long_scene_shot_maths():
    assert ap_mod.shots_for(150) == 20 and ap_mod.shots_for(4) == 1 and ap_mod.shots_for(600) == 40
    assert sum(ap_mod.spread([4, 4, 4, 4], 30)) == pytest.approx(30, abs=1)
    assert max(ap_mod.spread([1, 30], 10)) <= ap_mod.SHOT_RANGE[1]
    # a long scene isn't a single take, so the long-take cap doesn't touch it
    assert ap_mod.fit_durations([150] * 4, 600, many_shots=True) == [150, 150, 150, 150]
    assert max(ap_mod.fit_durations([150] * 2, 600)) <= 300


# ---------------------------------------------------------------- the whole film

def test_urdu_film_with_a_studio_cast_end_to_end(client, feature_brain, aerab_calls, fast_driver):
    b = feature_brain()
    mara = studio_character(client, name="Mara", description="Woman, 60s, grey braid")
    with_portrait(client, fast_driver, mara)
    r = client.post("/api/quick", json={"prompt": "An old keeper says goodbye to the harbour", "language": "ur",
                                        "cast_ids": [mara["id"]], "scenes": 2, "scene_seconds": 20})
    assert r.status_code == 201, r.text
    out = r.json()
    pid = out["project"]["id"]
    job = drive(out["job"]["id"], fast_driver, limit=400)
    assert job.status == "done", job.error
    assert stages(job)["stitch"] == "done"

    # the outline came back one scene short and was asked again; it saw the cast and the language
    outlines = b.bodies["QuickOutline"]
    assert len(outlines) == 2 and "It must have exactly 2" in _user_text(outlines[1])
    text = _user_text(outlines[0])
    assert "The film is in Urdu" in text and "- Mara: Woman, 60s, grey braid" in text
    assert all("The film is in Urdu" in _user_text(x) for x in b.bodies["draft"])
    shotlists = b.bodies["ShotList"]
    assert len(shotlists) == 2 and "about 20 seconds on screen" in _user_text(shotlists[0])
    assert "in Urdu, exactly as the script has it" in _user_text(shotlists[0])
    assert all("Always in English" in _user_text(x) for x in b.bodies["FramePrompts"])
    assert "CastLooks" not in b.bodies  # the studio character keeps her own looks

    with SessionLocal() as db:
        project = db.get(Project, pid)
        assert project.title == "The Quiet Sea"
        scenes = db.scalars(select(Scene).where(Scene.project_id == pid).order_by(Scene.order)).all()
        assert len(scenes) == 2 and all(mark(URDU) in s.script_text for s in scenes)
        # nobody else joined the cast: no walk-on character, the studio one linked, untouched
        assert db.scalars(select(Character).where(Character.project_id == pid)).all() == []
        assert db.get(Character, mara["id"]).description == "Woman, 60s, grey braid"
        for sc in scenes:
            shots = db.scalars(select(Shot).where(Shot.scene_id == sc.id).order_by(Shot.order)).all()
            assert len(shots) == 3
            assert sum(s.duration_s for s in shots) >= 19.5
            # the walk-on's line was dropped; Mara's is hers, in Urdu, with its marks
            assert shots[0].dialogue == [{"character_id": mara["id"], "text": mark(URDU), "language": "ur"}]
        take = db.scalars(select(Generation).where(Generation.project_id == pid, Generation.kind == "take",
                                                   Generation.status == "approved")).first()
        assert take.params["dialogue"]["mode"] == "lipsync"
        assert take.params["dialogue"]["lines"][0]["language"] == "ur"

        final = db.get(Generation, job.result["final_render_id"])
        intro = final.params["title_intro"]
        assert intro["title"] == mark(TITLE_UR) and intro["subtitle"] == "The Quiet Sea"
        assert intro["font"] == st.NASTALIQ and intro["rtl"] is True and intro["music"] is True
        assert final.params["chapters"][0]["title"] == title_intro.CHAPTER
        assert final.params["chapters"][1]["start_s"] == pytest.approx(title_intro.SECONDS, abs=0.1)
        length = rl.probe(generation_file(final)).duration
        assert length == pytest.approx(final.params["duration_s"], abs=0.6) and length > title_intro.SECONDS + 30
        music = db.get(Generation, intro["music_id"])
        assert music.kind == "music" and music.params["model"] == title_intro.MUSIC_MODEL
    assert ("film title", "ur") in aerab_calls and ("shot dialogue", "ur") in aerab_calls


def test_title_card_draws_and_encodes(tmp_path):
    c = title_intro.card(SimpleNamespace(title="The Quiet Sea"), TITLE_UR, "ur", None)
    assert c["font"] == st.NASTALIQ and c["subtitle_font"] == st.LATIN and c["subtitle"] == "The Quiet Sea"
    assert title_intro.card(SimpleNamespace(title="Storm"), "", "en")["subtitle"] == ""
    img = title_intro.still(c, (160, 90), None)
    assert img.size == (320, 180)
    png, dst = tmp_path / "t.png", tmp_path / "t.mp4"
    img.save(png)
    rl.run_ff(title_intro.clip_cmd(png, None, dst, {**c, "seconds": 2.0}, (160, 90), fps=rl.FPS, venc=rl.VENC,
                                   aenc=rl.AENC, afmt=rl.AFMT, head_idr_s=rl.HEAD_IDR_S))
    p = rl.probe(dst)
    assert p.has_audio and (p.width, p.height) == (160, 90) and p.duration == pytest.approx(2.0, abs=0.1)
    # range stitches never get the card
    proj = SimpleNamespace(settings={"title_intro": c})
    assert title_intro.for_render(proj, True)["title"] == TITLE_UR and title_intro.for_render(proj, False) is None


def test_mcp_tool_takes_the_feature_params(client, anon):
    c = studio_character(client, name="Mara", description="Woman, 60s, grey braid")
    m = Mcp(anon, _mint(client, ["read", "generate"])["token"])
    schema = next(t for t in m.rpc("tools/list")["tools"] if t["name"] == "create_project_from_idea")["inputSchema"]
    assert {"language", "cast_ids", "scenes", "scene_seconds", "title_intro", "title"} <= set(schema["properties"])
    out = m.call_json("create_project_from_idea", idea="An old keeper says goodbye to the harbour", language="ur",
                      cast_ids=[c["id"]], scenes=4, scene_seconds=150, title="Khamosh Samandar")
    assert out["runtime_s"] == 600 and out["title"] == "Khamosh Samandar" and out["type"] == "autopilot"
    with SessionLocal() as db:
        p = db.get(Job, out["job_id"]).payload
        assert p["language"] == "ur" and p["cast_ids"] == [c["id"]] and p["title_intro"] is True
        assert p["title"] == "Khamosh Samandar" and p["title_auto"] is False
    assert m.call("create_project_from_idea", idea="Bad scenes", scenes=13)["isError"]
    res = m.call("create_project_from_idea", idea="Who is this", cast_ids=["nope"])
    assert res["isError"] and "Character not found" in res["content"][0]["text"]
