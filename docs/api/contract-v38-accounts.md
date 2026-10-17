---
title: "Contract v38: Accounts (M17 step 1)"
status: Active
created: 2026-10-17
extends: contract-v27 (tokens), contract-v34 (via_api, admin), contract-v37 (studio parts)
migration: 0027_accounts
plan: docs/PLAN-m17-accounts.md (step 1: A, B, E basic users, F, G)
---

# Contract v38: Accounts

Open sign-up with email confirmation, a private studio (workspace) per person, password reset, a basic Users
admin, and the isolation hardening that has to be in place before anyone else signs up. Google sign-in (C) and
packages / limits (D) come in later steps; `job.user_id` and `usage_ledger.user_id` are stamped now so they can.

## 1. Settings (`.env`)

| key | default | notes |
|---|---|---|
| `SIGNUP` | `open` | `open`: anyone; `invite`: only accounts the admin makes; `closed`: none. Anything else reads as `closed` |
| `EMAIL_VERIFY` | `on` | off: new accounts are confirmed at once and can start work straight away |
| `PUBLIC_URL` | first `CORS_ORIGINS` entry | base of every emailed link; also an origin the Origin check accepts |
| `EMAIL_BACKEND` | `console` | `console` logs the message and its link (warning level); `smtp` sends in a background thread |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASSWORD` / `SMTP_FROM` | | `SMTP_FROM` like `Name <addr@domain>` |
| `SMTP_TLS` | `starttls` | `starttls` \| `ssl` \| `off` |

## 2. Data (migration 0027)

- `user`: `is_admin`, `email_verified_at`, `last_login_at`, `google_sub` (unique, for step 3), `avatar_url`,
  `handle` (unique slug, for the public pages later), `session_version` (int, default 0).
  `password_hash` stays NOT NULL; `""` means "no password yet" (an invite not taken up) and never matches.
- `workspace.owner_user_id`, `job.user_id` (indexed), `usage_ledger.user_id` (indexed). No foreign keys: adding
  them means a table rebuild on SQLite.
- `email_token`: `user_id`, `purpose` (`verify` | `reset` | `invite`), `token_hash` (sha256, unique),
  `expires_at`, `used_at`. Lifetimes: verify 48 h, reset 1 h, invite 7 days. Single use; issuing a new link of
  the same purpose retires the older unused one.
- Backfill: every existing user is confirmed (`email_verified_at = created_at`); the `ADMIN_EMAIL` user gets
  `is_admin`; handles from the name; each workspace's first owner becomes `owner_user_id` and owns its old jobs
  and ledger rows.

`app/accounts.create_account()` makes the user, a workspace called "<name>'s studio" and an owner membership.
Sign-up, the admin's invite, `manage.py create-user` and the first-start seed (workspace "Default") all use it.

## 3. Endpoints (`/api/auth`, not in the public API docs)

| method | path | body | returns |
|---|---|---|---|
| GET | `/auth/config` | | `{signup: "open"\|"invite"\|"closed", google: false, verify: bool}` |
| POST | `/auth/signup` | `{email, password (≥ 10), name}` | 202 `{detail}`: the same answer for a new and a known address (a known one gets an "already have an account" email instead). 403 when sign-up isn't open; 422 bad email / short password; 429 over 5 an hour per IP or 3 a day per address |
| GET | `/auth/verify?token=` | | 303 to `/?verified=1` with a session cookie. A used link whose address is confirmed: 303 `/login?verified=1`, no cookie. Unknown or expired: 303 `/verify-email?status=expired` |
| POST | `/auth/verify/resend` | `{email?}` | 200 `{detail}`, always the same. Signed in: resends for the current user, no email needed. 3 an hour per address, 10 an hour per IP (429) |
| POST | `/auth/forgot` | `{email}` | 200 `{detail}`, always the same. Over 3 an hour per address it quietly sends nothing; 10 an hour per IP gives 429 |
| POST | `/auth/reset` | `{token, password}` | `UserOut` + cookie. Takes `reset` and `invite` links; confirms the email; bumps `session_version`. 400 used / expired / unknown; 422 short password |
| POST | `/auth/password` | `{current_password, new_password}` | `UserOut` + a fresh cookie for this browser; every other session ends. 400 wrong current password (not 401, which the app reads as signed out) |
| POST | `/auth/logout-everywhere` | | 204; bumps `session_version`, clears this cookie |
| PATCH | `/auth/me` | `{display_name}` | `UserOut` |
| POST | `/auth/login` | | as before, plus: 10 failures per address in 15 minutes (429); 403 for a switched-off account with the right password; sets `last_login_at` |

`UserOut` gains `verified: bool`.

### Sessions

The cookie now holds `{"uid", "sv"}`. A cookie whose `sv` isn't the user's `session_version` is refused (401).
Cookies from before this version carry no `sv` and count as 0, so nobody is signed out by the upgrade.

### The unverified gate

An unconfirmed user can sign in and look around but can't queue anything: any new `Job` in a request made by
them fails with **403 `Confirm your email to start creating`**. It is one `before_flush` check
(`security._gate_unverified`), so it covers every REST route, API tokens and MCP tools (as a tool error) alike.
`EMAIL_VERIFY=off` turns it off.

Every new job is stamped with the acting user (`models._stamp_user`); the worker stamps child jobs and the
ledger row with the job's user.

## 4. Admin (`/api/admin`, session only, admin only: 404 for everyone else)

`security.is_admin` is now `user.is_admin`, not "owner whose email is ADMIN_EMAIL".

| method | path | body | returns |
|---|---|---|---|
| GET | `/admin/users?q=&status=all\|active\|inactive\|unverified\|admin&limit=` | | `AdminUserOut[]`, newest first |
| POST | `/admin/users` | `{email, name, admin}` | 201 `AdminUserOut`; emails an invite link to `/reset-password?token=…&invite=1`. 409 address taken |
| PATCH | `/admin/users/{id}` | `{display_name?, is_active?, is_admin?, verified?}` | `AdminUserOut`. Switching off signs the user out everywhere and revokes their tokens. 422 when it's your own account and you switch it off or drop admin |
| POST | `/admin/users/{id}/send-reset` | | 202 |
| POST | `/admin/users/{id}/resend-verification` | | 202; 422 already confirmed |

`AdminUserOut`: `id, email, display_name, is_admin, is_active, verified, workspace_id, created_at, last_login_at,
gpu_min_today, gpu_min_month` (UTC day and month, from the ledger), `jobs, tokens` (live ones).

`manage.py create-user --email E --name N [--admin] [--unverified]` (password from `MIXAI_NEW_PASSWORD` or a
prompt). `reset-password` now also signs the user out everywhere. `list-users` shows `[admin, inactive,
unverified]` flags.

## 5. Isolation hardening

- `GET /system/status` gains `queue: {queued, running}` (everyone's: the GPUs are shared). For non-admins:
  `lanes.*.job` is only ever one of their own workspace's jobs, `lanes.*.worker.ids` is gone, and every
  ComfyUI / Ollama `url` is `""` with `error` reduced to "Not reachable".
- `GET /system/comfy-check` and `GET /system/llm-check` are admin only (404).
- **Origin check** (`app/origin.py`): a POST / PUT / PATCH / DELETE without a Bearer header is refused with 403
  when its `Origin` (or, without one, `Referer`) is neither `PUBLIC_URL`, a `CORS_ORIGINS` entry nor the
  request's own host. No Origin and no Referer passes (scripts; they can't carry a victim's cookie).
- **Tokens** stop working (401, and 401 on MCP) when their user is switched off or the API closes to them:
  `PUBLIC_API` off and the user not an admin. A viewer's token stays read-only as before.
- `tests/test_isolation.py`: a second studio gets 404 on the first's projects, characters, brand kits, media
  items and files, generations, thumbs, jobs, poetry and ads; empty lists; no signed-link or MCP way in; its event
  stream and system status show nothing of the first.

## 6. Frontend

- `/login`: "Forgot password?", "New here? Create an account" (when sign-up is open), and notes for
  `?verified=1` / `?reset=1`.
- `/signup`: name, email, password with a strength hint; then "Check your inbox" with a resend button.
- `/verify-email`: the expired-link page, with a resend form.
- `/forgot-password` and `/reset-password?token=` (`&invite=1` words it as "Choose your password").
- A banner across the shell while unverified, with "Send the link again".
- Settings → Account (`/settings/account`): name, email (read-only), change password, sign out everywhere.
- Admin → Users (`/admin/users`, rail entry for admins only): search, status filter, table with a verified
  badge, active switch and admin switch, a details drawer with reset / resend actions, and "Add a user".
