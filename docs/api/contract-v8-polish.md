---
title: "API contract v8: UI polish (P2 video controls, P3 studio)"
status: Active (P2 and P3 built)
created: 2026-10-07
extends: contract-v0..v7
migration: P2 none; P3 0007 (shot.camera_rack, additive)
---

# API contract v8: UI polish

Source: `docs/design/ui-polish-proposal.md`. Each phase owns its own section; P3 adds its section below P2.

## P2: camera rack, frame slots, @-mentions

### Camera rack

`GET /api/camera/presets` (any signed-in user) returns the vocabulary. The ids are fixed; labels and descriptions can change.

```json
{
  "shot_size": [{"id": "ecu", "label": "Extreme close-up", "short": "ECU", "description": "…", "phrase": "extreme close-up"}, …],
  "angle":     [{"id": "eye", …}, {"id": "low", …}, …],
  "motion":    [{"id": "static", …}, {"id": "push_in", …}, …],
  "speed":     [{"id": "slow", …}, {"id": "medium", …}, {"id": "fast", …}],
  "default_speed": "slow"
}
```

| Group | Ids |
|---|---|
| `size` | `ecu` `cu` `mcu` `ms` `mls` `ls` (Wide) `ews` |
| `angle` | `eye` `low` `high` `overhead` (bird's-eye) `dutch` `pov` `ots` (over the shoulder) |
| `motion` | `static` `push_in` `pull_out` `pan_left` `pan_right` `tilt_up` `tilt_down` `orbit_left` `orbit_right` `handheld` `crane_up` `crane_down` `dolly_left` `dolly_right` `zoom_in` `zoom_out` |
| `speed` | `slow` `medium` `fast` (no speed = slow) |

`POST /api/videos/generate` accepts an optional `camera`:

```json
{"prompt": "a fisherman mends nets at dawn", "camera": {"size": "ms", "angle": "low", "motion": "push_in", "speed": "slow"}}
```

- Unknown ids are a 422 (pydantic). An empty object is the same as no camera.
- The server appends one sentence to the motion prompt, **before** the brand text: `a fisherman mends nets at dawn. Medium shot, low-angle shot looking up, slow push-in.`
- Eye level isn't written (it is the default framing). Static is `static locked-off shot`; handheld is `handheld, subtle shake` / `natural shake` / `energetic shake` by speed; other moves are `{slow|steady|fast} {move}`.
- Saved as `params.camera` (the ids) on the generation. `params.user_prompt` stays the user's own words.

#### For P3: storyboard shots

`app/camera.py` is the single source of the wording. Call it, don't copy the phrases:

```python
from app import camera

camera.to_prompt({"size": "ms", "motion": "push_in", "speed": "slow"})  # "Medium shot, slow push-in."
camera.compose(motion_prompt, shot_camera)   # "<motion prompt>. Medium shot, slow push-in."
camera.summary(shot_camera)                  # "MS · Push-in slow", for cards
camera.Camera                                # the pydantic model for a structured field
```

- `to_prompt` takes a dict or a `camera.Camera`, skips unknown ids, and returns `""` when nothing is set, so it is safe on older free-text shots. It also accepts loose spellings (`"wide"`, `"birds_eye"`, `"dolly-in"`, `"track_left"`).
- Compose it into the take's motion prompt before `brand.apply_to_request` (or the brand moment text), as `videos/generate` does.
- The frontend rack is `CameraRack` / `CameraChip` in `frontend/src/components/camera/CameraRack.tsx`, with the ids and `cameraSummary` / `cameraPayload` in `frontend/src/lib/camera.ts`.

### Frame slots and duration

No API change. Create Video now offers an optional End image once a Start image is set (it sends `end_image_id`, which needs `image_id` and a first+last frame model, as in v6). Both video pages use the duration presets 5 · 10 · 20 · 30 s · 1 min plus a custom box, with the estimate under it.

### @-mentions

`GET /api/mentions?q=&project_id=&types=character,location,product,logo&kit_id=`

```json
[{"type": "character", "id": "<uuid>", "label": "Mara", "hint": "Reef",
  "thumb_url": "/api/media/…png", "ref_generation_id": "<generation id or null>"}]
```

- `project_id`: that project's cast and locations; without it, the 20 most recently updated projects, with the project title as `hint`.
- Logos and products come from `kit_id`, else the project's kit, else the default kit. Their `id` is the brand asset's media id.
- `q` matches the start of any word in the name (`ma` finds Mara, not Omar). At most 30 rows. Unknown `types` is a 422.
- A character's picture is its approved portrait (then an approved sheet view, then the newest finished one); a location's is its establishing frame.

**Tokens.** A prompt carries a mention as `@[Mara](character:<id>)` (`character`, `location`, `product`, `logo`). These endpoints resolve them before queuing: `images/generate`, `images/edit`, `images/img2img`, `videos/generate`, `quick`.

| Flow | Reference budget | What a mention does |
|---|---|---|
| `images/generate` | 3 (the default edit model) | the picture becomes a reference; the run composes on the edit model with "Picture N shows …" |
| `images/edit` | model `max_refs` minus the sources | the picture is appended after the sources |
| `images/img2img`, `videos/generate`, `quick` | 0 | the name stays, plus a short description sentence (`Mara: a tall fisherwoman in a red coat.`) |

- Tokens become plain names in the prompt, in titles and in `params.user_prompt`. Repeated mentions count once; pictures are in order of first appearance.
- Too many pictures is a **422** with a plain message, e.g. `Qwen-Image-Edit 2511 takes at most 3 reference pictures; this would use 4 (2 sources + 2 mentioned). Remove a mention.`
- A mention that can't be found (deleted, or another workspace's) falls back to its name and is recorded with `"missing": true`.
- Saved as `params.mentions` = `[{type, id, label, ref_generation_id, missing?}]`; Quick saves it on the job payload.
- The magic prompt preview is sent plain names; when an enhanced draft is used, the frontend links the names back to their tokens.

## P3: studio polish (shot-list review, shot cards, Quick progress)

### Shot-list review gate

`POST /projects/{id}/storyboard` and `POST /scenes/{id}/ai/suggest-shots` take `review_first` (bool, default `false`; the studio UI sends `true`, Quick Create never does).

- With `review_first`, the job plans and writes the shots (prompts included) but queues **no frames**, and marks each written scene `shots_review: "pending"`. `job.result.review_scene_ids` lists them; `frame_job_ids` is empty. Scenes that become suggestions are untouched.
- A run without `review_first` that writes a scene clears its gate.
- `Scene` gains `shots_review: "pending" | null`. It is kept in `project.settings.shots_review` (no migration); the project settings PATCH can't change it.

| Method | Path | Body | Returns |
|---|---|---|---|
| PATCH | `/scenes/{id}/shots-review` | `{status: "pending" \| null}` | `Scene` (reopen a list for review, or drop the gate without generating) |
| POST | `/scenes/{id}/shots-review/approve` | `{generate_frames?=true, params?}` | `202 {scene, jobs: Job[]}`: clears the gate and queues the keyframes not made yet (END only for a Continue shot, nothing for the logo reveal). `params` go into each frame's generation params (the review header's image model). `409` when the scene has no shots |

### Merge, split, extend

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/shots/merge` | `{shot_ids: [≥2]}` | `Shot[]` of the scene. Neighbouring shots of one scene (any order in the list) become the first of them |
| POST | `/shots/{id}/split` | `{at_ratio?=0.5 (0.05–0.95), descriptions?: [a, b]}` | `Shot[]` of the scene. The new second shot sits right after, `seam_in: "continue"` |
| POST | `/shots/{id}/extend` | `{duration_s?=5, prompt?}` | `201 {shot, job}`: a new shot right after with `seam_in: "continue"` (its START is this shot's END); `job` is `ai_extend_shot` |

**Merge:** description = the descriptions joined in order; `duration_s` = the sum, capped at `LONGTAKE_MAX_S` (and `shot_type: "long_take"` past one chunk); `character_ids` = ordered union; `brand_placements` = union by asset and surface (hero beats background, the user's beats the AI's); `camera` joined when they differ (`camera_rack` kept only when all agree); `start_prompt` from the first, `end_prompt` from the last, `motion_prompt` emptied (compiled at render time); beats reset. Errors: `422` not neighbours / different scenes / fewer than 2; `409` any shot has approved frames or takes, or is the advert's closing shot.

**Split:** durations split at `at_ratio` in half-second steps, each ≥ 1 s (`422` under 2 s). Without `descriptions` the text splits at the sentence (else word) nearest the ratio. The first keeps its START prompt and loses its END and motion prompts; the second gets the original END prompt. Same `409` rules as merge.

**Locks:** merge and split rewrite the description, so the result is locked like a PATCH edit (`source: "ai_edited"` when every input was AI, else `"user"`). The header choices (aspect, image model, brand kit) are project-level and apply to every frame of the list.

**Seams:** any Continue shot whose previous shot changed (merge, split, reorder, delete) is marked `stale` if it already has frames or takes. Reorder now does this too.

**Extend job (`ai_extend_shot`):** the creative LLM writes `description`, `camera`, `end_prompt` and `motion_prompt` for the new shot from the shot before it (its description, END prompt and camera) and the scene. A `prompt` from the user becomes the locked description and steers the AI; the AI never replaces it. Nothing is rendered: the user generates the new shot's END frame, then a take. `409` on the closing shot.

### Re-render one shot

`POST /shots/{id}/rerender` `{what: "frames" | "takes", count?, params?}` → `202 {jobs: Job[], linked_next_shot_id}`

- `frames`: new versions of this shot's START and END (END only when its START is linked). `takes`: `count` takes (default as `POST /shots/{id}/takes`), needs an approved START (`409`).
- No other shot gets a generation. `linked_next_shot_id` is the next shot when it has a Continue seam: it is marked stale only when a new END is **approved** (the v1 rule), never regenerated. The UI shows this as a warning before and after.
- `409` for the logo reveal.

### Shot cards

`Shot` gains:

- `activity: [{id, kind, status: "queued"|"generating"|"failed", job_id, version}]`: generations in flight, plus each kind whose newest try failed. The card pill reads progress and ETA from the job (`queued · 42% · ETA · failed`).
- `camera_rack: {size?, angle?, motion?, speed?}` (migration 0007; `{}` on older shots). `PATCH /shots/{id}` takes `camera_rack` (the P2 `Camera` model; unknown ids `422`). Setting it rewrites `camera` in plain words (`camera.to_prompt`) unless `camera` is in the same PATCH, and locks the shot like a camera edit. Take prompts get the rack sentence appended through `camera.compose` (once; skipped when the motion prompt already says it). Split copies the rack; merge keeps it only when all shots agree.

Version flipping (‹ v2/5 ›) uses the existing `GET /generations?target_type=shot&target_id=&kind=` and approve endpoints.

### Quick Create progress

The autopilot job's `result` gains:

- `stage_media`: `{outline: {text: "3 scenes"}, cast: [...], storyboard: [...], render: [...], stitch: [...]}`. Each list item is `{id, kind, url, video}`, oldest first, at most 12 (portraits and establishing frames; keyframes; takes; the stitched film). Refreshed with `preview_ids`.
- `eta_range_s: [low, high]` next to `eta_s`. The render share uses `GET /estimate`'s measured take timings when there are any; otherwise the rough figure widened 0.75×–1.6×. `[0, 0]` when done.

"Leave — we'll notify you" on the progress page needs no API: the jobs tray tracks the autopilot job and toasts when it ends.


## P4: organisation (folders, favourites, saved filters, batch, before/after, Blueprints)

Migration **0008** (additive): tables `folder`, `folder_link`, `favourite`, `saved_filter`, and a nullable `media_item.folder_id` (indexed, not an FK; cleared in code when a folder goes). Existing items read back unfiled.

### Refs

A **ref** names one Library row. A standalone item is its MediaItem id. A project result (a finished render or an approved still, which are never copied into `media_item`) is `gen:<generation id>`. Bare generation ids are accepted and normalised, so favourites from the old browser-only store still resolve. Responses always use the canonical form.

`MediaItem` gains `folder_id: string | null` (project rows: from their link) and `favourite: bool` (the caller's own heart).

### Folders

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/folders?kind=image\|video` | | `Folder[]` `{id, name, parent_id, kind: any\|image\|video, sort, item_count, created_at, updated_at}`. `kind` keeps `any` folders too |
| POST | `/folders` | `{name, parent_id?, kind?="any"}` | `201 Folder`. A sub-folder of a typed folder takes the parent's kind. `422` deeper than 6 levels |
| PATCH | `/folders/{id}` | `{name?, parent_id?, sort?}` | `Folder`. `parent_id: ""` moves it to the top. `422` for a cycle |
| DELETE | `/folders/{id}` | | `204`. Sub-folders, items and links move up to the parent (links are dropped at the top level). Nothing in the library is deleted |
| POST | `/media/move` | `{refs: [1..500], folder_id: string \| null}` | `{action:"move", done: refs[], skipped: [{ref, reason}], jobs: []}`. `null` takes them out of every folder. Standalone items set `folder_id`; project rows get a `folder_link`, never a copy. Typed folders skip the other kind |

`GET /media` takes `folder_id` (that folder only, not its sub-folders; `404` for a stranger's folder) and `favourite=1`; both combine with every other filter. Project rows appear in a folder when linked (still subject to `origin` / `include`).

### Favourites and saved filters

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/favourites` | | `{refs}` for the current user |
| POST | `/favourites/toggle` | `{ref, on?}` (`on` omitted flips it) | `{ref, favourite}`; `404` unknown ref |
| POST | `/favourites/import` | `{refs: [..2000]}` | `{refs, imported, skipped}`. One-off hand-over from localStorage; unknown ids are dropped |
| GET | `/saved-filters` | | `SavedFilter[]` `{id, name, query, created_at, updated_at}` (per user) |
| POST | `/saved-filters` | `{name, query}` | `201 SavedFilter`; `422` past 4 kB of query |
| PATCH / DELETE | `/saved-filters/{id}` | `{name?, query?}` | `SavedFilter` / `204` |

`query` is opaque to the server. The Library stores `{kind, origin?, q?, tag?, favourite?, folder_id?}`. Deleting media (single or batch) drops its hearts and folder links.

The frontend syncs hearts on app start: if `mixai.favourites` exists in localStorage it is sent to `/favourites/import` once and removed; otherwise `GET /favourites`. A `404` (older server) keeps the browser-only behaviour.

### Batch

`POST /media/batch` `{action, refs: [1..500], options}` → `{action, done, skipped: [{ref, reason}], jobs}`. Unknown refs are skipped with `"Not found"`; one bad item never fails the batch.

| action | options | Behaviour |
|---|---|---|
| `delete` | | Standalone items only (with all versions and files). Project rows are skipped: "Project results are changed inside their project" |
| `tag` | `{add?: [], remove?: []}` | Standalone only; `422` when both are empty |
| `move` | `{folder_id}` | Same as `/media/move` |
| `upscale` | `{image?: {engine, target}, video?: {engine, target}}` | One upscale job per item on its current version (same rules as `POST /generations/{id}/upscale`). An item the engine can't take is skipped with the reason |
| `download` | | One `media_zip` job (CPU, priority 50, ledger kind `export`). `422` when nothing has a finished file; unfinished items are skipped |

The `media_zip` job writes `DATA_DIR/workspaces/{ws}/exports/{job_id}.zip` (stored, not deflated; names from titles, de-duplicated) and sets `result: {file, bytes, count, missing, download_url}`. `GET /exports/{job_id}/download` streams it (`409` until done, `410` if the file is gone, `404` for another workspace's job).

### Generate into…

`POST /images/generate`, `/images/edit`, `/images/img2img` and `/videos/generate` take `folder_id`: new items land in that folder. `404` unknown folder, `422` when the folder holds only the other kind. The dock shows an "Into folder" chip once any folder exists.

### Before / after, Blueprints

No API. The before/after slider and loupe read the existing versions (`params.upscale.source_id`). Home Blueprints use `POST /templates/{id}/start` and plain routes; "Instant brand" cards show when `GET /brand-kits` returns a kit.
