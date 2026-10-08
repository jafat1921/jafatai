# Installing Mix AI Cinema Studio

This guide installs the studio on a **Linux GPU server** that already runs **ComfyUI** and **Ollama**,
and on a **Windows/macOS/Linux workstation** for development. No Docker is needed.

- [1. How it fits together](#1-how-it-fits-together)
- [2. Server requirements](#2-server-requirements)
- [3. Quick install (recommended)](#3-quick-install-recommended)
- [4. Put it on the web with Caddy](#4-put-it-on-the-web-with-caddy)
- [5. First login and checks](#5-first-login-and-checks)
- [6. Manual install (step by step)](#6-manual-install-step-by-step)
- [7. Two GPUs: images and video in parallel](#7-two-gpus-images-and-video-in-parallel)
- [8. Configuration reference (.env)](#8-configuration-reference-env)
- [9. Updating](#9-updating)
- [10. Backup and restore](#10-backup-and-restore)
- [11. Admin tasks](#11-admin-tasks)
- [12. Troubleshooting](#12-troubleshooting)
- [13. Development setup (workstation)](#13-development-setup-workstation)

---

## 1. How it fits together

```
 Browser ──HTTPS──► Caddy :8443 ──► mixai-api (uvicorn, 127.0.0.1:8090) ──┐
                                        │  serves the built React app      │ SQLite + media
                                        │  REST + live updates (SSE)       ▼ DATA_DIR
                                    mixai-worker (python -m app.worker) ───┤
                                        ├──► ComfyUI  127.0.0.1:8188  (images, video)
                                        └──► Ollama   127.0.0.1:11434 (script writing)
```

- **mixai-api** serves the web app and the API.
- **mixai-worker** runs every generation job one at a time. Jobs survive restarts and resume.
  With two GPUs it is split into three lane workers so images and video render at the same time (section 7).
- Everything the app creates (the database and all media) lives in `DATA_DIR`.

## 2. Server requirements

| Item | Needed |
|---|---|
| OS | Ubuntu 22.04/24.04 or similar (systemd) |
| GPU | NVIDIA, 20 GB+ VRAM recommended (LTX-2.3 offloads to RAM on smaller cards) |
| RAM | 64 GB minimum, 128 GB recommended |
| Disk | ~5 GB for the app plus space for your media (`DATA_DIR`) |
| Tools | `git`, `curl`, `openssl`, **Node.js 20+** (build step only), `ffmpeg` (recommended) |
| Python | Not needed system-wide: `uv` installs Python 3.12 for the app |
| ComfyUI | Running on `127.0.0.1:8188`, with the nodes and models below |
| Ollama | Running on `127.0.0.1:11434`, with the models below |

**ComfyUI custom nodes:** ComfyUI-LTXVideo, ComfyUI-KJNodes, ComfyUI-VideoHelperSuite.

**ComfyUI models** (file names as the app expects them):

| Folder | Files |
|---|---|
| `diffusion_models/` | `z_image_turbo_bf16.safetensors`, `qwen_image_edit_2511_fp8mixed.safetensors` |
| `checkpoints/` | `ltx-2.3-22b-distilled-fp8.safetensors` |
| `text_encoders/` | `qwen_3_4b.safetensors`, `qwen_2.5_vl_7b_fp8_scaled.safetensors`, `gemma_3_12B_it_fp4_mixed.safetensors` |
| `vae/` | `ae.safetensors`, `qwen_image_vae.safetensors` (LTX-2.3 video and audio VAEs load from its checkpoint) |
| `loras/` | `Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors`; optional: `qwen-image-edit-2511-multiple-angles-lora.safetensors` (better turnaround views) |

**Ollama models:**
```bash
ollama pull deepseek-r1:14b    # reasoning: story structure
ollama pull gemma4:e4b         # creative writing, prompts, vision
```

Install Node.js if it's missing:
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
```

## 3. Quick install (recommended)

> **Repository:** replace `<REPO_URL>` with the copy you use, e.g. `https://github.com/mharisali-hash/mixaicinemastudio.git` or `https://github.com/jafat1921/jafatai.git`. Both are kept identical. Cloning into the folder `mixaicinemastudio` keeps the paths in this guide valid.

```bash
sudo mkdir -p /data/apps /data/outputs/mixai && sudo chown -R "$USER": /data/apps /data/outputs/mixai
cd /data/apps
git clone <REPO_URL> mixaicinemastudio
cd mixaicinemastudio
chmod +x scripts/install-server.sh
./scripts/install-server.sh --admin-email you@example.com --public-url https://YOUR_HOST:8443 --systemd
```

The script:
1. installs `uv` if it's missing, and checks Node and ffmpeg;
2. creates the Python 3.12 environment (`backend/.venv`) and builds the frontend (`frontend/dist`);
3. creates `.env` with the **server profile**: production mode, ComfyUI and Ollama on loopback, the recommended models, a random `APP_SECRET` and a **random admin password, printed once at the end**;
4. creates the database in `DATA_DIR` and applies migrations;
5. with `--systemd`, installs and starts `mixai-api` and `mixai-worker` (or, with two GPUs, the three lane workers of section 7), then runs a health check.

| Option | Default | Meaning |
|---|---|---|
| `--admin-email` | prompted | Login for the first (owner) account |
| `--public-url` | prompted | URL people will open; used for CORS |
| `--data-dir` | `/data/outputs/mixai` | Database and media |
| `--comfy-root` | `/data/apps/ComfyUI` | Used for the output and LoRA folders |
| `--port` | `8090` | Local API port that Caddy proxies to |
| `--user` | current user | User the services run as |
| `--systemd` | off | Install and start the services |
| `--gpu-lanes` / `--no-gpu-lanes` | auto | One worker per GPU lane (section 7). Auto = on when `COMFY_IMAGE_URLS` and `COMFY_VIDEO_URLS` are both set, or two ComfyUI services / ports 8188+8189 are found |

Re-running the script is safe. It never overwrites an existing `.env`.

## 4. Put it on the web with Caddy

The app has its own login and listens on loopback only, so Caddy only needs to proxy it.
Add to `/etc/caddy/Caddyfile` (also in `deploy/Caddyfile.mixai`):

```caddyfile
YOUR_HOST:8443 {
	encode zstd gzip
	reverse_proxy 127.0.0.1:8090 {
		flush_interval -1   # live updates (SSE) must not be buffered
	}
}
```
```bash
caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
```
`YOUR_HOST` can be a domain (Caddy gets a public certificate automatically) or an IP (internal certificate; browsers will warn once).

> **Security:** if ComfyUI itself is published through Caddy, put a login in front of it. The studio talks to ComfyUI on `127.0.0.1` and doesn't need the public route.

## 5. First login and checks

1. Open `https://YOUR_HOST:8443` and sign in with the admin email and the password the installer printed.
2. The top bar should show **ComfyUI · Connected** and **Ollama · Connected**.
3. Detailed checks, from the server:
   ```bash
   curl -s http://127.0.0.1:8090/api/health
   ```
   The following need a signed-in session, so open them in the browser:
   - `/api/system/status`: connections and worker heartbeat;
   - `/api/system/comfy-check`: per workflow, any missing nodes or models;
   - `/api/system/llm-check`: per role, whether the model exists and how fast it answers.
4. Try it:
   - **Cast & World → Add character → Generate portrait.** The first run loads models, which takes 1–2 minutes.
   - **New project → AI Director:** a one-line brief. The first Ollama call loads the model.

## 6. Manual install (step by step)

Use this instead of section 3 if you want to control each step.

```bash
cd /data/apps && git clone <REPO_URL> mixaicinemastudio && cd mixaicinemastudio
curl -LsSf https://astral.sh/uv/install.sh | sh          # if uv is missing
(cd backend && uv sync --frozen)
(cd frontend && npm ci && npm run build)
cp .env.example .env && chmod 600 .env && nano .env      # uncomment the SERVER PROFILE block, see section 8
mkdir -p /data/outputs/mixai
(cd backend && uv run alembic upgrade head)
```

Services:
```bash
sudo cp deploy/mixai-api.service deploy/mixai-worker.service /etc/systemd/system/
sudo nano /etc/systemd/system/mixai-api.service       # check User=, paths and --port
sudo nano /etc/systemd/system/mixai-worker.service
sudo systemctl daemon-reload && sudo systemctl enable --now mixai-api mixai-worker
```

Without systemd (foreground, for a quick try):
```bash
cd backend
uv run uvicorn app.main:app --host 127.0.0.1 --port 8090 --timeout-graceful-shutdown 3 &
uv run python -m app.worker
```

## 7. Two GPUs: images and video in parallel

With two GPUs, each running its own ComfyUI, the studio gives one GPU to **image** work and the other to
**video** work, and runs both at once: a portrait or keyframe no longer waits behind a long take.

Every job gets a **lane** when it's queued:

| Lane | Jobs | ComfyUI |
|---|---|---|
| `image` | portraits, turnaround views, establishing shots, keyframes, Library images, image edits and image upscales | `COMFY_IMAGE_URLS` |
| `video` | takes and long takes, video generations, video upscales (SeedVR2 / FlashVSR) | `COMFY_VIDEO_URLS` |
| `general` | AI writing (Ollama), reel assembly, branding (ffmpeg), exports, Quick Create orchestration | none (if it ever needs one, the image GPU) |

One worker serves each lane: `mixai-worker@image`, `mixai-worker@video` and `mixai-worker@general`
(a systemd template, `deploy/mixai-worker@.service`; the instance name is the lane list). Quick Create keeps
working across them: the autopilot waits on the general worker while its frames and takes run on the GPUs.

**Server profile** (two ComfyUI services, `comfyui.service` = GPU 0 on 8188, `comfyui-gpu1.service` = GPU 1 on 8189):
```ini
COMFY_URLS=http://127.0.0.1:8188,http://127.0.0.1:8189
COMFY_IMAGE_URLS=http://127.0.0.1:8188     # GPU 0: stills
COMFY_VIDEO_URLS=http://127.0.0.1:8189     # GPU 1: video
```
To swap which GPU does what, swap the two values and restart the lane workers. An empty lane list falls back
to `COMFY_URLS` (first healthy instance), which is the old single-GPU behaviour.

Switch an existing install over (the installer does this for you, and fills in the two keys when both ports answer):
```bash
cd /data/apps/mixaicinemastudio && git pull
./scripts/install-server.sh --systemd --gpu-lanes
```
By hand:
```bash
sudo cp deploy/mixai-worker@.service /etc/systemd/system/    # check User= and paths
sudo systemctl daemon-reload
sudo systemctl disable --now mixai-worker
sudo systemctl enable --now mixai-worker@image mixai-worker@video mixai-worker@general
sudo systemctl restart mixai-api
```
Going back to one worker: `sudo systemctl disable --now mixai-worker@image mixai-worker@video mixai-worker@general && sudo systemctl enable --now mixai-worker`
(or re-run the installer with `--no-gpu-lanes`). Without systemd, start one `uv run python -m app.worker --lanes <lane>` per lane;
`python -m app.worker` with no flag still serves every lane.

`/api/system/status` has a `lanes` object: for each lane whether a worker is alive, the job it's running, and
the ComfyUI URL it uses with its health and GPU. Logs: `journalctl -u mixai-worker@video -f`.

## 8. Configuration reference (.env)

All settings live in `.env` at the repository root. Restart both services after changing it.

| Key | Server value | Notes |
|---|---|---|
| `APP_ENV` | `prod` | `prod` makes cookies Secure (HTTPS) and disables dev conveniences |
| `APP_SECRET` | random, 64 hex chars | Signs login sessions. Changing it logs everyone out |
| `APP_HOST` / `APP_PORT` | `127.0.0.1` / `8090` | Used by `scripts/tasks.py`; the systemd unit sets its own port |
| `CORS_ORIGINS` | `https://YOUR_HOST:8443` | Comma-separated |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_NAME` | your values | **Used only on the very first start** to create the owner. Later changes need `app.manage` (section 11) |
| `DEV_LOGIN_PREFILL` | `false` | Pre-fills the login form on local dev machines only |
| `DATABASE_URL` | `sqlite:////data/outputs/mixai/mixai.db` | Four slashes for an absolute path |
| `DATA_DIR` | `/data/outputs/mixai` | Media and generated files |
| `GEN_DRIVER` | `comfy` | `mock` makes placeholder images (no GPU) |
| `COMFY_URLS` | `http://127.0.0.1:8188` | Comma-separated; the first healthy one is used |
| `COMFY_IMAGE_URLS` | two GPUs: `http://127.0.0.1:8188` | ComfyUI for image jobs (section 7). Empty = `COMFY_URLS` |
| `COMFY_VIDEO_URLS` | two GPUs: `http://127.0.0.1:8189` | ComfyUI for video jobs. Empty = `COMFY_URLS` |
| `COMFY_AUTH_TOKEN` | empty | Bearer token, if ComfyUI sits behind an auth proxy |
| `COMFY_VERIFY_TLS` | `true` | `false` only for self-signed HTTPS ComfyUI URLs |
| `COMFY_OUTPUT_DIR` | `/data/apps/ComfyUI/output` | Optional, for faster local reads |
| `COMFY_LORA_DIR` | `/data/apps/ComfyUI/models/loras` | Where uploaded LoRAs go |
| `LLM_BASE_URL` | `http://127.0.0.1:11434/v1` | Ollama (or any OpenAI-compatible server) |
| `LLM_API_KEY` | `ollama` | Ignored by Ollama; needed by some other servers |
| `LLM_MODEL_REASONING` | `deepseek-r1:14b` | Story structure / breakdown (thinks) |
| `LLM_MODEL_CREATIVE` | `gemma4:e4b` | Scene text, dialogue, image prompts (thinking off) |
| `LLM_MODEL_VISION` | `gemma4:e4b` | Image scoring |
| `LLM_REASONING_FORMAT` | `deepseek` | How thinking is separated from answers |
| `LLM_API` | `auto` | `auto` uses Ollama's native API when available |
| `LLM_NUM_CTX` | `8192` | Context window requested from Ollama |
| `LLM_TIMEOUT_S` | `600` | Per-call timeout; first calls include model loading |
| `FFMPEG_BIN` | empty | Empty means `ffmpeg` from PATH, else a bundled copy |

## 9. Updating

```bash
cd /data/apps/mixaicinemastudio
git pull
./scripts/install-server.sh --systemd      # re-syncs deps, rebuilds, migrates, restarts; keeps .env
```
Restarting the worker during a render is safe: the job is re-queued and resumes.

## 10. Backup and restore

Everything is in `DATA_DIR`, plus your `.env`.
```bash
sudo systemctl stop mixai-worker mixai-worker@image mixai-worker@video mixai-worker@general mixai-api
tar czf mixai-backup-$(date +%F).tgz -C /data/outputs mixai /data/apps/mixaicinemastudio/.env
sudo systemctl start mixai-api mixai-worker      # two GPUs: mixai-worker@image mixai-worker@video mixai-worker@general
```
To restore, stop the services, extract the archive back to the same paths, and start them.

## 11. Admin tasks

```bash
cd /data/apps/mixaicinemastudio/backend
uv run python -m app.manage list-users
uv run python -m app.manage reset-password you@example.com      # prompts for the new password
journalctl -u mixai-api -f
journalctl -u mixai-worker -f          # two GPUs: journalctl -u 'mixai-worker@*' -f
```

## 12. Troubleshooting

| Symptom | Fix |
|---|---|
| Login page loads but signing in fails silently | Over plain HTTP with `APP_ENV=prod` the Secure cookie is dropped. Use HTTPS through Caddy |
| Top bar says *ComfyUI unreachable* | Check `curl -s http://127.0.0.1:8188/system_stats` and `COMFY_URLS` |
| A generation fails with *missing model / node* | Open `/api/system/comfy-check`; install what it lists, then restart ComfyUI |
| Queue jobs stay *Waiting* | The worker isn't running: `systemctl status mixai-worker` (two GPUs: `systemctl status 'mixai-worker@*'`) |
| Two GPUs: images still wait for video | Check `/api/system/status` → `lanes`: all three workers alive? `COMFY_IMAGE_URLS` and `COMFY_VIDEO_URLS` set to different ports? Restart the lane workers after editing `.env` |
| Two GPUs: only one lane's jobs move | That lane's worker or ComfyUI is down: `systemctl status mixai-worker@video comfyui-gpu1` and `curl -s http://127.0.0.1:8189/system_stats` |
| Both `mixai-worker` and `mixai-worker@*` running | They are either/or; `sudo systemctl disable --now mixai-worker` (the lane units also declare `Conflicts=`) |
| Lane worker logs `unknown lane(s)` | The instance name must be `image`, `video`, `general` or a dash-joined list like `image-video` |
| AI writing is very slow or times out | First call per model loads it (minutes). Check `nvidia-smi` that Ollama uses a GPU; raise `LLM_TIMEOUT_S` |
| AI writing returns empty text | Use the recommended models; check `/api/system/llm-check` |
| Live progress doesn't update | Make sure the Caddy block has `flush_interval -1` |
| Forgot the admin password | `uv run python -m app.manage reset-password <email>` |
| `uv sync --frozen` fails after `git pull` | Run `uv sync` (without `--frozen`) once, then report it |
| Port 8090 already in use | Re-run the installer with `--port <free port>` and update Caddy |

## 13. Development setup (workstation)

Needs Python 3.12 via [uv](https://docs.astral.sh/uv/), Node 20+, and git.

```bash
git clone <REPO_URL> mixaicinemastudio && cd mixaicinemastudio
python scripts/tasks.py setup      # .env from template + deps
python scripts/tasks.py migrate
python scripts/tasks.py dev        # API :8000 + worker + web :5173
```
- Open http://localhost:5173. In dev mode the login form is pre-filled from `.env`.
- `GEN_DRIVER=mock` needs no GPU.
- To use the server's GPU from your workstation, tunnel it:
  `ssh -L 8188:127.0.0.1:8188 -L 11434:127.0.0.1:11434 user@YOUR_HOST`, then set `GEN_DRIVER=comfy`.

Tests: `python scripts/tasks.py test` (backend pytest and frontend Vitest).

**Prompt template previews.** Each prompt template ships with an example picture in
`backend/app/templates/previews/<id>.webp`. After adding or changing a template, render the missing
ones on the image GPU (Z-Image Turbo; Qwen-Image Lightning for text templates; one prompt at a time,
waiting for other people's jobs first):
`cd backend && uv run python ../scripts/gen_prompt_template_previews.py --comfy https://YOUR_IMAGE_GPU [--only id,id] [--force]`
(`--dry-run` prints the prompts without queueing anything).
