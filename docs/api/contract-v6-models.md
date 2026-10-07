---
title: API contract v6: Model catalog and model choice everywhere (Milestone 7)
status: Active
created: 2026-10-07
extends: contract-v0..v5
---

# API contract v6: Model catalog

**Goal (product owner):** "Provide the options to the users of what we have." Every model installed on the server that the app can drive becomes a user-selectable option, with honest labels (speed, quality, sound or no sound, what it's good at).

## Catalog
`GET /api/models?type=image|edit|video|upscale` → `Model[]`
```
Model = {
  id, type: "image"|"edit"|"video"|"upscale",
  label, badge: "FAST"|"BEST"|"TEXT"|"NEW"|"HQ"|"QUICK"|"UPSCALE"|null,
  description,                       // one line, plain language
  capabilities: [ "t2i" | "edit" | "refs" | "t2v" | "i2v" | "flf" | "audio" | "longtake" | "text_render" | "multi_angle" ],
  speeds?: [{id, label, steps, note}], // e.g. Qwen-Image: full / lightning-4 / turbo-2
  default_speed?, max_refs?, max_duration_s?,
  est_seconds?: number,              // a typical single output, warm
  available: bool, reason?: str,     // from check_template (missing nodes or models)
  default: bool                      // the default for its type
}
```
The catalog lives in `backend/app/models_catalog.py`, one entry per model, each pointing at a template plus default parameters. It is the **single source of truth** for menus, pickers and validation.

### Entries
| id | type | label · badge | template / files | notes |
|---|---|---|---|---|
| `zimage_turbo` | image | Z-Image Turbo · FAST · default | zimage_t2i | photoreal, about 7 s |
| `qwen_image_2512` | image | Qwen-Image 2512 · TEXT | new `qwen_image_t2i`: qwen_image_2512_fp8_e4m3fn + qwen_2.5_vl_7b_fp8_scaled + qwen_image_vae | **text inside images, including Urdu**. Speeds: Full (about 20–30 steps), Lightning 4-step (`Qwen-Image-2512-Lightning-4steps-V1.0-fp32`), Turbo 2-step (`Wuli-Qwen-Image-2512-Turbo-LoRA-2steps-V1.0-bf16`) |
| `flux2_klein` | image | FLUX.2 klein 4B · FAST | new `flux2_klein_t2i`: flux-2-klein-4b-fp8 + qwen_3_4b + flux2-vae | very fast general images |
| `qwen_image_edit_2511` | edit | Qwen-Image-Edit 2511 · BEST · default | qwen_edit | up to 3 references; multi-angle LoRA option |
| `flux2_klein_edit` | edit | FLUX.2 klein 4B (base) · edit | new `flux2_klein_edit`: flux-2-klein-base-4b + qwen_3_4b + flux2-vae, reference conditioning | reference-guided edits; up to the references the graph supports (validate) |
| `ltx23_distilled` | video | LTX-2.3 · default | ltx23_i2v / ltx23_extend | t2v, i2v, flf, **audio**, longtake. "Standard" |
| `ltx23_hq` | video | LTX-2.3 High quality · HQ | new `ltx23_two_stage`: ltx-2.3-22b-dev-fp8 + `ltx-2.3-22b-distilled-lora-384-1.1` (or the dynamic 1.1 LoRA) stage 1, then spatial upscaler ×2 (`ltx-2.3-spatial-upscaler-x2-1.1`) refine stage 2 | t2v, i2v, flf, **audio**; slower, higher resolution. Single-chunk shots only for now (long takes keep Standard) |
| `wan22_t2v` | video | Wan 2.2 14B · no sound | new `wan22_t2v`: high/low-noise 14B fp8 + lightx2v 4-step LoRAs + umt5_xxl + wan_2.1_vae | **t2v only, no audio, no image input**; offered only where a text prompt starts the clip |
| `seedvr2` / `flashvsr` / `esrgan` / `zimage_redraw` | upscale | (existing) | existing | listed for the menus |

**Optional render toggle** (an LTX option, not a separate model): **Smooth motion ×2** uses `ltx-2.3-temporal-upscaler-x2-1.0` (24→48 fps) inside the LTX graph. Expose it as `params.smooth_motion` if the temporal upscaler node chain validates; otherwise mark it unavailable with a reason.

## Where users choose
- **Image → Create Image:** a model picker (Z-Image Turbo · Qwen-Image 2512 · FLUX.2 klein), plus a speed picker when the model has speeds. `POST /images/generate` accepts `model` and `speed`.
- **Image → Edit Image:** a model picker (Qwen-Image-Edit 2511 · FLUX.2 klein base). `POST /images/edit` accepts `model`.
- **Studio:**
  - Cast & World portraits and establishing frames, and Storyboard frames, accept `params.model` (an image model for no-reference generation; the edit model is used when references exist). The project default comes from `project.settings.image_model`.
  - Render: **Quality** = Standard (LTX-2.3) / High quality (LTX two-stage), plus **Smooth motion** if available. Wan is **not** offered in the studio, because the studio needs image input with first/last frames.
- **Video → Create Video (new page, "clip maker"):** one prompt to one clip, or prompt plus a start image.
  - Model picker: LTX-2.3 (with sound; up to the long-take max) · LTX-2.3 HQ · Wan 2.2 (text only, no sound; about 5 s).
  - `POST /videos/generate {prompt, model, duration_s, aspect, image_id?, seed?, smooth_motion?}` → a MediaItem of kind video.
- **Quick Create:** Advanced options gain "Image model" and "Video quality".
- **Mega-menus:** the Models column comes from the catalog, showing only available models. Clicking a model preselects it (`?model=`).

## Validation
- An unknown or unavailable model returns 422 with the reason.
- A capability mismatch returns 422 with a plain message. Examples: Wan with an image input; refs > `max_refs`; duration > `max_duration_s`.
- `GET /api/system/comfy-check` includes the new templates.

## As built (backend, 2026-10-07)
Everything above is implemented. Additions and small deviations, all backwards compatible:

**Catalog (`GET /api/models`)**
- Extra fields: `estimate_source: "measured"|"rough"` (measured = median GPU s of this workspace's recent outputs; videos are per 5 s clip); each speed carries `available` and `reason` (a missing speed LoRA disables only that speed); video entries carry `audio: bool` and LTX entries `smooth_motion: {available, reason}`.
- `ltx23_distilled.max_duration_s` is the long-take maximum (`LONGTAKE_MAX_S`, 300 s). `ltx23_hq` is 10.67 s (one pass, 257 frames). Wan is 5 s.
- Wan's badge is `NEW`; FLUX.2 klein edit has no badge. `flux2_klein_edit.max_refs = 3`.
- Qwen-Image "Full" uses 30 steps, cfg 4, shift 3.1 (the ComfyUI template uses 50; 30 keeps most of the detail in 60% of the time). Lightning: 4 steps, cfg 1. Turbo: 2 steps, cfg 1, shift 3.
- When ComfyUI can't be reached, every entry is `available: false` with the reason. Validation only refuses a model when a recent check said it is unavailable.

**Image studio**: `POST /images/generate {model?, speed?}`, `POST /images/edit {model?}` (refs above `max_refs` give 422 naming the model). Regenerate keeps the model.

**Studio**
- Stills take `params.model` (image model) and optional `params.edit_model` (used when references exist; default Qwen-Image-Edit). Character sheet views always use Qwen-Image-Edit (the angles LoRA is Qwen-only).
- `project.settings` (in `ProjectOut`, `ProjectCreate`, `ProjectPatch`): `image_model`, `image_speed`, `edit_model`, `video_quality: "standard"|"hq"`, `smooth_motion: bool`. PATCH **merges** keys (a key set to `null` is removed), so other features' keys (brand kits) are untouched. Unknown model ids give 422.
- Takes: `POST /shots/{id}/takes` and `/scenes/{id}/render` accept `quality` and `smooth_motion` (or `params.quality` / `params.smooth_motion` on `POST /generations`). HQ and Smooth motion are single-pass only: asked for explicitly on a long take they return 422; inherited from the project default they fall back to Standard and the take gets `params.quality_note`. A scene-wide render skips the explicit choice for its long shots instead of failing.
- User LoRAs are only applied to the family they belong to (Z-Image, Qwen-Edit, LTX); with another model they are ignored.

**Create Video**: `POST /videos/generate {prompt, model?, duration_s=5, aspect="16:9"|"9:16"|"1:1"|"4:3"|"2.39:1", image_id?, seed?, smooth_motion?, negative?, title?}` → `202` with a MediaItem (`kind: "video"`) plus `job`. `image_id` is a Library image (MediaItem id) or an image generation id. LTX-2.3 clips longer than one pass render as a long take (chunk 0 is text to video when there's no image). Wan clips are 81 frames at 16 fps (reported `duration_s` = 5.0). Finished clips get a poster thumbnail.

**Quick Create**: `image_model`, `image_speed`, `video_quality`, `smooth_motion`; stored in `project.settings`, so every autopilot stage uses them (long takes fall back to Standard with a note).

**Smooth motion** is `ltx-2.3-temporal-upscaler-x2-1.0` through `LTXVLatentUpsampler` after the last sampling pass: frames 2N−1, played at 48 fps, same duration. It validates on the server but has not been rendered yet, so treat it as experimental until the server check below passes.

**Templates**: `qwen_image_t2i`, `flux2_klein_t2i`, `flux2_klein_edit`, `ltx23_two_stage`, `wan22_t2v`; `ltx23_i2v` now also does text to video and smooth motion. All appear in `GET /system/comfy-check` (with `features.smooth_motion` for the LTX ones); all 15 templates pass against the live `/object_info`.
