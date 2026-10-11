"""Podcast Studio C2 (contract v20): shows, episodes, document ingest, the LLM writer, recording lines, the
episode mix with music and ducking, publishing (ID3, chapters, SRT) and the Audiogram."""
import io
import json
import re
import sqlite3
import subprocess

import httpx
import pytest

from app import audio_analysis as aa
from app import audio_edit as ae
from app import dialogue as dl
from app.config import get_settings
from app.db import SessionLocal
from app.lanes import lane_for
from app.llm import set_transport
from app.models import Generation, Job, MediaItem, VoiceScript
from app.podcast import ingest, publish
from app.podcast import service as sv
from tests.test_library import png_bytes, upload
from tests.test_migrations import _alembic
from tests.test_storyboard import _run_all
from tests.test_voices import tone


# ---------------------------------------------------------------- helpers

class FakeLLM:
    """Answers by the JSON schema the writer asked for; plain calls (material summaries) get a summary."""

    def __init__(self, answers: dict):
        self.answers = answers
        self.calls: list[str] = []
        self.prompts: list[str] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        schema = ((body.get("response_format") or {}).get("json_schema") or {}).get("schema") or {}
        name = schema.get("title") or "text"
        self.calls.append(name)
        self.prompts.append(body["messages"][-1]["content"])
        answer = self.answers.get(name)
        if callable(answer):
            answer = answer(body)
        content = answer if isinstance(answer, str) else json.dumps(answer, ensure_ascii=False)
        return httpx.Response(200, json={"choices": [{"message": {"content": content}, "finish_reason": "stop"}],
                                         "usage": {}})


@pytest.fixture
def fake_llm():
    def install(answers):
        fake = FakeLLM(answers)
        set_transport(httpx.MockTransport(fake))
        return fake
    yield install
    set_transport(None)


def ok(r, code=200):
    assert r.status_code == code, r.text
    return r.json()


def episode(client, **body):
    body.setdefault("title", "New episode")
    body.setdefault("hosts", [{"name": "Ali", "role": "host", "persona": "curious"},
                              {"name": "Sara", "role": "cohost", "persona": "dry wit"}])
    return ok(client.post("/api/podcast/episodes", json=body), 201)


def get(client, ep):
    return ok(client.get(f"/api/podcast/episodes/{ep['id']}"))


def script(client, ep):
    return ok(client.get(f"/api/scripts/{get(client, ep)['script_id']}"))


def paste(client, ep, text):
    return ok(client.post(f"/api/podcast/episodes/{ep['id']}/script", json={"text": text}))


def clip(client, tmp_path, seconds, freq=330, name=None):
    p = tone(tmp_path / (name or f"t{freq}_{seconds}.wav"), seconds, freq)
    return ok(upload(client, p.name, p.read_bytes(), "audio/wav", title=p.stem), 201)


def master_path(client, ep):
    mix = get(client, ep)["outputs"]["mix"]
    with SessionLocal() as db:
        return get_settings().data_dir / db.get(Generation, mix["generation_id"]).file_path


def rms(path, start, dur, lowpass=None):
    af = ",".join([*(["lowpass=f=60"] * 4 if lowpass else []), "astats=metadata=0:measure_perchannel=none"])
    err = ae.run(["-ss", f"{start:.3f}", "-t", f"{dur:.3f}", "-i", str(path), "-af", af, "-f", "null", "-"])
    m = re.findall(r"RMS level dB:\s*(-?[\d.]+|-inf)", err)
    return float(m[-1]) if m and m[-1] != "-inf" else -200.0


def ff_meta(path):
    out = path.with_suffix(".meta.txt")
    subprocess.run([get_settings().ffmpeg_path(), "-y", "-loglevel", "error", "-i", str(path), "-f", "ffmetadata",
                    str(out)], check=True, capture_output=True)
    return out.read_text(encoding="utf-8")


def streams(path):
    r = subprocess.run([get_settings().ffmpeg_path(), "-hide_banner", "-i", str(path)], capture_output=True,
                       text=True, encoding="utf-8", errors="replace")
    return re.findall(r"Stream #\S+?(?:\[\w+\])?(?:\(\w+\))?: (Video|Audio|Data|Subtitle)", r.stderr)


DIALOGUE = "# Welcome\nAli: Hello and welcome to the show today.\nSara: Thanks Ali, glad to be here.\n" \
           "# The news\nAli: Big news this week from the river.\nSara: The bridge finally opened."


# ---------------------------------------------------------------- schema and lanes

def test_0016_adds_podcast_tables(tmp_path):
    db = tmp_path / "prod-copy.db"
    _alembic(db, "upgrade", "0016")
    con = sqlite3.connect(db)
    cols = {r[1] for r in con.execute("PRAGMA table_info(podcast_episode)")}
    assert {"id", "workspace_id", "show_id", "title", "format", "language", "target_minutes", "sources", "hosts",
            "chapters", "script_id", "settings", "notes", "outputs"} <= cols
    assert {"name", "author", "cover_media_id", "hosts", "music", "ads"} <= \
        {r[1] for r in con.execute("PRAGMA table_info(podcast_show)")}
    con.close()
    _alembic(db, "downgrade", "0015")
    con = sqlite3.connect(db)
    tables = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert not {"podcast_show", "podcast_episode"} & tables
    con.close()
    _alembic(db, "upgrade", "head")


def test_podcast_jobs_run_on_the_general_lane():
    for t in (sv.WRITE_JOB, sv.MIX_JOB, sv.PUBLISH_JOB, sv.VIDEO_JOB):
        assert lane_for(t) == "general"


# ---------------------------------------------------------------- shows and episodes

def test_show_and_episode_crud(client, tmp_path):
    jingle = clip(client, tmp_path, 1.5)
    cover = ok(upload(client, "c.png", png_bytes(), "image/png"), 201)
    show = ok(client.post("/api/podcast/shows", json={
        "name": "River Talk", "language": "ur", "author": "Mix AI", "cover_media_id": cover["id"],
        "hosts": [{"name": "Ali", "voice_id": "gallery:ur-lahore-narrator"}, {"name": "Me", "me": True,
                                                                            "voice_id": "ignored"}],
        "music": {"intro_media_id": jingle["id"]}}), 201)
    assert show["cover_url"] and show["episodes"] == 0
    assert [h["voice_id"] for h in show["hosts"]] == ["gallery:ur-lahore-narrator", None]

    show = ok(client.post(f"/api/podcast/shows/{show['id']}/ads", json={"name": "Sponsor", "kind": "sponsor",
                                                                        "text": "Brought to you by tea."}))
    show = ok(client.post(f"/api/podcast/shows/{show['id']}/ads", json={"name": "Sting", "media_id": jingle["id"]}))
    assert [a["kind"] for a in show["ads"]] == ["sponsor", "jingle"]
    assert client.post(f"/api/podcast/shows/{show['id']}/ads", json={"name": "Empty"}).status_code == 422
    show = ok(client.delete(f"/api/podcast/shows/{show['id']}/ads/{show['ads'][0]['id']}"))
    assert len(show["ads"]) == 1

    # an episode takes the show's language, hosts and music
    ep = ok(client.post("/api/podcast/episodes", json={"show_id": show["id"], "format": "interview",
                                                       "topic": "The new bridge"}), 201)
    assert ep["language"] == "ur" and ep["show_name"] == "River Talk"
    assert [h["name"] for h in ep["hosts"]] == ["Ali", "Me"] and ep["hosts"][1]["me"]
    assert ep["settings"]["intro"]["media_id"] == jingle["id"] and ep["settings"]["loudness"] == "stereo"
    assert ep["sources"]["topic"] == "The new bridge" and ep["script_id"] is None

    ep = ok(client.patch(f"/api/podcast/episodes/{ep['id']}", json={
        "title": "Bridge day", "target_minutes": 3, "step": 2, "sources": {"text": "Some notes."},
        "settings": {**ep["settings"], "duck_db": 9, "loudness": "mono"}}))
    assert ep["title"] == "Bridge day" and ep["step"] == 2 and ep["settings"]["duck_db"] == 9
    assert ep["sources"]["text"] == "Some notes."
    bad = {**ep["settings"], "bed": {"media_id": cover["id"], "gain_db": -20}}
    assert client.patch(f"/api/podcast/episodes/{ep['id']}", json={"settings": bad}).status_code == 422
    assert client.post("/api/podcast/episodes", json={"title": "x", "format": "rant"}).status_code == 422

    assert ok(client.get(f"/api/podcast/episodes?show_id={show['id']}"))[0]["id"] == ep["id"]
    assert ok(client.get(f"/api/podcast/shows/{show['id']}"))["episodes"] == 1
    # deleting the show keeps the episode
    assert client.delete(f"/api/podcast/shows/{show['id']}").status_code == 204
    assert get(client, ep)["show_id"] is None
    assert client.delete(f"/api/podcast/episodes/{ep['id']}").status_code == 204
    assert client.get(f"/api/podcast/episodes/{ep['id']}").status_code == 404


def test_pasted_script_makes_chapters_hosts_and_lines(client):
    ep = episode(client, hosts=[{"name": "Ali"}])
    ep = paste(client, ep, DIALOGUE)
    assert [c["title"] for c in ep["chapters"]] == ["Welcome", "The news"]
    assert [h["name"] for h in ep["hosts"]] == ["Ali", "Sara"]
    s = script(client, ep)
    names = {c["id"]: c["name"] for c in s["cast"]}
    assert [names[ln["speaker_id"]] for ln in s["lines"]] == ["Ali", "Sara", "Ali", "Sara"]
    assert [ln["chapter_id"] for ln in s["lines"]] == [ep["chapters"][0]["id"]] * 2 + [ep["chapters"][1]["id"]] * 2
    assert ep["words"] == 24 and ep["minutes"] == round(24 / 150, 1)
    # a host's voice reaches the script's cast; "me" turns their lines into recordings
    hosts = ep["hosts"]
    hosts[0]["voice_id"] = "gallery:af_heart"
    hosts[1]["me"] = True
    ep = ok(client.patch(f"/api/podcast/episodes/{ep['id']}", json={"hosts": hosts}))
    s = script(client, ep)
    cast = {c["id"]: c for c in s["cast"]}
    assert cast[hosts[0]["id"]]["voice_id"] == "gallery:af_heart" and cast[hosts[1]["id"]]["voice_id"] is None
    assert [ln["kind"] for ln in s["lines"]] == ["speech", "recording", "speech", "recording"]
    hosts[1]["me"] = False
    s = script(client, ok(client.patch(f"/api/podcast/episodes/{ep['id']}", json={"hosts": hosts})))
    assert {ln["kind"] for ln in s["lines"]} == {"speech"}
    assert client.post(f"/api/podcast/episodes/{ep['id']}/script", json={"text": "# Only a title"}).status_code == 422


# ---------------------------------------------------------------- ingest

def _pdf(text: str) -> bytes:
    stream = f"BT /F1 18 Tf 20 100 Td ({text}) Tj ET".encode()
    objs = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 144] /Contents 4 0 R "
            b"/Resources << /Font << /F1 5 0 R >> >> >>",
            b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream",
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    out, offsets = io.BytesIO(), []
    out.write(b"%PDF-1.4\n")
    for n, body in enumerate(objs, start=1):
        offsets.append(out.tell())
        out.write(b"%d 0 obj\n" % n + body + b"\nendobj\n")
    xref = out.tell()
    out.write(b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1))
    for off in offsets:
        out.write(b"%010d 00000 n \n" % off)
    out.write(b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref))
    return out.getvalue()


def _docx(*paras: str) -> bytes:
    docx = pytest.importorskip("docx")
    d = docx.Document()
    for p in paras:
        d.add_paragraph(p)
    t = d.add_table(rows=1, cols=2)
    t.rows[0].cells[0].text, t.rows[0].cells[1].text = "Year", "2026"
    buf = io.BytesIO()
    d.save(buf)
    return buf.getvalue()


def test_ingest_txt_md_pdf_docx(client):
    ep = episode(client)
    url = f"/api/podcast/episodes/{ep['id']}/sources"
    ep = ok(client.post(url, files={"file": ("notes.md", "# Bridge\n\n\n\nOpened   on Monday.".encode(), "text/plain")}))
    doc = ep["sources"]["docs"][0]
    assert doc["type"] == "md" and doc["chars"] == len("# Bridge\n\nOpened on Monday.") and "text" not in doc
    ep = ok(client.post(url, files={"file": ("urdu.txt", "پل کھل گیا".encode("utf-16"), "text/plain")}))
    assert ep["sources"]["docs"][1]["chars"] == len("پل کھل گیا")

    pytest.importorskip("pypdf")
    ep = ok(client.post(url, files={"file": ("report.pdf", _pdf("Hello podcast PDF"), "application/pdf")}))
    assert ep["sources"]["docs"][2]["type"] == "pdf" and ep["sources"]["docs"][2]["pages"] == 1
    ep = ok(client.post(url, files={"file": ("brief.docx", _docx("Hello from Word."), "application/octet-stream")}))
    assert ep["sources"]["docs"][3]["type"] == "docx"
    with SessionLocal() as db:
        from app.models import PodcastEpisode

        docs = db.get(PodcastEpisode, ep["id"]).sources["docs"]
    assert "Hello podcast PDF" in docs[2]["text"] and "Hello from Word." in docs[3]["text"]
    assert "Year | 2026" in docs[3]["text"]
    material = ingest.material({"text": "pasted", "docs": docs})
    assert material.startswith("pasted") and "## report.pdf" in material

    r = client.post(url, files={"file": ("old.doc", b"\xd0\xcf\x11\xe0junk", "application/msword")})
    assert r.status_code == 422 and ".docx" in r.json()["detail"]
    assert client.post(url, files={"file": ("x.exe", b"MZ", "application/octet-stream")}).status_code == 422
    assert client.post(url, files={"file": ("empty.txt", b"", "text/plain")}).status_code == 422
    ep = ok(client.delete(f"{url}/{docs[0]['id']}"))
    assert len(ep["sources"]["docs"]) == 3


def test_chunks_cut_at_paragraphs():
    text = "\n\n".join(f"Paragraph {i}. " + "word " * 200 for i in range(30))
    parts = ingest.chunks(text, 3000)
    assert len(parts) > 3 and all(len(p) <= 3000 for p in parts)
    assert all(p.startswith("Paragraph") for p in parts)


# ---------------------------------------------------------------- the writer

EPISODE_JSON = {"title": "The bridge opens", "chapters": [
    {"title": "Hello", "lines": [{"host": "Ali", "text": "Welcome to the show."},
                                 {"host": "Sara", "text": "Good to be here."},
                                 {"host": "ali", "text": "Today, the bridge."}]},
    {"title": "Wrap", "lines": [{"host": "Sara", "text": "That was quick."},
                                {"host": "Ali", "text": "See you next week."}]}]}


def test_writer_turns_llm_json_into_script_lines(client, fake_llm, fast_driver):
    fake = fake_llm({"WEpisode": EPISODE_JSON,
                     "WLines": {"lines": [{"host": "Ali", "text": "Welcome, and today: the bridge."}]}})
    ep = episode(client, topic="A new bridge", target_minutes=3,
                 hosts=[{"name": "Ali"}, {"name": "Sara", "role": "cohost", "me": True}])
    assert client.post(f"/api/podcast/episodes/{episode(client, hosts=[])['id']}/write").status_code == 422
    job = ok(client.post(f"/api/podcast/episodes/{ep['id']}/write"), 202)
    assert job["type"] == "podcast_write" and job["lane"] == "general"
    # one write at a time
    assert client.post(f"/api/podcast/episodes/{ep['id']}/write").status_code == 409
    _run_all(fast_driver)
    ep = get(client, ep)
    assert ep["jobs"]["write"]["status"] == "done", ep["jobs"]["write"]
    assert fake.calls == ["WEpisode"]
    assert "Topic: A new bridge" in fake.prompts[0]
    assert ep["title"] == "The bridge opens"
    assert [c["title"] for c in ep["chapters"]] == ["Hello", "Wrap"]
    s = script(client, ep)
    names = {c["id"]: c["name"] for c in s["cast"]}
    assert [(names[ln["speaker_id"]], ln["kind"]) for ln in s["lines"]] == [
        ("Ali", "speech"), ("Sara", "recording"), ("Ali", "speech"), ("Sara", "recording"), ("Ali", "speech")]
    assert s["lines"][2]["para"] is True and s["lines"][3]["chapter_id"] == ep["chapters"][1]["id"]

    # Shorter on two lines: replaced in place by what the LLM sent back
    picked = [s["lines"][0]["id"], s["lines"][2]["id"]]
    ok(client.post(f"/api/podcast/episodes/{ep['id']}/edit-lines", json={"op": "shorter", "line_ids": picked}), 202)
    _run_all(fast_driver)
    s = script(client, ep)
    assert [ln["text"] for ln in s["lines"]][:2] == ["Welcome, and today: the bridge.", "Good to be here."]
    assert len(s["lines"]) == 4 and s["lines"][0]["chapter_id"] == ep["chapters"][0]["id"]
    assert fake.calls[-1] == "WLines" and "Ali: Welcome to the show." in fake.prompts[-1]
    assert client.post(f"/api/podcast/episodes/{ep['id']}/edit-lines",
                       json={"op": "rewrite_chapter"}).status_code == 422


def test_writer_outlines_long_episodes_and_condenses_long_material(client, fake_llm, fast_driver):
    outline = {"title": "Rivers", "chapters": [{"title": "One", "beats": ["a"]}, {"title": "Two", "beats": ["b"]}]}
    fake = fake_llm({"Outline": outline, "text": "SUMMARY POINTS",
                     "WLines": lambda body: {"lines": [{"host": "Ali", "text": "Chapter words here."}]}})
    ep = episode(client, target_minutes=10, language="ur")
    long_text = "\n\n".join("The river carries silt to the sea every spring. " * 12 for _ in range(30))
    ok(client.patch(f"/api/podcast/episodes/{ep['id']}", json={"sources": {"text": long_text}}))
    ok(client.post(f"/api/podcast/episodes/{ep['id']}/write"), 202)
    _run_all(fast_driver)
    ep = get(client, ep)
    assert ep["jobs"]["write"]["status"] == "done", ep["jobs"]["write"]
    n = len(ingest.chunks(long_text))
    assert n >= 2 and fake.calls == ["text"] * n + ["Outline", "WLines", "WLines"]
    # the writer read the summaries, not the material; Urdu is asked for in Urdu script
    assert "SUMMARY POINTS" in fake.prompts[n] and "silt" not in fake.prompts[n]
    assert [c["title"] for c in ep["chapters"]] == ["One", "Two"] and len(script(client, ep)["lines"]) == 2


def test_notes_need_a_mix_then_come_from_the_llm(client, fake_llm, fast_driver):
    ep = paste(client, episode(client), DIALOGUE)
    assert client.post(f"/api/podcast/episodes/{ep['id']}/notes").status_code == 409
    ok(client.post(f"/api/podcast/episodes/{ep['id']}/render"), 202)
    _run_all(fast_driver)
    ok(client.post(f"/api/podcast/episodes/{ep['id']}/mix"), 202)
    _run_all(fast_driver)
    fake_llm({"Notes": {"description": "Two friends on a bridge.", "key_points": ["It opened", " "]}})
    ok(client.post(f"/api/podcast/episodes/{ep['id']}/notes"), 202)
    _run_all(fast_driver)
    ep = get(client, ep)
    assert ep["notes"]["description"] == "Two friends on a bridge." and ep["notes"]["key_points"] == ["It opened"]
    assert [c["title"] for c in ep["notes"]["chapters"]] == ["Welcome", "The news"]
    assert ep["notes"]["chapters"][0]["start"] == 0
    md = client.get(f"/api/podcast/episodes/{ep['id']}/notes.md")
    assert md.status_code == 200 and "## Chapters" in md.text and "- 00:00 Welcome" in md.text
    assert "- It opened" in md.text


# ---------------------------------------------------------------- recordings and render

def test_recording_lines_skip_tts_and_use_the_clip(client, tmp_path, fast_driver):
    ep = episode(client, hosts=[{"name": "Ali"}, {"name": "Sara", "me": True}])
    ep = paste(client, ep, DIALOGUE)
    s = script(client, ep)
    assert [ln["status"] for ln in s["lines"]] == ["empty"] * 4
    out = ok(client.post(f"/api/podcast/episodes/{ep['id']}/render"), 202)
    assert out["queued"] == 2  # only Ali's lines
    _run_all(fast_driver)
    s = script(client, ep)
    assert [ln["status"] for ln in s["lines"]] == ["ready", "empty", "ready", "empty"]
    assert client.post(f"/api/podcast/episodes/{ep['id']}/mix").status_code == 409

    take = clip(client, tmp_path, 2.0, 500)
    for ln in (s["lines"][1], s["lines"][3]):
        ep = ok(client.post(f"/api/podcast/episodes/{ep['id']}/record-line",
                            json={"line_id": ln["id"], "media_id": take["id"]}))
    s = script(client, ep)
    assert [ln["status"] for ln in s["lines"]] == ["ready"] * 4
    rec = s["lines"][1]
    assert rec["kind"] == "recording" and rec["media_id"] == take["id"] and rec["take_media_id"] == take["id"]
    assert abs(rec["duration_s"] - 2.0) < 0.05 and rec["take_url"]
    # nothing went to TTS for it, and the clip is now a hidden take
    with SessionLocal() as db:
        assert db.get(MediaItem, take["id"]).tags == [dl.take_tag(s["id"])]
        speech = db.query(Generation).filter(Generation.kind == "speech").count()
    assert speech == 2
    assert ok(client.post(f"/api/podcast/episodes/{ep['id']}/render"), 202)["queued"] == 0
    assert client.post(f"/api/podcast/episodes/{ep['id']}/record-line",
                       json={"line_id": "nope", "media_id": take["id"]}).status_code == 404

    # the Dialogue mix of the same script plays the recordings too
    ok(client.post(f"/api/scripts/{s['id']}/mix"), 202)
    _run_all(fast_driver)
    s = script(client, ep)
    assert s["mix"] and abs(s["mix"]["duration_s"] - (sum(ln["duration_s"] for ln in s["lines"]) + 0.35 + 0.8 + 0.35)) < 0.15


# ---------------------------------------------------------------- the mix

def _produced(client, tmp_path, fast_driver, **settings):
    ep = paste(client, episode(client), DIALOGUE)
    intro, outro = clip(client, tmp_path, 6.0, 880, "intro.wav"), clip(client, tmp_path, 4.0, 990, "outro.wav")
    bed = clip(client, tmp_path, 3.0, 40, "bed.wav")
    ad = clip(client, tmp_path, 1.5, 700, "ad.wav")
    s = script(client, ep)
    # an ad at the chapter boundary, and a 2 s break after the first line
    ep = ok(client.post(f"/api/podcast/episodes/{ep['id']}/insert",
                        json={"kind": "ad", "after_line_id": s["lines"][1]["id"], "media_id": ad["id"]}))
    ep = ok(client.post(f"/api/podcast/episodes/{ep['id']}/insert",
                        json={"kind": "break", "after_line_id": s["lines"][0]["id"], "seconds": 2.0}))
    st = {**ep["settings"], "intro": {"media_id": intro["id"], "lead_s": 2.0, "overlap_s": 1.0, "gain_db": 0},
          "outro": {"media_id": outro["id"], "overlap_s": 1.0, "gain_db": 0, "max_s": 30},
          "bed": {"media_id": bed["id"], "gain_db": -12}, "gap_s": 0.3, "chapter_gap_s": 1.0, **settings}
    ep = ok(client.patch(f"/api/podcast/episodes/{ep['id']}", json={"settings": st}))
    ok(client.post(f"/api/podcast/episodes/{ep['id']}/render"), 202)
    _run_all(fast_driver)
    job = ok(client.post(f"/api/podcast/episodes/{ep['id']}/mix"), 202)
    assert job["type"] == "podcast_mix" and job["lane"] == "general"
    _run_all(fast_driver)
    ep = get(client, ep)
    assert ep["jobs"]["mix"]["status"] == "done", ep["jobs"]["mix"]
    return ep


def test_mix_order_duration_and_ducking(client, tmp_path, fast_driver):
    ep = _produced(client, tmp_path, fast_driver, loudness="none", duck_db=15)
    mix = ep["outputs"]["mix"]
    tl = mix["timeline"]
    assert [t["kind"] for t in tl] == ["speech", "speech", "ad", "speech", "speech"]
    s = script(client, ep)
    durs = {ln["id"]: ln["duration_s"] for ln in s["lines"]}
    # intro lead, then each line with its gap: the break after line 1, the paragraph gap closing chapter 1,
    # then the ad (still chapter 1) and the chapter gap after it
    assert tl[0]["start"] == 2.0
    expect = [2.0]
    gaps = [0.3 + 2.0, 0.8, 0.3 + 1.0, 0.3]
    for t, g in zip(tl, gaps):
        expect.append(expect[-1] + durs[t["line_id"]] + g)
    assert [t["start"] for t in tl] == pytest.approx(expect, abs=0.01)
    assert tl[2]["chapter_id"] == ep["chapters"][0]["id"]
    voice_end = tl[-1]["end"]
    # the outro starts 1 s before the voice ends and plays its 4 s
    assert mix["duration_s"] == pytest.approx(voice_end - 1.0 + 4.0, abs=0.08)
    assert mix["chapters"][0]["start"] == 0 and mix["chapters"][1]["start"] == tl[3]["start"]
    assert mix["chapters"][1]["end"] == pytest.approx(mix["duration_s"], abs=0.01) and mix["stale"] is False
    path = master_path(client, ep)
    assert aa.stream_info(path).channels == 2

    # the 40 Hz bed, isolated with a low-pass: well down under a line, back up in the 2 s break
    a = tl[0]
    under = rms(path, a["start"] + 0.5, a["end"] - a["start"] - 0.6, lowpass=True)
    brk = rms(path, a["end"] + 0.9, 1.4, lowpass=True)
    assert brk - under > 8, (brk, under)

    # without ducking the bed stays at its level under speech
    st = {**ep["settings"], "duck_db": 0}
    ep = ok(client.patch(f"/api/podcast/episodes/{ep['id']}", json={"settings": st}))
    assert ep["outputs"]["mix"]["stale"] is True
    ok(client.post(f"/api/podcast/episodes/{ep['id']}/mix"), 202)
    _run_all(fast_driver)
    ep2 = get(client, ep)
    assert ep2["outputs"]["mix"]["media_id"] == mix["media_id"]
    assert ep2["outputs"]["mix"]["generation_id"] != mix["generation_id"]
    flat = rms(master_path(client, ep2), a["start"] + 0.5, a["end"] - a["start"] - 0.6, lowpass=True)
    assert flat - under > 8, (flat, under)


def test_mix_levels_to_podcast_loudness(client, tmp_path, fast_driver):
    ep = _produced(client, tmp_path, fast_driver)
    path = master_path(client, ep)
    err = ae.run(["-i", str(path), "-af", "ebur128=peak=true:framelog=quiet", "-f", "null", "-"])
    m = aa.parse_ebur128(err)
    assert m["lufs_i"] == pytest.approx(-16.0, abs=1.5) and m["true_peak_db"] <= -0.5
    ep = ok(client.patch(f"/api/podcast/episodes/{ep['id']}", json={"settings": {**ep["settings"],
                                                                                   "loudness": "mono"}}))
    ok(client.post(f"/api/podcast/episodes/{ep['id']}/mix"), 202)
    _run_all(fast_driver)
    assert aa.stream_info(master_path(client, ep)).channels == 1


# ---------------------------------------------------------------- publishing

def test_publish_mp3_with_tags_cover_and_chapters(client, tmp_path, fast_driver):
    assert client.post(f"/api/podcast/episodes/{episode(client)['id']}/publish").status_code == 409
    show = ok(client.post("/api/podcast/shows", json={"name": "River Talk", "author": "Mix AI",
                                                      "description": "Weekly; about rivers = life"}), 201)
    ep = _produced(client, tmp_path, fast_driver, loudness="none")
    cover = ok(upload(client, "c.png", png_bytes(), "image/png"), 201)
    ok(client.patch(f"/api/podcast/episodes/{ep['id']}", json={"show_id": show["id"], "title": "Bridge day"}))
    job = ok(client.post(f"/api/podcast/episodes/{ep['id']}/publish",
                         json={"format": "mp3", "cover_media_id": cover["id"], "notes": False}), 202)
    assert job["type"] == "podcast_publish" and job["lane"] == "general"
    _run_all(fast_driver)
    ep = get(client, ep)
    assert ep["jobs"]["publish"]["status"] == "done", ep["jobs"]["publish"]
    pub = ep["outputs"]["publish"]
    assert pub["format"] == "mp3" and pub["url"]
    with SessionLocal() as db:
        g = db.get(Generation, pub["generation_id"])
        path = get_settings().data_dir / g.file_path
        assert g.media_type == "audio/mpeg" and db.get(MediaItem, pub["media_id"]).kind == "audio"
    meta = ff_meta(path)
    assert "title=Bridge day" in meta and "album=River Talk" in meta and "artist=Mix AI" in meta
    assert "genre=Podcast" in meta and "Weekly\\; about rivers \\= life" in meta
    marks = re.findall(r"\[CHAPTER\]\nTIMEBASE=1/1000\nSTART=(\d+)\nEND=(\d+)\ntitle=(.+)", meta)
    chapters = ep["outputs"]["mix"]["chapters"]
    assert [m[2] for m in marks] == ["Welcome", "The news"]
    assert [int(m[0]) for m in marks] == pytest.approx([round(c["start"] * 1000) for c in chapters], abs=30)
    assert streams(path).count("Video") == 1  # the cover, as an attached picture
    assert abs(aa.stream_info(path).duration - ep["outputs"]["mix"]["duration_s"]) < 0.15

    ok(client.post(f"/api/podcast/episodes/{ep['id']}/publish", json={"format": "m4a", "notes": False}), 202)
    _run_all(fast_driver)
    ep = get(client, ep)
    with SessionLocal() as db:
        g = db.get(Generation, ep["outputs"]["publish"]["generation_id"])
        assert g.media_type == "audio/mp4" and g.version == 2
        meta = ff_meta(get_settings().data_dir / g.file_path)
    assert "title=Bridge day" in meta and meta.count("[CHAPTER]") == 2


def test_srt_timings_match_the_timeline(client, tmp_path, fast_driver):
    ep = _produced(client, tmp_path, fast_driver, loudness="none")
    r = client.get(f"/api/podcast/episodes/{ep['id']}/subtitles.srt")
    assert r.status_code == 200 and "attachment" in r.headers["content-disposition"]
    starts = re.findall(r"(\d\d):(\d\d):(\d\d),(\d{3}) -->", r.text)
    secs = [int(h) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000 for h, m, s, ms in starts]
    spoken = [t for t in ep["outputs"]["mix"]["timeline"] if t["kind"] == "speech"]
    assert len(secs) >= len(spoken)
    for t in spoken:
        assert any(abs(x - t["start"]) < 0.002 for x in secs), t
    assert "Hello and welcome to the show today." in r.text
    out = ok(client.get(f"/api/podcast/episodes/{ep['id']}/outputs"))
    assert out["srt_url"].endswith("/subtitles.srt") and out["mix"]["timeline"]


def test_video_podcast_mp4(client, tmp_path, fast_driver):
    ep = _produced(client, tmp_path, fast_driver, loudness="none")
    job = ok(client.post(f"/api/podcast/episodes/{ep['id']}/video",
                         json={"aspect": "1:1", "burn_subtitles": True}), 202)
    assert job["type"] == "podcast_video" and job["lane"] == "general"
    assert client.post(f"/api/podcast/episodes/{ep['id']}/video", json={"aspect": "4:3"}).status_code == 422
    _run_all(fast_driver)
    ep = get(client, ep)
    assert ep["jobs"]["video"]["status"] == "done", ep["jobs"]["video"]
    vid = ep["outputs"]["video"]
    assert vid["aspect"] == "1:1" and vid["burned"] is True
    with SessionLocal() as db:
        g = db.get(Generation, vid["generation_id"])
        item = db.get(MediaItem, vid["media_id"])
        path = get_settings().data_dir / g.file_path
        assert item.kind == "video" and g.media_type == "video/mp4"
        res = db.get(Job, ep["jobs"]["video"]["id"]).result
    assert (res["width"], res["height"]) == (1080, 1080)
    assert sorted(streams(path)) == ["Audio", "Video"]
    assert abs(aa.stream_info(path).duration - ep["outputs"]["mix"]["duration_s"]) < 0.2
    # it's a Library video like any other
    ids = {i["id"] for i in client.get("/api/media?kind=video").json()["items"]}
    assert vid["media_id"] in ids


def test_speaker_spans_merge_a_speakers_run():
    tl = [{"kind": "speech", "name": "Ali", "start": 0, "end": 1}, {"kind": "speech", "name": "Ali", "start": 1.3,
                                                                     "end": 2},
          {"kind": "ad", "name": "", "start": 2.2, "end": 3}, {"kind": "speech", "name": "Sara", "start": 3.5,
                                                               "end": 4}]
    assert publish.speaker_spans(tl) == {"Ali": [(0, 2)], "Sara": [(3.5, 4)]}


def test_clip_lines_in_the_dialogue_model():
    line = {"id": "l1", "kind": "recording", "media_id": None, "text": "hi"}
    assert not dl.needs_tts(line) and not dl.has_clip(line)
    assert dl.needs_tts({"kind": "ad", "text": "Sponsor"}) and not dl.needs_tts({"kind": "ad", "media_id": "m"})
    s = VoiceScript(settings={})
    lines = [{"id": "a", "speaker_id": "narrator", "take_id": "t1", "text": "one"},
             {"id": "b", "kind": "break", "pause_after_s": 1.5},
             {"id": "c", "speaker_id": "narrator", "kind": "music", "media_id": "m", "take_id": "t2"},
             {"id": "d", "kind": "break"}]
    takes, gaps, _, _ = dl.mix_plan(s, lines)
    assert takes == ["t1", "t2"] and gaps == [pytest.approx(0.35 + 1.5), 0.0]
