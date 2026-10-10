"""Audio editor, analysis and Score a Clip (contract v15): edit stack, peaks, loudness, versions, export, mix."""
import io
import re
import subprocess
import uuid
import zipfile
from pathlib import Path

import pytest

from app import audio_analysis as aa
from app import audio_edit as ae
from app import mixdown as md
from app import reel
from app.config import get_settings
from app.db import SessionLocal
from app.lanes import lane_for
from app.models import Generation, Job, MediaItem, Workspace
from tests.test_library import png_bytes, upload
from tests.test_storyboard import _run_all


def ff(*args: str) -> None:
    subprocess.run([get_settings().ffmpeg_path(), "-y", "-hide_banner", "-loglevel", "error", *args], check=True,
                   capture_output=True)


def lavfi(path: Path, src: str, *args: str) -> Path:
    ff("-f", "lavfi", "-i", src, *args, str(path))
    return path


def tone(path: Path, seconds: float = 4.0, freq: int = 440, amp: float = 0.1, *args: str) -> Path:
    return lavfi(path, f"aevalsrc={amp}*sin(2*PI*{freq}*t):s=48000:d={seconds}", *args)


def length(path: Path) -> float:
    return aa.stream_info(path).duration


def codec(path: Path) -> str:
    err = subprocess.run([get_settings().ffmpeg_path(), "-hide_banner", "-i", str(path)], capture_output=True,
                         text=True).stderr
    return re.search(r"Audio: (\w+)", err)[1]


def rms(path: Path, start: float, dur: float) -> float:
    err = subprocess.run([get_settings().ffmpeg_path(), "-hide_banner", "-nostats", "-ss", str(start), "-t", str(dur),
                          "-i", str(path), "-af", "astats=measure_perchannel=none:measure_overall=RMS_level",
                          "-f", "null", "-"], capture_output=True, text=True).stderr
    m = re.search(r"RMS level dB: (-?[\d.]+|-inf)", err)
    return float(m[1]) if m and m[1] != "-inf" else -200.0


def render(tmp_path: Path, edit: dict, src: Path, appends=None, name="out.wav", **kw) -> tuple[Path, dict]:
    dst = tmp_path / name
    info = ae.render(edit, src, dst, ["-c:a", "pcm_s16le"], appends, **kw)
    return dst, info


def upload_audio(client, path: Path, title: str | None = None) -> dict:
    r = upload(client, path.name, path.read_bytes(), "audio/wav", title=title)
    assert r.status_code == 201, r.text
    return r.json()


def gen_path(gen_id: str) -> Path:
    with SessionLocal() as db:
        return get_settings().data_dir / db.get(Generation, gen_id).file_path


# ------------------------------------------------------------------ the stack, on paper

def test_normalise_fills_defaults_and_rejects_bad_stacks():
    e = ae.normalise({})
    assert e["speed"] == 1.0 and e["cuts"] == [] and e["trim"] is None and e["version"] == 1
    assert ae.normalise({"cuts": [{"start": 3, "end": 4}, {"start": 1, "end": 2}]})["cuts"][0]["start"] == 1
    for bad in ({"speed": 3}, {"trim": {"start": 2, "end": 1}}, {"fade_in": {"s": 1, "curve": "zig"}},
                {"chain": {"preset": "space", "amount": 50}}, {"append": ["x"] * 9}, {"loudness": {"target": "loud"}},
                {"markers": [{"t": 1, "label": "x" * 41}]}):
        with pytest.raises(ae.EditError):
            ae.normalise(bad)


def test_keep_segments_trim_cuts_and_silence():
    e = ae.normalise({"trim": {"start": 1, "end": 9}, "cuts": [{"start": 2, "end": 3}, {"start": 8.5, "end": 12}]})
    assert ae.keep_segments(e, 10) == [(1, 2), (3, 8.5)]
    with pytest.raises(ae.EditError):
        ae.keep_segments(ae.normalise({"cuts": [{"start": 0, "end": 10}]}), 10)
    with pytest.raises(ae.EditError):
        ae.keep_segments(ae.normalise({"trim": {"start": 11, "end": 12}}), 10)
    # silence at both ends (in source time) comes off what's kept, with a hair of margin
    sil = [{"start": 0, "end": 1.5}, {"start": 7, "end": 10}]
    segs = ae.keep_segments(ae.normalise({"silence_trim": True, "cuts": [{"start": 3, "end": 4}]}), 10, sil)
    assert segs[0][0] == pytest.approx(1.49) and segs[-1][1] == pytest.approx(7.01) and len(segs) == 2
    with pytest.raises(ae.EditError):
        ae.keep_segments(ae.normalise({"silence_trim": True}), 10, [{"start": 0, "end": 10}])


def test_atempo_chains_beyond_its_range():
    assert ae.atempo(1.0) == []
    assert ae.atempo(1.5) == ["atempo=1.500000"]
    assert ae.atempo(3.0) == ["atempo=2.0", "atempo=1.500000"]
    assert ae.atempo(0.3) == ["atempo=0.5", "atempo=0.600000"]


def test_graph_builder_steps():
    src = aa.StreamInfo(duration=10, sample_rate=44100, channels=2, has_audio=True)
    mono = aa.StreamInfo(duration=10, sample_rate=44100, channels=1, has_audio=True)

    def graph(edit, info=src, **kw):
        return ae.build(ae.normalise(edit), info, **kw)

    assert graph({}).graph.endswith("anull[out]") and graph({}).duration == 10
    assert "channel_layouts=mono" in graph({}, mono).graph and "channel_layouts=stereo" in graph({}).graph
    p = graph({"cuts": [{"start": 2, "end": 3}, {"start": 5, "end": 6}]})
    assert "asplit=3" in p.graph and "concat=n=3:v=0:a=1" in p.graph and p.duration == 8
    assert graph({"speed": 2}).duration == 5 and "atempo=2.000000" in graph({"speed": 2}).graph
    assert "rubberband=tempo=1.000000:pitch=1.189207" in graph({"pitch": 3}, rubberband=True).graph
    fallback = graph({"pitch": 12}).graph
    assert "asetrate=96000" in fallback and "atempo=0.5" in fallback
    assert "amix=inputs=2:weights='0.400 0.600'" in graph({"chain": {"preset": "hall", "amount": 60}}).graph
    full = graph({"chain": {"preset": "hall", "amount": 100}}).graph
    assert "aecho" in full and "amix" not in full
    assert "aecho" not in graph({"chain": {"preset": "hall", "amount": 0}}).graph
    for name in ae.PRESETS:
        assert graph({"chain": {"preset": name}}).duration == 10
    assert "volume=-6.00dB" in graph({"gain_db": -6}).graph
    lp = graph({"loop_to": 25})
    assert lp.duration == 25 and "aloop=loop=-1" in lp.graph and "afade=t=out:st=23.500000" in lp.graph
    assert graph({"loop_to": 4}).duration == 4
    with pytest.raises(ae.EditError):
        ae.build(ae.normalise({"loop_to": 3000}), aa.StreamInfo(duration=0.5, channels=2, has_audio=True))
    app = graph({}, appends=[aa.StreamInfo(duration=3, channels=1, has_audio=True)])
    assert app.duration == pytest.approx(12.98) and "concat=n=3" in app.graph and "[1:a]" in app.graph
    f = graph({"fade_in": {"s": 2, "curve": "qsin"}, "fade_out": {"s": 50 / 2, "curve": "exp"}}).graph
    assert "afade=t=in:st=0:d=2.000000:curve=qsin" in f and "afade=t=out:st=0.000000:d=10.000000:curve=exp" in f
    m = graph({"loudness": {"target": "podcast"}}, measure_loudness=True).graph
    assert "loudnorm=I=-16.0:TP=-1.0" in m and "print_format=json" in m
    stats = {"input_i": "-30", "input_tp": "-12", "input_lra": "3", "input_thresh": "-40", "target_offset": "0.1"}
    a = graph({"loudness": {"target": "broadcast"}}, loud=stats).graph
    assert "measured_I=-30" in a and "linear=true" in a and "aresample=48000" in a
    assert graph({}, meter=True).graph.endswith("ebur128=peak=true:framelog=quiet[out]")


# ------------------------------------------------------------------ the stack, rendered

def test_renders_land_on_the_planned_lengths(tmp_path):
    src = tone(tmp_path / "src.wav", 4.0)
    extra = tone(tmp_path / "extra.wav", 1.0, 660)
    cases = [({"trim": {"start": 1, "end": 3}}, 2.0),
             ({"cuts": [{"start": 0.5, "end": 1}, {"start": 2, "end": 2.5}]}, 3.0),
             ({"speed": 2.0}, 2.0),
             ({"speed": 0.5}, 8.0),
             ({"pitch": -4}, 4.0),
             ({"loop_to": 10}, 10.0),
             ({"loop_to": 2.5}, 2.5)]
    for k, (edit, want) in enumerate(cases):
        out, info = render(tmp_path, edit, src, name=f"o{k}.wav")
        assert info["duration_s"] == pytest.approx(want, abs=0.001), edit
        assert length(out) == pytest.approx(want, abs=0.03), edit
    out, info = render(tmp_path, {"append": ["ignored here"]}, src, [extra], name="app.wav")
    assert length(out) == pytest.approx(4.98, abs=0.03) and info["duration_s"] == pytest.approx(4.98)


def test_pitch_without_rubberband_keeps_the_length(tmp_path, monkeypatch):
    monkeypatch.setattr(ae, "has_rubberband", lambda: False)
    out, _ = render(tmp_path, {"pitch": 5, "speed": 1.25}, tone(tmp_path / "s.wav", 3.0))
    assert length(out) == pytest.approx(2.4, abs=0.03)


def test_fades_start_silent_and_loop_fades_out(tmp_path):
    src = tone(tmp_path / "src.wav", 4.0, amp=0.5)
    out, _ = render(tmp_path, {"fade_in": {"s": 1.0, "curve": "tri"}, "fade_out": {"s": 1.0, "curve": "qsin"}}, src)
    assert rms(out, 0, 0.05) < rms(out, 2.0, 0.5) - 20
    assert rms(out, 3.95, 0.05) < rms(out, 2.0, 0.5) - 20
    looped, _ = render(tmp_path, {"loop_to": 9}, src, name="loop.wav")
    # steady through the seams, then the automatic fade-out
    assert abs(rms(looped, 3.5, 1.0) - rms(looped, 1.0, 1.0)) < 1.0
    assert rms(looped, 8.95, 0.05) < rms(looped, 5.0, 1.0) - 20


def test_silence_trim_strips_both_ends(tmp_path):
    src = lavfi(tmp_path / "s.wav", "aevalsrc='if(between(t,1,3),0.3*sin(2*PI*440*t),0)':s=48000:d=4.5")
    out, info = render(tmp_path, {"silence_trim": True}, src)
    assert info["duration_s"] == pytest.approx(2.02, abs=0.05) and length(out) == pytest.approx(2.02, abs=0.06)


@pytest.mark.parametrize("target", ["web", "podcast", "broadcast", "acx"])
def test_loudness_targets_land_within_one_lu(tmp_path, target):
    out, _ = render(tmp_path, {"loudness": {"target": target}}, tone(tmp_path / "s.wav", 6.0, 1000, 0.05))
    got = aa.measure(out)
    want_i, want_tp = ae.TARGETS[target]
    assert got["lufs_i"] == pytest.approx(want_i, abs=1.0)
    assert got["true_peak_db"] <= want_tp + 0.5


def test_every_chain_preset_renders(tmp_path):
    src = lavfi(tmp_path / "n.wav", "anoisesrc=d=2:c=pink:r=48000:a=0.2")
    levels = {}
    for name in ae.PRESETS:
        out, info = render(tmp_path, {"chain": {"preset": name, "amount": 70}}, src, name=f"{name}.wav", meter=True)
        assert length(out) == pytest.approx(2.0, abs=0.03), name
        levels[name] = info["lufs_i"]
    assert all(v is not None for v in levels.values())
    assert levels["telephone"] != levels["raw"]


# ------------------------------------------------------------------ analysis and peaks

def test_analysis_of_a_known_tone(tmp_path):
    # 1 kHz mono sine peaking at -20 dBFS: -23 LUFS (BS.1770 reads a full-scale 1 kHz sine as -3.01 LUFS)
    a = aa.analyse(tone(tmp_path / "t.wav", 5.0, 1000, 0.1, "-ac", "1"))
    assert a["lufs_i"] == pytest.approx(-23.0, abs=0.5)
    assert a["true_peak_db"] == pytest.approx(-20.0, abs=0.5) and a["sample_peak_db"] == pytest.approx(-20.0, abs=0.2)
    assert a["clipped_pct"] == 0 and a["flags"] == [] and a["silences"] == [] and a["lra"] is not None
    assert aa.analysis_file(tmp_path / "t.wav").is_file()


def test_clipping_and_loudness_flags(tmp_path):
    a = aa.analyse(tone(tmp_path / "hot.wav", 2.0, 220, 1.6, "-c:a", "pcm_s16le"))
    assert a["clipped_pct"] > 10 and {"clipping", "too_loud"} <= set(a["flags"])
    q = aa.analyse(tone(tmp_path / "quiet.wav", 2.0, 220, 0.005))
    assert "too_quiet" in q["flags"] and "clipping" not in q["flags"]


def test_silence_detection_and_long_silence(tmp_path):
    src = lavfi(tmp_path / "gap.wav", "aevalsrc='if(lt(t,1)+gt(t,5),0.3*sin(2*PI*440*t),0)':s=48000:d=6")
    a = aa.analyse(src)
    assert len(a["silences"]) == 1
    s = a["silences"][0]
    assert s["start"] == pytest.approx(1.0, abs=0.05) and s["end"] == pytest.approx(5.0, abs=0.05)
    assert "long_silence" in a["flags"]
    # silence that only trails off at the end isn't flagged
    tail = aa.analyse(lavfi(tmp_path / "tail.wav", "aevalsrc='if(lt(t,1),0.3*sin(2*PI*440*t),0)':s=48000:d=6"))
    assert tail["silences"][0]["end"] == pytest.approx(6.0, abs=0.05) and "long_silence" not in tail["flags"]


def test_peaks_shape_and_cache(tmp_path, monkeypatch):
    src = tone(tmp_path / "p.wav", 3.0, 440, 0.5, "-ac", "2")
    out = aa.peaks(src, 500)
    assert out["duration_s"] == pytest.approx(3.0, abs=0.01) and out["channels"] == 2 and out["sample_rate"] == 48000
    assert len(out["peaks"]) == 500 and all(-1 <= lo <= hi <= 1 for lo, hi in out["peaks"])
    assert max(hi for _, hi in out["peaks"]) == pytest.approx(0.5, abs=0.02)
    assert aa.peaks_file(src).is_file()

    def boom(*a, **k):
        raise AssertionError("decoded again")

    monkeypatch.setattr(aa, "_decode_mono", boom)
    assert aa.peaks(src, 500) == out
    tone(src, 1.0, 440, 0.5)  # a new file under the same name: the mtime moves, so the cache is stale
    monkeypatch.undo()
    assert aa.peaks(src, 500)["duration_s"] == pytest.approx(1.0, abs=0.01)
    assert len(aa.peaks(src, 200)["peaks"]) == 200


def test_buckets_on_tiny_input():
    import numpy as np

    assert aa.buckets(np.zeros(0, dtype="f4"), 3) == [[0.0, 0.0]] * 3
    assert len(aa.buckets(np.array([0.5, -0.5], dtype="f4"), 4)) == 4


def test_parsers():
    err = ("[Parsed_ebur128_0 @ 1] Summary:\n\n  Integrated loudness:\n    I:         -70.0 LUFS\n"
           "    Threshold:   0.0 LUFS\n\n  Loudness range:\n    LRA:         0.0 LU\n\n  Sample peak:\n"
           "    Peak:       -inf dBFS\n\n  True peak:\n    Peak:      -inf dBFS\n")
    assert aa.parse_ebur128(err) == {"lufs_i": -70.0, "lra": 0.0, "true_peak_db": None, "sample_peak_db": None}
    assert aa.parse_silences("silence_start: 1.5\nsilence_end: 2 | silence_duration: 0.5\nsilence_start: 8", 9) == \
        [{"start": 1.5, "end": 2.0}, {"start": 8.0, "end": 9.0}]
    assert ae.parse_loudnorm('{"input_i" : "-inf", "input_tp": "-inf"}') is None


# ------------------------------------------------------------------ API: peaks, analysis, preview

def test_peaks_and_analysis_endpoints(client, tmp_path):
    item = upload_audio(client, tone(tmp_path / "a.wav", 2.0, 1000, 0.1, "-ac", "1"))
    assert item["analysis"] is None
    r = client.get(f"/api/audio/{item['id']}/peaks", params={"n": 300})
    assert r.status_code == 200 and len(r.json()["peaks"]) == 300
    assert client.get(f"/api/audio/{item['id']}/peaks", params={"n": 50}).status_code == 422
    a = client.get(f"/api/audio/{item['id']}/analysis")
    assert a.status_code == 200 and a.json()["lufs_i"] == pytest.approx(-23, abs=0.6)
    # once worked out, the Library item carries the badge numbers
    got = client.get(f"/api/media/{item['id']}").json()["analysis"]
    assert got["lufs_i"] == a.json()["lufs_i"] and got["flags"] == [] and set(got) == {"lufs_i", "true_peak_db", "flags"}
    listed = client.get("/api/media", params={"kind": "audio"}).json()["items"]
    assert listed[0]["analysis"] == got

    assert client.get(f"/api/audio/{uuid.uuid4()}/analysis").status_code == 404
    assert client.get(f"/api/audio/{item['id']}/analysis", params={"version": str(uuid.uuid4())}).status_code == 404
    pic = upload(client, "p.png", png_bytes(), "image/png").json()
    assert client.get(f"/api/audio/{pic['id']}/peaks").status_code == 422
    # another item's version can't be borrowed
    other = upload_audio(client, tone(tmp_path / "b.wav", 1.0))
    r = client.get(f"/api/audio/{item['id']}/analysis", params={"version": other["generation_id"]})
    assert r.status_code == 404


def test_preview_returns_mp3_with_meter_headers(client, tmp_path, monkeypatch):
    item = upload_audio(client, tone(tmp_path / "a.wav", 3.0, 1000, 0.1))
    r = client.post(f"/api/audio/{item['id']}/preview",
                    json={"edit": {"trim": {"start": 0.5, "end": 2.5}, "loudness": {"target": "web"}}})
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "audio/mpeg" and r.content[:3] in (b"ID3", b"\xff\xfb", b"\xff\xf3")
    assert float(r.headers["x-duration-s"]) == pytest.approx(2.0)
    assert float(r.headers["x-lufs-i"]) == pytest.approx(-14, abs=1.0)
    assert float(r.headers["x-true-peak-db"]) <= -0.5 and int(r.headers["x-render-ms"]) >= 0
    mp3 = tmp_path / "p.mp3"
    mp3.write_bytes(r.content)
    assert codec(mp3) == "mp3" and length(mp3) == pytest.approx(2.0, abs=0.1)

    bad = client.post(f"/api/audio/{item['id']}/preview", json={"edit": {"speed": 5}})
    assert bad.status_code == 422
    bad = client.post(f"/api/audio/{item['id']}/preview", json={"edit": {"trim": {"start": 10, "end": 12}}})
    assert bad.status_code == 422 and "outside" in bad.json()["detail"]
    r = client.post(f"/api/audio/{item['id']}/preview", json={"edit": {"append": [str(uuid.uuid4())]}})
    assert r.status_code == 404
    monkeypatch.setattr(ae, "PREVIEW_MAX_S", 1.0)
    r = client.post(f"/api/audio/{item['id']}/preview", json={"edit": {}})
    assert r.status_code == 413 and "Save" in r.json()["detail"]


# ------------------------------------------------------------------ API: save as a version

def test_render_makes_a_new_version_and_the_item_moves_to_it(client, tmp_path, fast_driver):
    item = upload_audio(client, tone(tmp_path / "a.wav", 4.0, 440, 0.2), title="Theme")
    extra = upload_audio(client, tone(tmp_path / "b.wav", 1.0, 660, 0.2))
    edit = {"trim": {"start": 0, "end": 3}, "append": [extra["id"]], "fade_out": {"s": 0.5, "curve": "log"},
            "markers": [{"t": 1.0, "label": "drop"}]}
    r = client.post(f"/api/audio/{item['id']}/render", json={"edit": edit, "note": "tighter"})
    assert r.status_code == 202, r.text
    out = r.json()
    assert out["item"]["id"] == item["id"] and out["item"]["generation_id"] == item["generation_id"]
    job = out["job"]
    assert job["type"] == "audio_render" and job["lane"] == "general" and lane_for("audio_render") == "general"

    _run_all(fast_driver)
    with SessionLocal() as db:
        assert db.get(Job, job["id"]).status == "done", db.get(Job, job["id"]).error
        g = db.get(Generation, job["generation_id"])
        assert g.kind == "audio" and g.parent_id == item["generation_id"] and g.version == 2 and g.note == "tighter"
        assert g.params["source_id"] == item["generation_id"] and g.params["edit"]["markers"][0]["label"] == "drop"
        assert g.media_type == "audio/flac" and g.status == "ready"
        assert db.get(Job, job["id"]).payload["append"] == [extra["generation_id"]]
    now = client.get(f"/api/media/{item['id']}").json()
    assert now["generation_id"] == job["generation_id"] and now["versions_count"] == 2
    assert now["duration_s"] == pytest.approx(3.98, abs=0.03) and now["media_url"].endswith(".flac")
    assert now["thumb_url"] and now["analysis"] is not None  # waveform and badges came from the finish hooks
    assert [v["kind"] for v in now["versions"]] == ["audio", "upload"]
    path = gen_path(job["generation_id"])
    assert codec(path) == "flac" and path.with_name(f"{path.stem}.wave.png").is_file()

    # the older version can still be previewed and edited by id
    r = client.post(f"/api/audio/{item['id']}/preview", json={"edit": {}, "version": item["generation_id"]})
    assert float(r.headers["x-duration-s"]) == pytest.approx(4.0)


def test_render_validates_appends_and_ownership(client, tmp_path):
    item = upload_audio(client, tone(tmp_path / "a.wav", 1.0))
    pic = upload(client, "p.png", png_bytes(), "image/png").json()
    r = client.post(f"/api/audio/{item['id']}/render", json={"edit": {"append": [pic["id"]]}})
    assert r.status_code == 422 and "Append" in r.json()["detail"]
    r = client.post(f"/api/audio/{item['id']}/render", json={"edit": {"append": [str(uuid.uuid4())]}})
    assert r.status_code == 404
    assert client.post(f"/api/audio/{uuid.uuid4()}/render", json={"edit": {}}).status_code == 404
    with SessionLocal() as db:
        other = Workspace(name="Other")
        db.add(other)
        db.flush()
        db.get(MediaItem, item["id"]).workspace_id = other.id  # someone else's now
        db.commit()
    assert client.post(f"/api/audio/{item['id']}/render", json={"edit": {}}).status_code == 404
    with SessionLocal() as db:
        assert db.query(Job).filter(Job.type == "audio_render").count() == 0


# ------------------------------------------------------------------ API: export

def test_export_every_format(client, tmp_path):
    item = upload_audio(client, tone(tmp_path / "a.wav", 1.5, 440, 0.1), title="Main theme (v2)")
    want = {"wav16": "pcm_s16le", "wav24": "pcm_s24le", "wav32f": "pcm_f32le", "flac": "flac", "mp3_128": "mp3",
            "mp3_192": "mp3", "mp3_320": "mp3", "opus": "opus"}
    for fmt, c in want.items():
        r = client.get(f"/api/audio/{item['id']}/export", params={"format": fmt})
        assert r.status_code == 200, (fmt, r.text)
        _, ext, mt = ae.FORMATS[fmt]
        assert r.headers["content-type"].startswith(mt)
        assert r.headers["content-disposition"] == f'attachment; filename="Main-theme-v2{ext}"'
        f = tmp_path / f"x{fmt}{ext}"
        f.write_bytes(r.content)
        assert codec(f) == c, fmt
        assert length(f) == pytest.approx(1.5, abs=0.1)
    r = client.get(f"/api/audio/{item['id']}/export", params={"format": "wav16", "loudness": "broadcast"})
    f = tmp_path / "loud.wav"
    f.write_bytes(r.content)
    assert aa.measure(f)["lufs_i"] == pytest.approx(-23, abs=1.0)
    assert client.get(f"/api/audio/{item['id']}/export", params={"format": "aiff"}).status_code == 422


def test_export_mp4_is_a_waveform_video(client, tmp_path):
    item = upload_audio(client, tone(tmp_path / "a.wav", 2.0, 440, 0.1), title="Shareable")
    r = client.get(f"/api/audio/{item['id']}/export", params={"format": "mp4", "loudness": "web"})
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("video/mp4")
    f = tmp_path / "share.mp4"
    f.write_bytes(r.content)
    p = reel.probe(f)
    assert p.has_video and p.has_audio and p.width == 1280 and p.height == 720
    assert length(f) == pytest.approx(2.0, abs=0.15)


# ------------------------------------------------------------------ Score a Clip

def clip(path: Path, seconds: float = 4.0, with_audio: bool = True) -> Path:
    args = ["-f", "lavfi", "-i", f"color=c=navy:s=160x90:r=24:d={seconds}"]
    if with_audio:
        # "dialogue" for the first half, nothing after
        args += ["-f", "lavfi", "-i", f"aevalsrc='if(lt(t,2),0.5*sin(2*PI*300*t),0)':s=48000:d={seconds}",
                 "-c:a", "aac"]
    ff(*args, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-shortest", str(path))
    return path


def upload_video(client, path: Path) -> dict:
    r = upload(client, path.name, path.read_bytes(), "video/mp4")
    assert r.status_code == 201, r.text
    return r.json()


def streams(path: Path) -> tuple[int, int]:
    err = subprocess.run([get_settings().ffmpeg_path(), "-hide_banner", "-i", str(path)], capture_output=True,
                         text=True).stderr
    return len(re.findall(r"Stream #\S+.*?: Video:", err)), len(re.findall(r"Stream #\S+.*?: Audio:", err))


def test_mix_makes_a_new_video_version_with_ducked_music_and_stems(client, tmp_path, fast_driver):
    video = upload_video(client, clip(tmp_path / "clip.mp4"))
    music = upload_audio(client, tone(tmp_path / "m.wav", 1.5, 1000, 0.3), title="Bed")
    sfx = upload_audio(client, tone(tmp_path / "s.wav", 0.5, 2000, 0.3), title="Hit")
    body = {"video_id": video["id"], "original": {"keep": True, "gain_db": 0},
            "tracks": [{"media_id": music["id"], "offset_s": 0.25, "gain_db": -3, "loop": True, "duck": True,
                        "fade_in_s": 0.1},
                       {"media_id": sfx["id"], "offset_s": 3.0, "mute": True}],
            "duck": {"amount_db": 12}, "stems": True, "note": "first score"}
    r = client.post("/api/audio/mix", json=body)
    assert r.status_code == 202, r.text
    job = r.json()["job"]
    assert job["type"] == "audio_mix" and job["lane"] == "general" and r.json()["item"]["id"] == video["id"]

    _run_all(fast_driver)
    with SessionLocal() as db:
        j = db.get(Job, job["id"])
        assert j.status == "done", j.error
        g = db.get(Generation, job["generation_id"])
        assert g.kind == "video" and g.parent_id == video["generation_id"] and g.params["mix"]["duck"]["amount_db"] == 12
        result = j.result
    now = client.get(f"/api/media/{video['id']}").json()
    assert now["generation_id"] == job["generation_id"] and now["versions_count"] == 2
    out = gen_path(job["generation_id"])
    assert streams(out) == (1, 1) and length(out) == pytest.approx(4.0, abs=0.1) and codec(out) == "aac"
    assert result["ducked"] is True and result["stems_tracks"] == ["original.wav", "01-Bed.wav"]

    z = client.get(result["stems"])
    assert z.status_code == 200
    names = zipfile.ZipFile(io.BytesIO(z.content)).namelist()
    assert names == ["original.wav", "01-Bed.wav"]  # the muted hit isn't in the mix or the stems
    zipfile.ZipFile(io.BytesIO(z.content)).extractall(tmp_path / "stems")
    bed = tmp_path / "stems" / "01-Bed.wav"
    assert length(bed) == pytest.approx(4.0, abs=0.05)
    assert rms(bed, 0.0, 0.2) < -60  # the 0.25 s offset
    # music dips under the dialogue (first 2 s) and comes back once it stops
    assert rms(bed, 0.7, 1.0) < rms(bed, 2.7, 1.0) - 6


def test_mix_preview_is_the_soundtrack_at_the_video_length(client, tmp_path):
    video = upload_video(client, clip(tmp_path / "clip.mp4", 3.0))
    music = upload_audio(client, tone(tmp_path / "m.wav", 1.0, 1000, 0.3))
    body = {"video_id": video["id"], "tracks": [{"media_id": music["id"], "loop": True, "fade_out_s": 0.5}],
            "loudness": {"target": "web"}}
    r = client.post("/api/audio/mix/preview", json=body)
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "audio/mpeg" and float(r.headers["x-duration-s"]) == pytest.approx(3.0)
    f = tmp_path / "mix.mp3"
    f.write_bytes(r.content)
    assert length(f) == pytest.approx(3.0, abs=0.1) and aa.measure(f)["lufs_i"] == pytest.approx(-14, abs=1.0)

    # a silent clip with "keep original" is just silence under the music
    mute = upload_video(client, clip(tmp_path / "mute.mp4", 2.0, with_audio=False))
    r = client.post("/api/audio/mix/preview", json={"video_id": mute["id"], "tracks": [{"media_id": music["id"]}]})
    assert r.status_code == 200 and float(r.headers["x-duration-s"]) == pytest.approx(2.0)


def test_mix_validation(client, tmp_path):
    video = upload_video(client, clip(tmp_path / "clip.mp4", 1.0))
    music = upload_audio(client, tone(tmp_path / "m.wav", 1.0))
    assert client.post("/api/audio/mix", json={"video_id": music["id"]}).status_code == 422
    r = client.post("/api/audio/mix", json={"video_id": video["id"], "tracks": [{"media_id": video["id"]}]})
    assert r.status_code == 422 and r.json()["detail"].startswith("Track 1")
    r = client.post("/api/audio/mix/preview", json={"video_id": video["id"], "tracks": [{"media_id": str(uuid.uuid4())}]})
    assert r.status_code == 404
    assert client.post("/api/audio/mix", json={"video_id": str(uuid.uuid4())}).status_code == 404
    too_many = [{"media_id": music["id"]}] * 5
    assert client.post("/api/audio/mix", json={"video_id": video["id"], "tracks": too_many}).status_code == 422
    r = client.post("/api/audio/mix", json={"video_id": video["id"], "duck": {"amount_db": 30}})
    assert r.status_code == 422


def test_duck_mix_depth():
    assert md.duck_mix(0) == 0
    assert md.duck_mix(20) == pytest.approx(0.9)
