"""Milestone 8B: brand kits, deterministic compositing, brand references and the logo check (contract v7)."""
import io
import re
import subprocess
from pathlib import Path

import pytest
from PIL import Image

from app import brand as br
from app import brand_render as rnd
from app import worker
from app.brand_schemas import BrandSettings, WatermarkSettings, merged_settings
from app.config import get_settings
from app.db import SessionLocal
from app.drivers.mock import MockDriver
from app.models import BrandKit, Generation, Job, MediaItem, Project

FONT_CANDIDATES = [Path(p) for p in rnd.SYSTEM_FONTS]
SYSTEM_FONT = next((p for p in FONT_CANDIDATES if p.is_file()), None)
needs_font = pytest.mark.skipif(SYSTEM_FONT is None, reason="no TrueType font on this machine")


def png(size=(200, 100), colour=(200, 30, 30, 255), mode="RGBA", fmt="PNG") -> bytes:
    buf = io.BytesIO()
    if mode == "RGBA":  # a logo: a solid mark on a transparent canvas
        im = Image.new("RGBA", size, (0, 0, 0, 0))
        im.paste(colour, (size[0] // 8, size[1] // 8, size[0] * 7 // 8, size[1] * 7 // 8))
    else:
        im = Image.new(mode, size, colour[:3])
    im.save(buf, fmt)
    return buf.getvalue()


def asset(client, purpose, name, data):
    return client.post(f"/api/brand-kits/assets?purpose={purpose}", files={"file": (name, data, "application/octet-stream")})


def run_jobs():
    while worker.process_one(driver_factory=lambda: MockDriver(step_seconds=0, steps=1)):
        pass


def make_kit(client, **extra) -> dict:
    logo = asset(client, "logo", "logo.png", png()).json()["item"]
    body = {"name": "Leaf Coffee", "tagline": "Fresh every morning",
            "palette": [{"hex": "#0f4c5c", "name": "deep teal"}, {"hex": "E3B23C", "name": "warm sand"}],
            "style_text": "minimal, premium, soft daylight", "voice_text": "warm and witty",
            "logos": {"primary": {"media_id": logo["id"], "description": "round green leaf"}}, **extra}
    r = client.post("/api/brand-kits", json=body)
    assert r.status_code == 201, r.text
    return r.json()


def media_frame(path: Path) -> dict:
    """Size, fps, duration and audio of a video, read with ffmpeg."""
    ff = get_settings().ffmpeg_path()
    err = subprocess.run([ff, "-hide_banner", "-nostdin", "-i", str(path)], capture_output=True, text=True,
                         encoding="utf-8", errors="replace").stderr
    dur = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", err)
    vid = re.search(r"Video: .*?, (\d{2,5})x(\d{2,5}).*?, (\d+(?:\.\d+)?) fps", err)
    # decoded audio length, so a track that stops early shows up
    a = subprocess.run([ff, "-hide_banner", "-nostdin", "-i", str(path), "-map", "0:a:0", "-f", "null", "-"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace").stderr
    times = re.findall(r"time=(\d+):(\d+):(\d+(?:\.\d+)?)", a)
    adur = int(times[-1][0]) * 3600 + int(times[-1][1]) * 60 + float(times[-1][2]) if times else 0.0
    return {"duration": int(dur[1]) * 3600 + int(dur[2]) * 60 + float(dur[3]), "size": (int(vid[1]), int(vid[2])),
            "fps": float(vid[3]), "has_audio": "Audio:" in err, "audio_s": adur}


@pytest.fixture
def source_video(tmp_path) -> Path:
    out = tmp_path / "src.mp4"
    subprocess.run([get_settings().ffmpeg_path(), "-y", "-hide_banner", "-loglevel", "error",
                    "-f", "lavfi", "-i", "testsrc=size=320x240:rate=24:duration=2",
                    "-f", "lavfi", "-i", "sine=frequency=440:duration=2:sample_rate=44100",
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(out)], check=True)
    return out


# ------------------------------------------------------------------ uploads

@needs_font
def test_font_upload_sniffs_and_validates(client):
    real = SYSTEM_FONT.read_bytes()
    r = asset(client, "font", "Brand.ttf", real)
    assert r.status_code == 201, r.text
    item = r.json()["item"]
    assert item["kind"] == "font" and item["origin"] == "upload" and "brand" in item["tags"]
    # fonts stay out of the picture grid
    assert item["id"] not in [i["id"] for i in client.get("/api/media").json()["items"]]

    fake = b"\x00\x01\x00\x00" + b"definitely not a font" * 40
    r = asset(client, "font", "fake.ttf", fake)
    assert r.status_code == 415 and "damaged" in r.json()["detail"]
    assert asset(client, "font", "pic.ttf", png()).status_code == 415
    assert asset(client, "font", "Brand.otf", real).status_code == 415  # TrueType bytes, .otf name


def test_logo_upload_rules(client):
    r = asset(client, "logo", "logo.png", png())
    assert r.status_code == 201 and r.json()["warnings"] == []
    r = asset(client, "logo", "flat.png", png(mode="RGB"))
    assert r.status_code == 201 and "transparent" in r.json()["warnings"][0]
    # JPEG logos are refused (no alpha, ever); product photos may be JPEG
    assert asset(client, "logo", "logo.jpg", png(mode="RGB", fmt="JPEG")).status_code == 415
    assert asset(client, "product", "can.jpg", png(mode="RGB", fmt="JPEG")).status_code == 201
    big = b"\x89PNG\r\n\x1a\n" + b"\0" * (br.LOGO_MAX + 10)
    assert asset(client, "logo", "huge.png", big).status_code == 413


def test_svg_logo_is_rasterised_and_unsafe_svg_refused(client):
    svg = (b'<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60" viewBox="0 0 120 60">'
           b'<circle cx="30" cy="30" r="25" fill="#2a8"/></svg>')
    r = asset(client, "logo", "leaf.svg", svg)
    assert r.status_code == 201, r.text
    item = r.json()["item"]
    assert item["media_url"].endswith(".png") and max(item["width"], item["height"]) == br.SVG_MAX_SIDE
    with SessionLocal() as db:
        assert db.get(Generation, item["generation_id"]).params["original_format"] == "svg"

    script = b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
    assert asset(client, "logo", "x.svg", script).status_code == 415
    ext = b'<svg xmlns="http://www.w3.org/2000/svg"><image href="file:///etc/passwd"/></svg>'
    assert "outside files" in asset(client, "logo", "y.svg", ext).json()["detail"]


# ------------------------------------------------------------------ kit API and prompts

def test_kit_crud_default_and_prompt_context(client):
    kit = make_kit(client)
    assert kit["is_default"] is True  # the first kit becomes the default
    assert kit["palette"][0] == {"hex": "#0F4C5C", "name": "deep teal"} and kit["palette"][1]["hex"] == "#E3B23C"
    s = kit["settings"]
    assert not any(s[k]["enabled"] for k in ("watermark", "end_card", "intro_card", "lower_third", "grade"))
    assert s["grade"]["strength"] == 0.25 and s["end_card"]["duration_s"] == 2.5
    ctx = kit["prompt_context"]
    assert "Brand: Leaf Coffee" in ctx and "deep teal #0F4C5C" in ctx and "warm and witty" in ctx
    assert "soft daylight" in ctx and "round green leaf" in ctx

    second = client.post("/api/brand-kits", json={"name": "Other"}).json()
    assert second["is_default"] is False
    assert client.post(f"/api/brand-kits/{second['id']}/default").json()["is_default"] is True
    kits = client.get("/api/brand-kits").json()
    assert [k["is_default"] for k in kits] == [True, False] and kits[0]["id"] == second["id"]

    r = client.patch(f"/api/brand-kits/{kit['id']}", json={"settings": {"watermark": {"enabled": True,
                                                                                         "position": "tl"}}})
    assert r.json()["settings"]["watermark"]["position"] == "tl" and r.json()["settings"]["watermark"]["size_pct"] == 12
    assert client.patch(f"/api/brand-kits/{kit['id']}", json={"palette": [{"hex": "blue"}]}).status_code == 422
    assert client.patch(f"/api/brand-kits/{kit['id']}",
                        json={"font_files": [kit["logos"]["primary"]["media_id"]]}).status_code == 422
    assert client.delete(f"/api/brand-kits/{second['id']}").status_code == 204
    assert client.get(f"/api/brand-kits/{second['id']}").status_code == 404


def test_image_prompt_suffix_and_generation_hook(client):
    kit = make_kit(client)
    r = client.post("/api/images/generate", json={"prompt": "a cup on a table", "brand_kit_id": kit["id"]})
    assert r.status_code == 202, r.text
    with SessionLocal() as db:
        g = db.get(Generation, r.json()["items"][0]["generation_id"])
        assert "colour palette: deep teal #0F4C5C, warm sand #E3B23C" in g.prompt
        assert "soft daylight" in g.prompt and "warm and witty" not in g.prompt
        assert g.params["brand"] == {"kit_id": kit["id"], "auto": True}
    assert client.post("/api/images/generate", json={"prompt": "x", "brand_kit_id": "nope"}).status_code == 404


def test_brand_reference_set_priorities(client):
    prod = asset(client, "product", "can.png", png()).json()["item"]
    kit = make_kit(client, products=[{"media_id": prod["id"], "name": "Leaf Cold Brew",
                                      "description": "matte black 330 ml can"}])
    logo_id = kit["logos"]["primary"]["media_id"]
    with SessionLocal() as db:
        k = db.get(BrandKit, kit["id"])
        placements = [
            {"asset_id": prod["id"], "asset_type": "product", "surface": "cafe counter", "prominence": "background"},
            {"asset_id": logo_id, "asset_type": "logo", "surface": "cup sleeve", "prominence": "hero"},
        ]
        rs = br.brand_reference_set(k, placements, max_refs=3, character_ref_ids=["char-gen"])
        assert rs.media_ids == [logo_id, "char-gen", prod["id"]]
        assert "the Leaf Coffee logo (round green leaf) printed on the cup sleeve, front-facing, sharp, legible" in rs.prompt
        assert "Leaf Cold Brew (matte black 330 ml can) on the cafe counter" in rs.prompt
        tight = br.brand_reference_set(k, placements, max_refs=2, character_ref_ids=["char-gen"])
        assert tight.media_ids == [logo_id, "char-gen"] and tight.dropped == [prod["id"]]
        assert "Leaf Cold Brew" in tight.prompt  # still asked for in words
        gen_ids = br.resolve_reference_ids(db, k.workspace_id, rs.media_ids[:1])
        assert gen_ids == [db.get(MediaItem, logo_id).generation_id]
        assert br.brand_refs(k) == [prod["id"]]


def test_shot_brand_placements_patch(client, project):
    sc = client.post(f"/api/projects/{project['id']}/scenes", json={"heading": "INT. CAFE"}).json()
    shot = client.post(f"/api/scenes/{sc['id']}/shots", json={"description": "cup"}).json()
    assert shot["brand_placements"] == []
    pl = [{"asset_id": "m1", "asset_type": "logo", "surface": "cup sleeve", "prominence": "hero"}]
    r = client.patch(f"/api/shots/{shot['id']}", json={"brand_placements": pl})
    # the user's placements are tagged so AI re-plans only suggest changes to them
    assert r.status_code == 200 and r.json()["brand_placements"] == [{**pl[0], "source": "user"}]
    bad = [{"asset_id": "m1", "asset_type": "sticker"}]
    assert client.patch(f"/api/shots/{shot['id']}", json={"brand_placements": bad}).status_code == 422


# ------------------------------------------------------------------ logo check (fake vision model)

class _FakeResult:
    def __init__(self, data):
        self.data = data

    def call_info(self, role):
        return {"role": role, "model": "fake-eye"}


def test_check_logo_with_fake_llm_and_fallback(tmp_path, monkeypatch):
    frame, logo = tmp_path / "f.png", tmp_path / "l.png"
    Image.new("RGB", (64, 64), "white").save(frame)
    Image.new("RGBA", (32, 32), (0, 128, 0, 255)).save(logo)
    seen = {}

    def fake(role, messages, schema=None, **kw):
        seen["role"], seen["images"] = role, len(messages[-1]["images"])
        return _FakeResult(schema(present=True, legible=True, distorted=False, score="8/10", issues=[]))

    monkeypatch.setattr(br, "chat_sync", fake)
    out = br.check_logo(frame, logo, "cup sleeve")
    assert out["checked"] and out["passed"] and out["score"] == 8 and seen == {"role": "vision", "images": 2}

    monkeypatch.setattr(br, "chat_sync", lambda *a, **k: _FakeResult(br.LogoCheck(present=True, legible=False,
                                                                                    distorted=True, score=3,
                                                                                    issues=["warped letters"])))
    out = br.check_logo(frame, logo)
    assert out["checked"] and not out["passed"] and out["issues"] == ["warped letters"]

    def down(*a, **k):
        raise br.LLMError("vision model offline")

    monkeypatch.setattr(br, "chat_sync", down)
    assert br.check_logo(frame, logo) == {"checked": False, "reason": "vision model offline"}
    assert br.check_logo(tmp_path / "missing.png", logo)["checked"] is False


# ------------------------------------------------------------------ pixels

def test_watermark_position_size_and_opacity(tmp_path):
    logo = tmp_path / "logo.png"
    Image.new("RGBA", (100, 50), (255, 0, 0, 255)).save(logo)
    src, out = tmp_path / "src.png", tmp_path / "out.png"
    Image.new("RGB", (400, 300), (100, 100, 100)).save(src)
    st = BrandSettings(watermark=WatermarkSettings(enabled=True, position="br", size_pct=20, opacity=0.5,
                                                   margin_pct=3))
    assert rnd.watermark_box(400, 300, 100, 50, st.watermark) == (331, 261, 60, 30)
    applied = rnd.apply_to_image(src, out, rnd.KitAssets(logo=logo), st)
    assert applied == ["watermark"]
    with Image.open(out) as im:
        assert im.size == (400, 300) and im.mode == "RGB"
        r, g, b = im.getpixel((360, 275))  # inside the logo
        assert abs(r - 178) <= 2 and abs(g - 50) <= 2 and abs(b - 50) <= 2  # 50% red over grey
        assert im.getpixel((330, 275)) == (100, 100, 100)  # one pixel left of it
        assert im.getpixel((360, 292)) == (100, 100, 100)  # in the bottom margin
        assert im.getpixel((10, 10)) == (100, 100, 100)

    tl = WatermarkSettings(enabled=True, position="tl", size_pct=10, margin_pct=0)
    assert rnd.watermark_box(1920, 1080, 500, 500, tl) == (0, 0, 108, 108)


def test_grade_is_off_by_default_and_mild(tmp_path):
    st = merged_settings(None)
    assert st.enabled() == [] and st.grade.enabled is False and st.grade.strength == 0.25
    src = tmp_path / "s.png"
    Image.new("RGB", (8, 8), (128, 128, 128)).save(src)
    with pytest.raises(rnd.BrandRenderError):
        rnd.apply_to_image(src, tmp_path / "o.png", rnd.KitAssets(), st)
    pal = [{"hex": "#0F4C5C"}, {"hex": "#E3B23C"}]
    graded = rnd.grade_image(Image.open(src), pal, 0.25)
    px = graded.getpixel((0, 0))
    assert px != (128, 128, 128) and max(abs(c - 128) for c in px) <= 12
    assert rnd.grade_image(Image.new("RGB", (2, 2), (0, 0, 0)), pal, 0.25).getpixel((0, 0)) == (0, 0, 0)
    assert rnd.grade_filter(pal, 0) is None and "lutrgb" in rnd.grade_filter(pal, 0.25)


@needs_font
def test_urdu_tagline_card_renders(tmp_path):
    logo = tmp_path / "logo.png"
    Image.new("RGBA", (80, 80), (0, 160, 90, 255)).save(logo)
    assets = rnd.KitAssets(name="لیف کافی", tagline="ہر صبح تازہ، ہر گھونٹ میں سکون اور خوشبو", logo=logo,
                           palette=[{"hex": "#0F4C5C"}], font=SYSTEM_FONT)
    st = merged_settings(None, {"end_card": True, "intro_card": True})
    end = rnd.render_card((640, 360), assets, st.end_card, "end_card")
    intro = rnd.render_card((360, 640), assets, st.intro_card, "intro_card")
    assert end.size == (640, 360) and intro.size == (360, 640)
    # something besides the background got drawn below the logo (the tagline)
    lower = end.crop((0, 230, 640, 360)).convert("L")
    assert lower.getextrema()[1] > 200
    assert rnd.is_rtl(assets.tagline) and not rnd.is_rtl("Fresh")
    lt = rnd.render_lower_third((640, 360), assets, st.lower_third)
    assert lt.mode == "RGBA" and lt.getchannel("A").getextrema()[1] > 0


# ------------------------------------------------------------------ video

def test_video_watermark_and_end_card(tmp_path, source_video):
    logo = tmp_path / "logo.png"
    Image.new("RGBA", (100, 50), (255, 255, 255, 255)).save(logo)
    assets = rnd.KitAssets(name="Leaf", tagline="Fresh", logo=logo, palette=[{"hex": "#0F4C5C"}])
    st = merged_settings(None, {"watermark": True, "end_card": True})
    out = tmp_path / "out.mp4"
    info = rnd.apply_to_video(source_video, out, assets, st, tmp_path / "work")
    assert info["applied"] == ["watermark", "end_card"] and info["end_s"] == 2.5
    m = media_frame(out)
    assert abs(m["duration"] - 4.5) < 0.1, m
    assert m["size"] == (320, 240) and m["fps"] == 24 and m["has_audio"]
    assert abs(m["audio_s"] - m["duration"]) < 0.1, m


def test_video_without_audio_gets_silence_and_intro(tmp_path):
    src = tmp_path / "mute.mp4"
    subprocess.run([get_settings().ffmpeg_path(), "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
                    "-i", "testsrc=size=256x144:rate=25:duration=1.5", "-c:v", "libx264", "-pix_fmt", "yuv420p",
                    str(src)], check=True)
    st = merged_settings(None, {"intro_card": True, "lower_third": {"enabled": True, "at_s": 0.2}, "grade": True})
    out = tmp_path / "o.mp4"
    rnd.apply_to_video(src, out, rnd.KitAssets(name="Leaf", palette=[{"hex": "#E3B23C"}]), st, tmp_path / "w")
    m = media_frame(out)
    assert abs(m["duration"] - 3.5) < 0.1 and m["size"] == (256, 144) and m["fps"] == 25 and m["has_audio"]


# ------------------------------------------------------------------ preview, apply, reveal

def test_preview_returns_png(client):
    kit = make_kit(client)
    for kind in ("image", "end_card", "intro_card", "lower_third"):
        r = client.post(f"/api/brand-kits/{kit['id']}/preview", json={"kind": kind})
        assert r.status_code == 200 and r.headers["content-type"] == "image/png", r.text
        assert Image.open(io.BytesIO(r.content)).size == (1280, 720)
    sample = client.post("/api/media/upload", files={"file": ("s.png", png((300, 200), mode="RGB"), "image/png")}).json()
    r = client.post(f"/api/brand-kits/{kit['id']}/preview", json={"kind": "image", "sample_media_id": sample["id"],
                                                                   "settings": {"watermark": {"position": "tl"}}})
    assert r.status_code == 200 and Image.open(io.BytesIO(r.content)).size == (300, 200)


def test_brand_apply_creates_new_version_and_keeps_original(client):
    kit = make_kit(client, settings={"watermark": {"enabled": True}})
    up = client.post("/api/media/upload", files={"file": ("p.png", png((320, 200), (90, 90, 90, 255), "RGB"),
                                                           "image/png")}).json()
    r = client.post(f"/api/generations/{up['generation_id']}/brand", json={})  # project-less: the default kit
    assert r.status_code == 202, r.text
    assert r.json()["type"] == "brand_apply"
    run_jobs()
    detail = client.get(f"/api/media/{up['id']}").json()
    assert [v["version"] for v in detail["versions"]] == [2, 1]
    new, old = detail["versions"]
    assert new["status"] == "ready" and new["parent_id"] == old["id"] and old["status"] == "ready"
    assert new["params"]["brand"]["applied"] == ["watermark"] and new["params"]["brand"]["kit_id"] == kit["id"]
    assert detail["generation_id"] == new["id"]
    with SessionLocal() as db:
        assert Path(get_settings().data_dir / db.get(Generation, old["id"]).file_path).is_file()
    # nothing switched on for images -> a clear 422
    r = client.post(f"/api/generations/{up['generation_id']}/brand",
                    json={"kit_id": kit["id"], "options": {"watermark": False}})
    assert r.status_code == 422 and "Nothing to apply" in r.json()["detail"]


def test_auto_brand_after_image_generation(client):
    kit = make_kit(client, settings={"watermark": {"enabled": True, "position": "tl"}})
    r = client.post("/api/images/generate", json={"prompt": "a cup", "brand_kit_id": kit["id"]})
    item = r.json()["items"][0]
    run_jobs()
    with SessionLocal() as db:
        gens = db.query(Generation).filter(Generation.target_id == item["id"]).order_by(Generation.version).all()
        assert [g.version for g in gens] == [1, 2] and gens[1].params["brand"]["auto"] is True
        jobs = db.query(Job).filter(Job.type == br.BRAND_JOB).all()
        assert len(jobs) == 1 and jobs[0].priority == -1 and jobs[0].status == "done"

    # kit with nothing switched on: no follow-up job at all
    plain = client.post("/api/brand-kits", json={"name": "Plain"}).json()
    client.post("/api/images/generate", json={"prompt": "a cup", "brand_kit_id": plain["id"]})
    run_jobs()
    with SessionLocal() as db:
        assert db.query(Job).filter(Job.type == br.BRAND_JOB).count() == 1


def test_logo_reveal_endpoint_makes_a_video(client):
    kit = make_kit(client)
    r = client.post(f"/api/brand-kits/{kit['id']}/logo-reveal", json={"duration_s": 2, "aspect": "1:1"})
    assert r.status_code == 202, r.text
    item = r.json()["item"]
    assert item["kind"] == "video" and r.json()["job"]["type"] == "brand_reveal"
    run_jobs()
    got = client.get(f"/api/media/{item['id']}").json()
    assert got["status"] == "ready" and (got["width"], got["height"]) == (1080, 1080)
    with SessionLocal() as db:
        path = get_settings().data_dir / db.get(Generation, got["generation_id"]).file_path
    m = media_frame(path)
    assert abs(m["duration"] - 2.0) < 0.1 and m["has_audio"] and m["size"] == (1080, 1080)

    no_logo = client.post("/api/brand-kits", json={"name": "Text only"}).json()
    assert client.post(f"/api/brand-kits/{no_logo['id']}/logo-reveal", json={}).status_code == 422


def test_reveal_frames_are_deterministic(tmp_path):
    logo = tmp_path / "l.png"
    Image.new("RGBA", (120, 60), (240, 240, 240, 255)).save(logo)
    assets = rnd.KitAssets(name="Leaf", tagline="Fresh", logo=logo, palette=[{"hex": "#0F4C5C"}])
    bg = rnd.reveal_background((160, 90), assets)
    a = [f.tobytes() for f in rnd.reveal_frames((160, 90), assets, 1.5, 12, bg, True)]
    b = [f.tobytes() for f in rnd.reveal_frames((160, 90), assets, 1.5, 12, bg, True)]
    assert len(a) == 18 and a == b and a[0] != a[-1]


def test_project_brand_kit_setting(client, project):
    kit = make_kit(client)
    r = client.put(f"/api/projects/{project['id']}/brand-kit", json={"kit_id": kit["id"]})
    assert r.json() == {"project_id": project["id"], "brand_kit_id": kit["id"]}
    assert client.get(f"/api/projects/{project['id']}").json()["settings"]["brand_kit_id"] == kit["id"]
    assert client.put(f"/api/projects/{project['id']}/brand-kit", json={"kit_id": "x"}).status_code == 404
    assert client.put(f"/api/projects/{project['id']}/brand-kit", json={}).json()["brand_kit_id"] is None


def test_auto_brand_for_stitched_film_follows_project_kit(client, project, tmp_path, source_video):
    kit = make_kit(client, settings={"end_card": {"enabled": True}})
    client.put(f"/api/projects/{project['id']}/brand-kit", json={"kit_id": kit["id"]})
    with SessionLocal() as db:
        rel = f"workspaces/x/projects/{project['id']}/generations/film.mp4"
        dest = get_settings().data_dir / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(source_video.read_bytes())
        p = db.get(Project, project["id"])
        render = Generation(workspace_id=p.workspace_id, project_id=p.id, target_type="project", target_id=p.id,
                            kind="render", version=1, status="ready", prompt="", seed=0, file_path=rel,
                            media_type="video/mp4", params={"title": "Full film", "autopilot": "ap1"})
        db.add(render)
        db.flush()
        ap = Job(id="ap1", workspace_id=p.workspace_id, type="autopilot", project_id=p.id, status="done",
                 payload={"upscale": None}, result={"final_render_id": render.id})
        stitch = Job(workspace_id=p.workspace_id, type="reel_assemble", project_id=p.id, status="done",
                     generation_id=render.id)
        db.add_all([ap, stitch])
        db.commit()
        br.on_job_finished(db, stitch)
        db.commit()
        render_id = render.id
    run_jobs()
    with SessionLocal() as db:
        branded = db.query(Generation).filter(Generation.parent_id == render_id).one()
        assert branded.kind == "render" and branded.version == 2 and branded.status == "ready"
        assert branded.params["title"] == "Full film" and abs(branded.params["duration_s"] - 4.5) < 0.05
        assert db.get(Job, "ap1").result["final_render_id"] == branded.id
        assert db.get(Job, "ap1").result["clean_render_id"] == render_id
