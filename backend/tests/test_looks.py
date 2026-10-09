"""Milestone 9a: looks, Lightroom preset import, .cube export/import, apply a look to video (contract v9)."""
import io
import subprocess

import numpy as np
import pytest
from PIL import Image

from app import longtake as lt
from app import reel as rl
from app.config import get_settings
from app.db import SessionLocal
from app.models import Generation, Job, Look, MediaItem
from app.photo import analysis as an
from app.photo import develop as dv
from app.photo import looks as lk
from app.photo import lut
from app.photo import xmp
from tests.test_photo import run_jobs, scene, upload
from tests.test_upscale import audio_md5

XMP = """<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
   crs:PresetType="Normal" crs:Version="15.0" crs:ProcessVersion="11.0" crs:UUID="ABC"
   crs:Exposure2012="+0.75" crs:Contrast2012="+20" crs:Highlights2012="-40" crs:Shadows2012="+35"
   crs:Whites2012="+10" crs:Blacks2012="-15" crs:Vibrance="+12" crs:Saturation="-5"
   crs:IncrementalTemperature="+8" crs:IncrementalTint="-3" crs:Clarity2012="+15" crs:Sharpness="40"
   crs:LuminanceSmoothing="20" crs:PostCropVignetteAmount="-25"
   crs:ParametricShadows="+10" crs:ParametricDarks="-6" crs:ParametricLights="+4" crs:ParametricHighlights="-20"
   crs:HueAdjustmentBlue="-10" crs:SaturationAdjustmentBlue="+25" crs:LuminanceAdjustmentOrange="+8"
   crs:SplitToningShadowHue="210" crs:SplitToningShadowSaturation="20" crs:Texture="+10" crs:Dehaze="0"
   crs:GrainAmount="15">
   <crs:Name><rdf:Alt><rdf:li xml:lang="x-default">Harbour Dusk</rdf:li></rdf:Alt></crs:Name>
   <crs:ToneCurvePV2012><rdf:Seq><rdf:li>0, 0</rdf:li><rdf:li>128, 140</rdf:li><rdf:li>255, 255</rdf:li></rdf:Seq>
   </crs:ToneCurvePV2012>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
"""

LRTEMPLATE = """s = {
\tid = "1234",
\tinternalName = "Quiet Morning",
\ttitle = "Quiet Morning",
\ttype = "Develop",
\tvalue = {
\t\tsettings = {
\t\t\tExposure2012 = -0.3,
\t\t\tContrast2012 = -10,
\t\t\tConvertToGrayscale = true,
\t\t\tHueAdjustmentGreen = 12,
\t\t\tSaturationAdjustmentGreen = -30,
\t\t\tPostCropVignetteAmount = -12,
\t\t\tSplitToningHighlightHue = 45,
\t\t\tToneCurvePV2012 = {
\t\t\t\t0,
\t\t\t\t20,
\t\t\t\t255,
\t\t\t\t240,
\t\t\t},
\t\t},
\t\tuuid = "1234",
\t},
\tversion = 0,
}
"""


def _import(client, *files):
    return client.post("/api/looks/import", files=[("files", f) for f in files])


# ------------------------------------------------------------------ built-ins and CRUD

def test_builtins_and_crud(client):
    looks = client.get("/api/looks").json()
    built = [x for x in looks if x["source"] == "builtin"]
    assert len(built) == 7 and looks[:7] == built
    assert {x["name"] for x in built} >= {"Natural Portrait", "Teal & Orange", "Classic Mono"}
    mono = next(x for x in built if x["name"] == "Classic Mono")
    assert mono["params"]["saturation"] == -100 and not mono["editable"] and "sharpness" in mono["spatial"]
    assert "lightPoints" not in mono["params"]  # stored sparse
    r = client.get(mono["thumb_url"])
    assert r.status_code == 200 and r.headers["content-type"] == "image/jpeg"
    assert client.patch(f"/api/looks/{mono['id']}", json={"name": "Mine"}).status_code == 403
    assert client.delete(f"/api/looks/{mono['id']}").status_code == 403

    ids = upload(client, scene(60, 90))
    r = client.post("/api/looks", json={"name": "Punchy", "params": {"contrast": 30, "hsl": {"red": {"s": 10}}},
                                        "category": "Mine", "generation_id": ids["item"]})
    assert r.status_code == 201, r.text
    mine = r.json()
    assert mine["params"] == {"contrast": 30.0, "hsl": {"red": {"s": 10.0}}} and mine["editable"]
    with SessionLocal() as db:
        assert db.get(Look, mine["id"]).thumb_path
    assert client.get(f"/api/looks/{mine['id']}/thumb", params={"generation_id": ids["gen"]}).status_code == 200
    r = client.patch(f"/api/looks/{mine['id']}", json={"name": "Punchier", "params": {"contrast": 45}})
    assert r.json()["name"] == "Punchier" and r.json()["params"] == {"contrast": 45.0}
    assert client.get("/api/looks").json()[7]["id"] == mine["id"]
    assert client.delete(f"/api/looks/{mine['id']}").status_code == 204
    assert client.get(f"/api/looks/{mine['id']}").status_code == 404


def test_builtins_stay_in_step(db):
    row = db.get(Look, "builtin-classic-mono")
    row.params = {"saturation": 0}
    db.commit()
    lk.ensure_builtins(db)
    db.refresh(row)
    assert row.params["saturation"] == -100


# ------------------------------------------------------------------ Lightroom presets

def test_xmp_mapping():
    out = xmp.parse("Harbour.xmp", XMP.encode())
    p = out["params"]
    assert out["name"] == "Harbour Dusk" and out["kind"] == "xmp"
    assert p["exposure"] == 50  # 0.75 stops on a 1.5-stop slider
    assert (p["contrast"], p["highlights"], p["shadows"], p["whites"], p["blacks"]) == (20, -40, 35, 10, -15)
    assert (p["vibrance"], p["saturation"], p["temperature"], p["tint"]) == (12, -5, 8, -3)
    assert (p["clarity"], p["sharpness"], p["noiseReduction"], p["vignette"]) == (15, 40, 20, -25)
    assert p["curve"]["shadows"] == 3 and p["curve"]["highlights"] == -6 and p["curve"]["mids"] == pytest.approx(-0.3)
    assert p["hsl"]["blue"] == {"h": -10, "s": 25, "l": 0} and p["hsl"]["orange"]["l"] == 8
    assert "Exposure2012" in out["mapped"] and "HueAdjustmentBlue" in out["mapped"]
    assert set(out["unmapped"]) == {"SplitToningShadowHue", "SplitToningShadowSaturation", "Texture", "GrainAmount",
                                    "ToneCurvePV2012"}  # Dehaze=0 isn't a change, metadata never listed


def test_lrtemplate_mapping():
    out = xmp.parse("quiet.lrtemplate", LRTEMPLATE.encode())
    p = out["params"]
    assert out["name"] == "Quiet Morning" and out["kind"] == "lrtemplate"
    assert p["exposure"] == -20 and p["contrast"] == -10 and p["saturation"] == -100
    assert p["hsl"]["green"] == {"h": 12, "s": -30, "l": 0} and p["vignette"] == -12
    assert set(out["unmapped"]) == {"SplitToningHighlightHue", "ToneCurvePV2012"}


def test_preset_errors():
    with pytest.raises(xmp.PresetError):
        xmp.parse("empty.xmp", b"<x:xmpmeta></x:xmpmeta>")
    with pytest.raises(xmp.PresetError):
        xmp.parse("odd.xmp", b'<rdf:Description crs:Texture="20" crs:Dehaze="10"/>')


def test_import_endpoint_reports_per_file(client):
    cube = lut.write_cube(lut.identity(5), "Plain")
    r = _import(client, ("Harbour.xmp", XMP.encode(), "application/octet-stream"),
                ("quiet.lrtemplate", LRTEMPLATE.encode(), "text/plain"),
                ("plain.cube", cube.encode(), "text/plain"),
                ("notes.txt", b"hello", "text/plain"),
                ("broken.cube", b"LUT_3D_SIZE 3\n0 0 0\n", "text/plain"))
    assert r.status_code == 201, r.text
    body = r.json()
    assert [x["name"] for x in body["looks"]] == ["Harbour Dusk", "Quiet Morning", "Plain"]
    reps = {x["file"]: x for x in body["reports"]}
    assert reps["Harbour.xmp"]["ok"] and "Texture" in reps["Harbour.xmp"]["unmapped"]
    assert reps["plain.cube"]["kind"] == "cube" and reps["plain.cube"]["cube_size"] == 5
    assert not reps["notes.txt"]["ok"] and "Only .xmp" in reps["notes.txt"]["error"]
    assert not reps["broken.cube"]["ok"] and "Expected 27" in reps["broken.cube"]["error"]
    plain = next(x for x in body["looks"] if x["has_cube"])
    assert plain["source"] == "imported" and plain["params"] == {}
    r = _import(client, ("lut1d.cube", b"LUT_1D_SIZE 2\n0 0 0\n1 1 1\n", "text/plain"))
    assert r.status_code == 422 and "1D" in str(r.json())


# ------------------------------------------------------------------ .cube

POINT_PARAMS = {"exposure": 15, "contrast": 25, "highlights": -30, "shadows": 20, "temperature": 12, "tint": -5,
                "vibrance": 20, "saturation": -10, "curve": {"blacks": 8, "highlights": -6},
                "hsl": {"blue": {"h": 10, "s": -25, "l": -10}, "orange": {"s": 15}}}


def test_cube_parse_write_and_domain():
    t = lut.identity(9)
    c = lut.parse_cube(lut.write_cube(t, 'He said "hi"', ["a note"]))
    assert c["size"] == 9 and c["title"] == "He said 'hi'" and np.allclose(c["table"], t, atol=1e-6)
    text = "LUT_3D_SIZE 2\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 2 2 2\n" + "\n".join(
        f"{r} {g} {b}" for b in (0, 2) for g in (0, 2) for r in (0, 2))
    c = lut.parse_cube(text)
    assert np.allclose(lut.apply_lut(np.array([[0.5, 0.25, 1.0]]), lut.standard_table(c)), [[0.5, 0.25, 1.0]])
    for bad in ("TITLE x\n", "LUT_3D_SIZE 99\n", "LUT_3D_SIZE 2\n1 2\n"):
        with pytest.raises(lut.CubeError):
            lut.parse_cube(bad)


def test_cube_round_trip_matches_develop(client):
    r = client.post("/api/looks", json={"name": "Round trip", "params": {**POINT_PARAMS, "clarity": 20}})
    look = r.json()
    r = client.get(f"/api/looks/{look['id']}/cube", params={"size": 33})
    assert r.status_code == 200 and 'filename="Round trip.cube"' in r.headers["content-disposition"]
    text = r.text
    assert "Not included" in text and "clarity" in text.split("LUT_3D_SIZE")[0]
    r = _import(client, ("round.cube", text.encode(), "text/plain"))
    imported = r.json()["looks"][0]
    assert imported["cube_size"] == 33 and imported["name"] == "Round trip"

    a = scene(noise=0.01)
    expect = dv.quantise(dv.develop(a, POINT_PARAMS))
    with SessionLocal() as db:
        from app.photo import service as svc

        table = svc.look_table(db.get(Look, imported["id"]))
    got = dv.quantise(dv.develop(a, {}, lut=(table, 1.0)))
    de = an.delta_e(expect, got)
    assert de.mean() < 0.5 and np.percentile(de, 99) < 2.0, (de.mean(), np.percentile(de, 99))

    # and through the preview with params.lut, as the panel would apply it
    ids = upload(client, a)
    r = client.post(f"/api/photo/{ids['gen']}/preview",
                    json={"params": {"lut": {"look_id": imported["id"], "amount": 100}}})
    prev = np.asarray(Image.open(io.BytesIO(r.content)).convert("RGB"))
    # the preview is a JPEG: compare it with the expected image through the same encoder
    same_jpeg = np.asarray(Image.open(io.BytesIO(dv.encode(dv.to_unit(expect), None, "jpeg", 90))).convert("RGB"))
    assert an.delta_e(prev, same_jpeg).mean() < 1.0
    r = client.post(f"/api/photo/{ids['gen']}/preview", json={"params": {"lut": {"look_id": "missing"}}})
    assert r.status_code == 422


def test_cube_from_params_endpoint(client):
    r = client.post("/api/photo/cube", json={"params": {"saturation": -100}, "size": 5, "title": "Mono"})
    assert r.status_code == 200
    c = lut.parse_cube(r.text)
    assert c["size"] == 5 and np.abs(c["table"][..., 0] - c["table"][..., 2]).max() < 1e-5


# ------------------------------------------------------------------ apply to video

@pytest.fixture(scope="module")
def clip(tmp_path_factory):
    d = tmp_path_factory.mktemp("look")
    out = d / "clip.mp4"
    rl.run_ff(["-f", "lavfi", "-i", "testsrc2=size=160x96:rate=24:duration=2",
               "-f", "lavfi", "-i", "sine=frequency=440:duration=2:sample_rate=48000",
               "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
               "-c:a", "aac", "-b:a", "96k", str(out)])
    return out


def _frame(path, at=1.0) -> np.ndarray:
    raw = subprocess.run([get_settings().ffmpeg_path(), "-hide_banner", "-loglevel", "error", "-ss", str(at), "-i",
                          str(path), "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"],
                         capture_output=True, check=True).stdout
    return np.asarray(Image.open(io.BytesIO(raw)).convert("RGB"))


def test_apply_look_to_video_keeps_timing_and_audio(client, clip, monkeypatch):
    monkeypatch.setattr(lk, "SEGMENT_S", 0.75)  # 48 frames -> segments of 18, 18, 12
    r = client.post("/api/media/upload", files={"file": ("clip.mp4", clip.read_bytes(), "video/mp4")})
    assert r.status_code == 201, r.text
    item = r.json()["id"]
    r = client.post("/api/looks/builtin-classic-mono/apply-video", json={"generation_id": item, "intensity": 1})
    assert r.status_code == 202, r.text
    job = r.json()
    assert job["type"] == "look_video" and job["lane"] == "general"
    again = client.post("/api/looks/builtin-classic-mono/apply-video", json={"generation_id": item, "intensity": 1})
    assert again.json()["id"] == job["id"]
    run_jobs()
    with SessionLocal() as db:
        j = db.get(Job, job["id"])
        assert j.status == "done", j.error
        g = db.get(Generation, job["generation_id"])
        assert g.kind == "video" and g.media_type == "video/mp4" and g.status == "ready"
        assert g.params["look"]["name"] == "Classic Mono" and "unsharp" in g.params["look"]["unsharp"]
        assert g.params["look"]["spatial_skipped"] == [] and len(g.params["segments"]) == 3
        out = get_settings().data_dir / g.file_path
        assert db.get(MediaItem, item).generation_id == g.id
        assert not lk.grade_dir(g)[0].exists()
    src, res = rl.probe(clip), rl.probe(out)
    assert (res.width, res.height) == (src.width, src.height) == (160, 96)
    assert abs(res.duration - src.duration) < 0.05
    assert lt.count_frames(out) == lt.count_frames(clip) == 48
    from app import upscale as up

    assert up.probe_source(out).fps_str == up.probe_source(clip).fps_str
    assert audio_md5(out) == audio_md5(clip)
    frame = _frame(out).astype(int)
    assert np.abs(frame[..., 0] - frame[..., 2]).mean() < 4  # graded to monochrome
    assert np.abs(_frame(clip).astype(int)[..., 0] - _frame(clip).astype(int)[..., 2]).mean() > 20


def test_apply_video_refuses_images_and_keeps_intensity(client, clip):
    ids = upload(client, scene(40, 60))
    r = client.post("/api/looks/builtin-teal-orange/apply-video", json={"generation_id": ids["gen"]})
    assert r.status_code == 422
    assert client.post("/api/looks/nope/apply-video", json={"generation_id": ids["gen"]}).status_code == 404
    r = client.post("/api/media/upload", files={"file": ("clip.mp4", clip.read_bytes(), "video/mp4")})
    item = r.json()["id"]
    r = client.post("/api/looks/builtin-teal-orange/apply-video", json={"generation_id": item, "intensity": 0})
    with SessionLocal() as db:
        g = db.get(Generation, r.json()["generation_id"])
        cube = lut.parse_cube((get_settings().data_dir / g.params["look"]["cube_file"]).read_text())
        assert np.allclose(cube["table"], lut.identity(33), atol=1e-5)  # intensity 0 is identity
        assert g.params["look"]["spatial_skipped"] == ["vignette"] and g.params["look"]["unsharp"] == ""

