---
title: "Contract v34: what the API makes stays out of the app"
status: Active
created: 2026-10-15
extends: contract-v27 (token API), MCP server (docs/api/mcp.md)
migration: 0022_via_api
---

# Contract v34: what the API makes stays out of the app

Work created through the token REST API (a `Bearer mxa_…` header on the ordinary `/api` routes: BlogCreatorPro,
scripts, Swagger) is not shown in the studio app. Work created in the app (cookie session) or through the MCP
server (`/api/mcp`) is. API clients keep seeing and fetching everything in their workspace, as before.

## 1. Channels

`security.CurrentUser.channel`:

| channel | how | lists in the app |
|---|---|---|
| `app` | session cookie | API rows left out |
| `api` | Bearer token on a REST route (`authenticate`) | everything |
| `mcp` | Bearer token on `/api/mcp` (`mcp_server.acting`) | everything |

## 2. The flag

`via_api` (boolean, default false, indexed) on `project`, `character`, `generation`, `job`, `media_item`,
`folder`, `album`, `brand_kit`, `look`, `voice_profile`, `voice_script`, `dub_project`, `transcript`,
`podcast_show`, `podcast_episode`, `video_podcast`, `user_template`, `poetry_short`.

- A token request marks its DB session (`Session.info["via_api"]`); a `before_flush` listener stamps every new
  row of those tables. A session flag rather than a contextvar: FastAPI runs sync dependencies in a copied
  context, so a contextvar set while authenticating never reaches the route.
- The worker sets the same flag from `job.via_api` for the whole of `run_job`, finished hooks included. Results,
  Library items, child jobs (autopilot, video podcast, Poetry Shorts, character sheets, story music) of an API
  job are API rows too; an app job's are not.
- Rows a later app request adds to an API row (a new version of an API item, say) are app rows. Adding a gallery
  voice in the app that an API client had added first clears its flag.

## 3. What the app leaves out

With `channel == "app"`: `GET /media` (Library, folders, favourites, dashboard), `/photos` (+ facets, neighbours),
`/folders` (and their counts), `/albums`, `/projects`, `/quick/recent`, `/characters`, `/voices`, `/voices/gallery`
(the "added" mark), `/scripts`, `/dubs`, `/transcripts`, `/podcast/shows`, `/podcast/episodes`, `/poetry`,
`/brand-kits`, `/looks`, `/my-templates`, `/templates`, `/upscales`, `/jobs`, `/dashboard`, `/mentions`, and the
`/events` stream (jobs, generations, media; shots and reels by their project's flag).

Project results in the Library are read-through generations, so their `generation.via_api` decides.

`GET` by id is unchanged: the app can still open an API item from an old link.

## 4. Admin view

`?via=` on any of the lists above, honoured only for the admin (`security.is_admin`) on a cookie session:

| value | lists |
|---|---|
| (none) / `app` | app rows only |
| `api` | API rows only |
| `all` | both |

Anyone else's `via` is ignored (they get the default). `/auth/me` carries `admin: true` for the admin; the
Library and the Queue show a **Made through the API** chip to the admin only (off by default). The Queue's API
view polls every 10 s, since the event stream leaves those jobs out.

## 5. Rows from before the flag

Past token use wasn't recorded per row.

- Migration 0022 marks the story jobs (`story_audio`, `story_video`, API-only) and what they used: the music
  bed's generation, the pages' and title card's generations (found by file path), their Library items and
  those items' other versions.
- `POST /api/admin/mark-api` (cookie, admin only, 404 otherwise, not in the OpenAPI): body
  `{ids?, since?, until?, kinds?, apply = false}`. Ids of any kind pull in what hangs off them (an item's
  versions and jobs, a project's results, cast and jobs, a job's generation, children and story pictures);
  `since` / `until` (UTC, until exclusive) take every row of `kinds` created in the window. Answers
  `{apply, counts, already, sample, unknown_ids?}`; nothing is written unless `apply`.
- `scripts/mark-api-items.py` does the same from the server shell, across workspaces unless `--workspace`:

```bash
cd backend
uv run python ../scripts/mark-api-items.py --ids <id>,<id>            # dry run
uv run python ../scripts/mark-api-items.py --since 2026-10-14T09:00 --until 2026-10-14T18:00 --kinds media,job,generation
uv run python ../scripts/mark-api-items.py --ids <id> --apply
```

Kinds: `media generation job project character voice script dub transcript podcast_show podcast_episode
video_podcast poetry brand_kit template folder album look`.

## 6. Not covered

Clients, saved filters, scenes, shots and locations have no flag of their own (they live inside a project or
are per-user). Smart-album and client photo counts still count API photos.
