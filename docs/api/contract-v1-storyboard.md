---
title: API contract v1: Storyboard and Render (Milestone 3)
status: Active
created: 2026-10-04
extends: contract-v0.md (all v0 rules apply: auth, errors, ids, SSE, review loop)
---

# API contract v1: Storyboard and Render

## Locations (Cast & World)
`Location = {id, project_id, name, description, source, locked, time_of_day_variants:[str], approved_establishing?: Generation, created_at, updated_at}`

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/projects/{id}/locations` | — | `Location[]` |
| POST | `/projects/{id}/locations` | `{name, description?}` | `201 Location` |
| PATCH | `/locations/{id}` | partial | `Location` |
| DELETE | `/locations/{id}` | — | `204` |
| POST | `/projects/{id}/ai/extract-locations` | — | `Job` (AI reads scene headings and scripts, then upserts locations; same lock rules as characters) |

- `Scene` gains `location_id?`. AI extraction links scenes to locations by heading.
- Establishing frame: `POST /generations {target_type:"location", target_id, kind:"establishing", prompt, params?}` uses Z-Image at the project aspect ratio.

## Shots
`Shot = {id, scene_id, project_id, order, shot_type, duration_s, description, camera, prompt, prompt_mode, character_ids:[id], location_id?, seam_in, handoff_text, status, stale, source, locked, start_frame?: Generation, end_frame?: Generation, approved_take?: Generation, takes_count, created_at, updated_at}`

| Field | Values / meaning |
|---|---|
| `shot_type` | `wide`, `medium`, `close_up`, `extreme_close_up`, `over_shoulder`, `pov`, `insert`, `establishing`, `long_take` |
| `duration_s` | Number, 1–20 for standard shots (long takes later) |
| `prompt_mode` | `auto` (AI compiles the prompts from script + anchors) or `manual` (user-written, locked) |
| `seam_in` | `cut` or `continue`. **`continue` means this shot's START frame is the previous shot's approved END frame** (same file, linked, not copied) |
| `start_frame` / `end_frame` | The **current** (approved, else newest ready) generation of kind `keyframe_start` / `keyframe_end` |
| `status` | Derived: `draft` → `frames_ready` (both frames approved) → `rendering` → `take_ready` → `approved` (a take is approved) |

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/scenes/{id}/shots` | — | `Shot[]` ordered |
| GET | `/projects/{id}/shots` | — | `Shot[]`, all scenes, ordered by scene then shot |
| POST | `/scenes/{id}/shots` | `{shot_type?, duration_s?, description?, after_shot_id?}` | `201 Shot` (source `user`) |
| PATCH | `/shots/{id}` | partial | `Shot`. User edits to `description`, `prompt` or `camera` lock the shot (same rule as scenes) |
| POST | `/scenes/{id}/shots/reorder` | `{shot_ids:[...]}` | `Shot[]` |
| DELETE | `/shots/{id}` | — | `204` |
| POST | `/scenes/{id}/ai/suggest-shots` | `{max_shots?=6}` | `Job`. The AI breaks the scene script into shots (type, duration, description, camera, characters, start/end visual descriptions). It writes directly only when the scene has no user/locked shots; otherwise it creates suggestions |
| POST | `/shots/{id}/ai/compile-prompts` | — | `Job`. The creative LLM writes `start_prompt`, `end_prompt` and `motion_prompt` from the shot plus character/location descriptions and the Style Bible (world reconstruction). Stored on the shot; a no-op when `prompt_mode=manual` |

Shot also carries the text fields `start_prompt`, `end_prompt` and `motion_prompt`. They are shown and editable in the UI; editing them sets `prompt_mode=manual`.

**Staleness:**
- Editing a scene script marks its shots `stale=true`.
- A new approved END frame marks the next shot (when `seam_in=continue`) and its takes `stale=true`.
- A new approved START or END frame marks that shot's takes `stale=true`.
- `POST /shots/{id}/clear-stale` resets the flag.

## Storyboard from script (one click; the primary flow)
The product owner's main flow: the storyboard is built from the script, with a **first and last frame per scene**.

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/projects/{id}/storyboard` | `{mode?="scene", scene_ids?:[id], generate_frames?=true, overwrite?=false}` | `Job` (parent). Progress and messages over SSE; child keyframe jobs are queued as it goes |

**`mode`:**
- `"scene"` (default): **one shot per scene**. The shot's description and duration come from the scene's script. The AI (creative model) writes `start_prompt` = how the scene **opens**, `end_prompt` = how it **ends**, and `motion_prompt` = what happens in between. `duration_s` comes from the script length, with dialogue words timed at a natural speaking rate, clamped to 2–20 s.
- `"shots"`: runs `suggest-shots` per scene first (several shots per scene), then compiles prompts per shot.

**Other parameters:**
- `scene_ids`: limit to some scenes (default: all scenes in order).
- `overwrite=false`: scenes that already have shots are skipped. Locked or user shots are never touched; suggestions apply instead.

**Seams:**
- **Between scenes:** `cut`.
- **Inside a scene (mode `shots`):** `continue` where the AI marks continuous action.
- **Optional `continuity:"chain"` (bool, default false):** sets `seam_in=continue` between consecutive scenes as well, so scene N+1 opens on scene N's last frame. Each scene's last frame is then available as the next scene's first frame.

**Frames:**
- With `generate_frames=true`, the job queues `keyframe_start` and `keyframe_end` for every shot, in order.
- With chain continuity, each next START is linked to the previous END, not generated.
- References (approved character portraits plus the location establishing frame) are attached automatically, as described in Keyframes below.

## Keyframes (Storyboard)
Keyframes use the shared generations API with `target_type:"shot"`:

- **Start frame:** `POST /generations {target_type:"shot", target_id, kind:"keyframe_start", prompt?, params?}`
- **End frame:** the same with `kind:"keyframe_end"`.
- If `prompt` is empty, the server uses the shot's `start_prompt` / `end_prompt`, and compiles them first if they're missing.
- **References:** the server automatically passes the approved portrait (or front sheet view) of each character in `character_ids`, plus the approved establishing frame of `location_id`, as `params.reference_ids`. With references it uses the `qwen_edit` template (up to 3 images, prioritised: characters, then location); without them, `zimage_t2i` at the project aspect ratio.
- **Continue seam:** requesting `keyframe_start` for a shot with `seam_in=continue` returns `409` with detail "linked to previous shot's end frame". The UI shows the linked frame instead. `GET /shots/{id}` returns the previous shot's approved END generation as `start_frame`, plus `start_linked: true`.
- Review actions (approve / regenerate / with note / edit / reject / versions) are exactly as in v0.

## Takes (Render)
- **Request:** `POST /generations {target_type:"shot", target_id, kind:"take", params?: {seed?, duration_s?}}`
- **Server checks:** the shot must have an approved (or linked) START frame. The END frame is optional; without it the take is I2V from the start frame only.
- **Server fills in:**
  - `params.first_frame_id` and `params.last_frame_id`;
  - `num_frames` from `duration_s` (8n+1);
  - the size from the project aspect at draft resolution (16:9 → 768×432, snapped to a multiple of 32; 9:16 → 432×768; 1:1 → 576×576; 2.39:1 → 1024×428);
  - the prompt = `motion_prompt` (compiled if missing) plus world anchors.
- **Batch:** `POST /shots/{id}/takes` `{count?=project.takes_per_shot}` → `Job[]`, one take per seed, queued back to back (keeps LTX warm).
- **Scene batch:** `POST /scenes/{id}/render` `{count?}` → `Job[]` for every shot with approved frames. Ordered by shot, so a Continue seam's END frame is final before the next shot renders.
- Approving a take sets the shot's `approved_take`. Only one approved take per shot (v0 rule).

## Events
- **Generation events:** unchanged.
- **New SSE event `shot`:** data is `Shot`, emitted on status, stale and frame/take changes.

## Implementation notes (backend, M3) — read these, they pin down details the sections above leave open
- **Draft take sizes** are snapped to /32 as stated, so the real values are: 16:9 → **768×448**, 9:16 → **448×768**, 1:1 → 576×576, 2.39:1 → **1024×416**, 4:3 → 640×480. Takes are capped at 257 frames (~10.7 s at 24 fps) until the long-take templates land; `params.duration_s` keeps the requested length.
- **Project** gains `style_bible` (string, default `""`, settable on create/PATCH). Frame, establishing and take prompts end with it verbatim; compile-prompts passes it to the LLM.
- **Extra routes:** `GET /shots/{id}` and `GET /locations/{id}`. `POST /shots/{id}/takes` and `POST /scenes/{id}/render` return **202** with `Job[]`. Scene render answers `409` when no shot has an approved (or linked) START.
- **POST /scenes/{id}/shots** also accepts `camera`, `character_ids`, `location_id` (defaults to the scene's) and `seam_in` (default `cut`). It locks the shot when a description is given.
- **Shot** carries `start_linked` on every response (list, single, SSE). For a linked shot `start_frame` is the previous shot's *current* END (approved, else newest ready) so the UI can show it early; a take still needs that END **approved**. A Continue seam on the film's first shot behaves as a cut. `frames_ready` = both START (or linked END) and END approved.
- **Staleness detail:** approving a START/END marks the shot stale only if it has takes; a new approved END marks the next Continue shot stale only if that shot has frames or takes. Changing `seam_in` on a shot that has generations, or deleting the shot before a Continue shot, also marks stale.
- **Generation params the server adds:** `aspect_ratio`, `reference_ids` + `reference_labels` (names, for the inspector's "refs used"), and for takes `first_frame_id`, `last_frame_id` (null without END), `duration_s`, `fps`, `num_frames`, `width`, `height`. An empty prompt sets `compile_first: true`; the worker writes the shot's prompts with the creative LLM before rendering (`job.message` "Writing this shot's prompts first…"), stores them on the shot and the prompt on the generation. `kind:"establishing"` is new in the `kind` enum. Non-shot/location targets still need a prompt (`422`).
- **Shot suggestions:** when suggest-shots or storyboard (overwrite) meets user/locked shots, or shots with approved work, it creates a `Suggestion` with `target_type:"scene"`, `field:"shots"`, `proposed_text` = JSON array of shot plans. Accepting it **replaces** the scene's shots (source `ai_edited`, locked). Location descriptions use `target_type:"location"`, `field:"description"`; accept returns `{suggestion, location}`.
- **Storyboard body:** `continuity` accepts `"chain"` or `true`; `max_shots` (default 6) applies to mode `shots`. A queued/running storyboard job for the project is returned instead of a second one; `409` when no selected scene has a script. `job.result`: `scene_ids`, `skipped_scene_ids`, `shot_ids`, `suggestion_ids`, `generation_ids`, `frame_job_ids`, `outcome`, `calls`.
- **AI job types:** `ai_storyboard`, `ai_suggest_shots`, `ai_compile_prompts`, `ai_extract_locations` (`job.result`: `location_ids`, `created_ids`, `updated_ids`, `suggestion_ids`, `scene_ids` linked).
