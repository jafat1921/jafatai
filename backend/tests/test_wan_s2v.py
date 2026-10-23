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
