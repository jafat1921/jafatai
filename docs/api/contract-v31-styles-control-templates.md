---
title: "Contract v31: style catalogue, Restyle, Sketch / Depth / Pose to image, saved templates"
status: Active
created: 2026-10-14
extends: contract-v30 (image tools), contract-v29 (edit templates), contract-v5 (image studio), contract-v27 (token API)
research: docs/research/nightcafe-styles-2026-10-14.md, docs/research/nightcafe-styles-table.md
---

# Contract v31: styles, control and saved templates

Four additions to the Image section. They share one idea: a style or a template is a recipe the server
applies, so the API, the token API and the UI all get the same result.

## 1. Style catalogue

Styles live in `backend/app/templates/styles.json`. There are 45 of them in 7 groups. The research table
says 44, but it lists 45 rows, and all 45 are shipped. The wording is our own and names no artists.

```
GET /api/images/options
{ "aspects": [...], "count": {...}, "edit_sources": {...},
  "styles": [{ "id": "oil", "group": "painting", "label": "Oil Painting", "subtitle": "Thick brushwork",
               "suffix": "oil on canvas, ...", "negative": "photo, smooth", "best_model": "qwen_image_2512",
               "preview_url": "/api/images/styles/oil/preview?v=1760450000" | null }],
  "style_groups": [{ "id": "photo", "label": "Photo", "restyle_strength": 0.3 }, ...],
  "style_aliases": { "painterly": "oil" } }
GET /api/images/styles/{id}/preview      -> image/webp, 404 when not rendered yet
```

- Groups, in order: `photo` (Photo), `painting` (Painting), `illustration` (Illustration), `anime` (Anime),
  `3d` (3D / Game), `dark` (Dark / Fantasy) and `retro` (Retro / Neon).
- The old ids `photoreal`, `cinematic`, `illustration` and `product` are still catalogue ids. `painterly` is
  accepted everywhere as an alias of `oil`. It is not listed in `styles`.
- Applying a style: the positive text is appended after the prompt (`library.styled_prompt`). The style's
  negative is joined to the user's negative only when the run samples with CFG > 1. Today that means only
  Qwen-Image 2512 at the `full` speed. Z-Image Turbo, FLUX.2 klein and Qwen's Lightning and Turbo speeds run
  at CFG 1 and never read a negative.
- `best_model` is a hint. The server never switches models because of it. The style gallery shows
  "Best on X" and a "Use X" button, and the user's own choice always stays. The model picks are first
  guesses, so A/B them on the server.
- An unknown style is a 422 on `/images/generate`, `/images/img2img`, `/images/control` and `/my-templates`.
- Previews are rendered by `scripts/gen_prompt_template_previews.py --styles`. Every style uses one fixed
  subject and one fixed seed (20261014), on its own `best_model`, at 3:4. Each lands at
  `templates/previews/styles/<id>.webp` with a 400 px long side. Until then `preview_url` is null and the UI
  shows a lettered card.

## 2. Restyle my photo (Image to Image)

`POST /images/img2img` gains these fields:

| field | |
|---|---|
| `style` | a style id or alias; its positive text is applied as on Generate |
| `prompt` | may now be empty (or left out) when `style` is set; one of the two is required (422 otherwise) |
| `strength` | left out with a style: the group's `restyle_strength` (Photo 0.3, Illustration 0.55, Painting/Anime/3D 0.6, Dark/Retro 0.5). Sent: always wins |
| `template_id` | kept on the result for the record |

The UI calls the slider "Style strength", with marks Subtle 0.3, Balanced 0.5 and Strong 0.7. Each mark is a
button that sets the slider. Picking a style moves the slider to its group preset until the user moves the
slider. After that, the user's value stays. With no words, the magic prompt is off for the run.

Edit template `image-edit-restyle` ("Restyle my photo", Qwen-Image-Edit) has
`options_from: "styles"`. The server expands it into one option:
`{slot: "style", label: "Style", gallery: "styles", choices: [{label, value: "<Label>: <positive>", style_id}]}`.
The scaffold is `Redraw image 1 as [style]; keep the composition, faces and identity.` The UI shows the
style gallery for an option with `gallery: "styles"`, with no "None" card.

Edit template `image-edit-image-prompt` ("Image prompting") takes one Reference. It makes a new picture of
`[new scene]` with the subject and style of image 1.

## 3. Sketch, depth and pose to image

```
POST /api/images/control   (202, ImageBatchOut)
{ "source_id": "...", "control": "depth|canny|pose|hed|scribble", "use_as_is": false,
  "prompt": "...", "style": null, "strength": 0.8, "aspect": "source", "count": 1, "seed": null,
  "negative": null, "engine": "auto|controlnet|edit", "template_id": null, "folder_id": null }
```

- Engine: Z-Image Turbo, patched by **Z-Image-Turbo-Fun-Controlnet-Union-2.1, lite 2602 8-step**
  (alibaba-pai, Apache-2.0). The file is
  `models/model_patches/Z-Image-Turbo-Fun-Controlnet-Union-2.1-lite-2602-8steps.safetensors`. It is
  2,016,627,488 bytes, with sha256 `3ea098db9bd145be525c7e2366920b6d76c5ffd46b3d7aa8169bbc943fdaee35`, from
  repo revision `5155fc56d1`. The lite build is 2.0 GB instead of 6.7 GB, so it fits beside Z-Image bf16 on a
  20 GB card. It also allows higher scales and looks more natural.
- `strength` runs from 0.65 to 1.0 (the model card's range), with 0.8 as the default.
- Workflows: `zimage_controlnet` takes the picture as it is. `zimage_controlnet_{depth,canny,pose,hed,scribble}`
  make the map first:

  | type | detector | licence |
  |---|---|---|
  | `depth` | DepthAnythingV2Preprocessor, Small | Apache-2.0 |
  | `canny` | CannyEdgePreprocessor | no weights |
  | `pose` | DWPreprocessor with `yolox_l.torchscript.pt` + `dw-ll_ucoco_384_bs5.torchscript.pt` | Apache-2.0 per the model cards (hr16/yolox-onnx, hr16/DWPose-TorchScript-BatchSize5) |
  | `hed` | HEDPreprocessor | Annotators, "other": gated by `IMAGE_ALLOW_NONCOMMERCIAL` |
  | `scribble` | Scribble_XDoG_Preprocessor | no weights |

- `use_as_is` with `canny`, `hed` or `scribble` handles a drawing with a light background (mean grey above
  127). The server saves an inverted copy (light lines on black) under `workspaces/<ws>/media/masks/` and
  records it as `params.control.control_file`.
- Fallback: when the patch or its nodes aren't installed (cached `/object_info`), the type is switched off,
  or `engine: "edit"` is sent, the request runs on Qwen-Image-Edit with the picture as reference. The
  instruction is `Render <prompt>[, <style>], following the <pose|depth and layout|...> of image 1. Use image
  1 only as a guide ...`. The response has `tool_fallback` (the reason) and `model_resolved:
  "qwen_image_edit_2511"`, and the UI says the result follows the picture more loosely. `engine:
  "controlnet"` gives a 422 instead of falling back.
- A ControlNet run returns `tool_resolved: "controlnet:<type>"`. Its params include `control` (template,
  inputs, source) and `control_of` (`media_id`, `generation_id`, `type`, `as_is`).
- `GET /images/tools` gains `control`, which holds `{engine, licence, available, reason, fallback, strength:
  {min,max,default}, types: [{id, label, detector, licence, noncommercial, available, reason}]}`. Types that
  are switched off are left out.

Templates (`target: "image-control"`, category "Sketch, depth & pose") are `image-control-depth`,
`image-control-sketch` (`use_as_is: true`), `image-control-pose` and `image-control-edges` (canny).
`TemplateOut.control` is `{type, label, detector, licence, noncommercial, as_is}`. `/start` returns
`target: "image-control"` with `{prompt, control, use_as_is, strength, count, aspect: "source", style,
template_id, control_card, placeholders}`. The UI route is `/image/control`
(`?type=pose&source=<id>` works too). The page has a picture slot, a choice between "a photo" and "already a
map", the style gallery, and a "Control strength" slider.

### Assumptions to verify on the server

- `ModelPatchLoader(name)` and `QwenImageDiffsynthControlnet(model, model_patch, vae, image, strength;
  optional mask, start_percent, end_percent)` are read from ComfyUI master `comfy_extras/nodes_model_patch.py`
  (2026-10-14). They are not checked against the server yet. Newer ComfyUI also has `ZImageFunControlnet`
  with the same inputs, but with `image` optional. The fixture entries in `tests/fixtures/comfy_object_info.json` are
  copies of that source.
- That the lite 2602 file loads as a `ZImage_Control` patch. Run `curl /object_info/ModelPatchLoader` and one
  real job.
- Where the patch goes in the graph: UNet, then ModelSamplingAuraFlow, then ControlNet, then KSampler, using
  8 steps at CFG 1.
- `DWPreprocessor` inputs come from controlnet_aux `a587a4c`. TorchScript avoids onnxruntime.

## 4. Saved templates ("My templates")

Migration `0020_user_template` adds table `user_template`. Its columns are id, workspace_id, created_by,
title, description, target (`generate|edit`), prompt, negative, style, model, aspect, count, ref_labels,
examples, preview_generation_id, created_at and updated_at. Templates are shared by the workspace, like the
Library.

```
GET    /api/my-templates                 -> TemplateOut[] (mine: true, category "My templates")
POST   /api/my-templates                 -> 201 TemplateOut   (UserTemplateIn)
PATCH  /api/my-templates/{id}            -> TemplateOut       ({title?, description?, prompt?})
DELETE /api/my-templates/{id}            -> 204
GET    /api/prompt-templates?type=image  -> the workspace's own first among the image cards
POST   /api/prompt-templates/{id}/start  -> works for a saved template id too (prefill.mine = true)
```

`UserTemplateIn` has these fields: `title`, `description`, `target`, `prompt` (with `[slots]`), `negative`,
`style`, `model`, `aspect`, `count` (1-4), `ref_labels` (edit only, up to 3), `examples` (kept only for slots
in the prompt) and `from_media_id`. That last field is the result it came from. That result's thumbnail
becomes the card's `preview_url` while it exists.

Validation (422):
- the style must be in the catalogue;
- the model must exist and be of the right type (an image model for `generate`, an edit model for `edit`);
- an edit template has no style or negative;
- a generate template has no `ref_labels`.

Another workspace's id is a 404 everywhere. The token API reaches these routes with the usual method
scopes: `read` for GET, `generate` for POST and PATCH, and `manage` for DELETE.

UI:
- "Save as template" appears in a result tile's ⋯ menu and as a result row action. It is offered for Create
  and Edit results; restyles, tools and control runs are excluded.
- It is also a header button on Create Image and Edit Image.
- The dialog has a "Make selection a [slot]" helper.
- The template gallery shows a "My templates" section where each card has Rename and Delete. The Create Image
  template picker lists My templates first.
