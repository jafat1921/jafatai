# API contract v10: Photo Studio Restore and Cut-out (M9b)

Builds on [v9 Photo Studio](contract-v9-photo.md). Every tool makes a **new version** of the picture, the same way Develop does. ComfyUI only does the model work, on the **image** lane. The server then finishes on the CPU at the source's full size:
- strength blend;
- alpha kept;
- prompted fixes pasted only where the picture changed;
- cut-outs composited from a stored mask.

## Endpoints (`/api/photo`)
| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/tools` | — | `{tools: RestoreTool[], effects}`. Availability is checked against ComfyUI's `/object_info` (cached for 120 s) |
| GET | `/{id}/smart-plan` | — | `{analysis, steps: PlanStep[], source, message}` |
| POST | `/{id}/smart-restore` | `{steps: [{tool, on, variant, strength}]}` | 202 `{chain_id, steps, first_job_id}` |
| POST | `/{id}/restore` | `RestoreIn` | 202 `Job` |
| POST | `/{id}/background` | `{background: {type, colour?, generation_id?, radius?}, edge?: {feather, shift}}` | 202 `Job` (CPU, general lane) |
| GET | `/{id}/mask` | — | the current cut-out mask as a PNG, or 404 |
| POST | `/{id}/describe` | — | `{caption, details, defects[], suggested_tools[]}` from the vision LLM |

`{id}` accepts a generation id or a Library item id (meaning its current version). `RestoreIn` fields:
- `tool`, `variant`;
- `strength` (0.05–1);
- `prompt` (≤600 characters);
- `words`, `include[]`, `exclude[]` — points as 0..1 of the *source* image;
- `op`: `replace` | `add` | `subtract`;
- `edge`, `note`.

Errors are 422, with a plain-English `detail`.

## Tools
| id | Group | Engine (template) | Options |
|---|---|---|---|
| repair | repair | SeedVR2 (`image_upscale_seedvr2` at source size, capped to `IMAGE_UPSCALE_MAX_MP`) | variant 3b / 7b, strength |
| scratches | repair | Qwen-Image-Edit with the scratch-removal preset | optional extra prompt |
| heavy | repair | SUPIR + SDXL (`photo_supir`, about 1.5 MP) | **only when `PHOTO_ALLOW_NONCOMMERCIAL=true`** |
| fix | repair | edit model, ~1 MP | prompt required |
| jpeg | clean | FBCNN (`photo_model_1x`) | strength |
| denoise | clean | NAFNet-SIDD (strong) / SCUNet (gentle) | variant, strength |
| deblur | clean | NAFNet-GoPro (motion blur) | strength |
| faces | faces | GFPGAN v1.4 (`photo_face_restore`) | strength |
| colourise | colour | DDColor modelscope (natural) / artistic (vivid) (`photo_colourise`) | variant, strength |
| deyellow, polish | colour, finish | CPU effects `deyellow` / `auto_restore` | strength |
| stylise | style | edit model: hand-painted or cinematic anime | variant |
| cutout | cutout | BiRefNet mask (`photo_cutout_mask`) | edge |
| select | cutout | SAM 3.1 mask (`photo_sam_mask`) from words and/or points | op, edge |
| background | cutout | edit model paints the scene; the subject's own pixels are composited back over it | prompt required |

Colourise details:
- **Sepia, yellowed or grey** sources are first converted to an auto-contrast grey (`restore.grey_first`).
- DDColor's input size scales with megapixels: ≥6 MP → 1024, ≥2 MP → 768, otherwise 512.

## Smart Restore
The plan follows NoorViz's order, with a reason on each step:
1. JPEG clean-up, if the JPEG is heavily compressed (under ~0.3 bytes per pixel).
2. Scratches, then repair, if the photo looks damaged. Repair alone if it is only blurry.
3. Denoise: noise σ > 4, Immerkær estimate. The "gentle" variant is used when σ < 7.
4. Deblur: offered switched off.
5. Colourise, for black & white or tinted prints. Landscapes get "vivid", others "natural".
6. Otherwise de-yellow, if there is a yellow cast.
7. Faces: switched on for old or portrait-shaped photos; switched off for landscapes.
8. Final polish at 50%.

How a run behaves:
- Each step becomes its own version. The next step is queued by a finished-job hook.
- A failed step does not stop the chain: the next step starts from the last good version.
- A step that can't be queued (for example, its model went missing) is recorded in `chain_skipped`.
- Cancelling a step stops the rest.

## History additions
`versions[]` now also carries:
- `restore: {tool, variant, strength, user_prompt, changed}`
- `cutout: {has_mask, coverage, edge, background}`
- `chain: {id, index, steps, skipped}`

`edit` can now be `restore` or `cutout`.

## Image upscale
New engine `anime` (alias `cartoon`): Real-ESRGAN x4plus anime 6B, at 2× / 4× / 2K / 4K.
