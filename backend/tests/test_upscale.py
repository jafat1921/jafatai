import json
import subprocess
from pathlib import Path

import pytest

from app import longtake as lt
from app import reel as rl
from app import upscale as up
from app import worker
from app.config import get_settings
from app.db import SessionLocal
from app.drivers import comfy_client
from app.drivers.comfy import plan_generation
from app.drivers.mock import MockDriver
from app.models import Generation, Job, Project, new_id, utcnow
from app.workflows import build, check_template

FIXTURE = Path(__file__).parent / "fixtures" / "comfy_object_info.json"


@pytest.fixture(scope="session")
def film(tmp_path_factory) -> Path:
    """6 s, 24 fps, 320x180 with a tone and two chapters: stands in for a stitched render."""
    d = tmp_path_factory.mktemp("upscale")
    meta = d / "chapters.txt"
    meta.write_text(";FFMETADATA1\ntitle=Test\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=3000\ntitle=One\n"
                    "[CHAPTER]\nTIMEBASE=1/1000\nSTART=3000\nEND=6000\ntitle=Two\n", encoding="utf-8")
    out = d / "film.mp4"
    rl.run_ff(["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=6",
               "-f", "lavfi", "-i", "sine=frequency=330:duration=6:sample_rate=48000",
               "-f", "ffmetadata", "-i", str(meta), "-map", "0:v", "-map", "1:a", "-map_chapters", "2",
               "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", str(out)])
    return out


@pytest.fixture
def small_segments(monkeypatch):
    s = get_settings()
    monkeypatch.setattr(s, "upscale_segment_s", 2.0)
    monkeypatch.setattr(s, "upscale_overlap_s", 0.5)


def _source(project_id: str, clip: Path, size=(320, 180)) -> str:
    with SessionLocal() as db:
        p = db.get(Project, project_id)
        g = Generation(id=new_id(), workspace_id=p.workspace_id, project_id=p.id, target_type="project",
                       target_id=p.id, kind="render", version=1, status="ready", prompt="Reef · Full film",
                       seed=1, media_type="video/mp4",
                       params={"title": "Full film", "scene_ids": ["s1", "s2"], "scene_range": "Scenes 1–2",
                               "full": True, "duration_s": 6.0, "size": list(size)})
        rel = f"workspaces/{p.workspace_id}/projects/{p.id}/generations/{g.id}.mp4"
        dst = get_settings().data_dir / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_bytes(clip.read_bytes())
        g.file_path = rel
        db.add(g)
        db.commit()
        return g.id


def audio_md5(path: Path) -> str:
    r = subprocess.run([get_settings().ffmpeg_path(), "-hide_banner", "-loglevel", "error", "-i", str(path),
                        "-map", "0:a", "-c", "copy", "-f", "md5", "-"], capture_output=True, text=True, check=True)
    return r.stdout.strip()


class SegDriver(MockDriver):
    def __init__(self, stop_at=None, cancel_at=None, job_id=None):
        super().__init__(step_seconds=0, steps=1)
        self.calls: list[dict] = []
        self.stop_at, self.cancel_at, self.job_id = stop_at, cancel_at, job_id

    def generate_video(self, prompt, params, seed, out_path, progress_cb):
        idx = params.get("segment_idx")
        if idx == self.stop_at:
            worker._stop.set()
        if idx == self.cancel_at:
            with SessionLocal() as db:
                db.get(Job, self.job_id).status = "cancelled"
                db.commit()
        self.calls.append({k: params.get(k) for k in ("segment_idx", "template", "width", "height", "scale", "model")})
        return super().generate_video(prompt, params, seed, out_path, progress_cb)


# ------------------------------------------------------------------ planning and sizes

@pytest.mark.parametrize("frames,fps,seg,ov", [(240, 24, 4, 0.5), (1441, 24, 4, 0.5), (50, 24, 4, 0.5),
                                               (97, 24, 4, 0.5), (86400, 24, 4, 0.5), (300, 25, 3, 1)])
def test_segment_plan_math(frames, fps, seg, ov):
    plan = up.plan_segments(frames, fps, seg, ov)
    k = up.overlap_frames(plan)
    assert plan[0]["start_frame"] == 0
    assert plan[-1]["start_frame"] + plan[-1]["frames"] == frames
    for a, b in zip(plan, plan[1:]):
        assert b["start_frame"] == a["start_frame"] + a["frames"] - k  # same overlap at every join
    assert max(s["frames"] for s in plan) <= round(seg * fps)
    if len(plan) > 1:
        # the overlap is capped so a body survives both of its ends being shared
        assert k == min(round(ov * fps), (round(seg * fps) - 1) // 3)
        # spread evenly: no stub at the end
        assert max(s["frames"] for s in plan) - min(s["frames"] for s in plan) <= 1
        assert all(s["frames"] > 2 * k for s in plan)
    assert sum(s["frames"] for s in plan) - k * (len(plan) - 1) == frames


@pytest.mark.parametrize("src,target,box", [
    ((768, 448), "1080p", (1920, 1080)), ((448, 768), "1080p", (1080, 1920)), ((640, 640), "1440p", (2560, 1440)),
    ((832, 480), "4k", (3840, 2160)), ((960, 416), "1080p", (1920, 1080)), ((768, 448), "4k", (3840, 2160)),
])
@pytest.mark.parametrize("engine", ["best", "fast", "quick"])
def test_output_dims_fit_the_box(src, target, box, engine):
    sp = up.size_plan(up.ENGINES[engine], *src, target)
    assert sp.width % 2 == 0 and sp.height % 2 == 0
    assert sp.width <= box[0] and sp.height <= box[1]
    assert sp.width >= box[0] - 2 or sp.height >= box[1] - 2  # touches the box on one side
    assert abs(sp.width / sp.height - src[0] / src[1]) < 0.01
    assert sp.engine_width % 2 == 0 and sp.engine_height % 2 == 0
    assert sp.scale <= up.ENGINES[engine].max_scale
    if engine == "fast":
        assert sp.scale in (2, 4)


def test_scale_choices():
    fast, best = up.ENGINES["fast"], up.ENGINES["best"]
    sp = up.size_plan(fast, 768, 448, "1080p")  # needs x2.41: x2 plus a small lanczos nudge
    assert sp.scale == 2 and (sp.engine_width, sp.engine_height) == (1536, 896) and (sp.width, sp.height) == (1850, 1080)
    assert up.size_plan(fast, 640, 360, "1440p").scale == 4  # x4 exactly
    sp = up.size_plan(best, 768, 448, "4k")  # x4.82 is past SeedVR2's cap
    assert sp.scale == 4 and (sp.engine_width, sp.engine_height) == (3072, 1792) and sp.height == 2160
    sp = up.size_plan(best, 768, 448, "1080p")
    assert (sp.engine_width, sp.engine_height) == (sp.width, sp.height)  # straight to the final size
    with pytest.raises(up.UpscaleError):
        up.size_plan(best, 1920, 1080, "1080p")


def test_templates_valid_and_driver_plans(tmp_path):
    info = json.loads(FIXTURE.read_text(encoding="utf-8"))
    clip = tmp_path / "seg.mp4"
    clip.write_bytes(b"x")
    for eid, e in up.ENGINES.items():
        assert check_template(e.template, info)["ok"], e.template
        plan = plan_generation("upscale_segment", "", {"template": e.template, "video_path": str(clip), "width": 1850,
                                                      "height": 1080, "fps": 24.0, "scale": 2}, 7, None)
        graph, resolved = build(plan.template, {**plan.inputs, "video": "mixai/seg.mp4"})
        assert plan.media == "video" and plan.images == {"video": clip}
        assert any(n["class_type"] == "VHS_LoadVideo" and n["inputs"]["video"] == "mixai/seg.mp4" for n in graph.values())
    graph, _ = build("upscale_seedvr2", {"video": "v.mp4", "width": 1850, "height": 1080,
                                         "model": "seedvr2_7b_int8_convrot.safetensors"})
    by_title = {n["_meta"]["title"]: n for n in graph.values()}
    assert by_title["Resize"]["inputs"]["width"] == 1850 and by_title["Model"]["inputs"]["unet_name"].startswith("seedvr2_7b")
    # chunks go through conditioning and the sampler, then merge with the overlap the split reports
    assert by_title["Merge"]["inputs"]["temporal_overlap"][1] == 1
    assert by_title["Post"]["inputs"]["color_correction_method"] == "lab"


# ------------------------------------------------------------------ options

def _fake_comfy(monkeypatch, info):
    class Fake:
        base_url = "http://comfy.test"

        async def object_info(self):
            return info

        async def close(self):
            pass

    async def fake_pick(*a, **k):
        return Fake()

    monkeypatch.setattr(comfy_client, "pick_client", fake_pick)
    monkeypatch.setattr(get_settings(), "gen_driver", "comfy")
    up._INFO_CACHE.update(at=0.0, info=None)


def test_options_availability_from_object_info(client, project, film, monkeypatch):
    info = json.loads(FIXTURE.read_text(encoding="utf-8"))
    del info["AILab_FlashVSR_Advanced"]
    unet = info["UNETLoader"]["input"]["required"]["unet_name"][0]
    unet.remove("seedvr2_7b_int8_convrot.safetensors")
    _fake_comfy(monkeypatch, info)
    body = client.get("/api/system/upscale-options").json()
    eng = {e["id"]: e for e in body["engines"]}
    assert eng["best"]["available"] and eng["best"]["variants"] == ["3b"]
    assert not eng["fast"]["available"] and "AILab_FlashVSR_Advanced" in eng["fast"]["reason"]
    assert eng["quick"]["available"] and eng["quick"]["est_gpu_s_per_output_s"] > 0
    assert eng["best"]["estimate_source"] == "provisional"
    assert body["default_engine"] == "best" and [t["id"] for t in body["targets"]] == ["1080p", "1440p", "4k"]

    # queueing an engine the server just said it lacks is refused up front
    src = _source(project["id"], film)
    r = client.post(f"/api/generations/{src}/upscale", json={"engine": "fast", "target": "1080p"})
    assert r.status_code == 422 and "FlashVSR" in r.text

    # SeedVR2 gone: the default falls back to something that runs
    for cls in [k for k in info if k.startswith("SeedVR2")]:
        del info[cls]
    up._INFO_CACHE.update(at=0.0, info=None)
    body = client.get(f"/api/system/upscale-options?generation_id={src}").json()
    assert body["default_engine"] == "quick"
    assert body["source"] == {"width": 320, "height": 180, "duration_s": 6.0}
    est = body["estimates"]["quick"]["1080p"]
    assert est["allowed"] and (est["width"], est["height"]) == (1920, 1080) and est["est_gpu_s"] > 0


def test_options_when_comfy_unreachable(client, monkeypatch):
    monkeypatch.setattr(get_settings(), "gen_driver", "comfy")
    up._INFO_CACHE.update(at=0.0, info=None)
    body = client.get("/api/system/upscale-options").json()  # conftest leaves COMFY_URLS empty
    assert not any(e["available"] for e in body["engines"])
    assert "isn't reachable" in body["engines"][0]["reason"]


# ------------------------------------------------------------------ the pipeline

def test_upscale_end_to_end_resume_and_audio(client, project, film, small_segments):
    src_id = _source(project["id"], film)
    r = client.post(f"/api/generations/{src_id}/upscale", json={"engine": "quick", "target": "1080p"})
    assert r.status_code == 202, r.text
    job_id = r.json()["id"]
    # same request again while it's queued: same job
    assert client.post(f"/api/generations/{src_id}/upscale", json={"engine": "quick", "target": "1080p"}).json()["id"] == job_id

    first = SegDriver(stop_at=1)
    try:
        worker.process_one(driver_factory=lambda: first)
    finally:
        worker._stop.clear()
    with SessionLocal() as db:
        job = db.get(Job, job_id)
        gen = db.get(Generation, job.generation_id)
        segs = gen.params["segments"]
        assert job.status == "queued" and len(segs) == 4  # 144 frames, 48 per segment, 12 shared
        assert [s["status"] for s in segs] == ["done", "pending", "pending", "pending"]
        assert (get_settings().data_dir / segs[0]["file"]).is_file()
        assert gen.parent_id == src_id and gen.params["title"] == "Full film · 1080p"
        assert gen.params["scene_ids"] == ["s1", "s2"] and gen.params["scene_range"] == "Scenes 1–2"
    assert [c["segment_idx"] for c in first.calls] == [0, 1]

    second = SegDriver()
    worker.process_one(driver_factory=lambda: second)
    assert [c["segment_idx"] for c in second.calls] == [1, 2, 3]  # resumed, segment 0 not redone
    # 320x180 needs x6; RealESRGAN stops at x4 and ffmpeg does the rest
    assert {(c["width"], c["height"], c["template"]) for c in second.calls} == {(1280, 720, "upscale_esrgan")}

    with SessionLocal() as db:
        job = db.get(Job, job_id)
        gen = db.get(Generation, job.generation_id)
        assert job.status == "done", job.error
        assert gen.status == "ready" and gen.kind == "render" and gen.params["size"] == [1920, 1080]
        assert gen.params["upscale_stats"]["segments"] == 4
        assert all("file" not in s for s in gen.params["segments"])
        out = get_settings().data_dir / gen.file_path
        seg_folder, _ = up.seg_dir(gen)
    p = rl.probe(out)
    assert (p.width, p.height) == (1920, 1080)
    assert lt.count_frames(out) == lt.count_frames(film) == 144
    assert audio_md5(out) == audio_md5(film)  # audio packets copied bit for bit
    assert len(p.chapters) == 2
    assert not seg_folder.exists()

    renders = client.get(f"/api/projects/{project['id']}/renders").json()
    mine = next(x for x in renders if x["id"] == gen.id)
    assert mine["title"] == "Full film · 1080p" and mine["media_url"] and mine["parent_id"] == src_id


def test_upscale_seedvr2_portrait_and_variant(client, project, tmp_path, small_segments):
    clip = tmp_path / "tall.mp4"
    rl.run_ff(["-f", "lavfi", "-i", "testsrc2=size=224x384:rate=24:duration=1.5", "-c:v", "libx264",
               "-preset", "ultrafast", "-pix_fmt", "yuv420p", str(clip)])
    src_id = _source(project["id"], clip, size=(224, 384))
    r = client.post(f"/api/generations/{src_id}/upscale", json={"engine": "seedvr2", "target": "1080p", "variant": "7b"})
    assert r.status_code == 202, r.text
    drv = SegDriver()
    worker.process_one(driver_factory=lambda: drv)
    assert drv.calls[0]["model"] == "seedvr2_7b_int8_convrot.safetensors"
    with SessionLocal() as db:
        gen = db.get(Generation, db.get(Job, r.json()["id"]).generation_id)
        assert gen.status == "ready", db.get(Job, r.json()["id"]).error
        assert gen.params["upscale"]["engine"] == "best" and gen.params["upscale"]["variant"] == "7b"
        out = get_settings().data_dir / gen.file_path
    p = rl.probe(out)
    assert p.width <= 1080 and p.height <= 1920 and (p.width, p.height) == (gen.params["size"][0], gen.params["size"][1])
    assert not p.has_audio  # silent source stays silent
    assert lt.count_frames(out) == 36


def test_upscale_cancel_keeps_finished_segments(client, project, film, small_segments):
    src_id = _source(project["id"], film)
    job_id = client.post(f"/api/generations/{src_id}/upscale", json={"engine": "fast", "target": "1440p"}).json()["id"]
    drv = SegDriver(cancel_at=2, job_id=job_id)
    worker.process_one(driver_factory=lambda: drv)
    with SessionLocal() as db:
        job = db.get(Job, job_id)
        gen = db.get(Generation, job.generation_id)
        assert job.status == "cancelled" and gen.status == "failed"
        assert [s["status"] for s in gen.params["segments"]] == ["done", "done", "pending", "pending"]
        assert drv.calls[0]["scale"] == 4  # 320x180 to 1440p needs x8: FlashVSR's x4, then lanczos
    assert not list(Path(get_settings().data_dir).rglob("*_in_*.mp4"))  # no stray input clips left


def test_upscale_rejects(client, project, film):
    src_id = _source(project["id"], film, size=(1920, 1080))
    r = client.post(f"/api/generations/{src_id}/upscale", json={"target": "1080p"})
    assert r.status_code == 422 and "already" in r.text
    with SessionLocal() as db:
        g = db.get(Generation, src_id)
        g.kind = "take"
        db.commit()
    r = client.post(f"/api/generations/{src_id}/upscale", json={"target": "4k"})
    assert r.status_code == 422 and "stitched" in r.text
