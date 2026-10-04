---
title: Deploying Mix AI Cinema Studio to the GPU server
status: Ready
created: 2026-10-04
---

# Deploying to the GPU server

| | |
|---|---|
| **Target** | `gpu@SERVER_IP`, next to the existing ComfyUI (`127.0.0.1:8188`, `/data/apps/ComfyUI`) and Ollama (`127.0.0.1:11434`) |
| **Layout** | Code in `/data/apps/mixaicinemastudio`; data in `/data/outputs/mixai`; API on `127.0.0.1:8090`; public at **`https://SERVER_IP:8443`** through Caddy |
| **No Docker** | Python via `uv`, two systemd services (API and worker), same as the plan |

## 1. Get the code (on the server)
```bash
sudo mkdir -p /data/apps /data/outputs/mixai && sudo chown -R gpu:gpu /data/apps /data/outputs/mixai
cd /data/apps
git clone https://github.com/mharisali-hash/mixaicinemastudio.git
cd mixaicinemastudio
```

## 2. Build the frontend (on the server)
The built SPA is not committed, so build it once per update. This needs Node 20+.
```bash
node --version || (curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs)
cd /data/apps/mixaicinemastudio/frontend && npm ci && npm run build
```
The API serves `frontend/dist` itself, so Node is only needed for this build step, not at runtime.

## 3. First-time setup (on the server)
```bash
# uv, if not present
curl -LsSf https://astral.sh/uv/install.sh | sh

cd /data/apps/mixaicinemastudio/backend && uv sync --frozen    # creates .venv with Python 3.12
cd .. && cp .env.example .env && nano .env    # never commit this file
```

Set the **server profile** in `.env`. The block is at the bottom of `.env.example`; uncomment it and add:
```
APP_ENV=prod
APP_SECRET=<openssl rand -hex 32>
ADMIN_EMAIL=<your email>
ADMIN_PASSWORD=<strong password>
DATA_DIR=/data/outputs/mixai
DATABASE_URL=sqlite:////data/outputs/mixai/mixai.db
GEN_DRIVER=comfy
COMFY_URLS=http://127.0.0.1:8188
COMFY_VERIFY_TLS=true
COMFY_OUTPUT_DIR=/data/apps/ComfyUI/output
COMFY_LORA_DIR=/data/apps/ComfyUI/models/loras
LLM_BASE_URL=http://127.0.0.1:11434/v1
LLM_MODEL_REASONING=deepseek-r1:14b
LLM_MODEL_CREATIVE=gemma4:e4b
LLM_MODEL_VISION=gemma4:e4b
CORS_ORIGINS=https://SERVER_IP:8443
```

Then create the database:
```bash
cd backend && uv run alembic upgrade head
```

## 4. Services
```bash
sudo cp /data/apps/mixaicinemastudio/deploy/mixai-api.service /data/apps/mixaicinemastudio/deploy/mixai-worker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now mixai-api mixai-worker
systemctl status mixai-api mixai-worker --no-pager
```
The units assume user `gpu` and the paths above. Edit them if yours differ.

## 5. Caddy
Append `deploy/Caddyfile.mixai` to `/etc/caddy/Caddyfile`, replace `SERVER_IP` with the server address, then:
```bash
caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
```
Open **https://SERVER_IP:8443** and log in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`. In production the form is not pre-filled.

## 6. Smoke test
```bash
curl -sk https://SERVER_IP:8443/api/health                    # {"status":"ok"}
journalctl -u mixai-worker -n 50 --no-pager                      # worker loop running
```
In the app, the top bar should show **ComfyUI Connected** and **Ollama Connected**. Settings → System check lists any missing node or model per template.

## Updating
```bash
cd /data/apps/mixaicinemastudio && git pull
cd backend && uv sync --frozen && uv run alembic upgrade head
cd ../frontend && npm ci && npm run build
sudo systemctl restart mixai-api mixai-worker
```
`.env` and `/data/outputs/mixai` are not in git, so `git pull` never touches them.

Restarting the worker in the middle of a render is safe. The job is re-queued and resumes, and long takes resume from their last finished chunk once that lands.

## Notes
- The app talks to ComfyUI over loopback, so it bypasses the Caddy lock-down from `secure-comfyui.md`. Apply that lock-down anyway: it protects the public ComfyUI URL.
- Backups: `/data/outputs/mixai` holds everything (the SQLite DB and all media). Include it in your regular server backups.
