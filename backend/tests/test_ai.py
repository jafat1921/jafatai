import json

import httpx
import pytest

from app.config import get_settings
from app.db import SessionLocal
from app.llm import LLMError, chat_sync, set_transport, split_thinking
from app.models import Job, SceneVersion
from app.worker import process_one


def oa(content, reasoning=None, finish="stop"):
    msg = {"role": "assistant", "content": content}
    if reasoning is not None:
        msg["reasoning"] = reasoning
    return {"choices": [{"message": msg, "finish_reason": finish}], "usage": {"prompt_tokens": 5, "completion_tokens": 7}}


class FakeLLM:
    """Answers chat calls from a function of the request body; records every request."""

    def __init__(self, answer):
        self.answer = answer
        self.requests: list[dict] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else {}
        self.requests.append({"url": str(request.url), **body})
        return httpx.Response(200, json=self.answer(body))


@pytest.fixture
def fake_llm():
    holder = {}

    def install(answer):
        fake = FakeLLM(answer)
        set_transport(httpx.MockTransport(fake))
        holder["fake"] = fake
        return fake

    yield install
    set_transport(None)


def schema_title(body) -> str | None:
    rf = body.get("response_format") or {}
    return (rf.get("json_schema") or {}).get("schema", {}).get("title") or (body.get("format") or {}).get("title")


def run_job(job_id, fast_driver=None):
    # summaries are low priority and wait for typing to settle, so stop as soon as our job is finished
    for _ in range(20):
        with SessionLocal() as db:
            if db.get(Job, job_id).status in ("done", "failed", "cancelled"):
                break
        process_one(driver_factory=fast_driver)
    with SessionLocal() as db:
        return db.get(Job, job_id)


# ------------------------------------------------------------------ client

def test_split_thinking_tags_and_separate_field():
    assert split_thinking("<think>plan it</think>\nThe answer") == ("The answer", "plan it")
    # template that swallowed the opening tag
    assert split_thinking("half a thought</think>Done") == ("Done", "half a thought")
    assert split_thinking("Plain", "from field") == ("Plain", "from field")


def test_chat_reads_reasoning_field_and_think_tags(fake_llm):
    fake_llm(lambda b: oa("<think>inline</think>Hello", reasoning="separate"))
    res = chat_sync("reasoning", [{"role": "user", "content": "hi"}])
    assert res.content == "Hello"
    assert "separate" in res.thinking and "inline" in res.thinking
    assert res.model == "fake-reasoner"


def test_empty_content_with_reasoning_retries_without_thinking(fake_llm):
    answers = iter([oa("", reasoning="I was thinking so hard", finish="length"), oa("Actual words")])
    fake = fake_llm(lambda b: next(answers))
    res = chat_sync("creative", [{"role": "user", "content": "x"}], max_tokens=20)
    assert res.content == "Actual words"
    assert res.thinking == "I was thinking so hard"
    assert fake.requests[1]["max_tokens"] == 40
    assert fake.requests[1]["reasoning_effort"] == "none"


def test_empty_content_twice_fails_clearly(fake_llm):
    fake_llm(lambda b: oa("", reasoning="still thinking", finish="length"))
    with pytest.raises(LLMError, match="token budget"):
        chat_sync("creative", [{"role": "user", "content": "x"}], max_tokens=20)


def test_native_ollama_path_turns_thinking_off_for_creative(fake_llm, monkeypatch):
    monkeypatch.setattr(get_settings(), "llm_api", "ollama")
    fake = fake_llm(lambda b: {"message": {"content": "Prose", "thinking": ""}, "done_reason": "stop", "eval_count": 3})
    res = chat_sync("creative", [{"role": "user", "content": "x"}])
    req = fake.requests[0]
    assert req["url"].endswith("/api/chat") and "/v1/" not in req["url"]
    assert req["think"] is False and req["options"]["num_ctx"] == get_settings().llm_num_ctx
    assert res.content == "Prose" and res.usage["completion_tokens"] == 3

    chat_sync("reasoning", [{"role": "user", "content": "x"}])
    assert fake.requests[1]["think"] is True


def test_json_repair_pass_uses_creative_model(fake_llm):
    from app.llm.prompts import SceneDraft

    def answer(body):
        if body["messages"][0]["content"].startswith("You repair broken JSON"):
            return oa('{"heading": "INT. BOAT - NIGHT", "script_text": "Waves."}')
        return oa('Sure! {"heading": "INT. BOAT')

    fake = fake_llm(answer)
    res = chat_sync("reasoning", [{"role": "user", "content": "x"}], schema=SceneDraft)
    assert res.data.heading == "INT. BOAT - NIGHT" and res.usage["repaired"] is True
    assert [r["model"] for r in fake.requests] == ["fake-reasoner", "fake-writer"]


def test_json_still_invalid_after_repair_raises(fake_llm):
    from app.llm.prompts import SceneDraft

    fake_llm(lambda b: oa("never json"))
    with pytest.raises(LLMError, match="repair pass failed"):
        chat_sync("creative", [{"role": "user", "content": "x"}], schema=SceneDraft)


def test_unreachable_server_message():
    set_transport(None)
    with pytest.raises(LLMError, match="isn't reachable at http://127.0.0.1:9"):
        chat_sync("creative", [{"role": "user", "content": "x"}], timeout=5)


# ------------------------------------------------------------------ jobs

OUTLINE = {
    "logline": "A diver finds the reef she loved has gone white.",
    "characters": [{"name": "Maya", "role": "marine biologist"}, {"name": "Tomas", "role": "boat captain"}],
    "scenes": [
        {"heading": "ext. harbour - dawn", "logline": "Maya loads her gear.", "purpose": "setup",
         "time_of_day": "Dawn", "mood": "quiet", "duration_s": 40, "characters": ["Maya", "Tomas"]},
        {"heading": "EXT. CORAL REEF - DAY", "logline": "She sees the bleaching.", "purpose": "turn",
         "time_of_day": "day", "mood": "grief", "duration_s": 50, "characters": ["Maya"]},
        {"heading": "EXT. BOAT DECK - DUSK", "logline": "She decides to fight.", "purpose": "resolve",
         "time_of_day": "sunset", "mood": "resolve", "duration_s": 30, "characters": ["Maya", "Tomas"]},
    ],
}
LOOKS = {"characters": [
    {"name": "Maya", "description": "Woman, mid-30s, lean, sun-browned skin, short black hair, faded teal wetsuit."},
    {"name": "TOMAS", "description": "Man, 60s, stocky, grey beard, yellow oilskin jacket."},
]}


def director(body):
    title = schema_title(body)
    if title == "Outline":
        return oa(json.dumps(OUTLINE), reasoning="Three beats: setup, discovery, resolve.")
    if title == "CastLooks":
        return oa(json.dumps(LOOKS))
    return oa("    Maya hauls a tank onto the deck.\n\n        MAYA\n    Let's go.")


def test_outline_creates_scenes_characters_and_keeps_thinking(client, fake_llm, fast_driver):
    fake_llm(director)
    p = client.post("/api/projects", json={"title": "Reef", "authoring_mode": "ai_director",
                                           "brief": "A short film about coral bleaching", "target_runtime_s": 120}).json()
    job = client.post(f"/api/projects/{p['id']}/ai/outline").json()
    assert job["type"] == "ai_outline" and job["status"] == "queued"
    # asking again while it's queued returns the same job instead of a second outline
    assert client.post(f"/api/projects/{p['id']}/ai/outline").json()["id"] == job["id"]

    done = run_job(job["id"], fast_driver)
    assert done.status == "done", done.error
    scenes = client.get(f"/api/projects/{p['id']}/scenes").json()
    assert [s["heading"] for s in scenes] == ["EXT. HARBOUR - DAWN", "EXT. CORAL REEF - DAY", "EXT. BOAT DECK - DUSK"]
    assert all(s["source"] == "ai" and not s["locked"] for s in scenes)
    assert scenes[0]["script_text"].startswith("Maya hauls a tank")  # flush-left
    assert "\n    " not in scenes[0]["script_text"]
    assert scenes[2]["time_of_day"] == "golden_hour"

    chars = {c["name"]: c for c in client.get(f"/api/projects/{p['id']}/characters").json()}
    assert set(chars) == {"Maya", "Tomas"}
    assert "teal wetsuit" in chars["Maya"]["description"] and chars["Tomas"]["source"] == "ai"

    listed = next(j for j in client.get("/api/jobs").json() if j["id"] == job["id"])
    assert listed["result"]["thinking"] == "Three beats: setup, discovery, resolve."
    assert len(listed["result"]["drafted_ids"]) == 3 and listed["result"]["calls"]
    assert client.get(f"/api/projects/{p['id']}").json()["logline"].startswith("A diver")

    assert client.post(f"/api/projects/{p['id']}/ai/outline").status_code == 409


def _user_scene(client, project, text="The diver drifts over pale coral."):
    return client.post(f"/api/projects/{project['id']}/scenes", json={"heading": "EXT. REEF - DAY", "script_text": text}).json()


def test_assist_on_user_scene_makes_suggestion_then_accept(client, project, fake_llm, fast_driver, db):
    fake_llm(lambda b: oa("The diver drifts over pale coral.\nA cloud dims the water."))
    scene = _user_scene(client, project)
    assert scene["locked"] and scene["source"] == "user"

    job = client.post(f"/api/scenes/{scene['id']}/ai/assist", json={"action": "expand"}).json()
    done = run_job(job["id"], fast_driver)
    assert done.result["outcome"] == "suggested"

    after = client.get(f"/api/projects/{project['id']}/scenes").json()[0]
    assert after["script_text"] == scene["script_text"] and after["version"] == scene["version"]

    [sug] = client.get(f"/api/projects/{project['id']}/suggestions").json()
    assert sug["field"] == "script_text" and sug["current_text"] == scene["script_text"]
    assert "cloud dims" in sug["proposed_text"]

    res = client.post(f"/api/suggestions/{sug['id']}/accept").json()
    assert res["suggestion"]["status"] == "accepted"
    assert "cloud dims" in res["scene"]["script_text"]
    assert res["scene"]["source"] == "ai_edited" and res["scene"]["locked"]
    assert res["scene"]["version"] == scene["version"] + 1
    assert db.query(SceneVersion).filter_by(scene_id=scene["id"], version=res["scene"]["version"]).count() == 1

    assert client.post(f"/api/suggestions/{sug['id']}/accept").status_code == 409
    assert client.get(f"/api/projects/{project['id']}/suggestions").json() == []


def test_reject_suggestion_leaves_text(client, project, fake_llm, fast_driver):
    fake_llm(lambda b: oa("A tighter line."))
    scene = _user_scene(client, project)
    run_job(client.post(f"/api/scenes/{scene['id']}/ai/assist", json={"action": "tighten"}).json()["id"], fast_driver)
    [sug] = client.get(f"/api/projects/{project['id']}/suggestions").json()
    assert client.post(f"/api/suggestions/{sug['id']}/reject").json()["suggestion"]["status"] == "rejected"
    assert client.get(f"/api/projects/{project['id']}/scenes").json()[0]["script_text"] == scene["script_text"]


def test_draft_into_empty_scene_writes_directly_then_unlocked_ai_rewrites_directly(client, project, fake_llm, fast_driver):
    draft = {"heading": "int. lab - night", "logline": "Maya studies samples.", "time_of_day": "night",
             "mood": "tense", "script_text": "Maya leans over the microscope."}

    def answer(body):
        return oa(json.dumps(draft)) if schema_title(body) == "SceneDraft" else oa("Maya leans closer, breath held.")

    fake_llm(answer)
    empty = client.post(f"/api/projects/{project['id']}/scenes", json={}).json()
    assert not empty["locked"]
    job = client.post(f"/api/scenes/{empty['id']}/ai/assist", json={"action": "draft_from_idea", "idea": "lab at night"}).json()
    assert run_job(job["id"], fast_driver).result["outcome"] == "written"
    s = client.get(f"/api/projects/{project['id']}/scenes").json()[0]
    assert s["heading"] == "INT. LAB - NIGHT" and s["source"] == "ai" and not s["locked"] and s["version"] == 2

    job = client.post(f"/api/scenes/{empty['id']}/ai/assist", json={"action": "rewrite_tone", "tone": "eerie"}).json()
    assert run_job(job["id"], fast_driver).result["outcome"] == "written"
    s = client.get(f"/api/projects/{project['id']}/scenes").json()[0]
    assert s["script_text"] == "Maya leans closer, breath held." and s["version"] == 3
    assert client.get(f"/api/projects/{project['id']}/suggestions").json() == []


def test_ai_fills_empty_field_of_user_scene_without_suggestion(client, project, fake_llm, fast_driver):
    fake_llm(lambda b: oa('"The diver mourns the reef."'))
    scene = _user_scene(client, project)
    run_job(client.post(f"/api/scenes/{scene['id']}/ai/assist", json={"action": "suggest_logline"}).json()["id"], fast_driver)
    s = client.get(f"/api/projects/{project['id']}/scenes").json()[0]
    assert s["logline"] == "The diver mourns the reef." and s["script_text"] == scene["script_text"]
    assert s["source"] == "ai_edited"


def test_assist_validation(client, project):
    empty = client.post(f"/api/projects/{project['id']}/scenes", json={}).json()
    assert client.post(f"/api/scenes/{empty['id']}/ai/assist", json={"action": "expand"}).status_code == 409
    assert client.post(f"/api/scenes/{empty['id']}/ai/assist", json={"action": "draft_from_idea"}).status_code == 422
    assert client.post(f"/api/scenes/{empty['id']}/ai/assist", json={"action": "dance"}).status_code == 422


def test_extract_characters_never_overwrites_user_description(client, project, character, fake_llm, fast_driver):
    # fixture character "Diver" was created by the user with a description, so it's locked
    fake_llm(lambda b: oa(json.dumps({"characters": [
        {"name": "DIVER", "description": "Woman, 40s, wetsuit."},
        {"name": "Captain (V.O.)", "description": "Man, 60s, grey beard."},
    ]})))
    _user_scene(client, project, "DIVER\nIt's gone white.\n\nCAPTAIN (V.O.)\nCome up.")
    done = run_job(client.post(f"/api/projects/{project['id']}/ai/extract-characters").json()["id"], fast_driver)
    assert done.status == "done", done.error

    chars = {c["name"]: c for c in client.get(f"/api/projects/{project['id']}/characters").json()}
    assert chars["Diver"]["description"] == "Grey hair"
    assert chars["Captain"]["source"] == "ai" and "grey beard" in chars["Captain"]["description"]
    [sug] = client.get(f"/api/projects/{project['id']}/suggestions").json()
    assert sug["target_type"] == "character" and sug["proposed_text"] == "Woman, 40s, wetsuit."

    res = client.post(f"/api/suggestions/{sug['id']}/accept").json()
    assert res["character"]["description"] == "Woman, 40s, wetsuit." and res["character"]["source"] == "ai_edited"


def test_portrait_prompt_lands_on_job_result(client, character, fake_llm, fast_driver):
    fake = fake_llm(lambda b: oa("woman in her 40s, grey hair, head-and-shoulders, neutral grey background"))
    job = client.post(f"/api/characters/{character['id']}/ai/portrait-prompt").json()
    done = run_job(job["id"], fast_driver)
    assert done.result["prompt"].startswith("woman in her 40s") and done.result["character_id"] == character["id"]
    assert "Grey hair" in fake.requests[0]["messages"][1]["content"]


def test_write_missing_fills_only_empty_scenes(client, project, fake_llm, fast_driver):
    draft = {"heading": "EXT. SHORE - DUSK", "logline": "Bridge.", "script_text": "Waves fold onto the sand."}
    fake = fake_llm(lambda b: oa(json.dumps(draft)))
    first = _user_scene(client, project, "Scene one text.")
    gap = client.post(f"/api/projects/{project['id']}/scenes", json={}).json()
    _user_scene(client, project, "Scene three text.")

    done = run_job(client.post(f"/api/projects/{project['id']}/ai/write-missing").json()["id"], fast_driver)
    assert done.result["drafted_ids"] == [gap["id"]]
    scenes = client.get(f"/api/projects/{project['id']}/scenes").json()
    assert scenes[1]["script_text"] == "Waves fold onto the sand." and scenes[0]["script_text"] == first["script_text"]
    # neighbours went in as context
    prompt = fake.requests[0]["messages"][1]["content"]
    assert "Scene one text." in prompt and "Scene three text." in prompt

    assert client.post(f"/api/projects/{project['id']}/ai/write-missing").status_code == 409


def test_failed_llm_fails_job_with_plain_message(client, project, fast_driver):
    set_transport(None)
    scene = _user_scene(client, project)
    done = run_job(client.post(f"/api/scenes/{scene['id']}/ai/assist", json={"action": "expand"}).json()["id"], fast_driver)
    assert done.status == "failed" and "isn't reachable" in done.error


def test_regenerate_with_note_rewrites_prompt(client, character, fake_llm):
    fake_llm(lambda b: oa("a diver with short grey hair, serious expression"))
    v1 = client.post("/api/generations", json={"target_type": "character", "target_id": character["id"],
                                                "kind": "portrait", "prompt": "a smiling diver"}).json()
    v2 = client.post(f"/api/generations/{v1['id']}/regenerate", json={"mode": "note", "note": "grey hair, no smile"}).json()
    assert v2["prompt"] == "a diver with short grey hair, serious expression"
    assert v2["note"] == "grey hair, no smile"
    job = next(j for j in client.get("/api/jobs").json() if j["id"] == v2["job_id"])
    assert "appended" not in job["message"]


def test_regenerate_with_note_falls_back_and_flags(client, character):
    set_transport(None)
    v1 = client.post("/api/generations", json={"target_type": "character", "target_id": character["id"],
                                                "kind": "portrait", "prompt": "a smiling diver"}).json()
    v2 = client.post(f"/api/generations/{v1['id']}/regenerate", json={"mode": "note", "note": "no smile"}).json()
    assert v2["prompt"] == "a smiling diver\n\nNote: no smile"
    job = next(j for j in client.get("/api/jobs").json() if j["id"] == v2["job_id"])
    assert "note appended" in job["message"] and "isn't reachable" in job["message"]


def test_user_script_edit_queues_one_summary(client, project):
    scene = client.post(f"/api/projects/{project['id']}/scenes", json={}).json()
    for text in ("one", "one two", "one two three"):
        client.patch(f"/api/scenes/{scene['id']}", json={"script_text": text})
    summaries = [j for j in client.get("/api/jobs").json() if j["type"] == "ai_summarize"]
    assert len(summaries) == 1 and summaries[0]["status"] == "queued"


def test_llm_check_reports_roles(client, fake_llm, monkeypatch):
    monkeypatch.setattr(get_settings(), "llm_api", "ollama")

    def handler(request: httpx.Request):
        if request.url.path == "/api/tags":
            return httpx.Response(200, json={"models": [{"name": "fake-reasoner"}, {"name": "fake-writer"}]})
        return httpx.Response(200, json={"message": {"content": "ok"}, "done_reason": "stop"})

    set_transport(httpx.MockTransport(handler))
    r = client.get("/api/system/llm-check").json()
    assert r["roles"]["reasoning"]["present"] and "latency_ms" in r["roles"]["creative"]
    assert r["roles"]["vision"]["present"] is False and r["ok"] is False


def test_retried_outline_resumes_instead_of_starting_over(client, fake_llm, fast_driver):
    calls = {"drafts": 0}

    def flaky(body):
        if schema_title(body) is None:
            calls["drafts"] += 1
            if calls["drafts"] == 2:
                raise httpx.ConnectError("boom")
        return director(body)

    fake = fake_llm(flaky)
    p = client.post("/api/projects", json={"title": "Reef", "authoring_mode": "ai_director", "brief": "coral"}).json()
    job = client.post(f"/api/projects/{p['id']}/ai/outline").json()
    assert run_job(job["id"], fast_driver).status == "failed"
    assert len(client.get(f"/api/projects/{p['id']}/scenes").json()) == 3

    client.post(f"/api/jobs/{job['id']}/retry")
    done = run_job(job["id"], fast_driver)
    assert done.status == "done", done.error
    scenes = client.get(f"/api/projects/{p['id']}/scenes").json()
    assert len(scenes) == 3 and all(s["script_text"] for s in scenes)
    # the structure call ran once; the retry only drafted what was missing
    assert sum(1 for r in fake.requests if schema_title(r) == "Outline") == 1
    assert done.result["thinking"] == "Three beats: setup, discovery, resolve."
