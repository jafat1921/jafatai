"""Upscale engine benchmark, run ON THE GPU SERVER against COMFY_URLS.

    cd backend && uv run python ../scripts/bench_upscale.py [--input film.mp4] [--seconds 10]
        [--engines seedvr2,flashvsr,esrgan] [--scale 2] [--warm] [--allow-download]

Without --input it takes the newest finished stitched render (or take) under DATA_DIR that is at
least --seconds long. A sample is cut from the middle, each engine upscales it through the same
templates the app uses, and DATA_DIR/bench/upscale-<timestamp>/ gets one mp4 per engine, side-by-side
PNGs (source vs every engine at the same timestamps, centre crops at output resolution) and
report.md. The markdown table is printed at the end: paste it back to the team.

The box is shared production: one engine at a time, Ctrl+C cancels the running prompt.
Engines: seedvr2 (3B), seedvr2-7b, flashvsr, esrgan.
"""
import argparse
import asyncio
import json
import re
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

from PIL import Image, ImageDraw, ImageFilter, ImageStat  # noqa: E402

from app import longtake as lt  # noqa: E402
from app import reel as rl  # noqa: E402
from app import upscale as up  # noqa: E402
from app.config import get_settings  # noqa: E402
from app.drivers.comfy import exec_seconds  # noqa: E402
from app.drivers.comfy_client import ComfyError, parse_outputs, pick_client  # noqa: E402
from app.workflows import build, load  # noqa: E402

ENGINES = {
    "seedvr2": ("upscale_seedvr2", {"model": "seedvr2_3b_int8_convrot.safetensors"}),
    "seedvr2-7b": ("upscale_seedvr2", {"model": "seedvr2_7b_int8_convrot.safetensors"}),
    "flashvsr": ("upscale_flashvsr", {}),
    "esrgan": ("upscale_esrgan", {}),
}
CROP = 512  # px of output resolution per crop in the comparison sheets


def ffmpeg(*args: str, timeout: float = 900) -> str:
    cmd = [get_settings().ffmpeg_path(), "-hide_banner", "-nostdin", "-y", *args]
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)
    if r.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {r.stderr[-500:]}")
    return r.stderr


def newest_source(min_s: float) -> Path:
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import Generation
    from app.services import generation_file

    with SessionLocal() as db:
        for kind in ("render", "take"):
            rows = db.scalars(select(Generation).where(
                Generation.kind == kind, Generation.status.in_(("ready", "approved")),
                Generation.file_path.is_not(None)).order_by(Generation.created_at.desc()).limit(50)).all()
            for g in rows:
                p = generation_file(g)
                if p and p.is_file() and rl.probe(p).duration >= min_s - 0.05:
                    print(f"source: {kind} {g.id} ({p})")
                    return p
    raise SystemExit(f"no finished render or take of at least {min_s:g}s under {get_settings().data_dir}; pass --input")


# ---------------------------------------------------------------- FlashVSR weights

def comfy_root(models_info: list) -> Path | None:
    for item in models_info or []:
        for folder in item.get("folders", []):
            parts = Path(folder).parts
            if "models" in parts:
                return Path(*parts[:parts.index("models")])
    return None


def flashvsr_weights(root: Path | None) -> dict:
    """Look for the FlashVSR node pack's weights on this machine and for where it would fetch them."""
    out = {"root": str(root) if root else None, "found": [], "repos": [], "node_dir": None}
    if root is None or not root.is_dir():
        out["note"] = "ComfyUI folder isn't on this machine (run the script on the GPU server)"
        return out
    node = next((p for p in (root / "custom_nodes").glob("*FlashVSR*") if p.is_dir()), None)
    out["node_dir"] = str(node) if node else None
    exts = {".safetensors", ".pth", ".ckpt", ".bin", ".pt"}
    places = [p for p in (root / "models").glob("*") if "flashvsr" in p.name.lower()]
    if node:
        places.append(node)
    for place in places:
        for f in place.rglob("*"):
            if f.suffix.lower() in exts and f.stat().st_size > 1_000_000:
                out["found"].append(f"{f} ({f.stat().st_size / 1e9:.2f} GB)")
    if node:
        pat = re.compile(r"""["']([\w.-]+/[\w.-]*FlashVSR[\w.-]*)["']""", re.I)
        for py in node.rglob("*.py"):
            try:
                out["repos"] += pat.findall(py.read_text(encoding="utf-8", errors="ignore"))
            except OSError:
                pass
        out["repos"] = sorted(set(out["repos"]))
    return out


# ---------------------------------------------------------------- measuring

async def vram_watch(client, state: dict, stop: asyncio.Event) -> None:
    while not stop.is_set():
        try:
            r = await client._http.get("/system_stats", timeout=5.0)
            dev = (r.json().get("devices") or [{}])[0]
            state["total"] = dev.get("vram_total") or state.get("total")
            free = dev.get("vram_free")
            if free is not None:
                state["min_free"] = min(state.get("min_free", free), free)
        except Exception:
            pass
        try:
            await asyncio.wait_for(stop.wait(), 1.0)
        except asyncio.TimeoutError:
            pass


async def run_engine(client, name: str, clip_name: str, src: up.Source, scale: int, outdir: Path,
                     stall_s: float) -> dict:
    template, extra = ENGINES[name]
    w, h = up._even(src.width * scale), up._even(src.height * scale)
    inputs = {"video": clip_name, "width": w, "height": h, "fps": src.fps, "scale": scale, "seed": 1,
              "filename_prefix": f"mixai/bench_up_{name}", **extra}
    graph, _ = build(template, inputs)
    tpl = load(template)
    weights = {tpl.node_id(t): v for t, v in tpl.manifest.get("progress_weights", {}).items()}

    vram: dict = {}
    stop = asyncio.Event()
    watcher = asyncio.create_task(vram_watch(client, vram, stop))
    last = {"t": time.monotonic(), "msg": ""}
    t0 = time.monotonic()

    def on_progress(frac, msg):
        if msg != last["msg"]:
            last.update(t=time.monotonic(), msg=msg)
        elif time.monotonic() - last["t"] > stall_s:
            raise ComfyError(f"no progress for {stall_s:.0f}s at '{msg}' (downloading weights? see the FlashVSR note)")
        print(f"\r  {name}: {frac:4.0%} {msg[:44]:<44} {time.monotonic() - t0:6.0f}s", end="", flush=True)

    row = {"engine": name, "template": template, "scale": scale, "out": f"{w}x{h}"}
    try:
        _, entry = await client.run(graph, on_progress, timeout=3600, weights=weights)
    except Exception as e:
        print()
        row.update(status="failed", error=str(e)[:300])
        return row
    finally:
        stop.set()
        await watcher
    print()
    wall = time.monotonic() - t0
    outs = [o for o in parse_outputs(entry) if o.kind == "video"]
    if not outs:
        row.update(status="failed", error="no video output")
        return row
    dest = outdir / f"{name}.mp4"
    await client.download(outs[0], dest)
    gpu = exec_seconds(entry) or wall
    out_s = src.frames / src.fps
    p = rl.probe(dest)
    frames = lt.count_frames(dest)
    row.update(status="ok", file=str(dest), gpu_s=round(gpu, 1), wall_s=round(wall, 1),
               gpu_per_out_s=round(gpu / out_s, 2), rate_mp=round(gpu / out_s / (p.width * p.height / 1e6), 2),
               out=f"{p.width}x{p.height}", frames=frames, frames_ok=frames == src.frames)
    if vram.get("total") and vram.get("min_free") is not None:
        row["peak_vram_gb"] = round((vram["total"] - vram["min_free"]) / 1e9, 1)
    return row


def gray_frames(path: Path, size: tuple[int, int], crop: tuple[int, int, int, int] | None, count: int) -> list[bytes]:
    w, h = size
    vf = f"scale={w}:{h}:flags=lanczos"
    if crop:
        vf += f",crop={crop[2]}:{crop[3]}:{crop[0]}:{crop[1]}"
    cw, ch = (crop[2], crop[3]) if crop else (w, h)
    raw = subprocess.run([get_settings().ffmpeg_path(), "-hide_banner", "-loglevel", "error", "-i", str(path),
                          "-vf", vf + ",format=gray", "-frames:v", str(count), "-f", "rawvideo", "-"],
                         capture_output=True, timeout=900, check=True).stdout
    n = cw * ch
    return [raw[i:i + n] for i in range(0, len(raw) - n + 1, n)]


def metrics(path: Path, ref: Path, size: tuple[int, int], frames: int) -> dict:
    """Sharpness (high-frequency energy) and flicker (mean frame-to-frame change) on a centre crop,
    each as a ratio to the lanczos-upscaled source. Flicker well above 1.0 = shimmer the source hasn't got."""
    w, h = size
    cw, ch = min(CROP, w), min(CROP, h)
    crop = ((w - cw) // 2 // 2 * 2, (h - ch) // 2 // 2 * 2, cw, ch)
    n = min(frames, 120)

    def stats(p):
        fr = gray_frames(p, size, crop, n)
        sharp = []
        for raw in fr[:: max(1, len(fr) // 12)]:
            im = Image.frombytes("L", (cw, ch), raw)
            hf = Image.frombytes("L", (cw, ch), bytes(abs(a - b) for a, b in zip(raw, im.filter(ImageFilter.GaussianBlur(1.5)).tobytes())))
            sharp.append(ImageStat.Stat(hf).mean[0])
        step = 7  # sample pixels; plenty for a mean
        flick = [sum(abs(a[i] - b[i]) for i in range(0, len(a), step)) / (len(a) / step) for a, b in zip(fr, fr[1:])]
        return sum(sharp) / len(sharp), (sum(flick) / len(flick) if flick else 0.0)

    s_sharp, s_flick = stats(ref)
    e_sharp, e_flick = stats(path)
    return {"sharpness_x": round(e_sharp / s_sharp, 2) if s_sharp else None,
            "flicker_x": round(e_flick / s_flick, 2) if s_flick else None}


def sheets(src_clip: Path, rows: list[dict], size: tuple[int, int], duration: float, outdir: Path) -> list[str]:
    w, h = size
    ok = [r for r in rows if r.get("status") == "ok"]
    made = []
    for frac in (0.25, 0.5, 0.75):
        t = duration * frac
        panels = [("source (lanczos)", src_clip)] + [(r["engine"], Path(r["file"])) for r in ok]
        crops, fulls = [], []
        for label, p in panels:
            png = outdir / f"_f_{label.split()[0]}_{int(frac * 100)}.png"
            ffmpeg("-ss", f"{t:.3f}", "-i", str(p), "-frames:v", "1", "-vf", f"scale={w}:{h}:flags=lanczos", str(png))
            im = Image.open(png).convert("RGB")
            png.unlink(missing_ok=True)
            cw, ch = min(CROP, w), min(CROP, h)
            box = ((w - cw) // 2, (h - ch) // 2, (w - cw) // 2 + cw, (h - ch) // 2 + ch)
            crops.append((label, im.crop(box)))
            fulls.append((label, im.resize((w // 3, h // 3), Image.LANCZOS)))
        for kind, items in (("crop", crops), ("full", fulls)):
            pw, ph = items[0][1].size
            sheet = Image.new("RGB", (pw * len(items), ph + 28), (16, 16, 16))
            d = ImageDraw.Draw(sheet)
            for i, (label, im) in enumerate(items):
                sheet.paste(im, (i * pw, 28))
                d.text((i * pw + 8, 8), f"{label} @ {t:.2f}s", fill=(235, 220, 180))
            dest = outdir / f"compare_{kind}_{int(frac * 100)}.png"
            sheet.save(dest)
            made.append(str(dest))
    return made


def table(rows: list[dict], src: up.Source, seconds: float, server: str) -> str:
    lines = [f"Upscale benchmark · {server} · source {src.width}x{src.height} @ {src.fps:g} fps, {seconds:g} s "
             f"({src.frames} frames) · {datetime.now():%Y-%m-%d %H:%M}", "",
             "| engine | status | out | frames ok | GPU s | GPU s / out s | GPU s / out s / MP | peak VRAM GB | sharpness x | flicker x |",
             "|---|---|---|---|---|---|---|---|---|---|"]
    for r in rows:
        if r.get("status") != "ok":
            lines.append(f"| {r['engine']} | {r.get('status')}: {r.get('error', '')[:80]} | {r.get('out', '')} | | | | | | | |")
            continue
        lines.append(f"| {r['engine']} | ok{' (warm)' if r.get('warm') else ''} | {r['out']} | {'yes' if r['frames_ok'] else 'NO ' + str(r['frames'])} "
                     f"| {r['gpu_s']} | {r['gpu_per_out_s']} | {r['rate_mp']} | {r.get('peak_vram_gb', '?')} "
                     f"| {r.get('sharpness_x', '?')} | {r.get('flicker_x', '?')} |")
    lines += ["", "sharpness x / flicker x: centre crop vs the lanczos-upscaled source (1.0 = same). "
              "Flicker clearly above the source's means shimmer. Peak VRAM includes whatever else ComfyUI keeps loaded."]
    return "\n".join(lines)


async def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--input", type=Path)
    ap.add_argument("--seconds", type=float, default=10.0)
    ap.add_argument("--engines", default="seedvr2,flashvsr,esrgan")
    ap.add_argument("--scale", type=int, default=2, choices=(2, 4))
    ap.add_argument("--warm", action="store_true", help="run each engine twice and report the second (model already loaded)")
    ap.add_argument("--allow-download", action="store_true",
                    help="run FlashVSR even when its weights aren't on disk yet (the node pack downloads them)")
    ap.add_argument("--stall", type=float, default=600.0, help="give up on an engine after this many seconds without progress")
    args = ap.parse_args()
    names = [n.strip().lower() for n in args.engines.split(",") if n.strip()]
    bad = [n for n in names if n not in ENGINES]
    if bad:
        raise SystemExit(f"unknown engine(s) {bad}; pick from {', '.join(ENGINES)}")

    s = get_settings()
    source = args.input or newest_source(args.seconds)
    full = up.probe_source(source)
    start = max(0.0, (full.frames / full.fps - args.seconds) / 2)
    outdir = s.data_dir / "bench" / f"upscale-{datetime.now():%Y%m%d-%H%M%S}"
    outdir.mkdir(parents=True, exist_ok=True)
    clip = outdir / f"bench_src_{outdir.name}.mp4"
    ffmpeg("-ss", f"{start:.3f}", "-i", str(source), "-t", f"{args.seconds:.3f}", "-map", "0:v:0", "-an",
           "-c:v", "libx264", "-preset", "veryfast", "-crf", "8", "-pix_fmt", "yuv420p", str(clip))
    src = up.probe_source(clip)
    print(f"sample: {clip} ({src.width}x{src.height}, {src.frames} frames from {start:.1f}s of {source.name})")

    client = await pick_client(s.comfy_urls, s.comfy_auth_token, s.comfy_verify_tls)
    rows: list[dict] = []
    try:
        q = await client.queue_state()
        busy = len(q.get("queue_running", [])) + len(q.get("queue_pending", []))
        if busy:
            print(f"note: ComfyUI already has {busy} prompt(s) queued/running; ours wait behind them (GPU s stays exact)")
        fv = None
        if "flashvsr" in names:
            try:
                models_info = (await client._http.get("/experiment/models")).json()
            except Exception:
                models_info = []
            fv = flashvsr_weights(comfy_root(models_info))
            if fv["found"]:
                print("FlashVSR weights on disk:\n  " + "\n  ".join(fv["found"]))
            else:
                print("FlashVSR: no weights found on disk " + (f"(looked under {fv['root']}/models and {fv['node_dir']})" if fv["root"] else f"({fv.get('note')})"))
                if fv["repos"]:
                    print("  the node pack names these Hugging Face repos: " + ", ".join(fv["repos"]))
                print("  it downloads them on its first run. Either re-run with --allow-download (one long first run), or "
                      "pre-fetch: uv tool run --from huggingface_hub huggingface-cli download <repo> --local-dir <the folder the node reads>")
                if not args.allow_download:
                    names = [n for n in names if n != "flashvsr"]
                    rows.append({"engine": "flashvsr", "status": "skipped", "error": "weights not on disk; see note above (--allow-download)"})
        clip_name = await client.upload_image(clip)
        for name in names:
            print(f"{name}:")
            stall = max(args.stall, 1800.0) if name == "flashvsr" and args.allow_download else args.stall
            row = await run_engine(client, name, clip_name, src, args.scale, outdir, stall)
            if args.warm and row.get("status") == "ok":
                row = await run_engine(client, name, clip_name, src, args.scale, outdir, stall)
                row["warm"] = True
            rows.append(row)
    finally:
        await client.close()

    ok = [r for r in rows if r.get("status") == "ok"]
    size = (up._even(src.width * args.scale), up._even(src.height * args.scale))
    ref = outdir / "source_lanczos.mp4"
    ffmpeg("-i", str(clip), "-vf", f"scale={size[0]}:{size[1]}:flags=lanczos", "-c:v", "libx264", "-crf", "12",
           "-pix_fmt", "yuv420p", str(ref))
    for r in ok:
        try:
            r.update(metrics(Path(r["file"]), ref, size, src.frames))
        except Exception as e:  # metrics are a nice-to-have; the timings still count
            print(f"metrics for {r['engine']} failed: {e}")
    pngs = sheets(ref, rows, size, src.frames / src.fps, outdir) if ok else []

    md = table(rows, src, args.seconds, s.comfy_urls[0] if s.comfy_urls else "?")
    if fv is not None:
        md += "\n\nFlashVSR weights: " + ("; ".join(fv["found"]) or "not found on disk") + \
              (f" (repos named by the node: {', '.join(fv['repos'])})" if fv["repos"] else "")
    (outdir / "report.md").write_text(md + "\n", encoding="utf-8")
    (outdir / "rows.json").write_text(json.dumps(rows, indent=1), encoding="utf-8")
    print("\n" + md + "\n")
    print("files:")
    for p in [str(outdir / "report.md")] + [r["file"] for r in ok] + pngs:
        print("  " + p)
    return 0 if ok else 1


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except KeyboardInterrupt:
        print("\ncancelled (the running prompt was interrupted on ComfyUI)")
        sys.exit(130)
