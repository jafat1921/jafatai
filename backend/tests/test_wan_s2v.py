"""Wan 2.2 S2V lip-sync takes: the graph per pass count, the pre-flight check, and the driver's routing."""
import json
from pathlib import Path

import pytest

from app.config import get_settings
from app.drivers.comfy import plan_generation
from app.workflows import build, check_template, find_node

FIXTURE = Path(__file__).parent / "fixtures" / "comfy_object_info.json"


class Lookup:
    def __init__(self, tmp):
        self.tmp = tmp

    def generation_file(self, gid):
        p = self.tmp / f"{gid}.png"
        p.write_bytes(b"png")
        return p

    def project_aspect(self, _pid):
        return "16:9"


@pytest.fixture
def wan():
    s = get_settings()
    old = s.film_lipsync_engine
    s.film_lipsync_engine = "wan_s2v"
    yield
    s.film_lipsync_engine = old


def test_the_template_checks_against_the_servers_nodes():
    info = json.loads(FIXTURE.read_text(encoding="utf-8"))
    res = check_template("wan22_s2v", info)
    assert res["ok"], res


@pytest.mark.parametrize("seconds,passes", [(3.0, 1), (4.8, 1), (7.5, 2), (9.6, 2), (10.0, 3)])
def test_a_take_gets_just_the_passes_it_needs(wan, tmp_path, seconds, passes):
    params = {"speech_audio": str(tmp_path / "slice.wav"), "first_frame_id": "frame", "duration_s": seconds,
              "lipsync": True}
    p = plan_generation("take", "Ruslan speaks to camera.", params, 7, Lookup(tmp_path))
    assert p.template == "wan22_s2v" and p.sources["passes"] == passes
    g, _ = build(p.template, {**p.inputs, **{k: f"{k}.bin" for k in p.images}})
    titles = {n["_meta"]["title"] for n in g.values()}
    assert ("Extend1" in titles) == (passes >= 2) and ("Extend2" in titles) == (passes == 3)
    trim = g[find_node(g, "Trim")]["inputs"]
    assert trim["length"] == round(seconds * 16) and trim["batch_index"] == passes
    # the frames always reach the decoder, however many passes were dropped
    first_cut = g[find_node(g, "FirstCut")]["inputs"]["samples"]
    assert g[first_cut[0]]["_meta"]["title"] == {1: "Sampler", 2: "Concat2", 3: "Concat3"}[passes]
    assert g[find_node(g, "S2V")]["inputs"]["width"] == 832
    assert g[find_node(g, "AudioTrim")]["inputs"]["duration"] == pytest.approx(round(seconds * 16) / 16, abs=1e-3)


def test_ltx_stays_available(tmp_path):
    params = {"speech_audio": str(tmp_path / "slice.wav"), "first_frame_id": "frame", "duration_s": 5.0,
              "lipsync": True}
    assert plan_generation("take", "x", params, 1, Lookup(tmp_path)).template == "ltx23_ia2v"


@pytest.mark.parametrize("finish,steps,cfg,lora", [(None, 4, 1.0, True), ("fast", 4, 1.0, True), ("full", 20, 4.5, False)])
def test_the_finish_picks_steps_and_the_speed_lora(wan, tmp_path, finish, steps, cfg, lora):
    params = {"speech_audio": str(tmp_path / "slice.wav"), "first_frame_id": "frame", "duration_s": 4.0,
              "lipsync": True, **({"s2v_finish": finish} if finish else {})}
    p = plan_generation("take", "x", params, 1, Lookup(tmp_path))
    g, _ = build(p.template, {**p.inputs, **{k: f"{k}.bin" for k in p.images}})
    sampler = g[find_node(g, "Sampler")]["inputs"]
    assert (sampler["steps"], sampler["cfg"]) == (steps, cfg)
    titles = {n["_meta"]["title"] for n in g.values()}
    assert ("SpeedLoRA" in titles) == lora
    # without the LoRA the shift node reads the UNet straight
    assert g[g[find_node(g, "Shift")]["inputs"]["model"][0]]["_meta"]["title"] == ("SpeedLoRA" if lora else "UNet")


def test_an_hq_take_renders_at_720p(wan, tmp_path):
    params = {"speech_audio": str(tmp_path / "slice.wav"), "first_frame_id": "frame", "duration_s": 4.0,
              "lipsync": True, "quality": "hq"}
    p = plan_generation("take", "x", params, 1, Lookup(tmp_path))
    assert (p.inputs["width"], p.inputs["height"]) == (1280, 720)


def test_the_takes_own_engine_beats_the_server_default(tmp_path):
    params = {"speech_audio": str(tmp_path / "slice.wav"), "first_frame_id": "frame", "duration_s": 4.0,
              "lipsync": True, "lipsync_engine": "wan_s2v"}
    assert plan_generation("take", "x", params, 1, Lookup(tmp_path)).template == "wan22_s2v"


@pytest.mark.parametrize("scale", [3.0, 0.0])
def test_ltx_lip_sync_runs_modality_guidance_on_the_first_pass(tmp_path, scale):
    s = get_settings()
    old, s.ltx_modality_scale = s.ltx_modality_scale, scale
    try:
        params = {"speech_audio": str(tmp_path / "slice.wav"), "first_frame_id": "frame", "duration_s": 5.0,
                  "lipsync": True, "quality": "hq"}
        p = plan_generation("take", "x", params, 1, Lookup(tmp_path))
        g, _ = build(p.template, {**p.inputs, **{k: f"{k}.bin" for k in p.images}}, [("user.safetensors", 0.8)])
    finally:
        s.ltx_modality_scale = old
    first, refine = g[find_node(g, "Guider")]["inputs"]["model"], g[find_node(g, "Guider2")]["inputs"]["model"]
    if scale:
        guide = g[first[0]]
        assert guide["class_type"] == "LTXVModalityGuidance" and guide["inputs"]["modality_scale"] == 3.0
        # a user LoRA still sits under the guidance, and the refine pass skips it
        assert g[guide["inputs"]["model"][0]]["_meta"]["title"] == "LoRA 1" == g[refine[0]]["_meta"]["title"]
    else:
        assert "ModalityGuide" not in {n["_meta"]["title"] for n in g.values()}
        assert g[first[0]]["_meta"]["title"] == "LoRA 1"


@pytest.mark.parametrize("name", ["ltx23_ia2v", "ltx23_ia2v_extend"])
def test_the_ltx_lip_sync_templates_check_against_the_servers_nodes(name):
    info = json.loads(FIXTURE.read_text(encoding="utf-8"))
    assert check_template(name, info)["ok"]
