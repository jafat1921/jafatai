---
title: "Contract v40: 3D Studio (a picture, a prompt, a character or four views to a textured 3D model)"
status: Active
created: 2026-10-17
extends: contract-v39 (packages)
migration: none (MediaItem.kind and Generation.kind are plain strings)
updated: 2026-10-17 (addenda: text, character and four-view starts; turntable, thumbnail, Make 3D links)
plan: docs/PLAN-m20-3d-studio.md (deliveries 1, 2 and 3)
---

# Contract v40: 3D Studio

A finished picture becomes a textured 3D model (binary glTF, `.glb`) on the image GPU, with **Pixal3D** (true
to the picture) or **TRELLIS.2** (general). The result is an ordinary Library item of kind `model`. Part 1 is
the "From: Picture" start; text, character and four-view starts, the turntable and the Make 3D buttons come in
later parts.

## 1. Kinds

| | Value |
|---|---|
| `MediaItem.kind` | `model` |
| `Generation.kind` | `model3d` (target_type `media`, like every Library item) |
| `media_type` | `model/gltf-binary`; the file is `<generation id>.glb` |
| Lane | `image` |
| Package feature | `3d` ("3D Studio"); models `pixal3d`, `trellis2` |

`GET /api/media` keeps listing images and videos by default. `GET /api/media?kind=model` lists models (the
`home` / `include_home` rules of contract v37 apply). `search_library(kind="model")` does the same over MCP.
Folders may be of kind `model`.

## 2. Routes

### `GET /api/3d/options`

```json
{"engines": [{"id": "pixal3d", "label": "Pixal3D", "description": "...", "default": true, "best_for": [...]},
             {"id": "trellis2", "label": "TRELLIS.2", ...}],
 "qualities": [{"id": "draft", "label": "Draft"}, {"id": "final", "label": "Final"}],
 "default_quality": "final"}
```

`GET /api/models?type=model3d` lists the same two engines with live availability (`available`, `reason`,
`installed`, `est_seconds`). Each engine is a manifest *feature* of the shared template, so a missing Pixal3D
file makes Pixal3D unavailable without taking TRELLIS.2 down with it.

### `POST /api/3d/make` → 202

```json
{"source_id": "<media id or generation id>", "engine": "pixal3d", "quality": "final",
 "remove_background": true, "seed": null, "title": null, "folder_id": null, "part_of": null}
```

- `source_id` must be a finished picture in your studio (404 otherwise, 422 when it isn't an image).
- `engine`: `pixal3d` (default) or `trellis2`. `quality`: `draft` or `final` (default).
- `remove_background: false` only keeps the background when the picture is see-through: the graph crops to
  the picture's alpha. Without an alpha channel the background is removed anyway and `background_note` says so.
- The title defaults to "<source title> · 3D".

Answer:

```json
{"item": {MediaItem, "kind": "model", ...}, "job": {Job}, "model_resolved": "pixal3d", "background_note": null}
```

Quota, package features and models are checked like any other top-level job (403 when the package switches
`3d` off or doesn't list the engine, 429 over the minutes).

### Estimates

`GET /api/estimate?kind=model3d&model=<engine>&speed=<draft|final>`. Rough until the server has timings:
Final ≈ the catalog's `est_seconds` (Pixal3D 300 s, TRELLIS.2 270 s), Draft ≈ 45 % of that, plus a model load
when the GPU last ran something else. Measured once three runs of an engine and quality exist.

### Files

- `media_url` serves the GLB as `model/gltf-binary`.
- `thumb_url` is cut from the source picture (`<stem>.thumb256.webp` / `.thumb512.webp` beside the GLB). A
  turntable frame or a viewer snapshot replaces it (§7).
- OBJ, STL and USDZ are made in the browser from the GLB (three.js exporters); the server only stores the GLB.

## 3. The graph

`backend/app/workflows/trellis2_image_to_3d` is the official "Pixal3D & TRELLIS.2: Image to Model" workflow,
converted by `scripts/comfy_ui_to_api.py --manifest <manifest>` (46 API nodes from 66 UI nodes). Its switches
are resolved by `build()`, and the unused branch is pruned, so the other engine's weights never load.

| Input | Draft | Final |
|---|---|---|
| `upsample_resolution` | 1024 | 1536 |
| `texture_size` (bake + unwrap) | 2048 | 4096 |
| `face_count` (decimate) | 200 000 | 700 000 |
| `ao_resolution` | 1024 | 1024 |
| `normal_resolution` | 1024 | 2048 |

The engine also sets `pad_factor`: 1.1 for Pixal3D and 1.0 for TRELLIS.2, as the conditioning nodes advise.
`trellis2`, `remove_background` and `seed` (all four samplers) are the other inputs. The output is
`Save3DAdvanced` ("Save 3D") with `filename_prefix mixai/<generation id>`.

**History.** The driver takes any 3D file (`.glb .gltf .obj .fbx .stl .usdz .ply`) a node reports, under any
key and in any of the shapes ComfyUI uses: `{"3d": [{filename, subfolder, type}]}` (SaveGLB),
`{"result": ["mixai/<id>_00001_.glb [output]", ...]}` (the Load3D family), or a bare relative path. Files of
type `temp` are skipped.

## 4. MCP

`make_3d_model(image_id, engine="pixal3d", quality="final", remove_background=true, seed?, part_of?)` returns the
new item and its job; `wait_for_job` then gives a `download_url` for the `.glb`.

## 5. Frontend

- Route `/3d`, with its own rail entry "3D".
- The dock has the picture (drop, paste, upload or pick from the Library), an engine segment (Pixal3D "true to
  the picture" or TRELLIS.2 "general"), Draft / Final, a Remove background switch, and Make 3D with the
  estimate.
- **Viewer** (three.js, loaded on demand):
  - orbit and zoom;
  - Studio, Soft or Sunset lighting;
  - a plain or checker background;
  - wireframe;
  - arrow keys turn the model, + and − zoom, 0 resets;
  - no damping under reduced motion.
- **Downloads:** GLB (the original), plus OBJ, STL and USDZ.

## 6. Addendum: text, character and four-view starts (delivery 2)

`POST /api/3d/make` takes **exactly one** of four starts (422 otherwise). Everything in §2 still applies to
the picture start, whose request and record are unchanged.

```json
{"source_id": "<picture>"}                                   // picture (part 1)
{"prompt": "A brass oil lamp", "image_model": null, "brand_kit_id": null, "magic_prompt": null}
{"character_id": "<character id>"}
{"views": {"front": "<id>", "left": "<id>", "back": "<id>", "right": "<id>"}}
```

`engine`, `quality`, `remove_background`, `seed`, `title`, `folder_id` and `part_of` work as before.

### Text

- The prompt becomes `"<prompt>. Single object, centred, whole object in frame, plain light background, soft
  studio lighting, product photo"`. The negative asks for no text, logos or extra objects.
- A square picture is queued first on `image_model` (empty: the default image model). It is an ordinary image
  generation, a **working part** with `MediaItem.home = "3d"` (contract v37), so it stays out of the Library grid
  (`GET /api/media?home=3d` lists them).
- `brand_kit_id` adds the kit's palette and look to that picture, but not its logo pass.
- `magic_prompt` is **off unless asked** (`auto` / `on`, or `prompt_enhanced: true` for a reviewed prompt). An
  enhanced prompt keeps the object brief: only the user's words are swapped.
- The model's job waits for the picture: while it is queued or running, the job goes back to the queue
  (`message` "Making the picture first"); when it is done the picture becomes `params.model3d.source_id`. If the
  picture fails, the model's job fails and says why.
- The background is always removed.
- The answer adds `picture` (the image item) and `picture_job`.
- Package gates and quota see the picture as its own image job: a package without Create Image, or without the
  image model, refuses the request (403), and nothing is queued.

### Character

- The character must be in your studio (404 otherwise).
- **Views:** when the sheet has a turnaround with a front and at least one more angle, the panels are the views:
  - `turn_front` → front;
  - `turn_side` → left;
  - `turn_back` → back.
  
  Each is the approved panel, else the newest finished one. The side panel is never mirrored into a right view.
- **Single picture:** otherwise the full-body hero, else the portrait, is used as one picture. With neither the
  answer is 422.
- The model is a final output (`home` null). It records the character in both `params.character_id` and
  `params.model3d.character_id`, and is titled "<name> · 3D".

### Four views

- `front` plus at least one of `left`, `back` and `right`. Each must be a finished picture in your studio, and
  each view needs its own picture (422 otherwise).
- **Pixal3D only:**
  - `engine: "trellis2"` is a 422 for four views;
  - a character's turnaround runs on Pixal3D whatever was asked, and `engine_note` says so.
- `remove_background: false` is kept only when every view is see-through. Otherwise `background_note` says the
  backgrounds were removed.

### The answer

`Model3DOut` gains:

| Field | Meaning |
|---|---|
| `start` | `picture`, `text`, `character` or `views` |
| `engine_note` | Set when several views forced Pixal3D |
| `picture`, `picture_job` | A text start's working picture and its job |
| `views_used` | In order: `front`, `left`, `back`, `right` |

### Record

`params.model3d` adds:

| Key | Holds |
|---|---|
| `start` | Any start but a picture |
| `views` | `{view: generation id}` |
| `view_media` | `{view: media id}` |
| `measure_fov` | `true` for uploaded views, which are mostly photos: MoGe measures the front view. `false` for turnaround panels, which use 20°. |
| `picture` | `{generation_id, media_id, status: pending\|done\|failed}` |
| `character_id` | The character, for a character start |

`source_id` is always the picture or the front view, so thumbs and the Make 3D lists keep working.

### The four-view graph

`backend/app/workflows/pixal3d_multiview_to_3d` is built from the single-picture template. It keeps the
Pixal3D branch, puts `Pixal3DMultiViewConditioning` where `Pixal3DConditioning` was, and loads
`pixal3d_multiview_int8_convrot.safetensors` (from `install-3d-models.sh --multiview`).

- **Each view** gets its own LoadImage, BiRefNet cut-out, background switch and `ImageCropToMask`: 1024²,
  pad 1.1, black background, as the node asks.
- **Optional views:** a view that isn't given is dropped with its chain (`if_missing`), so the node only sees
  the connected sockets.
- **Field of view:** `fov` is 20, or MoGe's `MoGeGeometryToFOV` on the front crop when `measure_fov` is set.
  The MoGe nodes are a template *feature*, so a missing MoGe only affects measured views.
- **Shared settings:** quality, seed and the remaining passes are the same as the single-picture graph's.
- **Catalogue:** `pixal3d` lists the capability `multiview` (template `pixal3d_multiview_to_3d`). It is
  dropped from `GET /api/models?type=model3d` when the multi-view weights are missing, and
  `GET /api/3d/options` reports it as `views: {ids, required, min, engine, available, reason}`.

### MCP

`make_3d_model` accepts exactly one of the following, plus `image_model` and `brand_kit_id` for a prompt:

- `image_id`;
- `prompt`;
- `character_id`;
- `view_ids` (`{"front": id, "back": id, ...}`).

The answer adds:

- `start`;
- `picture` (with its `job_id`) for a prompt;
- `views`;
- `notes`.

### Frontend

The dock's **From** control has four choices: Picture | Text | Character | Four views.

- **Text:** a prompt box with Magic prompt. Progress shows two steps, the picture and then the 3D model.
- **Character:** a list of the studio's characters. It says whether the turnaround views will be used.
  `/3d?character=<id>` opens with that character picked.
- **Four views:** four labelled slots. Front is required; Left, Back and Right are optional.
- **Engine:** Four views, and a character with a turnaround, fix the engine to Pixal3D and say why.

## 7. Addendum: turntable, thumbnail and Make 3D links (delivery 3)

### `POST /api/3d/{media_id}/turntable` → 201

`multipart/form-data` with one `file` part: the turntable the viewer recorded, WebM or MP4, at most 60 MB.

- `media_id` must be a **finished** model in your studio: 404 for anyone else's id or an item that isn't a
  model, 409 while the model is still being made. Viewers get 403.
- Anything but WebM / MP4 is a 415 (sniffed from the bytes, as with every upload); over 60 MB is a 413.
- A WebM is converted to H.264 MP4 (`yuv420p`, 30 fps, `+faststart`, no audio) so it plays on phones, in
  Safari and on social sites. If ffmpeg can't, the WebM is kept and `transcoded` is `false`.
- The video is a new Library item: kind `video`, origin `generated`, `home` null (a final output), titled
  "<model title> · turntable". Its generation's `params.model3d_of` is the model's media id and
  `created_by.flow` is `make_3d:turntable`. The model's generation records `params.turntable_id` (the newest) and
  `params.turntables` (all of them, oldest first).
- Its **first frame** becomes the model's thumbnail, unless one was set from the viewer (below).

```json
{"item": {MediaItem, "kind": "video", ...}, "model": {MediaItem, "kind": "model", "thumb_url": "...&v=..."},
 "transcoded": true}
```

### `POST /api/3d/{media_id}/thumbnail` → 200

`multipart/form-data`, one `file` part: a PNG, JPEG or WebP picture of the model (the viewer sends a square
PNG of its current view), at most 10 MB. The same 404 / 409 / 403 rules apply; another type is a 415.
The answer is the model with its new `thumb_url`.

### Thumbs

- Both sizes are rewritten beside the GLB. The model's generation records `params.thumb_from`
  (`turntable` | `snapshot`) and `params.thumb_v`.
- A model's `thumb_url` carries `&v=<thumb_v>` once its thumb has been replaced, because
  `GET /api/media/thumb/{id}` is cached for a week.
- A snapshot wins: a later turntable doesn't replace a thumb that was picked by hand.

### Frontend

- **Viewer:** "Make turntable" records one 360° turn over 6 s at 1080×1080 (`canvas.captureStream` +
  `MediaRecorder`, VP9, else VP8, else plain WebM), with the chosen lighting and the plain-paper or checker
  background. Progress shows as a progress bar, with Cancel. Without `MediaRecorder` it says so calmly. The
  saved video is previewed (no autoplay under reduced motion) with a link to the video library.
  "Use this view as thumbnail" sends a square snapshot of the current camera.
- **Facing (fix):** Pixal3D and TRELLIS.2 put the picture's front on −Z, so the viewer's camera and lights now
  start on that side (they started on +Z and showed the back). A **Front / Back** control turns a model the
  other way round by 180° (per model). Exports bake world matrices, so a Back turn goes into the OBJ, STL and
  USDZ and Front adds nothing. The turntable always starts from the front.
- **Wireframe (fix):** drawn as a scene override material in one ink colour, so the downloads keep their
  textures and a dense, textured mesh can't look unchanged. The switch shows what the viewer reports, is
  applied once each model is drawn, and stays on across models. Lighting and background also stay.
- **Make 3D links** open `/3d?from=picture&source=<media id>` or `/3d?character=<id>` (`?image=` still
  works):
  - the Lightbox, on Library pictures;
  - a character's page, once it has a portrait;
  - Ad Studio's product photo slots and a brand kit's products (in a new tab, so the form isn't lost).
- They are hidden when `GET /api/account/usage` reports `features["3d"]: false`.
- **Model actions:** each tile in "Your models", and the open model, has a "⋯" menu (and the open model a
  favourite button). Every action uses an existing route:
  - Download: GLB, plus OBJ, STL and USDZ made in the browser.
  - Make turntable, and use a view as the thumbnail.
  - Make again: `POST /3d/make` with the same start and settings. A text start reuses the picture it made.
  - Try the other engine. Not offered for several views.
  - Show the source picture: `/image/library?open=<id>`.
  - Open in Library: the new `/3d/library?open=<id>` route.
  - Favourite, Rename (`PATCH /media/{id}`) and Delete (`DELETE /media/{id}`, a hard delete with a confirm).
  - Delete keeps the turntable videos unless "Also delete its turntable videos" is ticked. Deletes can't be
    undone, so there's no undo toast.
- **Layout:** the options column is 18rem from 1100 px and moves under the start fields below that. The four
  view slots use the drop zone's `compact` tiles, two across only when their own column has room.
