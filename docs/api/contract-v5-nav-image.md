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
