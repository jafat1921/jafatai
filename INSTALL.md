# Installing Mix AI Cinema Studio

This guide installs the studio on a **Linux GPU server** that already runs **ComfyUI** and **Ollama**,
and on a **Windows/macOS/Linux workstation** for development. No Docker is needed.

- [1. How it fits together](#1-how-it-fits-together)
- [2. Server requirements](#2-server-requirements)
- [3. Quick install (recommended)](#3-quick-install-recommended)
- [4. Put it on the web with Caddy](#4-put-it-on-the-web-with-caddy)
- [5. First login and checks](#5-first-login-and-checks)
- [6. Manual install (step by step)](#6-manual-install-step-by-step)
- [7. Configuration reference (.env)](#7-configuration-reference-env)
- [8. Updating](#8-updating)
- [9. Backup and restore](#9-backup-and-restore)
- [10. Admin tasks](#10-admin-tasks)
- [11. Troubleshooting](#11-troubleshooting)
- [12. Development setup (workstation)](#12-development-setup-workstation)

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
5. with `--systemd`, installs and starts `mixai-api` and `mixai-worker`, then runs a health check.

| Option | Default | Meaning |
|---|---|---|
| `--admin-email` | prompted | Login for the first (owner) account |
| `--public-url` | prompted | URL people will open; used for CORS |
| `--data-dir` | `/data/outputs/mixai` | Database and media |
| `--comfy-root` | `/data/apps/ComfyUI` | Used for the output and LoRA folders |
| `--port` | `8090` | Local API port that Caddy proxies to |
| `--user` | current user | User the services run as |
| `--systemd` | off | Install and start the services |

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
cp .env.example .env && chmod 600 .env && nano .env      # uncomment the SERVER PROFILE block, see section 7
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

## 7. Configuration reference (.env)

All settings live in `.env` at the repository root. Restart both services after changing it.

| Key | Server value | Notes |
|---|---|---|
| `APP_ENV` | `prod` | `prod` makes cookies Secure (HTTPS) and disables dev conveniences |
| `APP_SECRET` | random, 64 hex chars | Signs login sessions. Changing it logs everyone out |
| `APP_HOST` / `APP_PORT` | `127.0.0.1` / `8090` | Used by `scripts/tasks.py`; the systemd unit sets its own port |
| `CORS_ORIGINS` | `https://YOUR_HOST:8443` | Comma-separated |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_NAME` | your values | **Used only on the very first start** to create the owner. Later changes need `app.manage` (section 10) |
| `DEV_LOGIN_PREFILL` | `false` | Pre-fills the login form on local dev machines only |
| `DATABASE_URL` | `sqlite:////data/outputs/mixai/mixai.db` | Four slashes for an absolute path |
| `DATA_DIR` | `/data/outputs/mixai` | Media and generated files |
| `GEN_DRIVER` | `comfy` | `mock` makes placeholder images (no GPU) |
| `COMFY_URLS` | `http://127.0.0.1:8188` | Comma-separated; the first healthy one is used |
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

## 8. Updating

```bash
cd /data/apps/mixaicinemastudio
git pull
./scripts/install-server.sh --systemd      # re-syncs deps, rebuilds, migrates, restarts; keeps .env
```
Restarting the worker during a render is safe: the job is re-queued and resumes.

## 9. Backup and restore

Everything is in `DATA_DIR`, plus your `.env`.
```bash
sudo systemctl stop mixai-worker mixai-api
tar czf mixai-backup-$(date +%F).tgz -C /data/outputs mixai /data/apps/mixaicinemastudio/.env
sudo systemctl start mixai-api mixai-worker
```
To restore, stop the services, extract the archive back to the same paths, and start them.

## 10. Admin tasks

```bash
cd /data/apps/mixaicinemastudio/backend
uv run python -m app.manage list-users
uv run python -m app.manage reset-password you@example.com      # prompts for the new password
journalctl -u mixai-api -f
journalctl -u mixai-worker -f
```

## 11. Troubleshooting

| Symptom | Fix |
|---|---|
| Login page loads but signing in fails silently | Over plain HTTP with `APP_ENV=prod` the Secure cookie is dropped. Use HTTPS through Caddy |
| Top bar says *ComfyUI unreachable* | Check `curl -s http://127.0.0.1:8188/system_stats` and `COMFY_URLS` |
| A generation fails with *missing model / node* | Open `/api/system/comfy-check`; install what it lists, then restart ComfyUI |
| Queue jobs stay *Waiting* | The worker isn't running: `systemctl status mixai-worker` |
| AI writing is very slow or times out | First call per model loads it (minutes). Check `nvidia-smi` that Ollama uses a GPU; raise `LLM_TIMEOUT_S` |
| AI writing returns empty text | Use the recommended models; check `/api/system/llm-check` |
| Live progress doesn't update | Make sure the Caddy block has `flush_interval -1` |
| Forgot the admin password | `uv run python -m app.manage reset-password <email>` |
| `uv sync --frozen` fails after `git pull` | Run `uv sync` (without `--frozen`) once, then report it |
| Port 8090 already in use | Re-run the installer with `--port <free port>` and update Caddy |

## 12. Development setup (workstation)

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
