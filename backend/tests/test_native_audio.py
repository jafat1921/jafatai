"""What LTX-2.3 is told to say when it writes its own soundtrack (app.native_audio)."""
from pathlib import Path

import pytest

from app import native_audio as na
from app.drivers.comfy import plan_generation
from app.llm import prompts as P


class Lookup:
    def __init__(self, tmp):
        self.tmp = tmp

    def generation_file(self, gen_id):
        p = self.tmp / f"{gen_id}.png"
        p.write_bytes(b"x")
        return p

    def project_aspect(self, _pid):
        return "16:9"


@pytest.mark.parametrize("text,english", [
    ("One more dive.", True), ("Where are you going?", True), ("Yaar, this is crazy", True),
    ("Tum kahan ja rahe ho?", False), ("Main tumse pyar karta hoon", False), ("Bonjour, ça va?", False),
    ("سمندر آج خاموش ہے", False), ("आज समंदर शांत है", False), ("Shabash!", False),
])
def test_looks_english(text, english):
    assert na.looks_english(text) is english


def test_language_of():
    assert na.language_of("دِل کی بات") == "ur" and na.language_of("आज समंदर") == "hi"
    assert na.language_of("I know it") == "en" and na.language_of("dil ki baat suno") is None


def test_no_speech_wanted_says_so():
    out = na.ltx_prompt("A lighthouse at dusk, waves on the rocks.")
    assert out.endswith(na.SILENT) and "no dialogue" in out
    # a retried job doesn't stack clauses
    assert na.ltx_prompt(out) == out
    assert na.ltx_prompt("") == na.SILENT


def test_talk_without_words_stays_indistinct():
    assert na.ltx_prompt("Two friends talk over coffee.").endswith(na.MURMUR)


def test_quoted_lines_get_their_language():
    assert na.ltx_prompt('She says: "We should go home now."').endswith("The dialogue is spoken in English.")
    assert na.ltx_prompt('وہ کہتی ہے: "ہم گھر چلیں"').endswith("The dialogue is spoken in Urdu.")
    # already named, or a Latin line we can't place: left alone
    said = 'He says in English: "We should go."'
    assert na.ltx_prompt(said) == said
    assert na.ltx_prompt('He says: "Tum kahan ho"') == 'He says: "Tum kahan ho"'


@pytest.mark.parametrize("kind,params,template", [
    ("video", {"model": "ltx23_distilled"}, "ltx23_i2v"),
    ("video", {"model": "ltx23_hq"}, "ltx23_two_stage"),
    ("take", {"first_frame_id": "k1"}, "ltx23_i2v"),
    ("take_chunk", {"num_frames": 97, "context_video": "ctx.mp4"}, "ltx23_extend"),
])
def test_every_native_audio_graph_gets_the_clause(tmp_path, kind, params, template):
    plan = plan_generation(kind, "A quiet harbour at dawn.", params, 1, Lookup(tmp_path))
    assert plan.template == template and plan.inputs["prompt"].endswith(na.SILENT)


def test_lip_synced_and_silent_graphs_are_left_alone(tmp_path):
    plan = plan_generation("take", "A quiet harbour.", {"first_frame_id": "k1", "speech_audio": str(tmp_path / "s.wav")},
                           1, Lookup(tmp_path))
    assert plan.template == "ltx23_ia2v" and plan.inputs["prompt"] == "A quiet harbour."
    plan = plan_generation("video", "A quiet harbour.", {"model": "wan22_t2v"}, 1, Lookup(tmp_path))
    assert plan.inputs["prompt"] == "A quiet harbour."


def test_motion_prompts_never_carry_dialogue():
    assert "Never quote spoken words" in P.FRAME_RULES
