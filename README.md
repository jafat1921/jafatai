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

> **Repository:** replace `<REPO_URL>` with the copy you use, e.g. `https://github.com/mharisali-hash/mixaicinemastudio.git` or `https://github.com/jafat1921/jafatai.git`. Both are kept identical. Cloning into the folder `mixaicinemastudio` keeps the paths in this guide valid.

**[INSTALL.md](INSTALL.md)** is the full guide. The short version:

```bash
git clone <REPO_URL> mixaicinemastudio && cd mixaicinemastudio
./scripts/install-server.sh --admin-email you@example.com --public-url https://YOUR_HOST:8443 --systemd
```

## Configuration

Everything is set in `.env`. See [.env.example](.env.example), which includes a commented server profile.
Never commit `.env`.

## Required ComfyUI models and nodes

**Custom nodes:** ComfyUI-LTXVideo, ComfyUI-KJNodes, ComfyUI-VideoHelperSuite.

**Models:** `z_image_turbo_bf16`, `qwen_3_4b`, `ae`, `qwen_image_edit_2511_fp8mixed` + Lightning 4-step LoRA, `qwen_2.5_vl_7b_fp8_scaled`, `qwen_image_vae`, `ltx-2.3-22b-distilled-fp8`, `gemma_3_12B_it_fp4_mixed`. Full list with folders: [INSTALL.md](INSTALL.md#2-server-requirements).

`GET /api/system/comfy-check` reports anything missing.

## Contributors

| | GitHub |
|---|---|
| Muhammad Haris Ali | [@mharisali-hash](https://github.com/mharisali-hash) |
| Partner | [@jafat1921](https://github.com/jafat1921) |
