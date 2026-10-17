---
title: "Contract v40: 3D Studio, part 1 (a picture to a textured 3D model)"
status: Active
created: 2026-10-17
extends: contract-v39 (packages)
migration: none (MediaItem.kind and Generation.kind are plain strings)
plan: docs/PLAN-m20-3d-studio.md (delivery 1)
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
  turntable frame replaces it in part 3.
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
