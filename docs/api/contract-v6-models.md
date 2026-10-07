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

## As built: image to image and image to video (Milestone 8A, 2026-10-07)

**Catalog:** new capability `"i2i"` on `zimage_turbo`, `flux2_klein` and `qwen_image_2512`, each backed by its own template (the model's `extra` map). If the i2i template fails the `/object_info` check, `"i2i"` disappears from that model's `capabilities` while text to image stays available.

| Model | Template | Graph |
|---|---|---|
| `zimage_turbo` | `zimage_i2i` | LoadImage → ImageScale (lanczos, crop center) → VAEEncode → KSampler `denoise` = strength (8 real steps at any strength) |
| `flux2_klein` | `flux2_klein_i2i` | LoadImage → ImageScale → VAEEncode; Flux2Scheduler → **SplitSigmasDenoise** (low sigmas) → SamplerCustomAdvanced. The scheduler gets `ceil(4 / strength)` steps, so about 4 real steps run |
| `qwen_image_2512` | `qwen_image_i2i` | as Z-Image, with Qwen's speeds (Full / Lightning / Turbo) |

All three pass `check_template` against the live `/object_info` (2026-10-07). The test fixture gained `SplitSigmasDenoise`.

**`POST /api/images/img2img`** → `202 ImageBatchOut` (same as `/images/edit`)
```
{source_id,            // Library item id (uploads too) or any finished image generation id
 prompt,               // what the result should be
 strength: 0.45,       // 0.1 (subtle) – 0.9 (reimagine); outside → 422
 model?,               // an image model with "i2i" (default Z-Image Turbo); edit/video ids → 422
 speed?, count: 1–4, aspect: "source" | "1:1"|"16:9"|"9:16"|"4:3"|"3:4"|"2:3"|"3:2",
 seed?, negative?, title?, brand_kit_id?}
```
- `aspect: "source"` keeps the source's shape at about 1 MP (multiples of 64). Any other aspect centre-crops the source to that shape.
- Each result is a new Library image whose `params.img2img_of = {media_id|null, generation_id, strength}`. Regenerate re-runs the same image to image.
- `brand_kit_id` adds the palette and look to the prompt, like Create Image.
- 404 for an unknown source; 422 for a source that isn't a finished image.

**Image to video (`POST /api/videos/generate`)**
- New `end_image_id` (Library id or generation id, uploads included): first and last frame. It needs `image_id` (422 without it) and a model with `"flf"` (LTX-2.3 Standard and HQ).
  - Standard and HQ pass `last_image` into `ltx23_i2v` / `ltx23_two_stage`.
  - A long clip (over one pass, Standard only) pins the end image on its last chunk.
- `aspect` is now optional. Without it, the clip takes the supported aspect (16:9, 9:16, 1:1, 4:3, 2.39:1) closest to the start image, so a portrait photo makes a 9:16 clip. Without an image the default is 16:9, and an explicit `aspect` always wins.
- Wan 2.2 with `image_id` or `end_image_id` → 422 ("makes video from text only").
- `brand_kit_id` works as before.

**Uploads everywhere:** every source-image input takes a Library item id or a generation id: `images/edit`, `images/img2img`, `videos/generate` (`image_id`, `end_image_id`). `POST /generations/{id}/upscale` and `POST /generations/{id}/brand` now also take a Library item id, standing for its current version.

## P1 endpoints (UI polish, 2026-10-07)

**Magic prompt: `POST /api/prompts/enhance`** (editor)
```
in:  {prompt, kind: "image"|"video"|"quick" = "image", model?, style?, brand_kit_id?, mode: "auto"|"on" = "auto"}
out: {enhanced, changed: bool, notes?: str}
```
- The creative LLM (thinking off, strict JSON) adds visual detail: at most ~120 words for images, ~160 for video and quick. Video adds the camera, the motion and sound cues.
- Quoted text (`"…"`, `“…”`, `«…»`, `「…」`) is copied verbatim and never translated, including Urdu. If the model changes it, the original comes back with `changed: false` and a note.
- `auto` only enhances prompts under 12 words (quotes not counted) or prompts with no look, light or camera words. Otherwise the prompt comes back unchanged.
- If the LLM is down, slow (`ENHANCE_TIMEOUT_S`, 30 s) or broken, you get the original, `changed: false`, `notes: "enhancer unavailable"`. This is never an error.
- Identical requests are cached in memory for 10 minutes.

**Generators:** `images/generate`, `images/img2img`, `videos/generate` and `POST /quick` accept `magic_prompt: "auto"|"on"|"off"` (the default comes from `MAGIC_PROMPT_DEFAULT`, `auto`) and `prompt_enhanced: bool`.
- Send `prompt_enhanced: true` when the dock already showed the enhanced text. The job then won't enhance it again.
- Otherwise the job enhances the prompt before the GPU step. Style and brand suffixes are kept.
- Each generation records `params.magic_prompt {mode, status: off|client|pending|done, changed?, notes?}`, plus `params.original_prompt` and `params.enhanced_prompt` once the job has run.
- Quick Create keeps the client's brief. The expanded idea goes to the outline beside it, recorded in `job.result.magic_prompt`.
- Batch responses also return `magic_prompt` (the marker) and `model_resolved`.

**Auto model:** `model: "auto"` on `images/generate`, `images/img2img`, `images/edit`, `videos/generate`.
- **image:**
  - `qwen_image_2512` when the prompt has quoted text, non-Latin script, or words like poster, sign, logo, text, banner or billboard;
  - `flux2_klein` when `count ≥ 4` and there's no text;
  - otherwise `zimage_turbo`.
- **edit:** `qwen_image_edit_2511` (or an edit model that takes that many refs).
- **video:** `ltx23_distilled`; `ltx23_hq` only with `quality: "hq"`.
- A pick known to be unavailable is skipped.
- `params.model_resolved` is always set. With auto, `params.model_requested: "auto"` and `params.model_auto_reason` are set too.
- A `speed` sent with auto is ignored if the picked model has no speeds.
- `GET /api/models` lists `{id: "auto", label: "Auto", auto: true, description: "Picks the best model for your prompt", default: false}` first for image, edit and video. Project settings treat `"auto"` as "use the default" for now.

**Estimate: `GET /api/estimate?kind=image|video|take|upscale&model=&speed=&count=&duration_s=&width=&height=`**
```
out: {low_s, high_s, basis: "measured"|"rough", samples, model, load_s, units}
```
- A unit is one image, or one output second for video and video upscale (`kind=upscale` with `duration_s` means video; without it, image).
- **measured** (3 or more samples):
  - the median (low) and p80 (high) GPU seconds per unit from this workspace's last 300 finished generations (`params.comfy.gpu_seconds`, long-take and video-upscale stats, else `job.gpu_seconds`);
  - grouped by model, speed and a 0.25 MP size bucket;
  - other sizes of the same model are scaled by pixel count;
  - `high` is never under 1.15 × `low`.
- **rough:** the catalog's warm guess × 0.75 … 1.6.
- `load_s` (a model load) is added to both ends when the model isn't the last one the GPU ran.
