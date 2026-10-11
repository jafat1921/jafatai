"""AI video podcast (contract v24): the shot-plan rules, the ltx23_ia2v graph, consent, the hidden project,
and the whole pipeline on the mock driver (both review stops, render, the cut over the episode mix)."""
import json
import shutil
from pathlib import Path

import httpx
import pytest

from app import audio_analysis as aa
from app import reel as rl
from app.config import get_settings
from app.db import SessionLocal
from app.drivers.comfy import lipsync_plan, plan_generation
from app.llm import set_transport
from app.models import Generation, Job, MediaItem, Project, Shot, VideoPodcast
from app.podcast import video as vd
from app.podcast import vplan
from app.workflows import build, check_template, find_node
from tests.test_library import png_bytes, upload
from tests.test_podcast import ff_meta, rms, streams
from tests.test_storyboard import _run_all

FIXTURE = Path(__file__).parent / "fixtures" / "comfy_object_info.json"


def ok(r, code=200):
    assert r.status_code == code, r.text
    return r.json()


# ---------------------------------------------------------------- plan rules

def _line(lid, who, start, end, chapter, text="words"):
    return {"line_id": lid, "kind": "speech", "speaker_id": who, "name": who, "text": text, "start": start,
            "end": end, "chapter_id": chapter}


TL = [_line("l1", "a", 4.0, 16.0, "c1"), _line("l2", "b", 16.4, 21.0, "c1"), _line("l3", "a", 21.4, 28.0, "c1"),
      _line("l4", "b", 28.4, 54.0, "c1"), _line("l5", "a", 56.0, 62.0, "c2")]
TOTAL = 66.0


def test_plan_covers_the_episode_with_short_lip_synced_chunks():
    plan = vplan.build(TL, TOTAL, ["a", "b"])
    assert vplan.check(plan, TOTAL) is None
    assert plan[0]["start"] == 0 and plan[-1]["end"] == TOTAL
    for x, y in zip(plan, plan[1:]):
        assert x["end"] == y["start"]
    assert all(sh["end"] - sh["start"] <= vplan.MAX_CHUNK_S + 1e-6 for sh in plan)
    # intro and outro over music are the wide shot
    assert plan[0]["type"] == "wide" and plan[0]["end"] == 4.0 and plan[-1]["type"] == "wide"
    # every spoken moment shows its speaker (or the listener / the room), never the wrong host lip-syncing
    for sh in plan:
        if sh["type"] in vplan.LIPSYNC_TYPES:
            line = next(t for t in TL if t["line_id"] == sh["line_id"])
            assert sh["speaker_id"] == line["speaker_id"]
            if sh["type"] == "lipsync":
                assert vplan.angle_host(sh["angle"]) == sh["speaker_id"]
    # line 1 (12.4 s with its gap) is two chunks, close-up then 3/4
    l1 = [sh for sh in plan if sh["line_id"] == "l1" and sh["type"] == "lipsync"]
    assert [sh["angle"] for sh in l1] == ["a:close", "a:three_quarter"]


def test_plan_reactions_mediums_and_chapter_openings():
    plan = vplan.build(TL, TOTAL, ["a", "b"])
    reactions = [sh for sh in plan if sh["type"] == "reaction"]
    # the third line is the first that gets a cutaway: the host who spoke last, listening, mid-line
    assert reactions and reactions[0]["line_id"] == "l3" and reactions[0]["angle"] == "b:listen"
    assert all(1.5 - 1e-6 <= sh["end"] - sh["start"] <= 3.0 + 1e-6 for sh in reactions)
    # a 27.6 s line is three chunks; the third is the two-shot
    l4 = [sh for sh in plan if sh["line_id"] == "l4"]
    assert [sh["type"] for sh in l4] == ["lipsync", "lipsync", "medium"]
    # chapter 2 opens on 2 s of the wide shot
    first_c2 = next(sh for sh in plan if sh["line_id"] == "l5")
    assert first_c2["type"] == "wide" and abs(first_c2["end"] - first_c2["start"] - 2.0) < 0.05
    # a solo show has nobody to cut away to
    assert not [sh for sh in vplan.build(TL, TOTAL, ["a"]) if sh["type"] == "reaction"]


def test_plan_cover_ends_and_slivers():
    plan = vplan.build(TL, TOTAL, ["a", "b"], cover_intro=True, cover_outro=True)
    assert plan[0]["type"] == "cover" and plan[-1]["type"] == "cover" and plan[0]["angle"] == ""
    tiny = vplan.build([_line("x", "a", 0.1, 3.0, "c"), _line("y", "b", 3.2, 3.4, "c"),
                        _line("z", "a", 3.5, 6.0, "c")], 6.1, ["a", "b"])
    assert all(sh["end"] - sh["start"] >= vplan.MIN_SHOT_S for sh in tiny)
    assert vplan.check(tiny, 6.1) is None


# ---------------------------------------------------------------- the ia2v workflow

def test_ia2v_template_routes_the_speech_and_trims_it():
    info = json.loads(FIXTURE.read_text(encoding="utf-8"))
    res = check_template("ltx23_ia2v", info)
    assert res["ok"], res
    assert res["features"]["two_stage"]["ok"]
    inputs = {"prompt": "Ali talking", "first_image": "mixai/kf.png", "speech_audio": "mixai/speech.wav",
              "audio_start_s": 3.25, "duration_s": 4.0, "width": 1280, "height": 704, "latent_width": 640,
              "latent_height": 352, "num_frames": 97, "seed": 7}
    graph, resolved = build("ltx23_ia2v", inputs)
    load = graph[find_node(graph, "SpeechAudio")]
    assert load["class_type"] == "LoadAudio" and load["inputs"]["audio"] == "mixai/speech.wav"
    trim = graph[find_node(graph, "AudioTrim")]
    assert trim["class_type"] == "TrimAudioDuration"
    assert trim["inputs"]["start_index"] == 3.25 and trim["inputs"]["duration"] == 4.0
    assert trim["inputs"]["audio"] == [find_node(graph, "SpeechAudio"), 0]
    # the speech is frozen: a zero mask over the encoded audio, concatenated with the video latent
    mask = graph[find_node(graph, "AudioMask")]
    assert mask["class_type"] == "SolidMask" and mask["inputs"]["value"] == 0.0
    av = graph[find_node(graph, "AVLatent")]
    assert av["inputs"]["audio_latent"] == [find_node(graph, "AudioFreeze"), 0]
    assert graph[find_node(graph, "VideoLatent")]["inputs"]["length"] == 97
    assert "Upsample" in {n["_meta"]["title"] for n in graph.values()} and resolved["single_stage"] is False

    draft, resolved = build("ltx23_ia2v", {**inputs, "single_stage": True, "latent_width": 832, "latent_height": 480,
                                           "width": 832, "height": 480})
    titles = {n["_meta"]["title"] for n in draft.values()}
    assert not titles & {"Upsample", "SpatialLoader", "FirstFrame2", "AVLatent2", "Sampler2", "Separate2", "Guider2",
                         "Noise2", "Sigmas2", "CropGuides"}
    assert draft[find_node(draft, "Decode")]["inputs"]["samples"] == [find_node(draft, "Separate"), 0]
    assert resolved["single_stage"] is True


class _Lookup:
    def __init__(self, root):
        self.root = root

    def generation_file(self, gid):
        p = self.root / f"{gid}.png"
        p.write_bytes(png_bytes())
        return p

    def project_aspect(self, _pid):
        return "16:9"


def test_lipsync_plan_draft_and_final(tmp_path):
    speech = tmp_path / "speech.wav"
    params = {"kind": "take", "first_frame_id": "kf1", "speech_audio": str(speech), "audio_start_s": 1.5,
              "num_frames": 121, "fps": 24, "aspect_ratio": "16:9"}
    p = plan_generation("take", "Ali talking", params, 3, _Lookup(tmp_path))
    assert p.template == "ltx23_ia2v" and p.images["speech_audio"] == speech
    assert p.inputs["single_stage"] is True and (p.inputs["width"], p.inputs["latent_width"]) == (832, 832)
    assert p.inputs["audio_start_s"] == 1.5 and p.inputs["duration_s"] == 5.0  # (121 - 1) / 24
    hq = lipsync_plan("x", {**params, "quality": "hq"}, 3, _Lookup(tmp_path), "", [])
    assert hq.inputs["single_stage"] is False
    assert (hq.inputs["width"], hq.inputs["height"], hq.inputs["latent_width"]) == (1280, 704, 640)
    # a take without speech is still plain i2v
    assert plan_generation("take", "x", {k: v for k, v in params.items() if k != "speech_audio"}, 3,
                           _Lookup(tmp_path)).template == "ltx23_i2v"


# ---------------------------------------------------------------- record, consent, hidden project

@pytest.fixture
def fake_looks():
    def answer(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        schema = ((body.get("response_format") or {}).get("json_schema") or {}).get("schema") or {}
        content = json.dumps({"description": "early thirties, short dark hair, warm brown skin, navy shirt"}) \
            if schema.get("title") == "HostLook" else "ok"
        return httpx.Response(200, json={"choices": [{"message": {"content": content}, "finish_reason": "stop"}],
                                         "usage": {}})

    set_transport(httpx.MockTransport(answer))
    yield
    set_transport(None)


DIALOGUE = "# Welcome\nAli: Hello and welcome to the show today friends.\nSara: Thanks Ali, glad to be here " \
           "with you.\n# The news\nAli: Big news this week from the river town.\nSara: The bridge finally opened."


def _episode(client, fast_driver, mix=True):
    ep = ok(client.post("/api/podcast/episodes", json={
        "title": "River news", "language": "en",
        "hosts": [{"name": "Ali", "role": "host", "persona": "curious"},
                  {"name": "Sara", "role": "cohost", "persona": "dry wit"}]}), 201)
    ep = ok(client.post(f"/api/podcast/episodes/{ep['id']}/script", json={"text": DIALOGUE}))
    if mix:
        st = {**ep["settings"], "loudness": "none"}
        ok(client.patch(f"/api/podcast/episodes/{ep['id']}", json={"settings": st}))
        ok(client.post(f"/api/podcast/episodes/{ep['id']}/render"), 202)
        _run_all(fast_driver)
        ok(client.post(f"/api/podcast/episodes/{ep['id']}/mix"), 202)
        _run_all(fast_driver)
    return ok(client.get(f"/api/podcast/episodes/{ep['id']}"))


def test_create_makes_a_hidden_project_with_a_character_per_host(client, fast_driver):
    ep = _episode(client, fast_driver, mix=False)
    assert client.get(f"/api/podcast/episodes/{ep['id']}/ai-video").status_code == 404
    vp = ok(client.post(f"/api/podcast/episodes/{ep['id']}/ai-video", json={"aspect": "16:9"}), 201)
    again = ok(client.post(f"/api/podcast/episodes/{ep['id']}/ai-video", json={}), 200)
    assert again["id"] == vp["id"]
    assert [h["name"] for h in vp["hosts"]] == ["Ali", "Sara"] and all(h["character_id"] for h in vp["hosts"])
    assert vp["stage"] == "cast" and vp["status"] == "idle"
    with SessionLocal() as db:
        assert db.get(Project, vp["project_id"]).authoring_mode == "podcast"
    assert vp["project_id"] not in {p["id"] for p in ok(client.get("/api/projects"))}
    assert vp["project_id"] not in {p["id"] for p in ok(client.get("/api/dashboard"))["recent_projects"]}
    # an ordinary project's character can be borrowed
    pr = ok(client.post("/api/projects", json={"title": "Film", "authoring_mode": "scene_by_scene"}), 201)
    ok(client.post(f"/api/projects/{pr['id']}/characters", json={"name": "Diver", "description": "Grey hair"}), 201)
    names = {c["name"] for c in ok(client.get(f"/api/podcast/ai-video/{vp['id']}/characters"))}
    assert names == {"Diver"}


def test_uploaded_photo_needs_consent(client, fast_driver):
    ep = _episode(client, fast_driver, mix=False)
    vp = ok(client.post(f"/api/podcast/episodes/{ep['id']}/ai-video", json={}), 201)
    photo = ok(upload(client, "ali.png", png_bytes(), "image/png"), 201)
    hid = vp["hosts"][0]["host_id"]
    url = f"/api/podcast/ai-video/{vp['id']}"
    body = {"source": "photo", "media_id": photo["id"]}
    assert client.patch(url, json={"hosts": {hid: body}}).status_code == 422
    assert client.patch(url, json={"hosts": {hid: {**body, "consent": {"name": "Ali Raza",
                                                                      "statement": "yes"}}}}).status_code == 422
    assert client.patch(url, json={"hosts": {hid: {**body, "consent": {"name": "",
                                                                      "statement": vd.CONSENT}}}}).status_code == 422
    vp = ok(client.patch(url, json={"hosts": {hid: {**body, "consent": {"name": "Ali Raza", "statement": vd.CONSENT}}}}))
    host = vp["hosts"][0]
    assert host["source"] == "photo" and host["photo_media_id"] == photo["id"]
    assert host["consent"]["name"] == "Ali Raza" and host["consent"]["statement"] == vd.CONSENT
    assert host["consent"]["at"] and host["consent"]["user_id"]


# ---------------------------------------------------------------- the whole pipeline

def _continue(client, vp, fast_driver):
    job = ok(client.post(f"/api/podcast/ai-video/{vp['id']}/continue"), 202)
    assert job["type"] == "video_podcast" and job["lane"] == "general"
    _run_all(fast_driver)
    vp = ok(client.get(f"/api/podcast/ai-video/{vp['id']}"))
    assert vp["job"]["status"] == "done", vp["job"]
    return vp


def _ready_vp(client, fast_driver, **settings):
    ep = _episode(client, fast_driver)
    vp = ok(client.post(f"/api/podcast/episodes/{ep['id']}/ai-video", json={"aspect": "16:9"}), 201)
    if settings:
        vp = ok(client.patch(f"/api/podcast/ai-video/{vp['id']}", json={"settings": settings}))
    vp = _continue(client, vp, fast_driver)
    assert vp["status"] == "review" and vp["review"] == "hosts" and vp["stage"] == "cast"
    assert all(h["portrait"]["status"] == "ready" for h in vp["hosts"])
    assert all(set(h["sheet_views"]) == {"front", "three_quarter"} for h in vp["hosts"])
    vp = _continue(client, vp, fast_driver)
    assert vp["review"] == "look" and vp["stage"] == "keyframes"
    assert all(h["portrait"]["status"] == "approved" for h in vp["hosts"])
    assert vp["set"]["establishing"]["status"] == "approved"
    assert len(vp["angles"]) == 2 * 3 + 2 and all(a["frame"]["status"] == "ready" for a in vp["angles"])
    # the angle frames go through the edit model with the host and the set as references
    close = next(a for a in vp["angles"] if a["key"].endswith(":close"))
    refs = close["frame"]["params"]["reference_ids"]
    assert refs[0] == vp["hosts"][0]["portrait"]["id"] and refs[-1] == vp["set"]["establishing"]["id"]
    vp = _continue(client, vp, fast_driver)
    assert vp["status"] == "idle" and vp["stage"] == "render"
    assert all(a["frame"]["status"] == "approved" for a in vp["angles"])
    assert vp["plan"] and vp["plan"][-1]["end"] == pytest.approx(vp["duration_s"], abs=0.05)
    assert client.post(f"/api/podcast/ai-video/{vp['id']}/continue").status_code == 409
    return ep, vp


def _take_count(project_id):
    with SessionLocal() as db:
        return db.query(Generation).filter(Generation.project_id == project_id, Generation.kind == "take").count()


def test_pipeline_end_to_end_cuts_the_takes_over_the_episode_mix(client, fast_driver, fake_looks):
    ep, vp = _ready_vp(client, fast_driver, subtitles="soft")
    est = ok(client.get(f"/api/podcast/ai-video/{vp['id']}/estimate?quality=draft"))
    assert est["shots"] == sum(1 for sh in vp["plan"] if sh["type"] != "cover") and est["high_s"] > 0
    assert "video GPU" in est["label"]

    job = ok(client.post(f"/api/podcast/ai-video/{vp['id']}/render", json={"quality": "draft"}), 202)
    _run_all(fast_driver)
    vp = ok(client.get(f"/api/podcast/ai-video/{vp['id']}"))
    assert vp["job"]["id"] == job["id"] and vp["job"]["status"] == "done", vp["job"]
    assert vp["stage"] == "done"
    out = vp["outputs"]["draft"]
    assert out and out["subtitles"] == "soft" and (out["width"], out["height"]) == (832, 480)

    with SessionLocal() as db:
        takes = db.query(Generation).filter(Generation.project_id == vp["project_id"], Generation.kind == "take").all()
        lip = [g for g in takes if g.params.get("lipsync")]
        assert lip and all(g.params["speech_audio"].endswith(".wav") for g in lip)
        assert all(0 <= g.params["audio_start_s"] for g in lip)
        jobs = {db.get(Job, g.job_id).lane for g in takes}
        mix_path = get_settings().data_dir / db.get(Generation, ep["outputs"]["mix"]["generation_id"]).file_path
        video = get_settings().data_dir / db.get(Generation, out["generation_id"]).file_path
        assert db.get(MediaItem, out["media_id"]).kind == "video"
        shot_rows = db.query(Shot).filter(Shot.project_id == vp["project_id"]).count()
    assert jobs == {"video"}
    assert shot_rows == len(vp["plan"]) + len(vp["angles"])
    # as long as the episode, its audio is the episode mix (the takes' own sound is muted), chapters kept
    assert abs(aa.stream_info(video).duration - ep["outputs"]["mix"]["duration_s"]) < 0.15
    kinds = streams(video)  # mp4 chapters show up as a Data track
    assert (kinds.count("Video"), kinds.count("Audio"), kinds.count("Subtitle")) == (1, 1, 1)
    for t in (0.5, ep["outputs"]["mix"]["duration_s"] / 2):
        assert abs(rms(video, t, 0.8) - rms(mix_path, t, 0.8)) < 1.5
    meta = ff_meta(video)
    assert "title=Welcome" in meta and "title=The news" in meta
    assert vp["outputs"]["draft"]["media_id"] in {i["id"] for i in client.get("/api/media?kind=video").json()["items"]}

    # nothing changed: a second draft has nothing to do
    assert ok(client.get(f"/api/podcast/ai-video/{vp['id']}/estimate?quality=draft"))["shots"] == 0
    assert not any(sh["needs"]["draft"] for sh in vp["plan"])
    assert all(sh["needs"]["final"] for sh in vp["plan"] if sh["type"] != "cover")


def test_rerender_only_changed_or_marked_shots(client, fast_driver, fake_looks):
    ep, vp = _ready_vp(client, fast_driver, subtitles="none")
    ok(client.post(f"/api/podcast/ai-video/{vp['id']}/render", json={"quality": "draft"}), 202)
    _run_all(fast_driver)
    before = _take_count(vp["project_id"])
    vp = ok(client.get(f"/api/podcast/ai-video/{vp['id']}"))
    long = max((sh for sh in vp["plan"] if sh["type"] == "lipsync"), key=lambda s: s["duration"])
    other = next(sh for sh in vp["plan"] if sh["type"] == "lipsync" and sh["id"] != long["id"])
    vp = ok(client.post(f"/api/podcast/ai-video/{vp['id']}/shots/{long['id']}/split", json={}))
    vp = ok(client.patch(f"/api/podcast/ai-video/{vp['id']}/shots/{other['id']}", json={"marked": True}))
    need = {sh["id"] for sh in vp["plan"] if sh["needs"]["draft"]}
    assert len(need) == 3 and other["id"] in need and long["id"] in need
    assert ok(client.get(f"/api/podcast/ai-video/{vp['id']}/estimate?quality=draft"))["shots"] == 3
    ok(client.post(f"/api/podcast/ai-video/{vp['id']}/render", json={"quality": "draft"}), 202)
    _run_all(fast_driver)
    vp = ok(client.get(f"/api/podcast/ai-video/{vp['id']}"))
    assert vp["job"]["status"] == "done", vp["job"]
    assert _take_count(vp["project_id"]) == before + 3
    assert not any(sh["marked"] or sh["needs"]["draft"] for sh in vp["plan"])
    # one named shot is re-rendered on request even though nothing changed
    ok(client.post(f"/api/podcast/ai-video/{vp['id']}/render", json={"quality": "draft",
                                                                     "shot_ids": [other["id"]]}), 202)
    _run_all(fast_driver)
    assert _take_count(vp["project_id"]) == before + 4
    # merge back, and a plan edit that leaves a gap is refused
    vp = ok(client.get(f"/api/podcast/ai-video/{vp['id']}"))
    i = next(n for n, sh in enumerate(vp["plan"]) if sh["id"] == long["id"])
    vp = ok(client.post(f"/api/podcast/ai-video/{vp['id']}/shots/merge",
                        json={"shot_ids": [long["id"], vp["plan"][i + 1]["id"]]}))
    assert next(sh for sh in vp["plan"] if sh["id"] == long["id"])["duration"] == pytest.approx(long["duration"], abs=0.05)
    rows = [{k: sh[k] for k in ("id", "type", "angle", "start", "end")} for sh in vp["plan"]]
    rows[1]["start"] += 0.5
    assert client.patch(f"/api/podcast/ai-video/{vp['id']}", json={"plan": rows}).status_code == 422


def test_final_cut_burns_subtitles_and_falls_back_to_draft_takes(client, fast_driver, fake_looks, monkeypatch):
    from app import subtitles

    ep, vp = _ready_vp(client, fast_driver, subtitles="burn", cover_intro=True)
    assert vp["plan"][0]["type"] == "cover" or vp["plan"][0]["line_id"]
    ok(client.post(f"/api/podcast/ai-video/{vp['id']}/render", json={"quality": "draft"}), 202)
    calls = []

    def burn(src, dst, cues, *, language=None, width=None, height=None, timeout=7200, encode=None):
        calls.append({"language": language, "size": (width, height), "cues": list(cues)})
        shutil.copyfile(src, dst)
        return {"renderer": "ass", "fonts_missing": ["Noto Nastaliq Urdu"]}

    monkeypatch.setattr(subtitles, "burn", burn)
    _run_all(fast_driver)
    vp = ok(client.get(f"/api/podcast/ai-video/{vp['id']}"))
    assert vp["outputs"]["draft"]["renderer"] == "ass" and vp["outputs"]["draft"]["fonts_missing"]
    assert calls and calls[0]["language"] == "en" and calls[0]["size"] == (832, 480)
    assert any("welcome" in c[2].lower() for c in calls[0]["cues"])
    # a final cut with no final takes yet uses the draft ones and says so
    ok(client.post(f"/api/podcast/ai-video/{vp['id']}/assemble", json={"quality": "final"}), 202)
    _run_all(fast_driver)
    vp = ok(client.get(f"/api/podcast/ai-video/{vp['id']}"))
    fin = vp["outputs"]["final"]
    assert fin and fin["fallback_shots"] and (fin["width"], fin["height"]) == (1280, 704)
    with SessionLocal() as db:
        video = get_settings().data_dir / db.get(Generation, fin["generation_id"]).file_path
        assert rl.probe(video).width == 1280
        assert db.get(VideoPodcast, vp["id"]).outputs["draft"]["generation_id"] != fin["generation_id"]


def test_0017_adds_the_video_podcast_table(tmp_path):
    import sqlite3

    from tests.test_migrations import _alembic

    db = tmp_path / "prod-copy.db"
    _alembic(db, "upgrade", "0017")
    con = sqlite3.connect(db)
    cols = {r[1] for r in con.execute("PRAGMA table_info(video_podcast)")}
    assert {"id", "workspace_id", "episode_id", "project_id", "stage", "stages", "settings", "hosts",
            "set_location_id", "plan", "outputs", "job_id"} <= cols
    con.close()
    _alembic(db, "downgrade", "0016")
    con = sqlite3.connect(db)
    assert "video_podcast" not in {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    con.close()
    _alembic(db, "upgrade", "head")
