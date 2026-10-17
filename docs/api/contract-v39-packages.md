---
title: "Contract v39: Packages, quota, fair queue and the admin panel (M17 step 2)"
status: Active
created: 2026-10-17
extends: contract-v38 (accounts)
migration: 0028_packages
plan: docs/PLAN-m17-accounts.md (D, as changed on 2026-10-17: packages and a full admin panel)
---

# Contract v39: Packages

Limits now come from **packages** the admin manages, not from `.env`. Each person has at most one active
**subscription** to a package; with none (or once it ends) they are on **Free**. The admin can add **usage
grants** (extra minutes) and a per-user **override**. New top-level work over the limit is refused with 429;
running work is never stopped. The worker shares the GPUs fairly between people. No new settings.

## 1. Data (migration 0028)

- `package`: `slug` (unique; `free` / `demo` / `pro` for the seeded ones, `free` is the fallback), `name`,
  `description`, `price_pkr` (int, may be 0), `period` (`day|week|month|year|none`), `days` (a demo's length, or
  an assignment's length when the period is `none`), `gpu_min_day`, `gpu_min_month`, `max_queued` (null = no
  limit), `private_items` (stored for the public gallery later), `models` (allowed model ids, null = all),
  `features` (`{feature: false}` switches a studio off; anything not named is on), `kind`
  (`standard|demo|custom`), `public` (pricing page), `custom_for_user_id`, `active` (false = archived), `sort`.
- `subscription`: `user_id`, `package_id`, `starts_at`, `ends_at` (null = open-ended), `status`
  (`active|expired|cancelled|pending_payment`), `source` (`admin|demo|payment|signup_default`), `notes`,
  `granted_by`. One active per user: assigning cancels whatever was active.
- `usage_grant`: `user_id`, `gpu_min`, `reason`, `starts_at`, `expires_at`, `revoked_at`, `granted_by`.
- `payment`: `user_id`, `subscription_id`, `package_id`, `gateway` (free text; `manual` by default), `amount_pkr`,
  `status` (`pending|paid|failed|refunded`), `reference`, `raw` (JSON callback, for M19), `notes`.
- `admin_audit`: `actor_user_id`, `actor_email`, `action`, `target_type`, `target_id`, `detail` (JSON).
- `user` gains `limit_gpu_min_day`, `limit_gpu_min_month`, `limit_max_queued` (the override; null = the package's).
- Index `ix_job_user_lane_started (user_id, lane, started_at)` for the fair queue.
- Seeds: **Free** (30 GPU min/day, 2 at once, fallback), **Demo (7 days)** (120/day, 4 at once, kind demo, not
  public), **Pro** (240/day, 6 at once, monthly). Prices are seeded at 0; the admin sets them. Every existing
  non-admin user gets an active Free subscription (`signup_default`); admins get none. New accounts get the
  same from `accounts.create_account`. A database with no package rows (fresh dev) is seeded on start.

## 2. Effective limits

`quota.limits_for(user)`:
1. Admins: unlimited (no minutes, queue, model or studio limits).
2. The live subscription's package (`status=active`, started, not ended); otherwise Free; if even Free is
   missing, 30/day and 2 at once.
3. The user's override replaces a package value where set.
4. Live grants add their `gpu_min` to the daily limit (and to the monthly one, when there is one) every day
   while live. A grant with no expiry ends at the next UTC midnight: a top-up for today.

Usage is `usage_ledger.gpu_seconds` by `user_id` since the UTC day (or month) start.

## 3. The check

One `before_flush` hook (`quota._check_new_jobs`), for jobs made in a request (cookie session, token REST call
or MCP tool: `security.bind_session` marks the session). The worker's sessions aren't marked, so child jobs of
accepted work always go through; jobs whose payload has `parent_job_id` / `inline_of` are exempt anywhere.
Per transaction, the minutes / queue check runs once (a batch of four counts as one request); studio and model
checks run for every new job.

**429** (minutes or queue), a flat JSON body:

```json
{"detail": "You've used today's 30 GPU minutes. They come back at midnight UTC.",
 "reason": "day" | "month" | "queued", "used_min": 30.0, "limit_min": 30.0,
 "resets_at": "2026-10-18T00:00:00Z", "queued": null, "max_queued": null}
```

- `day`: used today ≥ daily limit. `month`: used this month ≥ monthly limit (resets on the 1st).
- `queued`: the user's queued + running top-level jobs ≥ `max_queued` (`resets_at` null; `queued` /
  `max_queued` filled).
- MCP tools get it as a tool error with the same `detail`.

**403** for a studio or model the package leaves out, e.g. `The Free package doesn't include Ad Studio`,
`The One model package doesn't include the model 'zimage_turbo'. Choose another one.`,
`… doesn't include the API or MCP` (token and MCP calls only).

Studios are worked out from the new job (`quota.features_of`): `ad_*` → ads, `poetry_*` → poetry,
`podcast_*` / `video_podcast*` → podcast, `dub_*` → dub, `story_*` → stories, `character_*` /
`ai_character*` / generations on a character → character, `autopilot` / `reel_*` / `upscale` → video, and a
generate job by its generation's kind (image / video / audio). Models: the generation's
`params.model_resolved` must be in `package.models`.

Feature keys: `image, video, audio, character, ads, poetry, podcast, dub, stories, api`.

## 4. Fair queue (`worker.claim_next`)

Order among claimable jobs: **priority** (desc), then the job owner's **running jobs in that lane** (fewest
first), then the owner's **last start in that lane** (longest ago first, never first), then `created_at`.
Priority stays first on purpose: a parent waiting on its children sits at `WAIT_PRIORITY` and must not jump
other people's work (it would defer and be claimed straight back). The `SERIAL_PER_PROJECT` rule is unchanged.

## 5. Expiry

Reads treat an active subscription past `ends_at` as expired (`packages.status_of`). The rows are updated by
`packages.expire_due`: the worker runs it every 5 minutes, and `GET /account/usage` and
`GET /admin/subscriptions` run it first.

## 6. User endpoint

`GET /api/account/usage` (session or token, any role):

```json
{"package": {"id", "name", "kind"}, "unlimited": false, "gpu_min_day": 30, "gpu_min_month": null,
 "max_queued": 2, "grant_min": 0, "used_min_today": 12.0, "used_min_month": 40.0, "queued": 1,
 "resets_at": "…T00:00:00Z", "month_resets_at": "…", "subscription": {"id", "status", "starts_at", "ends_at",
 "source"} | null, "features": {"image": true, …}, "models": null}
```

Admins: `unlimited: true`, package `{"id": null, "name": "Unlimited", "kind": "admin"}`, limits null.

## 7. Admin (`/api/admin`, session only, admins only: 404 for everyone else)

Every write below (and the v38 ones: create user, patch user, send reset, resend verification, mark-api with
`apply`) adds an `admin_audit` row.

| method | path | body / query | returns |
|---|---|---|---|
| GET | `/admin/overview` | | `{users: {total, new_week, active_today}, subscriptions: [{package_id, name, count}], payments_month: {count, paid_pkr, pending}, gpu_today: [{user_id, email, display_name, gpu_min}], queue: {queued, running, lanes}, workers: {live, stale, lanes, idle_lanes}}` |
| GET | `/admin/users` | v38 + `package_id=` (Free also matches people with nothing active) | `AdminUserOut[]`, which gains `package_id, package_name` ("Unlimited" for admins), `subscription_ends_at, gpu_min_day_limit` |
| GET | `/admin/users/{id}` | | `{user, usage (as §6), limits_override, subscription, subscriptions, grants, payments, recent_jobs, had_demo}` |
| PATCH | `/admin/users/{id}` | v38 + `limit_gpu_min_day?, limit_gpu_min_month?, limit_max_queued?` (null clears) | `AdminUserOut` |
| POST | `/admin/users/{id}/subscription` | `{package_id, starts_at?, ends_at?, notes?}` | 201 `SubscriptionOut`. Default end from the period (`day` 1, `week` 7, `month` 30, `year` 365 days; `none` → `days` or open-ended). 422 archived, someone else's custom package, end before start |
| POST | `/admin/users/{id}/demo` | `{package_id?, allow_repeat?, notes?}` | 201; 409 when they've had a demo and `allow_repeat` isn't set |
| POST | `/admin/users/{id}/grants` | `{gpu_min > 0, reason?, expires_at?}` | 201 `GrantOut` (`live`) |
| POST | `/admin/grants/{id}/revoke` | | `GrantOut` |
| POST | `/admin/users/{id}/custom-package` | package fields + `starts_at?, ends_at?` | 201 `SubscriptionOut`: a `custom` package for them, assigned at once |
| GET | `/admin/subscriptions` | `status=active\|expiring\|expired\|cancelled\|pending_payment\|all` (`expiring` = active, ending in the next 7 days), `package_id=, user_id=, limit=` | `SubscriptionOut[]` (`user_email`, `package_name`) |
| POST | `/admin/subscriptions/{id}/extend` | `{days}` or `{ends_at}` | from the later of its end and now; an expired / cancelled one comes back (409 if another is active) |
| POST | `/admin/subscriptions/{id}/cancel` | | 422 unless active or pending_payment |
| GET | `/admin/packages` | `archived=false, custom=true` | `PackageOut[]` with `subscribers` |
| POST | `/admin/packages` | `PackageIn` | 201; unknown model ids or feature keys 422; `custom_for_user_id` makes it custom and hidden |
| PATCH | `/admin/packages/{id}` | only what's sent; null clears a limit | Free can't be archived (422) |
| POST | `/admin/packages/{id}/duplicate` \| `/archive` \| `/restore` | | archived packages can't be given out; people on them keep them |
| GET | `/admin/payments` | `status=all\|pending\|paid\|failed\|refunded, gateway=, user_id=, limit=` | `PaymentOut[]` |
| GET | `/admin/payments/{id}` | | `PaymentDetail` (+ `raw`) |
| POST | `/admin/payments` | `{user_id, amount_pkr, package_id?, subscription_id?, gateway?, reference?, status: pending\|paid, notes?}` | 201. With a package: `pending` makes a `pending_payment` subscription, `paid` assigns it at once |
| POST | `/admin/payments/{id}/mark` | `{status: paid\|refunded\|failed, notes?}` | paid from pending/failed (activates a pending_payment subscription, keeping its length); refunded from paid; failed from pending; else 409. A refund doesn't cancel the subscription by itself |
| GET | `/admin/usage` | `days=30 (1-366), user_id=` | `{days, rows: [{day, user_id, email, display_name, gpu_min, jobs}], top, total_min}` |
| GET | `/admin/usage.csv` | same | `text/csv` attachment: `day,user_id,email,name,gpu_minutes,jobs` |
| GET | `/admin/audit` | `action=` (prefix), `target_id=`, `q=` (admin email), `limit=` | `AuditOut[]` newest first |

No payment gateway is called in this version (M19).

## 8. Frontend

- `/admin` is a section with its own sub-navigation: Overview, Users, Packages, Subscriptions, Payments,
  Usage, Audit log. The rail entry and the user-menu item now say **Admin** and open `/admin`.
- Users: a package column and filter; the drawer shows the package, today's meter, and actions: change package
  (with dates), start a demo, grant minutes, custom package, extend / cancel, own limits, grants (withdraw),
  payments and recent jobs.
- Packages: table with prices in PKR, a form (limits, studios, models, pricing-page and private-items
  switches), duplicate, archive / restore.
- Settings → Account: a Package card with "12 of 30 min today, resets 05:00" (local time) and a bar.
- The user menu shows the package badge. Generate buttons add "N GPU min left today" when a fifth or less (or
  five minutes or less) is left, and say when they come back at zero; the button stays usable.
- Any 429 with the body above shows a calm toast ("That's today's GPU time" / "Your queue is full for now")
  with "See usage", and refreshes the meter (`lib/api.onQuota`, wired in `main.tsx`).
