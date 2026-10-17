---
title: "Mix AI Cinema Studio API: getting started"
status: Active
created: 2026-10-14
contract: contract-v27-token-api.md
---

# Getting started with the API

Everything the studio does goes through its REST API, so a script can do the same things you do in the
app: make pictures, videos, songs and speech, build characters, then download the results.

While `PUBLIC_API` is off (the default) only the admin account can make tokens and open the docs.

**What you make through the API stays out of the studio app.** Items, projects, voices, jobs and the rest
created with a token don't appear in the app's Library, Queue or other lists; your script still lists and
downloads them through the API as usual. (The MCP server is different: what Claude makes there shows in the
app like your own work.) See [contract v34](contract-v34-api-visibility.md).

## 1. Make a token

1. Open **Settings → API → API tokens**.
2. Give the token a name (what will use it), tick its scopes and pick when it expires.
3. Press **Create token** and copy it. **It is shown once.** If you lose it, revoke it and make another.

Keep it out of your code: put it in an environment variable.

```bash
export MIXAI_URL="https://your-server:8443"
export MIXAI_TOKEN="mxa_1a2b3c4d_…"
```

## 2. Scopes

| Scope | Lets the token | HTTP methods |
|---|---|---|
| `read` | list and download projects, Library items, jobs, results | GET |
| `generate` | start work and change things | POST, PUT, PATCH |
| `manage` | delete things | DELETE |

Your role still applies. A viewer's token can't generate, whatever its scopes. Tokens can't sign in, see
your account or make other tokens.

## 3. Submit → poll → download

Long work answers **202** with one job per output. Poll `GET /api/jobs/{job_id}` until `status` is `done`
(or `failed` / `cancelled`). Then download the file.

### curl

```bash
H="Authorization: Bearer $MIXAI_TOKEN"

# submit
curl -s -X POST "$MIXAI_URL/api/images/generate" -H "$H" -H "Content-Type: application/json" \
  -d '{"prompt": "A lighthouse on a cliff at dusk", "aspect": "16:9"}' > batch.json
JOB=$(jq -r '.jobs[0].id' batch.json)
GEN=$(jq -r '.items[0].generation_id' batch.json)

# poll
while true; do
  STATUS=$(curl -s "$MIXAI_URL/api/jobs/$JOB" -H "$H" | jq -r .status)
  echo "$STATUS"
  case "$STATUS" in done|failed|cancelled) break ;; esac
  sleep 3
done

# download
curl -s -OJ "$MIXAI_URL/api/generations/$GEN/download" -H "$H"
```

### Python

```python
import os
import time

import requests

BASE = os.environ["MIXAI_URL"]
api = requests.Session()
api.headers["Authorization"] = f"Bearer {os.environ['MIXAI_TOKEN']}"


def wait(job_id: str, every: float = 3.0) -> dict:
    while True:
        job = api.get(f"{BASE}/api/jobs/{job_id}").json()
        if job["status"] in ("done", "failed", "cancelled"):
            return job
        print(f"{job['progress']:.0%} {job['message']}")
        time.sleep(every)


r = api.post(f"{BASE}/api/images/generate", json={"prompt": "A lighthouse on a cliff at dusk", "count": 2})
r.raise_for_status()
batch = r.json()

for job, item in zip(batch["jobs"], batch["items"]):
    if wait(job["id"])["status"] != "done":
        print("failed:", job["id"])
        continue
    file = api.get(f"{BASE}/api/generations/{item['generation_id']}/download")
    file.raise_for_status()
    with open(f"{item['id']}.png", "wb") as f:
        f.write(file.content)
```

### The same flow elsewhere

| What | Submit | Then |
|---|---|---|
| Image | `POST /api/images/generate`, `/images/edit`, `/images/img2img` | `jobs[]` and `items[]`, one per picture |
| Video | `POST /api/videos/generate` | `job` and the item |
| Song, music, SFX | `POST /api/audio/generate` | `jobs[]` and `items[]` |
| Speech | `POST /api/audio/speak` | `jobs[]` and `items[]` |
| Transcript | `POST /api/transcribe` | `job`, then `GET /api/transcripts/{transcript_id}` |
| Character sheet | `POST /api/characters/{id}/sheet` | `GET /api/characters/{id}/sheet` shows the panels |
| Upscale | `POST /api/generations/{id}/upscale` | one job |
| 3D model | `POST /api/3d/make` | `job` and the `item` (kind `model`, a GLB) |

A Library item's `media_url` (`/api/media/workspaces/…`) also downloads with the token.

### Uploading a file

```bash
curl -s -X POST "$MIXAI_URL/api/media/upload" -H "$H" -F "file=@photo.jpg" -F "title=Reference"
```

The answer is the new Library item; use its `id` as a source for edits, image to video and so on.

### Following progress live

`GET /api/events` is a server-sent event stream of job, generation and media changes in your workspace. It
needs the `read` scope. Polling `GET /api/jobs/{id}` is simpler and fine for most scripts.

## 4. Errors

Errors are JSON: `{"detail": "…"}`. Validation errors (422) list each bad field.

| Status | Meaning |
|---|---|
| 401 | No token, or it is unknown, expired or revoked. |
| 403 | The token lacks the scope (`This token doesn't have the 'generate' scope`), your role can't do it, or the route doesn't take tokens. |
| 404 | Not found, or not yours. |
| 409 | The thing is in the wrong state, e.g. cancelling a finished job. |
| 413 | The upload is too big. |
| 422 | A field is wrong. |
| 429 | Too many attempts. Wait for `Retry-After` seconds. |

## 5. Limits

- Sign-in allows 5 failed attempts a minute per IP address. Tokens skip sign-in, so scripts aren't affected.
- There is no request rate limit for tokens yet. The GPU queue is the real limit: jobs run one at a time per
  GPU in the order they arrive, so submit and poll rather than hammering.
- Up to 50 active tokens per user.

## 6. Reference

The full reference is at **`/api/docs`** (Swagger) and **`/api/redoc`**, with every route, field and
example. Press **Authorize**, paste a token (without the word Bearer), and try calls from the page. The
raw spec is at `/api/openapi.json`.
