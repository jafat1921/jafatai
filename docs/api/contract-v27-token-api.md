---
title: "Contract v27: Token API and Swagger (M12c)"
status: Active
created: 2026-10-14
extends: contract-v1 (auth), every router (Bearer auth applies to all of /api)
migration: 0019_api_token
plan: docs/PLAN-m12-characters-voices-api.md (Part C, Update 4)
---

# Contract v27: Token API and Swagger

Scripts and tools can call the REST API with a personal access token instead of the browser session.
The docs move under `/api` and are gated. While `PUBLIC_API` is off (the default) all of this is for the
admin only.

The getting-started guide for API users is [public-api.md](public-api.md). This file is the contract.

## Settings

| Key | Default | Meaning |
|---|---|---|
| `PUBLIC_API` | `off` | Off: only the admin (the `ADMIN_EMAIL` user with the owner role) sees the token page and the docs; the token routes and docs answer **404** to anyone else, signed in or not. On: owners and editors manage their own tokens; the docs open to any signed-in user. |
| `API_DOCS` | `on` | Off: `/api/docs`, `/api/redoc` and `/api/openapi.json` answer 404 for everyone. |

Valid tokens work on the REST routes whatever `PUBLIC_API` says. With it off, only the admin can mint them.

## Tokens

Table `api_token` (migration 0019): `id, user_id, workspace_id, name, prefix (unique), token_hash, scopes
(JSON list), expires_at?, last_used_at?, revoked_at?, created_at`.

- Format `mxa_<8 hex prefix>_<secret>` (`secrets.token_urlsafe(32)`, 43 chars).
- Only `sha256(token)` is stored. A presented token finds its row by prefix, then the hash is checked with
  `hmac.compare_digest`.
- The full token is returned **once**, by the create call.
- `last_used_at` is written at most once a minute.
- At most 50 unrevoked tokens per user.

### Scopes

| Scope | Methods |
|---|---|
| `read` | GET, HEAD |
| `generate` | POST, PUT, PATCH |
| `manage` | DELETE |

The scopes are independent; tick all that a script needs. A route can override the method rule with
`@token_scope("read")` (the Photo Studio preview, histogram, auto and upright POSTs only look at the
picture). `@session_only` refuses tokens outright.

Roles still apply on top of scopes: a viewer's token gets the usual 403 on anything `require_editor`
guards. A viewer can only mint `read` tokens.

### Routes (browser session only)

All three are `@session_only` (a Bearer token gets **403**) and hidden from the spec. With `PUBLIC_API` off,
anyone but the admin gets **404**.

```
GET    /api/tokens          → 200 [TokenOut]       newest first, revoked last
POST   /api/tokens          → 201 TokenCreatedOut  in: {name (1-120), scopes: ["read"|"generate"|"manage"] (≥1),
                                                       expires_days: 30|90|365|null (default 90)}
DELETE /api/tokens/{id}     → 204                  revoke; 404 if it isn't yours

TokenOut        {id, name, prefix, scopes, status: active|expired|revoked, expires_at?, last_used_at?,
                 revoked_at?, created_at}
TokenCreatedOut TokenOut + {token}
```

422 for no scopes, an unknown expiry, a blank name, a viewer asking for more than `read`, or the 50 limit.

## Auth

`security.authenticate(db, request)` is used by `get_current_user` and by the SSE stream:

1. `Authorization: Bearer …` present → `resolve_token`. Not live (unknown, wrong hash, revoked, expired,
   user inactive, membership gone) → **401** with `WWW-Authenticate: Bearer`. Then the scope check:
   session-only route or missing scope → **403**.
2. Otherwise the session cookie, as before.

A Bearer header wins over a cookie. Bearer requests carry no cookie, so they are CSRF-safe.

`resolve_token(db, raw) -> CurrentUser | None` is a plain function (no FastAPI dependency) so the MCP
server (Update 3) can reuse it. `CurrentUser` gained `token_id` and `scopes` (None for a browser session)
plus `via_token` and `can(scope)`.

Refused for tokens: `/api/auth/me`, `/api/auth/logout` and the token routes. Login takes a password, never
a token.

### Other changes

- `GET /api/auth/me` adds `api_access` (may open Settings → API tokens) and `api_docs` (may open the docs).
- `GET /api/events` (SSE) accepts a Bearer token with the `read` scope.
- **New** `GET /api/jobs/{job_id}` → `JobOut`; 404 for someone else's job.
- `GET /api/generations/{id}/download` and `GET /api/media/{path}` work with a Bearer token (they always
  used `get_current_user`).

## Docs

FastAPI's own `/docs`, `/redoc` and `/openapi.json` are off. Instead (all hidden from the spec, gated as
above):

```
GET /api/docs          Swagger UI (persistAuthorization on)
GET /api/redoc         ReDoc
GET /api/openapi.json  the spec
```

- The spec declares `components.securitySchemes.bearerAuth` (`http`, `bearer`) and a global
  `security: [{bearerAuth: []}]`, so Swagger's **Authorize** takes a token.
- Operations are regrouped into the tags Image, Video, Film, Characters, Audio, Voice, Podcast, Photo,
  Library and Jobs (`app/openapi.py`: router tag → area, with path overrides for `/api/images/*`,
  `/api/audio/speak` and `/api/characters*`).
- Hidden: the auth router, `/api/events`, the system router, `/api/system/llm-check`, the token routes.
- Request schemas with field descriptions and examples: ImageGenerateIn, ImageEditIn, Img2ImgIn,
  VideoGenerateIn, AudioGenerateIn, SpeakIn, TranscribeIn, CharacterCreate, SheetIn, UpscaleIn, TokenIn.
- Response models where routes returned bare dicts: `POST /transcribe` → `TranscribeQueued
  {transcript_id, job}`; `POST /dubs` → `DubOut` (main fields declared, the rest passes through);
  `GET|POST /photo/{id}/histogram` → `HistogramOut`; `POST /photo/{id}/auto` → `AutoOut`;
  `POST /photo/{id}/smart-restore` → `SmartRestoreQueued`.
- Raw multipart routes describe their body with `openapi_extra` (`app.openapi.multipart`):
  `/media/upload`, `/brand-kits/assets`, `/characters/import`, `/looks/import`.

## Hardening

- **Login rate limit:** 5 failed logins per client IP per minute; the 6th try (even with the right
  password) gets **429** with `Retry-After`. In memory: the API is one process. Behind Caddy, uvicorn's
  `--proxy-headers` makes `request.client` the real caller.
- **Weak secret warning:** at startup, a warning if `APP_SECRET` is the shipped default, the
  `.env.example` placeholder or shorter than 16 characters.
- **Reverse proxy:** `deploy/Caddyfile.mixai` uses a plain `reverse_proxy`, which passes the
  `Authorization` header through unchanged. Nothing to change.

## UI

Settings shows an **API** card (only when `api_access`) linking to `/settings/api`:

- **New token:** a name, scope checkboxes (read and generate ticked by default) and an expiry (30 / 90 /
  365 days / never).
- **Copy once:** a dialog with the token, a Copy button and a reminder that it won't be shown again.
- **Your tokens:** name, `mxa_<prefix>_…`, scopes, status, last used, expiry and created date, with
  **Revoke** behind a confirm.
- **API reference:** a link to `/api/docs` (only when `api_docs`).

The left column is where the MCP "Connect to Claude" card goes next.
