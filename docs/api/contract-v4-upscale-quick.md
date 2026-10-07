---
title: API contract v4: Upscale and Quick Create (Milestone 5)
status: Active
created: 2026-10-07
extends: contract-v0..v3
---

# API contract v4: Upscale and Quick Create

## Upscale
`POST /api/generations/{id}/upscale {engine: "best"|"fast"|"quick", target: "1080p"|"1440p"|"4k"}` → `202 Job`
- Allowed on generations of kind `render` (stitched videos). Later possibly `take`.
- **Engines:** `best` = SeedVR2, `fast` = FlashVSR, `quick` = RealESRGAN ×4 frame-wise. Defaults are chosen by the benchmark and exposed via the options endpoint below.
- **Target size:** fit-inside, keeping the aspect ratio. The scale is limited to what the engine supports, with downscaling after if needed. Even dimensions.
- **Creates a new `Generation(kind="render", target_type="project")`** with `parent_id` = the source and `params`:
  - `upscale: {engine, target, width, height, source_id}`;
  - `title`: the source title plus " · 1080p";
  - `segments: [{idx, t_start, t_end, status, file?}]`;
  - `scene_ids` and `scene_range` copied from the source.
- **Pipeline:**
  - Split into overlapping segments (`UPSCALE_SEGMENT_S`, default 4; overlap `UPSCALE_OVERLAP_S`, default 0.5).
  - Upscale each segment in ComfyUI. Segment files are checkpointed for resume.
  - Join the segments with a short video crossfade in the overlaps.
  - Remux the **original audio stream untouched**.
  - `job.message` shows "Segment i of N".
  - Cancel is supported.

`GET /api/system/upscale-options` → `{engines:[{id, label, available, reason?, scales:[...], est_gpu_s_per_output_s}], default_engine, targets:[...]}`. Availability comes from the template checks (missing nodes or models mean unavailable, with a reason).

**As built (M5A):**
- Body also takes `variant: "3b"|"7b"` (engine `best` only; default `UPSCALE_SEEDVR2_MODEL`). `engine` may be omitted (= `UPSCALE_DEFAULT_ENGINE`, default `best`) and accepts the aliases `seedvr2`, `flashvsr`, `esrgan`. `target` defaults to `1080p`.
- Errors: `422` with a readable `detail` when the source isn't a finished render, is already at/above the target, or the engine is known to be missing on the GPU server. Posting the same source/engine/target/variant while one is queued or running returns that job.
- Vertical sources use a vertical box (1080p for 9:16 = 1080x1920 box).
- Job `type="upscale"`; the new render's `params.upscale` also has `variant, template, engine_width, engine_height, engine_scale, source_size`; when done: `size`, `duration_s`, `upscale_stats {segments, gpu_seconds, gpu_per_output_s, rate_mp, join, ...}`. Segment `file` keys are dropped after a successful join (checkpoints are deleted).
- `params.title_auto=false`; `chapters` copied from the source. The Reel's `last_render` can now be an upscaled version (it is the newest whole-film render).
- Options: each engine also has `description`, `max_scale`, `estimate_source: "provisional"|"measured"`, `template`, `warning?` (FlashVSR weights), and for `best` `variants` + `default_variant`. `est_gpu_s_per_output_s` is quoted at a 1536x896 output. `targets: [{id, label, width, height}]`.
- `GET /api/system/upscale-options?generation_id=…` adds `source {width, height, duration_s}` and `estimates {engine: {target: {allowed, width, height, engine_scale, est_gpu_s, rate_gpu_s_per_output_s, estimate_source} | {allowed:false, reason}}}`.
- Autopilot (backend) queues via `app.upscale.queue_upscale(db, source, engine, target, variant, user_id, flow)`.

## Quick Create
`POST /api/quick {prompt, duration_s, aspect_ratio: "16:9"|"9:16"|"1:1", style: "cinematic"|"documentary"|"animated"|"commercial", dialogue: bool, upscale: null|{engine, target}}` → `201 {project: Project, job: Job}`
- Creates a project with `authoring_mode="quick"`, `title` written by the AI (or the first words of the prompt), and `brief` = the prompt. It starts the **autopilot** parent job.
- `duration_s` ranges from 5 to `LONGTAKE_MAX_S × 4` (default up to 20 min); the UI offers presets.

**Autopilot stages** (each one recorded in `job.result.stages` as `{key, label, status: pending|running|done|failed|skipped, started_at?, finished_at?, detail?}`):

| key | label | Notes |
|---|---|---|
| `outline` | "Writing" | Sizing rules: ≤ 12 s = 1 scene / 1 shot; ≤ 60 s = 1–3 scenes; longer = 1 scene per ~20–40 s. The style preset is applied to the Style Bible |
| `cast` | "Cast" | Characters and locations, then portraits and establishing frames, auto-approved |
| `storyboard` | "Storyboard" | `/storyboard` with mode scene and chain=true, frames auto-approved |
| `render` | "Rendering" | 1 take per shot (long takes when a shot > ~10 s), auto-approved |
| `stitch` | "Stitching" | Reel sync, then full-film assemble |
| `upscale` | "Upscaling" | Only if requested |

- `job.result` also has:
  - `preview_ids`: a list of the newest generation ids, for thumbnails;
  - `final_render_id`;
  - `eta_s`.
- **Auto-approval:**
  - **Images:** the vision LLM scores 0–10 against the description (plus the character reference when relevant). Approve at ≥ `AUTO_APPROVE_SCORE` (default 6), otherwise regenerate (at most `AUTO_RETRIES`, default 2) and keep the best score. If the LLM is unavailable, approve and mark `params.auto_check="unchecked"`.
  - **Takes:** approve the first take that passes the quick checks (duration within 10%, not mostly black, audio stream present).
  - Approvals made by autopilot are tagged `params.approved_by="autopilot"`.
- Failures: a stage that fails after retries marks the job failed, with a clear message. **Resume** via `POST /api/jobs/{id}/retry` continues from the failed stage; finished stages are not redone.

`GET /api/quick/recent` → `[{project, job, final_render?}]`, newest 12.

**Events:** the existing `job` SSE (with `result.stages`) plus `generation` events. Nothing new is needed.

`Project` gains `authoring_mode: "quick"` (string; no migration needed if it's already a free string — verify).

### Quick Create: implementation notes (as built)
- **Validation:** `duration_s` outside 5..`LONGTAKE_MAX_S × 4` → `422`. `upscale` is `{engine: best|fast|quick, target: 1080p|1440p|4k}` or `null`.
- **Job:** `type="autopilot"`. `job.result.stages` is present from creation, with all six stages `pending`. `result` also has `waiting_on` (child job ids), `outline`, `cast`, `stitch` and `upscale` (internal resume state; the UI can ignore these). `vision_unavailable` is set once the vision model fails.
- **Waiting looks like `queued`:** while its frames or takes render, the autopilot hands itself back to the queue (`status="queued"`, `message` = "Storyboard: Frames for 3 shots"). It is claimed again when its children finish. The UI should show the stage timeline, not "waiting for a worker", for `type="autopilot"`.
- **Cancel** (`POST /jobs/{id}/cancel`) also cancels the autopilot's queued or running children. **Retry** continues at the first unfinished stage; cancelled attempts don't count against `AUTO_RETRIES`.
- **Generations made by autopilot** carry `params.autopilot=<job id>`. Approved ones carry `params.approved_by="autopilot"` and `params.auto_check`, which is one of:
  - `passed`;
  - `below_threshold` (the best of `1+AUTO_RETRIES` images);
  - `unchecked` (vision model unavailable; reason in `auto_check_reason`);
  - `flagged` (takes: no take passed both tries; the issues are in `auto_issues`).
- **Scores** are in `generation.score`:
  - images: `{vision, issues[], model}`;
  - takes: `{check: passed|failed, issues[], duration_s, black_ratio, has_audio}`.
- **Takes** get 2 tries (the first plus one re-roll).
- **Upscale stage** calls `app.upscale.queue_upscale(..., flow="autopilot")`. When that raises `UpscaleError`, or the module is missing, the stage is `skipped` with a `detail`. On success, `final_render_id` points at the upscaled render.
- **`GET /api/generations/{id}`** returns the standard Generation shape (404 outside the workspace). The Quick progress screen uses it to resolve `preview_ids`.
