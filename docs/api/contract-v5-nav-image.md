---
title: API contract v5: Navigation, Media library, Image studio, Templates, standalone Upscale (Milestone 6)
status: Active
created: 2026-10-07
extends: contract-v0..v4 (+ image upscaling section of v4)
design: docs/design/navigation.md
---

# API contract v5

## Media items (the Library behind both sections)
`MediaItem = {id, workspace_id, kind: "image"|"video", origin: "generated"|"upload"|"project", title, tags:[str], project_id?, generation_id (current version), width?, height?, duration_s?, media_url, thumb_url?, created_at, updated_at, versions_count}`

- **Standalone images and videos** (Image studio results, uploads, standalone upscales) are MediaItems, with generations under `target_type: "media"`.
- **Project results** (Output renders and approved frames) appear in the Library via `origin: "project"`. These are read-through rows built from existing render/keyframe generations, so nothing is duplicated. Project images are listed only when approved; the `include` filter switches them on.

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/media?kind=&origin=&q=&tag=&project_id=&include=project&limit=&cursor=` | — | `{items: MediaItem[], next_cursor?}`, newest first |
| GET | `/media/{id}` | — | `MediaItem` + `versions: Generation[]` |
| POST | `/media/upload` | multipart `file` (+ `title?`) | `201 MediaItem`. Images: png/jpg/webp ≤ 40 MB. Videos: mp4/mov/webm ≤ 2 GB. The type is checked by content (not only the extension), the file gets a random name, and it's probed with ffprobe or Pillow |
| PATCH | `/media/{id}` | `{title?, tags?}` | `MediaItem` |
| DELETE | `/media/{id}` | — | `204` (standalone items only; project rows → 409) |

Uploads create a `Generation(kind="upload", status="ready", target_type="media")`, so upscale, edit and versioning work the same way as for generated media.

## Image studio
| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/images/generate` | `{prompt, negative?, aspect: "1:1"\|"16:9"\|"9:16"\|"4:3"\|"3:4"\|"2:3"\|"3:2", count: 1..4, style?, seed?, steps?, template_id?}` | `202 {items: MediaItem[], jobs: Job[]}`. One MediaItem per variation, using `zimage_t2i`. The size comes from the aspect at about 1 MP (snapped to /64) |
| POST | `/images/edit` | `{source_ids: [media or generation id] (1–3), instruction, aspect?, count?: 1..4, seed?}` | `202 {items, jobs}` using `qwen_edit` (multi-reference). The result is a **new MediaItem** (`origin` generated) with `params.edit_of` pointing at the sources |
| POST | `/media/{id}/regenerate` | `{mode: "same"\|"note"\|"edit", note?, prompt?}` | `Job` (a new version of that item; same semantics as the review loop) |

**Image upscale:** reuse `POST /generations/{id}/upscale`, which works on any image generation including uploads. The result is a new version on the same MediaItem.
**Video upscale (standalone):** `POST /generations/{id}/upscale` on an uploaded video's generation. Same engines and segment pipeline as renders. The result is a new version of the MediaItem.

## Templates
`Template = {id, type: "video"|"image", title, description, thumb?, defaults: {...}}`
- **Video:** defaults hold Quick Create fields (`prompt_scaffold`, `duration_s`, `aspect_ratio`, `style`, `dialogue`) and, for studio starts, `{authoring_mode, logline_hint, target_runtime_s}`.
- **Image:** `{prompt_scaffold, aspect, count, style, negative?}`.
- Templates are built-in (versioned JSON shipped in `backend/app/templates/`).

| Method | Path | Returns |
|---|---|---|
| GET | `/templates?type=video\|image` | `Template[]` |
| POST | `/templates/{id}/start` | `{target: "quick"\|"studio"\|"image", prefill: {...}}`. The frontend opens the matching form prefilled. **No generation happens until the user confirms** |

**Built-in set (first version):**
- **Video:** 30 s product ad · 60 s brand story · 2 min documentary · Music-video montage (1 min) · Short film (5 min, studio) · Social vertical teaser (15 s, 9:16).
- **Image:** Portrait · Product shot · Character sheet · Poster · Landscape · Food photography.

## Dashboard
`GET /dashboard` → `{recent_projects: Project[≤6], recent_videos: MediaItem[≤6], recent_images: MediaItem[≤8], running_jobs: Job[], quick_recent: [...]}`

## Events
`media` SSE event (data: `MediaItem`) when an item is created, updated, gets a new version or finishes.

## As built (M6 backend)
- **Routes:** everything above lives under `/api`. The Library JSON routes share the `/api/media` prefix with stored files: files keep their existing URLs (`/api/media/workspaces/…`, several path segments), while `/api/media/{id}` takes a single UUID segment, so existing `media_url`s are unchanged.
- **MediaItem extras:** `status` (the current version's status: `queued`/`generating` while a new item is still being made, then `ready`), `media_type`, `project_title` (project rows, or a linked standalone item).
- **Current version:** `generation_id` points at the newest *finished* version. A regenerate or upscale keeps showing the old picture until the new version is ready, then the item moves to it (and a `media` event fires). A brand-new item points at its queued generation from the start.
- **Versions** of a media item are numbered as one line across kinds: `upload` (v1 of an upload), `image` (generated, edited or upscaled stills; an upscaled upload is kind `image`), `video` (an upscaled standalone video).
- **Project rows** (`origin: "project"`, `id` = the generation id) come back only with `include=project` or `origin=project`, and never when `tag` is set. Videos: finished renders (`ready`/`approved`), the newest one per (project, title). Images: approved `portrait`, `establishing`, `keyframe_start|mid|end`. `PATCH`/`DELETE`/`regenerate` on them return `409`. `GET /media/{id}` gives their version line (renders with the same title, or the target's generations of that kind).
- **List:** `limit` 1–100 (default 40). `cursor` is opaque. `q` matches the title (and the tags of standalone items). `include` is a comma list; only `project` exists today.
- **Upload:** `415` for an unsupported or mismatched type (a PNG named `.mp4`), and for damaged files; `413` over the limit (enforced while streaming, so an oversize body is cut off early) or over 100 MP. The upload is parsed straight from the request stream into `DATA_DIR/workspaces/{ws}/media/` under a random name. Videos get a poster (`thumb_url`, a jpg). Upload generation `params`: `original_name, bytes, size, duration_s?, fps?, has_audio?`.
- **Image generate:** `style` ∈ `photoreal | cinematic | illustration | product | painterly` (appended to the prompt; `params.user_prompt` keeps the original). Sizes: 1:1 1024², 16:9 1344×768, 9:16 768×1344, 4:3 1152×896, 3:4 896×1152, 2:3 832×1280, 3:2 1280×832. With `seed`, variations use seed, seed+1, …. Body also takes `title?`. `GET /api/images/options` lists aspects, styles and limits.
- **Image edit:** sources can be media ids or generation ids (any finished image in the workspace, including approved project frames). Without `aspect`, the first source's shape is kept at ~1 MP. `params.edit_of = [{media_id|null, generation_id}]`, plus `reference_ids` (what the driver reads). More than 3 sources is a `422`.
- **Regenerate:** `202 Job`. It re-rolls the newest generated still (upscale settings dropped, so it's a fresh picture at the original size). Uploads and videos return `422`. `mode=edit` accepts `prompt` and `params.{negative, steps, seed}`.
- **Upscale:** `POST /generations/{id}/upscale` accepts upload generations (image or video), media `image` generations and upscaled media videos. Video results are `kind="video"`, `target_type="media"`, titled "<item title> · 1080p". Non-mp4 uploads (mov/webm) are first normalised to a CFR H.264/AAC mp4 inside the job.
- **Templates:** `start` prefill: quick → `{prompt, duration_s, aspect_ratio, style, dialogue, template_id, placeholders}`; studio → `{title:"", authoring_mode, logline:"", logline_hint, target_runtime_s, aspect_ratio, brief, template_id, placeholders}`; image → `{prompt, aspect, count, style, negative, template_id, placeholders}`. `placeholders` lists the `[bracketed]` words in the scaffold.
- **Dashboard:** `recent_videos` includes project renders, while `recent_images` is standalone items only (approved frames would crowd it). `running_jobs` holds the newest 20 queued or running jobs. `quick_recent` holds the newest 4 entries of `/quick/recent`.
- **Events:** `media` fires on create, on PATCH, when a new version is queued, and when a version finishes or fails.
