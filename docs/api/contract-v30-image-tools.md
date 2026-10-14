---
title: "Contract v30: Edit Image tools (line art, depth, edges, LaMa, IC-Light, CatVTON)"
status: Active
created: 2026-10-14
extends: contract-v29 (edit templates), contract-v10 (Photo Studio restore and cut-out), contract-v6 (models)
research: docs/research/image-templates-fal-atlas-2026-10-14.md
---

# Contract v30: Edit Image tools

Some Edit Image templates now run on a dedicated ComfyUI graph instead of Qwen-Image-Edit. The template names
its tool; the server runs the tool when it can and, for templates that allow it, falls back to the edit model
with the template's instruction when it can't. All of them run on the image GPU's ComfyUI.

The app is in **test mode**: the best tools are wired even when their weights are non-commercial, each one
labelled with its real licence and gated by a switch that defaults on.

## Tools

| `id` | Engine | Template | Weights licence | Gate | Falls back to Qwen |
|---|---|---|---|---|---|
| `lineart` | ControlNet line art (Informative Drawings `sk_model`) | `image_lineart` | Unverified: `lllyasviel/Annotators` says "other" | `IMAGE_ALLOW_NONCOMMERCIAL` | yes |
| `lineart_anime` | ControlNet anime line art (`netG.pth`) | `image_lineart_anime` | Unverified, as above | `IMAGE_ALLOW_NONCOMMERCIAL` | yes |
| `depth` | Depth Anything V2 **Small** | `image_depth` | Apache-2.0 (B/L/G are CC BY-NC; not used) | none | no |
| `canny` | OpenCV Canny | `image_canny` | no weights | none | no |
| `softedge` | HED (`ControlNetHED.pth`) | `image_softedge` | Unverified, as above | `IMAGE_ALLOW_NONCOMMERCIAL` | edge card uses Canny |
| `inpaint` | LaMa `big-lama` | `image_lama_inpaint` | Apache-2.0 | none | yes (no mask: always) |
| `relight` | IC-Light v1 fc / fbc on Realistic Vision 5.1 | `image_iclight` | Apache-2.0; RV 5.1 CreativeML OpenRAIL-M | none | yes |
| `tryon` | CatVTON | `image_catvton` | **CC BY-NC-SA 4.0** | `IMAGE_ALLOW_NONCOMMERCIAL` | no (Outfit swap is the commercial card) |

IC-Light's foreground matte uses BiRefNet (the core `RemoveBackground` node Photo cut-out already uses),
not RMBG-1.4, which is non-commercial.

### `IMAGE_ALLOW_NONCOMMERCIAL` (default `true`)

With `false`: `lineart`, `lineart_anime`, `softedge` and `tryon` are left out of `GET /images/tools`; the
"Virtual try-on (CatVTON)" card is left out of `GET /prompt-templates` and its `/start` is a 404; a request
naming it is a 422. "Photo to line art / colouring page" runs on Qwen-Image-Edit, and "Edge map" with Soft
picked runs Canny. Depth and Canny keep working.

`PHOTO_ALLOW_NONCOMMERCIAL` now defaults to `true` as well, so Photo Studio's Heavy restore (SUPIR) is on in
test mode. Its tool entry in `GET /photo/tools` carries `licence`.

## `GET /api/images/tools`

```json
{"tools": [{"id": "inpaint", "label": "Remove with a mask", "engine": "LaMa", "licence": "Apache-2.0 (LaMa big-lama)",
            "noncommercial": false, "fallback": true, "needs_mask": true, "available": true, "reason": null,
            "est_seconds": 8}]}
```

`available` comes from `check_template` against ComfyUI's `/object_info` (cached; mock driver: always true).
`reason` says what is missing ("missing nodes: CatVTON", "ComfyUI isn't reachable").

## Templates

`TemplateOut.tool` (and `prefill.tool` from `/start`) is `{id, label, engine, licence, noncommercial,
fallback, needs_mask}` or null. New image.json fields: `tool` (an id above) and, for relight,
`tool_prompt` (a short SD1.5 prompt using the same `[slots]` as the instruction).

New cards: `image-edit-virtual-tryon` (refs Person, Garment; option `garment type`), `image-edit-depth-map`,
`image-edit-edge-map` (option `edge style`: Canny or HED). Tools added to `image-edit-remove-object`,
`image-edit-relight` (second, optional ref "Background") and `image-edit-line-art` (now "Photo to line art /
colouring page"). The web app hides a tool-only card whose tool `GET /images/tools` reports unavailable.

## `POST /api/images/edit` additions

| Field | Meaning |
|---|---|
| `template_id` | The Edit template; its `tool` is used and its `[slot]` values are read back from `instruction` |
| `tool` | A tool id, for callers without a template |
| `engine` | `auto` (default): the tool when it can run, else the edit model if the tool allows a fallback, else 422. `tool`: the tool or 422. `edit`: never the tool |
| `tool_options` | `light` (`none` `left` `right` `top` `bottom`, relight), `garment_type` (`upper` `lower` `overall`, try-on; else read from the `garment type` slot), `edge` (`crisp` `soft`), `low_threshold` / `high_threshold` (Canny) |
| `mask` | LaMa: a PNG / WebP data URL. Opaque (alpha) or white (no alpha) = remove. Any size; scaled to the photo |

`instruction` may now be empty when a tool runs. Without `mask`, LaMa uses the source's Photo Studio
selection when the source is a cut-out / Select version (white = selected = removed). With neither, `auto`
falls back to Qwen.

Response: `tool_resolved` (tool id that runs; the line art or edge tool may differ from the template's when a
choice picks the anime or soft variant) or `tool_fallback` (why the edit model ran instead).

Line art, depth, edges and LaMa are deterministic, so they make **one** result whatever `count` says.
Relight and try-on keep `count` and `seed`.

Errors (422): unknown `template_id` / not an edit template; template switched off; unknown tool; tool can't
run and no fallback (`"Depth map can't run: missing nodes: …"`); `engine=tool` with no tool or no mask;
mask not a data URL, unreadable, empty (< 0.05 %) or nearly everything (> 90 %); try-on with one picture;
bad `light` / `garment_type` / thresholds.

## Generation params

`params.image_tool = {tool, template, source_id, inputs: {width, height, …}, mask_file?, mask_from?
("brush" | "selection"), garment_id?, background_id?, light?}`. Masks are stored under
`workspaces/<ws>/media/masks/`. Work sizes: preprocessors and LaMa keep the source size up to about 4 MP
(multiples of 8); IC-Light and CatVTON scale to about 0.79 MP (multiples of 64 / 16).

## Assumptions to verify on the server (`/object_info`)

Read from the pinned source: controlnet_aux preprocessors, `INPAINT_*` nodes, IC-Light nodes
(`LoadAndApplyICLightUnet` lists `models/unet`). Not yet verified: the CatVTON node input names
(`sd15_inpaint_path`, `catvton_path`, `mixed_precision`, `cloth_type`, `target_image`, `refer_image`,
`mask_image`, `seed`, `steps`, `cfg`); that the controlnet_aux v3 schema puts every preprocessor option under
`optional`; that the CatVTON pipeline loads `booksforcharlie/stable-diffusion-inpainting` and
`stabilityai/sd-vae-ft-mse` from the HF cache the install script fills.

Install: `scripts/install-image-tools.sh` (see its header).
