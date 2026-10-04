# Mix AI Cinema Studio

AI filmmaking studio: write a script scene by scene (or let the AI Director draft it), generate a cast,
storyboard start/end frames, render shots with LTX-2.3 image-to-video, and stitch long-form films.

Runs against your own **ComfyUI** and **Ollama**. No cloud services and no Docker.

| Part | Stack |
|---|---|
| Backend | Python 3.12, FastAPI, SQLAlchemy + Alembic, SQLite, a DB-backed job worker |
| Frontend | React 19, Vite, TypeScript, Tailwind |
| Generation | ComfyUI: Z-Image Turbo (portraits/keyframes), Qwen-Image-Edit 2511 (character sheets), LTX-2.3 (video) |
| Writing | Ollama: a reasoning model for structure, a creative model for prose and prompts |

## Quick start (development)

Needs Python 3.12+ with [uv](https://docs.astral.sh/uv/), and Node 20+.

```bash
python scripts/tasks.py setup     # creates .env from .env.example, installs backend + frontend deps
python scripts/tasks.py migrate   # creates the SQLite database
python scripts/tasks.py dev       # API :8000, worker, web :5173
```

Open http://localhost:5173 and sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD` from `.env`.
`GEN_DRIVER=mock` produces placeholder images without a GPU; set `GEN_DRIVER=comfy` to use ComfyUI.

Other tasks: `api`, `worker`, `web`, `build`, `test`, `serve`.

## Server install

See [docs/ops/deploy-server.md](docs/ops/deploy-server.md) for the full guide (clone, `.env`, systemd, Caddy).

## Configuration

Everything is set in `.env`. See [.env.example](.env.example), which includes a commented server profile.
Never commit `.env`.

## Required ComfyUI models and nodes

**Custom nodes:** ComfyUI-LTXVideo, ComfyUI-KJNodes, ComfyUI-VideoHelperSuite.

**Models:** `z_image_turbo_bf16`, `qwen_3_4b`, `ae`, `qwen_image_edit_2511` + Lightning 4-step LoRA, `qwen_2.5_vl_7b_fp8_scaled`, `qwen_image_vae`, `ltx-2.3-22b-distilled-fp8`, `gemma_3_12B_it_fp4_mixed`, `LTX23_video_vae_bf16`, `LTX23_audio_vae_bf16`.

`GET /api/system/comfy-check` reports anything missing.
