"""Strict aerab / tashkeel across the Arabic-script languages (contract v23): detection, the per-language letter
check, coverage and the strict retry, the first-pass rule in every writer and the verified second pass after it."""
import json

import httpx
import pytest

from app import aerab
from app.config import get_settings
from app.db import SessionLocal
from app.dub import text as tx
from app.llm import set_transport
from app.models import Generation, Transcript
from tests.test_aerab import MARKED, PLAIN
from tests.test_ai import run_job, schema_title
from tests.test_audio_edit import upload_video
from tests.test_dub import get as get_dub, make_dub, statuses
from tests.test_storyboard import _run_all
from tests.test_transcribe import reply, talking_clip

AR = "هذا سطر جميل"
AR_MARKED = "هَذَا سَطْرٌ جَمِيلٌ"
FA = "این کتاب خوب است"
FA_MARKED = "این کِتاب خوب اَست"
SAMPLES = {"ar": (AR, AR_MARKED), "ur": (PLAIN, MARKED), "fa": (FA, FA_MARKED)}


def text_reply(content: str) -> httpx.Response:
    return httpx.Response(200, json={"choices": [{"message": {"content": content}, "finish_reason": "stop"}],
                                     "usage": {}})


class Router:
    """Fake LLM: the marking pass gets `mark` run over its numbered lines, every writer gets `write(body)`."""

    def __init__(self, write=None, mark=None, marks_down=False):
        self.write = write or (lambda body: text_reply("ok"))
        self.mark = mark or (lambda x: x)
        self.marks_down = marks_down
        self.systems: list[str] = []
        self.mark_systems: list[str] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        system = body["messages"][0]["content"]
        if schema_title(body) == "Marked":
            self.mark_systems.append(system)
            if self.marks_down:
                return httpx.Response(500, json={"error": "marker is down"})
            lines = [row.split(". ", 1)[1] for row in body["messages"][-1]["content"].split("\n")]
            return reply({"lines": [self.mark(x) for x in lines]})
        self.systems.append(system)
        out = self.write(body)
        return reply(out) if isinstance(out, dict) else out


def swap(*pairs):
    def fn(line: str) -> str:
        for plain, marked in pairs:
            line = line.replace(plain, marked)
        return line
    return fn


@pytest.fixture
def router():
    def install(**kw):
        fake = Router(**kw)
        set_transport(httpx.MockTransport(fake))
        return fake
    yield install
    set_transport(None)


@pytest.fixture
def only_urdu():
    s = get_settings()
    before = s.aerab_languages
    s.aerab_languages = "ur"
    yield
    s.aerab_languages = before


# ---------------------------------------------------------------- the module

def test_detect_language_by_letters():
    assert aerab.detect_language(AR) == "ar" and aerab.detect_language("كتاب جميل") == "ar"
    assert aerab.detect_language(PLAIN) == "ur" and aerab.detect_language("یہ میری آواز ہے") == "ur"
    assert aerab.detect_language(FA) == "fa" and aerab.detect_language("سلام، حال شما چطور است؟") == "fa"
    assert aerab.detect_language("زه په کور کې یم") == "ps"
    assert aerab.detect_language("ٻار ڪتاب پڙهي ٿو") == "sd"
    assert aerab.detect_language("ساڈا پنجاب بہت سوہݨا اے") == "pnb"
    assert aerab.detect_language("hello there") is None and aerab.detect_language("") is None


def test_resolve_and_applies(only_urdu):
    assert aerab.resolve("ar-EG") == "ar" and aerab.resolve("ur-latn", PLAIN) is None
    assert aerab.resolve("pa", "ساڈا پنجاب") == "pnb" and aerab.resolve("pa", "ਪੰਜਾਬ") is None
    assert aerab.resolve("auto", AR) == "ar" and aerab.resolve("en", AR) is None
    # aerab_languages limits which ones get marks
    assert aerab.applies("ur", PLAIN) and not aerab.applies("ar", AR) and not aerab.applies("ur", "hello")
    assert aerab.writing_rule("ar") == "" and "aerab" in aerab.writing_rule("ur")


def test_master_switch_turns_everything_off():
    s = get_settings()
    s.urdu_aerab = False
    try:
        assert not aerab.applies("ur", PLAIN) and aerab.writing_rule("ur") == ""
        assert aerab.quoted_spoken(f'He says "{PLAIN}"') == []
    finally:
        s.urdu_aerab = True


def test_letter_check_is_language_aware():
    # Arabic text keeps its Arabic letters even when the LLM answers with Persian kaf / ye
    assert aerab.transfer("كتاب", "کِتَابٌ", "ar") == "كِتَابٌ"
    assert aerab.transfer("في", "فِی", "ar") == "فِي"
    # alef maqsura and ye are different letters in Arabic: no fold
    assert aerab.transfer("على", "عَلَيْ", "ar") is None
    # a hamza seat the model added doesn't sink the line, the writer's bare alif stays
    assert aerab.transfer("انا", "أَنَا", "ar") == "اَنَا"
    # Urdu still folds the Arabic look-alikes onto its own letters
    assert aerab.transfer(PLAIN, "دِل كي بات", "ur") == MARKED
    # Pashto writes ي and ی as two letters, Sindhi's k is ڪ
    assert aerab.transfer("سړی", "سړي", "ps") is None
    assert aerab.transfer("ڪتاب", "كِتاب", "sd") == "ڪِتاب"


def test_coverage_counts_words_not_function_words():
    assert aerab.coverage(AR_MARKED) == 1.0 and aerab.coverage(AR) == 0.0
    assert aerab.coverage(MARKED) == 0.5  # کی is a function word
    assert aerab.coverage("hello") == 1.0 and aerab.coverage("") == 1.0


def test_strict_retry_marks_what_the_first_pass_left_bare(router):
    first = "هَذَا سطر جميل"
    fake = router()
    fake.mark = lambda x: AR_MARKED if "EVERY word" in fake.mark_systems[-1] else first
    r = aerab.mark_sync(AR, "ar")
    assert r.text == AR_MARKED and (r.marked, r.kept, r.low_coverage, r.language) == (1, 0, 0, "ar")
    assert len(fake.mark_systems) == 2 and "tashkeel" in fake.mark_systems[0]
    assert "EVERY word" in fake.mark_systems[1] and "EVERY word" not in fake.mark_systems[0]


def test_strict_retry_reports_lines_still_sparse(router):
    fake = router(mark=lambda x: "هَذَا سطر جميل")
    r = aerab.mark_sync(f"{AR}\n[chorus]\n{AR}", "ar")
    assert r.stats() == {"marked": 2, "kept": 0, "low_coverage": 2} and len(fake.mark_systems) == 2


def test_a_failed_retry_keeps_the_first_pass(router):
    fake = router(mark=lambda x: "هَذَا سطر جميل")
    real = fake.__call__

    def flaky(request):
        if len(fake.mark_systems) == 1:
            fake.mark_systems.append("retry")
            return httpx.Response(500, json={"error": "gone"})
        return real(request)

    set_transport(httpx.MockTransport(flaky))
    r = aerab.mark_sync(AR, "ar")
    assert r.text == "هَذَا سطر جميل" and r.low_coverage == 1


def test_finish_never_fails_when_the_llm_is_away():
    set_transport(None)
    r = aerab.finish_sync(AR, "ar")
    assert r.text == AR and r.marked == 0
    assert aerab.finish_lines_sync([AR, "hi"], "ar") == [AR, "hi"]


def test_writing_rules_per_language():
    assert "WITH FULL tashkeel" in aerab.writing_rule("ar") and "i'rab" in aerab.writing_rule("ar")
    assert "izafat" in aerab.writing_rule("ur") and "ezafe" in aerab.writing_rule("fa")
    assert "Pashto" in aerab.writing_rule("ps") and "Sindhi" in aerab.writing_rule("sd")
    assert "Shahmukhi" in aerab.writing_rule("pnb") and aerab.writing_rule("en") == ""
    # no language given: the user's letters say which, and the rule only covers text in that language
    assert aerab.writing_rule(None, f"A film about {AR}").startswith("Wherever you write Arabic")
    assert aerab.writing_rule(None, "A film about the sea") == ""


# ---------------------------------------------------------------- writers: first pass + second pass

@pytest.mark.parametrize("lang", ["ar", "ur", "fa"])
def test_lyrics_writer_asks_for_marks_and_verifies_them(client, router, lang):
    plain, marked = SAMPLES[lang]
    fake = router(write=lambda body: {"lyrics": f"[verse]\n{plain}", "tags": "oud, slow"}, mark=swap((plain, marked)))
    r = client.post("/api/audio/lyrics", json={"topic": "the sea", "language": lang})
    assert r.status_code == 200, r.text
    assert r.json()["lyrics"] == f"[verse]\n{marked}" and r.json()["marked"] == 1
    assert "WITH FULL" in fake.systems[0] and aerab.NAMES[lang] in fake.systems[0]
    assert len(fake.mark_systems) == 1


def test_lyrics_come_back_plain_when_the_marker_is_down(client, router):
    router(write=lambda body: {"lyrics": AR, "tags": "oud"}, marks_down=True)
    r = client.post("/api/audio/lyrics", json={"topic": "the sea", "language": "ar"})
    assert r.status_code == 200 and r.json()["lyrics"] == AR and r.json()["marked"] == 0


def test_english_lyrics_get_no_rule_and_no_second_pass(client, router):
    fake = router(write=lambda body: {"lyrics": "[verse]\nla la", "tags": "pop"})
    assert client.post("/api/audio/lyrics", json={"topic": "the sea"}).status_code == 200
    assert "WITH FULL" not in fake.systems[0] and fake.mark_systems == []


def test_screenplay_assist_writes_marked_arabic_dialogue(client, project, router, fast_driver):
    fake = router(write=lambda body: text_reply(f"Maya looks up.\n\nMAYA\n{AR}"), mark=swap((AR, AR_MARKED)))
    scene = client.post(f"/api/projects/{project['id']}/scenes",
                        json={"heading": "INT. HOUSE - NIGHT", "script_text": f"Maya waits.\n\nMAYA\n{AR}"}).json()
    job = client.post(f"/api/scenes/{scene['id']}/ai/assist", json={"action": "write_dialogue"}).json()
    assert run_job(job["id"], fast_driver).status == "done"
    assert "Dialogue and narration: Wherever you write Arabic" in fake.systems[0]
    [sug] = client.get(f"/api/projects/{project['id']}/suggestions").json()
    assert sug["proposed_text"] == f"Maya looks up.\n\nMAYA\n{AR_MARKED}"


def test_english_screenplay_never_calls_the_marker(client, project, router, fast_driver):
    fake = router(write=lambda body: text_reply("Maya looks up."))
    scene = client.post(f"/api/projects/{project['id']}/scenes", json={"script_text": "Maya waits."}).json()
    run_job(client.post(f"/api/scenes/{scene['id']}/ai/assist", json={"action": "expand"}).json()["id"], fast_driver)
    assert "WITH FULL" not in fake.systems[0] and fake.mark_systems == []


def test_podcast_writer_marks_urdu_lines_and_notes_rule(client, router, fast_driver):
    episode = {"title": PLAIN, "chapters": [{"title": "One", "lines": [
        {"host": "Ali", "text": PLAIN}, {"host": "Sara", "text": "OK then."}]}]}
    fake = router(write=lambda body: episode, mark=swap((PLAIN, MARKED)))
    ep = client.post("/api/podcast/episodes", json={"title": "New episode", "topic": "دل", "language": "ur",
                                                    "target_minutes": 3, "hosts": [{"name": "Ali"}, {"name": "Sara"}]})
    assert ep.status_code == 201, ep.text
    ep = ep.json()
    assert client.post(f"/api/podcast/episodes/{ep['id']}/write").status_code == 202
    _run_all(fast_driver)
    sid = client.get(f"/api/podcast/episodes/{ep['id']}").json()["script_id"]
    lines = client.get(f"/api/scripts/{sid}").json()["lines"]
    assert [ln["text"] for ln in lines] == [MARKED, "OK then."]
    assert "WITH FULL aerab" in fake.systems[0] and len(fake.mark_systems) == 1


def test_dub_translation_into_arabic_is_marked(client, tmp_path, router, fast_driver):
    def write(body):
        rows = [row.split(" | ") for row in body["messages"][-1]["content"].split("\n")]
        return {"lines": [{"id": r[0], "text": AR} for r in rows]}

    fake = router(write=write, mark=swap((AR, AR_MARKED)))
    d = make_dub(client, tmp_path, targets=["ar"], speakers=1)
    _run_all(fast_driver)
    d = get_dub(client, d["id"])
    while statuses(d)["translate"] != "review":
        assert client.post(f"/api/dubs/{d['id']}/continue").status_code == 202
        _run_all(fast_driver)
        d = get_dub(client, d["id"])
    assert all(s["target"]["ar"]["text"] == AR_MARKED for s in d["segments"])
    assert "WITH FULL tashkeel" in fake.systems[0] and "tashkeel" in fake.mark_systems[0]
    assert "tashkeel" in tx.shorter_messages(AR, "hi", 1.0, "ar", [])[0]["content"]


def test_transcript_cleanup_comes_back_marked(client, tmp_path, router, fast_driver):
    video = upload_video(client, talking_clip(tmp_path / "talk.mp4"))
    tid = client.post("/api/transcribe", json={"media_id": video["id"]}).json()["transcript_id"]
    _run_all(fast_driver)
    with SessionLocal() as db:
        t = db.get(Transcript, tid)
        t.language = "ar"
        t.segments = [{**s, "text": AR} for s in t.segments]
        db.commit()

    def tidy(body):
        rows = [row.split(". ", 1) for row in body["messages"][-1]["content"].split("\n")]
        return {"lines": [{"i": int(n), "text": text} for n, text in rows]}

    fake = router(write=tidy, mark=swap((AR, AR_MARKED)))
    assert client.post(f"/api/transcripts/{tid}/cleanup").status_code == 202
    _run_all(fast_driver)
    t = client.get(f"/api/transcripts/{tid}").json()
    assert all(s["clean"] == AR_MARKED for s in t["segments"]) and AR_MARKED in t["cleanup_text"]
    assert "WITH FULL tashkeel" in fake.systems[0]


def test_tidied_lines_can_be_saved_back(client, tmp_path, fast_driver):
    video = upload_video(client, talking_clip(tmp_path / "talk.mp4"))
    tid = client.post("/api/transcribe", json={"media_id": video["id"]}).json()["transcript_id"]
    _run_all(fast_driver)
    n = len(client.get(f"/api/transcripts/{tid}").json()["segments"])
    r = client.put(f"/api/transcripts/{tid}/clean", json={"lines": [AR_MARKED] * n})
    assert r.status_code == 200, r.text
    assert all(s["clean"] == AR_MARKED for s in r.json()["segments"]) and AR_MARKED in r.json()["cleanup_text"]
    assert client.put(f"/api/transcripts/{tid}/clean", json={"lines": [AR]}).status_code == 422


# ---------------------------------------------------------------- render time

def test_arabic_song_and_speech_are_marked_before_they_render(client, router, fast_driver):
    router(mark=swap((AR, AR_MARKED)))
    song = client.post("/api/audio/generate", json={"kind": "song", "prompt": "oud", "language": "ar",
                                                    "lyrics": f"[verse]\n{AR}", "duration_s": 2})
    speech = client.post("/api/audio/speak", json={"text": AR, "language": "ar"})
    assert song.status_code == 202 and speech.status_code == 202, (song.text, speech.text)
    _run_all(fast_driver)
    with SessionLocal() as db:
        g = db.get(Generation, song.json()["items"][0]["generation_id"])
        assert g.params["lyrics"] == f"[verse]\n{AR_MARKED}" and g.params["lyrics_written"] == f"[verse]\n{AR}"
        g = db.get(Generation, speech.json()["items"][0]["generation_id"])
        assert g.params["text"] == AR_MARKED and g.params["text_written"] == AR


def test_quoted_arabic_dialogue_in_a_video_prompt(client, router, fast_driver):
    fake = router(mark=swap((AR, AR_MARKED)))
    r = client.post("/api/videos/generate", json={"prompt": f'A woman at the window says "{AR}", rain outside',
                                                   "duration_s": 2})
    assert r.status_code == 202, r.text
    _run_all(fast_driver)
    with SessionLocal() as db:
        g = db.get(Generation, r.json()["generation_id"])
        assert f'"{AR_MARKED}"' in g.prompt and AR in g.params["prompt_written"]
    assert "tashkeel" in fake.mark_systems[0]


def test_long_take_beats_get_their_quoted_lines_marked(router):
    from types import SimpleNamespace

    from app import longtake

    router(mark=swap((AR, AR_MARKED), (PLAIN, MARKED)))
    ctx = SimpleNamespace(progress=lambda *a: None)
    beats = [f'She whispers "{AR}"', "Wind moves the curtain", f'He answers "{PLAIN}"']
    assert longtake._spoken_with_aerab(ctx, SimpleNamespace(id="g"), beats) == [
        f'She whispers "{AR_MARKED}"', "Wind moves the curtain", f'He answers "{MARKED}"']
    set_transport(None)
    assert longtake._spoken_with_aerab(ctx, SimpleNamespace(id="g"), beats) == beats


def test_text_drawn_in_images_stays_unmarked(client, router, fast_driver):
    fake = router(mark=swap((AR, AR_MARKED)))
    prompt = f'A festival poster with the Arabic title "{AR}" in gold lettering'
    r = client.post("/api/images/generate", json={"prompt": prompt})
    assert r.status_code == 202, r.text
    _run_all(fast_driver)
    with SessionLocal() as db:
        assert db.get(Generation, r.json()["items"][0]["generation_id"]).prompt == prompt
    assert fake.mark_systems == []


# ---------------------------------------------------------------- the editors' endpoint

def test_text_aerab_endpoint(client, router):
    router(mark=swap((AR, AR_MARKED), (FA, FA_MARKED)))
    r = client.post("/api/text/aerab", json={"text": f"MAYA\n{AR}", "language": "ar"})
    assert r.status_code == 200, r.text
    assert r.json() == {"text": f"MAYA\n{AR_MARKED}", "marked": 1, "kept": 0, "low_coverage": 0, "language": "ar",
                        "complete": True, "remaining_chars": 0, "coverage": 1.0}
    r = client.post("/api/text/aerab", json={"text": FA})
    assert r.json()["language"] == "fa" and r.json()["text"] == FA_MARKED
    assert client.post("/api/text/aerab", json={"text": "only English here"}).status_code == 422
    r = client.post("/api/audio/lyrics/aerab", json={"lyrics": AR, "language": "ar"})
    assert r.json()["lyrics"] == AR_MARKED and r.json()["language"] == "ar"


def test_text_aerab_offline_is_503(client):
    set_transport(None)
    assert client.post("/api/text/aerab", json={"text": AR}).status_code == 503
