---
title: API contract v0 (Milestone 1 — Foundation)
status: Active
created: 2026-10-04
---

# API contract v0

- **Base path:** `/api`. All JSON uses snake_case.
- **Auth:** session cookie `mixai_session` (HttpOnly, SameSite=Lax, Secure when `APP_ENV=prod`).
- **Access:** every route except `POST /api/auth/login` and `GET /api/health` needs a session. Without one the API returns `401 {"detail": "..."}`.
- **Errors:** `{"detail": "human readable message"}` with the matching HTTP status. Validation errors use FastAPI's default 422 shape.
- **IDs:** UUID4 strings. **Timestamps:** ISO-8601 UTC.

## Auth
| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/auth/login` | `{email, password}` | `200 User` + cookie. `401` on bad credentials. |
| POST | `/auth/logout` | — | `204`, clears the cookie |
| GET | `/auth/me` | — | `User` |

`User = {id, email, display_name, workspace_id, role}`. `role` is `owner`, `editor` or `viewer` (single user = owner).

## System
| Method | Path | Returns |
|---|---|---|
| GET | `/health` | `{status:"ok"}`, no auth |
| GET | `/system/status` | `{comfy:{ok, url, version?, devices?:[{name, vram_total, vram_free}], error?}, llm:{ok, url, models?:[str], error?}, driver:"mock"\|"comfy", worker:{alive:bool, last_heartbeat?}}` |

## Projects
`Project = {id, title, logline, authoring_mode, aspect_ratio, target_runtime_s, quality, takes_per_shot, overnight, status, created_at, updated_at, thumbnail_url?, counts:{scenes, shots, characters}}`
- `authoring_mode`: `ai_director` \| `scene_by_scene` \| `import`
- `quality`: `draft` \| `final`
- `status`: `draft` \| `in_progress` \| `rendering` \| `done`

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/projects` | — | `Project[]`, newest updated first |
| POST | `/projects` | `{title, authoring_mode, logline?, aspect_ratio?="16:9", target_runtime_s?=120, quality?="draft", takes_per_shot?=3, overnight?=false, brief?}` | `201 Project` |
| GET | `/projects/{id}` | — | `Project` |
| PATCH | `/projects/{id}` | partial fields | `Project` |
| DELETE | `/projects/{id}` | — | `204` |

## Scenes (script)
`Scene = {id, project_id, order, heading, logline, script_text, summary, time_of_day, mood, lighting, source, locked, version, stale, created_at, updated_at}`
- `source`: `user` \| `ai` \| `ai_edited`
- `time_of_day`: `dawn|morning|day|golden_hour|dusk|night|interior` or null
- **Lock rule:** any PATCH from the user that changes `heading`, `logline` or `script_text` sets `source` to `user` (or to `ai_edited` if it was `ai`) and sets `locked=true`. Each such edit increments `version` and saves a `scene_version` row.

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/projects/{id}/scenes` | — | `Scene[]` ordered |
| POST | `/projects/{id}/scenes` | `{heading?, logline?, script_text?, after_scene_id?}` | `201 Scene` (source `user`) |
| PATCH | `/scenes/{id}` | partial | `Scene` |
| POST | `/projects/{id}/scenes/reorder` | `{scene_ids:[...]}` | `Scene[]` |
| DELETE | `/scenes/{id}` | — | `204` |

## Characters (Cast & World, minimal in M1)
`Character = {id, project_id, name, description, source, locked, approved_portrait?: Generation}`

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/projects/{id}/characters` | — | `Character[]` |
| POST | `/projects/{id}/characters` | `{name, description?}` | `201 Character` |
| PATCH | `/characters/{id}` | partial | `Character` |
| DELETE | `/characters/{id}` | — | `204` |

## Generations (shared review loop)
`Generation = {id, target_type, target_id, kind, version, status, prompt, params, seed, media_url?, media_type?, score?, note?, created_at, approved_at?, parent_id?, job_id?}`
- `target_type`: `character` \| `scene` \| `shot` \| `location` \| `project`
- `kind`: `portrait` \| `sheet_view` \| `keyframe_start` \| `keyframe_end` \| `keyframe_mid` \| `take` \| `tile` \| `render` \| `scene_text`
- `status`: `queued` \| `generating` \| `ready` \| `approved` \| `rejected` \| `failed`
- **Rule:** at most one `approved` generation per (`target_type`, `target_id`, `kind`). Approving a new one sets the previous approved one back to `ready`.

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/generations?target_type=&target_id=&kind=&include_rejected=false` | — | `Generation[]`, newest version first |
| POST | `/generations` | `{target_type, target_id, kind, prompt, params?}` | `201 Generation` (queued) plus a job |
| POST | `/generations/{id}/regenerate` | `{mode:"same"\|"note"\|"edit", note?, prompt?, params?}` | `201 Generation` (new version, `parent_id` = this one) |
| POST | `/generations/{id}/approve` | — | `Generation` |
| POST | `/generations/{id}/unapprove` | — | `Generation` (status back to `ready`) |
| POST | `/generations/{id}/reject` | `{reason?}` | `Generation` |
| POST | `/generations/{id}/restore` | — | `Generation` (from rejected back to ready) |

Regenerating with `mode=note` in M1 (mock driver) appends the note to the prompt. In M2 the creative LLM rewrites the prompt from the note.

## Jobs and events
`Job = {id, type, status, progress (0..1), message, project_id?, generation_id?, gpu?, attempts, error?, created_at, started_at?, finished_at?, gpu_seconds?}`
- `status`: `queued` \| `running` \| `done` \| `failed` \| `cancelled`

| Method | Path | Returns |
|---|---|---|
| GET | `/jobs?status=&project_id=` | `Job[]` (most recent 100) |
| POST | `/jobs/{id}/cancel` | `Job` |
| POST | `/jobs/{id}/retry` | `Job` (failed or cancelled → queued) |
| GET | `/events` | **SSE** stream. Event `job` with data `Job`; event `generation` with data `Generation`; a `ping` comment every 15 s. Supports `Last-Event-ID` (best effort). |

## Media
`GET /media/{path}` serves files under `DATA_DIR` only, behind the session check. It refuses any path that resolves outside `DATA_DIR` (404). `media_url` fields point to this route.

## AI (Milestone 2b: LLM writing)
All AI actions are **jobs**: the POST returns `202 Job` (status `queued`) and the client follows it over `/events` like any other job. `job.message` carries human-readable progress ("Writing scene 2 of 4: EXT. HARBOUR - DAWN… 35 s"); a model's first call says it is loading. `Job.result` (now part of `Job`) holds the output:

`AiJobResult = {thinking?, prompt?, outcome?: "written"|"suggested"|"unchanged", scene_ids?, drafted_ids?, character_ids?, created_ids?, updated_ids?, suggestion_ids?, calls: [{role, model, seconds, prompt_tokens, completion_tokens, step}]}`
- `thinking` is the reasoning model's trace (the "Director's reasoning" panel). The outline job publishes `thinking`, `scene_ids` and a growing `drafted_ids` while it runs.
- A failed `ai_outline` job keeps its partial scenes; `POST /jobs/{id}/retry` resumes it (drafts only the empty ones).

**LLM roles** (all from `.env`, never hardcoded): `LLM_MODEL_REASONING` plans structure (outline, what happens next); `LLM_MODEL_CREATIVE` writes prose, prompts, summaries and repairs invalid JSON; `LLM_MODEL_VISION` is reserved for scoring. Only the reasoning role may think; creative/vision calls go out with thinking off (`think:false` on Ollama's native `/api/chat`, `reasoning_effort:"none"` on plain OpenAI-compatible servers). `LLM_API=auto|ollama|openai`, `LLM_NUM_CTX`, `LLM_TIMEOUT_S` tune the client.

**Lock rule for AI writes:** AI writes a field directly only if it is empty, or the scene/character is an untouched AI draft (`source="ai"`, `locked=false`). Otherwise it creates a `Suggestion`. Direct writes set `source="ai"` (or `ai_edited` when AI filled an empty field of a user scene), bump `version` and save a `scene_version`. Accepting a suggestion applies the text, sets `source="ai_edited"`, `locked=true`, bumps `version` and saves a `scene_version`. A new suggestion for the same field replaces (rejects) the older pending one.

`Suggestion = {id, project_id, target_type: "scene"|"character", target_id, field: "heading"|"logline"|"script_text"|"description", current_text, proposed_text, action, status: "pending"|"accepted"|"rejected", job_id?, created_at, resolved_at?}`

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/projects/{id}/ai/outline` | — | `202 Job` (`ai_outline`). AI Director: structure from brief + `target_runtime_s` (reasoning), each scene drafted (creative), cast described. `409` if the project already has written scenes (empty stubs are replaced); returns the running job if one is queued/running. |
| POST | `/projects/{id}/ai/write-missing` | `{scene_ids?, after_scene_id?, count?}` | `202 Job` (`ai_write_missing`). Drafts every empty scene (or the listed ones) using neighbours N-2..N+2, characters and logline. With no empty scenes and `after_scene_id`, inserts `count` new scenes there. `409` when nothing is empty. |
| POST | `/projects/{id}/ai/continue` | `{count?: 1..10}` | `202 Job` (`ai_continue`): plans and writes the next scene(s) after the last. |
| POST | `/projects/{id}/ai/extract-characters` | — | `202 Job` (`ai_extract_characters`): upserts characters by name with image-ready physical descriptions; locked/user descriptions get a suggestion instead. |
| POST | `/scenes/{id}/ai/assist` | `{action, idea?, tone?}` | `202 Job` (`ai_assist`). `action`: `draft_from_idea` (needs `idea`) \| `expand` \| `tighten` \| `rewrite_tone` (needs `tone`) \| `write_dialogue` \| `suggest_logline`. Script actions need existing script text (`409`). |
| POST | `/characters/{id}/ai/portrait-prompt` | — | `202 Job` (`ai_portrait_prompt`); `result.prompt` is a head-and-shoulders, neutral-background portrait prompt. Nothing is written to the character. |
| GET | `/projects/{id}/suggestions?status=pending&target_id=` | — | `Suggestion[]`, newest first (`status` accepts a comma list; empty = all) |
| POST | `/suggestions/{id}/accept` | — | `{suggestion, scene?, character?}` (`409` if no longer pending) |
| POST | `/suggestions/{id}/reject` | — | `{suggestion}` |
| GET | `/system/llm-check?ping=true` | — | `{ok, url, reasoning_format, roles: {reasoning\|creative\|vision: {model, present, latency_ms?, error?}}, error?}`; pings each role with a 1-token call, one at a time (a cold model load can take minutes). |

**Scene summaries:** any script change (user PATCH, AI write, accepted suggestion) queues one low-priority `ai_summarize` job per scene (de-duplicated while queued). It waits until the scene has been quiet for 8 s, then stores a two-sentence continuity note in `scene.summary`, used as context for later AI writing.

**Regenerate with note** (`POST /generations/{id}/regenerate`, `mode="note"`): the creative model rewrites the previous prompt from the note before the new generation is queued. If the LLM is unavailable, the note is appended as before and the new job's `message` says so ("note appended, AI rewrite unavailable (…)").
