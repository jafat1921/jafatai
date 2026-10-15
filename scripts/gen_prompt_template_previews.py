"""Render one preview picture per prompt template (or per style) and ship it with the app.

    cd backend && uv run python ../scripts/gen_prompt_template_previews.py --comfy https://<image-gpu> \
        [--only id,id] [--force] [--seed N] [--dry-run]
    cd backend && uv run python ../scripts/gen_prompt_template_previews.py --comfy https://<image-gpu> --styles \
        [--only oil,anime] [--force] [--dry-run]

Each scaffold is filled with the template's own `examples`, styled the way the app styles it, and run
through the same graph builder the worker uses (Z-Image Turbo; Qwen-Image 2512 Lightning when the
template asks for Qwen because it renders text). Video templates get a still "poster" at the video
aspect from their `preview_prompt`; so do image edit templates, which have no picture of their own
to edit, so their card shows a typical result instead. Brand cards (contract v35) render their `preview_prompt`
on Qwen-Image 2512 with a made-up placeholder brand ("YOUR BRAND", slate and apricot), so no real logo is
needed and no customer's mark ends up in the shipped previews. Results land in backend/app/templates/previews/<id>.webp
(long side 640). Existing previews are kept unless --force.

The GPU is shared with live users: before each prompt we wait (up to --wait seconds) for anyone
else's queue to drain, and we only ever have one prompt of ours in flight.

--styles renders the style gallery instead (contract v31): one fixed subject and one fixed seed for every
style, each on the style's best_model, at 3:4, into backend/app/templates/previews/styles/<id>.webp. Same
subject and seed everywhere, so the cards compare the styles and nothing else.
"""
import argparse
import asyncio
import io
import json
import logging
import re
import sys
import time
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

from PIL import Image  # noqa: E402

from app.autopilot import STYLE_PRESETS  # noqa: E402
from app.drivers.comfy import plan_generation  # noqa: E402
from app.drivers.comfy_client import ComfyClient, ComfyError, parse_outputs  # noqa: E402
from app.library import size_for_aspect, styled_prompt  # noqa: E402
from app.styles import catalogue as style_catalogue  # noqa: E402
from app.workflows import build  # noqa: E402

TEMPLATES = ROOT / "backend" / "app" / "templates"
OUT = TEMPLATES / "previews"
LONG_SIDE = 640
STYLE_LONG_SIDE = 400
QUALITY = 78
SLOT = re.compile(r"\[([^\[\]]{1,60})\]")
# the style cards: a person, a place and some light, so every style has something to show
STYLE_SUBJECT = "A young woman with a lantern standing on an old stone bridge over a river, a small town behind her"
STYLE_SEED = 20261014
STYLE_ASPECT = "3:4"
# what a Brand card's {tokens} become on its preview: deliberately nobody's brand
PLACEHOLDER_BRAND = {"brand": "YOUR BRAND", "colours": "slate blue and warm apricot", "tagline": "",
                     "tagline_clause": "", "palette": "in slate blue and warm apricot", "logo": "a simple round logo",
                     "logo_colours": "", "product_clause": ""}
BRACES = re.compile(r"\{([a-z_]{2,30})\}")


def load_templates() -> list[dict]:
    rows = []
    for kind in ("image", "video"):
        data = json.loads((TEMPLATES / f"{kind}.json").read_text(encoding="utf-8"))
        rows += [{**t, "type": kind} for t in data["templates"]]
    return rows


def fill(text: str, examples: dict) -> str:
    def sub(m):
        if m.group(1) not in examples:
            raise KeyError(f"no example for [{m.group(1)}]")
        return examples[m.group(1)]
    return SLOT.sub(sub, text)


def recipe(t: dict) -> dict:
    """What we send for one template: prompt, size, model."""
    if t.get("kind") == "style":
        return style_recipe(t)
    d = t["defaults"]
    ex = t.get("examples") or {}
    if t.get("target") == "image-brand":
        # Qwen draws the placeholder name legibly; the card shows the idea, not anyone's real logo
        prompt = BRACES.sub(lambda m: PLACEHOLDER_BRAND[m.group(1)], fill(t["preview_prompt"], ex))
        aspect = (t.get("scene") or {}).get("aspect") or "1:1"
        w, h = size_for_aspect(aspect)
        return {"prompt": prompt, "aspect": aspect, "model": "qwen_image_2512",
                "params": {"width": w, "height": h, "negative": "", "model": "qwen_image_2512", "speed": "lightning"}}
    # edit and control cards have no picture of their own to work from: show a typical result
    if t.get("target") in ("image-edit", "image-control"):
        prompt = fill(t["preview_prompt"], ex)
        aspect = d.get("aspect") or "1:1"
        negative = "text, watermark, distorted hands, extra fingers"
    elif t["type"] == "image":
        prompt = styled_prompt(fill(d["prompt_scaffold"], ex), d.get("style"))
        aspect = d.get("aspect", "1:1")
        negative = d.get("negative") or ""
    else:
        # a poster frame for the clip, in the look the autopilot would give it
        text = fill(t.get("preview_prompt") or d.get("prompt_scaffold") or "", ex)
        look = STYLE_PRESETS[d.get("style") or "cinematic"][0]
        prompt = f"{text.rstrip('.')}. {look}"
        aspect = d.get("aspect_ratio", "16:9")
        negative = "text, watermark, subtitles, logo, distorted hands"
    prompt = prompt[:1].upper() + prompt[1:]
    qwen = d.get("model") == "qwen_image_2512"
    w, h = size_for_aspect(aspect)
    params = {"width": w, "height": h, "negative": negative,
              "model": "qwen_image_2512" if qwen else "zimage_turbo"}
    if qwen:
        params["speed"] = "lightning"
    return {"prompt": prompt, "params": params, "aspect": aspect, "model": params["model"]}


def load_styles() -> list[dict]:
    return [{"id": s.id, "kind": "style", "style": s} for s in style_catalogue().values()]


def style_recipe(row: dict) -> dict:
    s = row["style"]
    qwen = s.best_model == "qwen_image_2512"
    w, h = size_for_aspect(STYLE_ASPECT)
    # Lightning runs at CFG 1 and ignores a negative, so the gallery shows the style's positive words only
    params = {"width": w, "height": h, "negative": "", "model": s.best_model}
    if qwen:
        params["speed"] = "lightning"
    return {"prompt": styled_prompt(STYLE_SUBJECT, s.id), "params": params, "aspect": STYLE_ASPECT,
            "model": s.best_model}


def out_path(t: dict) -> Path:
    return OUT / t["style"].preview if t.get("kind") == "style" else OUT / f"{t['id']}.webp"


def to_webp(png: bytes, dest: Path, long_side: int = LONG_SIDE) -> int:
    im = Image.open(io.BytesIO(png)).convert("RGB")
    im.thumbnail((long_side, long_side), Image.LANCZOS)
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".webp.part")
    im.save(tmp, "WEBP", quality=QUALITY, method=6)
    tmp.replace(dest)
    return dest.stat().st_size


async def wait_for_idle(client: ComfyClient, max_wait: float) -> None:
    waited = 0.0
    while True:
        q = await client.queue_state()
        busy = len(q.get("queue_running") or []) + len(q.get("queue_pending") or [])
        if not busy:
            return
        if waited >= max_wait:
            raise ComfyError(f"ComfyUI still busy with {busy} job(s) after {max_wait:.0f}s; try again later")
        print(f"  ComfyUI busy ({busy} job(s) from others), waiting 30 s...", flush=True)
        await asyncio.sleep(30)
        waited += 30


async def render(client: ComfyClient, t: dict, seed: int, scratch: Path) -> tuple[float, int]:
    r = recipe(t)
    plan = plan_generation("image", r["prompt"], r["params"], seed, None)
    graph, _ = build(plan.template, {**plan.inputs, "filename_prefix": f"mixai/tplpreview-{t['id']}"}, plan.loras)
    t0 = time.monotonic()
    _, entry = await client.run(graph, timeout=1200.0)
    secs = time.monotonic() - t0
    outs = [o for o in parse_outputs(entry) if o.kind == "image"]
    if not outs:
        raise ComfyError("finished without an image")
    raw = scratch / f"{t['id']}.png"
    await client.download(outs[0], raw)
    # style cards are small tiles in a grid: 400 px is plenty and keeps 45 of them light
    size = to_webp(raw.read_bytes(), out_path(t), STYLE_LONG_SIDE if t.get("kind") == "style" else LONG_SIDE)
    raw.unlink(missing_ok=True)
    return secs, size


async def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # Urdu prompts on a Windows console
    logging.getLogger("mixai.comfy").setLevel(logging.ERROR)  # we poll on purpose; skip the websocket notice
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--comfy", required=True, help="ComfyUI base URL (the image GPU)")
    ap.add_argument("--token", default="")
    ap.add_argument("--verify-tls", action="store_true", help="check the TLS certificate (off: self-signed boxes)")
    ap.add_argument("--only", default="", help="comma-separated template ids")
    ap.add_argument("--force", action="store_true", help="re-render previews that already exist")
    ap.add_argument("--seed", type=int, default=None, help="override the per-template seed (for a re-roll)")
    ap.add_argument("--wait", type=float, default=900, help="max seconds to wait for other people's jobs")
    ap.add_argument("--dry-run", action="store_true", help="print the prompts, queue nothing")
    ap.add_argument("--styles", action="store_true", help="render the style gallery cards instead of the templates")
    args = ap.parse_args()

    rows = load_styles() if args.styles else load_templates()
    if args.only:
        wanted = {x.strip() for x in args.only.split(",") if x.strip()}
        unknown = wanted - {t["id"] for t in rows}
        if unknown:
            print(f"unknown {'style' if args.styles else 'template'} ids: {', '.join(sorted(unknown))}",
                  file=sys.stderr)
            return 2
        rows = [t for t in rows if t["id"] in wanted]
    todo = [t for t in rows if args.force or not out_path(t).exists()]
    print(f"{len(todo)} to render, {len(rows) - len(todo)} already there")

    if args.dry_run:
        for t in todo:
            r = recipe(t)
            print(f"\n{t['id']}  [{r['model']} {r['params']['width']}x{r['params']['height']}]\n  {r['prompt']}")
        return 0

    scratch = OUT / ".tmp"
    scratch.mkdir(parents=True, exist_ok=True)
    table, failed = [], []
    client = ComfyClient(args.comfy, args.token, verify_tls=args.verify_tls, websocket=False)
    try:
        if not await client.healthy():
            print(f"ComfyUI at {args.comfy} is not answering", file=sys.stderr)
            return 1
        for i, t in enumerate(todo, 1):
            # stable per-template seed, so a plain re-run reproduces the same picture; one seed for all styles
            if args.seed is not None:
                seed = args.seed
            elif args.styles:
                seed = STYLE_SEED
            else:
                seed = zlib.crc32(t["id"].encode()) & 0x7FFFFFFF
            print(f"[{i}/{len(todo)}] {t['id']} (seed {seed})", flush=True)
            try:
                await wait_for_idle(client, args.wait)
                secs, size = await render(client, t, seed, scratch)
                table.append((t["id"], recipe(t)["model"], secs, size))
            except ComfyError as e:
                print(f"  failed: {e}", flush=True)
                failed.append(t["id"])
    finally:
        await client.close()
        try:
            scratch.rmdir()
        except OSError:
            pass

    if table:
        print(f"\n{'id':40} {'model':16} {'seconds':>8} {'KB':>6}")
        for tid, model, secs, size in table:
            print(f"{tid:40} {model:16} {secs:8.1f} {size / 1024:6.0f}")
        print(f"{'total':40} {'':16} {sum(r[2] for r in table):8.1f} {sum(r[3] for r in table) / 1024:6.0f}")
    files = list(OUT.glob("styles/*.webp" if args.styles else "*.webp"))
    print(f"\nall previews on disk: {len(files)} files, {sum(p.stat().st_size for p in files) / 1024:.0f} KB")
    if failed:
        print(f"failed: {', '.join(failed)}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
