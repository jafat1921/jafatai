---
title: "API contract v7: Brand Kits (Milestone 8B)"
status: Active (backend built, frontend pending)
created: 2026-10-07
extends: contract-v0..v6
migration: 0006_brand_kit (additive: brand_kit table, project.settings, shot.brand_placements)
---

# API contract v7: Brand Kits

Per PLAN-m8 section B2, the brand belongs **inside** the advert. The logo and products are **reference images** for the edit models, the prompt names the surface they appear on, and a vision check confirms the logo came out. The exact extras (watermark, intro and end cards, lower third, colour grade) are **optional and all off by default**. A pixel-exact **logo reveal** clip is available as the closing shot.

## Data

`BrandKit` (one workspace can have several; one may be `is_default`):
```
BrandKit = {
  id, workspace_id, name, is_default,
  palette: [{hex: "#0F4C5C", name?: "deep teal"}],    // up to 8; hex normalised to #RRGGBB
  style_text, voice_text, tagline,
  logos: {primary?: {media_id, description}, light?: {...}, dark?: {...}},  // light = for dark backgrounds
  products: [{media_id, name, description}],           // up to 12
  font_files: [media_id],                              // up to 4; the first is used for cards and reveal
  reference_media_ids: [media_id],                     // up to 6 mood/look references
  settings: BrandSettings,                             // always returned in full, with defaults filled in
  assets: {media_id: {media_id, kind, media_url, missing}},
  prompt_context: string,                              // see prompt_context below
  created_at, updated_at
}
BrandSettings = {
  watermark:   {enabled: false, position: "tl"|"tr"|"bl"|"br" = "br", size_pct: 12, opacity: 0.85, margin_pct: 3,
                variant: "auto"|"primary"|"light"|"dark"},
  end_card:    {enabled: false, duration_s: 2.5, bg: palette index | "#hex" | null, show_tagline: true, show_name: false},
  intro_card:  {enabled: false, duration_s: 2.0, bg, show_tagline: false, show_name: true},
  lower_third: {enabled: false, at_s: 1.0, duration_s: 4.0, text?: string (default: kit name), subtext?: string (default: tagline)},
  grade:       {enabled: false, strength: 0.25}
}
```
- `size_pct` is the logo's **longer side** as a percentage of the frame's **short side**, and `margin_pct` uses the same base. For example, a 1920Ã—1080 frame with size 12% gives a logo 130 px on its long side.
- `bg: null` means the first palette colour, or near-black when the kit has no palette.
- Asset fields hold **MediaItem ids**. Products and references may also be a project still's generation id.
- `project.settings.brand_kit_id` is the project default. It is also set by Quick Create's `brand_kit_id`.
- `shot.brand_placements: [{asset_id, asset_type: "logo"|"product", surface, prominence: "hero"|"background"}]` (at most 12) is returned on `ShotOut` and accepted by `PATCH /api/shots/{id}`.

## Endpoints
| Method | Path | Body | Result |
|---|---|---|---|
| GET | `/api/brand-kits` | | `BrandKit[]`, default first |
| POST | `/api/brand-kits` | `BrandKitIn` (`name` required; everything else optional, `settings` partial) | 201 `BrandKit`. The first kit in a workspace becomes the default |
| GET / PATCH / DELETE | `/api/brand-kits/{id}` | `BrandKitPatch` (partial; `settings` merges per section) | `BrandKit` / 204. Delete keeps the uploaded assets in the Library |
| POST | `/api/brand-kits/{id}/default` | | `BrandKit` |
| POST | `/api/brand-kits/assets?purpose=logo\|font\|product\|reference` | multipart `file` (+ optional `title`) | 201 `{item: MediaItem, warnings: string[]}` |
| POST | `/api/brand-kits/{id}/preview` | `{kind: "image"\|"end_card"\|"intro_card"\|"lower_third", sample_media_id?, settings?}` | `image/png`, synchronous |
| POST | `/api/brand-kits/{id}/logo-reveal` | `{duration_s: 3 (1.5â€“10), aspect: "16:9"\|"9:16"\|"1:1"\|"4:5", background: {kind: "color"\|"image", color?: index\|hex, media_id?}, show_tagline: true, title?}` | 202 `{item: MediaItem (video), job}` |
| POST | `/api/generations/{id}/brand` | `{kit_id?, options?}` | 202 `Job` (`brand_apply`) |
| PUT | `/api/projects/{id}/brand-kit` | `{kit_id: string\|null}` | `{project_id, brand_kit_id}` |

**Uploads** (stream-sniffed by magic bytes; the file name's extension must match):
- `font`: TTF (`00 01 00 00` / `true`) or OTF (`OTTO`), up to 10 MB. The font is then loaded with Pillow, so a fake TTF returns 415. Fonts are `MediaItem.kind = "font"` and are **excluded from `GET /api/media`** (the kit's `assets` map lists them).
- `logo`: PNG or WebP up to 5 MB, or **SVG**. SVGs are rasterised in-process by resvg (`resvg-py`, no system libraries) into a transparent PNG with a 2048 px long side. An SVG with a DOCTYPE or entities, a script, a foreignObject, event attributes or links to outside files returns 415. JPEG is refused. A logo without transparency is accepted with a warning.
- `product`, `reference`: PNG, JPEG or WebP up to 40 MB.

All assets are tagged `brand` + the purpose.

**Preview:**
- `image` always shows the watermark position, even while the watermark is off, plus the grade if it is on.
- Without `sample_media_id` it uses a palette gradient at 1280Ã—720. A sample image or video frame keeps its own size, up to 1280 px.
- `settings` lets the editor preview unsaved changes.

**Apply brand** (`brand_apply`):
- Works on renders, takes, Library images and videos, project stills and uploads.
- Creates a **new version of the same target** (same kind; uploads become `image`/`video`), with `parent_id` set to the source. The source is untouched.
- `params.brand = {kit_id, kit_name, applied: [...], settings, source_id, auto, stats}`.
- Kit is chosen in this order: `kit_id`, then the project's kit, then the workspace default. If none is found it returns 422.
- `options` override the kit for this call. Use `{"watermark": true}` or `{"end_card": {"enabled": true, "duration_s": 3}}`.
- Images take only `watermark` and `grade`. If nothing is enabled it returns 422 with a message saying what to turn on.
- Videos get one ffmpeg pass that keeps the source size and frame rate:
  - grade, watermark (PNG overlay with alpha) and lower third (fades in and out) over the source;
  - intro and end cards (Pillow PNG, brand colour, centred logo, wrapped tagline in the brand font, 0.35 s fade) joined with the concat filter;
  - the original audio is kept and the cards carry silence, so the output always has one continuous 48 kHz stereo track;
  - chapters are preserved and shifted by the intro's length.
- Duration = intro + source + end (for example 2 s + 2.5 s = 4.5 s).
- Jobs are CPU-only (usage ledger kind `brand`).

**Logo reveal** (`brand_reveal`):
- A motion-graphics clip built from the real logo file:
  - the logo fades in over 0.7 s while easing from 94% to 100% scale;
  - a soft diagonal light sweep crosses it;
  - the tagline fades in from 0.9 s;
  - the background is the brand colour with a vignette, or a Library image darkened to 55%.
- 24 fps with a silent stereo track.
- Deterministic: the same input always gives the same frames.
- Sizes: 1920Ã—1080, 1080Ã—1920, 1080Ã—1080 or 1080Ã—1350.

## Generation-time hooks
`brand_kit_id` is accepted on `POST /api/images/generate`, `POST /api/images/edit`, `POST /api/videos/generate` and `POST /api/quick`:
- **Prompt:** `image_prompt_suffix(kit)` adds the palette and the look, for example `"... colour palette: deep teal #0F4C5C, warm sand #E3B23C, minimal, premium"`. Tone of voice is left out of image and video prompts.
- **Edit refs:** product images, then the kit's references, are appended to `reference_ids` while there is room under the model's `max_refs`.
- **Output pass:** `params.brand = {kit_id, auto: true}`. When the job finishes, the worker hook (`brand.on_job_finished`) queues a `brand_apply` follow-up (priority âˆ’1). It does this only if the kit has an output step switched on. With the defaults, nothing happens.
  - Same for stitched renders and upscaled renders of a project with `settings.brand_kit_id`.
  - For an autopilot that will upscale, the brand pass waits for the upscaled film.
  - When the branded film is ready, the Quick Create job's `result.final_render_id` moves to it (`clean_render_id` keeps the original).
- **Quick Create:** `brand_kit_id` is stored as `project.settings.brand_kit_id`.

## Integration points (planner, keyframes, autopilot)
All in `backend/app/brand.py`. They are now wired in through `app/brand_moments.py`; see "As built: brand moments" below.
| Function | Use |
|---|---|
| `get_kit(db, workspace_id, kit_id=None, project_id=None)` | `kit_id`, `"default"`, or the project's kit; `None` when unset |
| `prompt_context(kit) -> str` | Text block for the reasoning/creative LLM: name, tagline, palette (names + hex), look, tone of voice, products, logo description. Feed it to the advert planner and to script/caption prompts |
| `brand_reference_set(kit, placements, max_refs, character_ref_ids=None) -> BrandRefSet` | For a shot's `brand_placements`. Order: hero placements, then characters, then background placements, capped at `max_refs`. Returns `media_ids` and `labels` (for `reference_labels`, the "Picture N shows ..." preamble), `prompt` (e.g. "the Leaf logo (round green leaf) printed on the cup sleeve, front-facing, sharp, legible") and `dropped`. Placements that don't fit still appear in the prompt |
| `resolve_reference_ids(db, workspace_id, media_ids)` | Media ids to generation ids, which is what `params.reference_ids` expects. Character ids that are already generation ids pass through |
| `check_logo(image_path, logo_path, surface=None) -> dict` | Vision check: `{checked: true, passed, present, legible, distorted, score, issues, call}`, or `{checked: false, reason}` when the model is unavailable. `passed` = present âˆ§ legible âˆ§ Â¬distorted âˆ§ score â‰¥ 6. Use it for "regenerate up to N times, then flag for review" |
| `brand_render.logo_reveal_clip(assets, dest, duration_s, size, fps, colour, bg_image, show_tagline)` | The closing shot without a job. Use it to build it inline at the project's size and fps. `kit_assets(db, kit)` resolves the files |
| `apply_to_request(...)` | The generation-time prompt and refs hook above |

Suggested wiring:
- In `storyboard.prepare_shot_generation`, for keyframes, when `shot.brand_placements` is non-empty:
  - build a `brand_reference_set` with the character refs;
  - resolve the ids, set `reference_ids` and `reference_labels`, and append `.prompt`;
  - use the edit model.
- In the autopilot's image slot, run `check_logo` against the logo for hero placements.
- For hero shots, the planner asks for stable camera moves.

## As built: brand moments inside adverts (2026-10-07)
The integration points above are wired in. The glue is `backend/app/brand_moments.py`. No migration was needed: the closing shot is recorded in `project.settings`.

**Settings**
- `BrandSettings.closing: "auto"|"ai_packshot"|"logo_reveal"|"none" = "auto"`. It is a top-level scalar, set with `PATCH /brand-kits/{id} {"settings": {"closing": "logo_reveal"}}`.
- `project.settings.brand_closing` (same values) overrides the kit. It is also set by Quick Create's `brand_closing`.
- `auto` means `ai_packshot` when the kit has a product image, otherwise `logo_reveal`.
- A mode the kit can't do falls back to the other one: no logo means a packshot, no product means the reveal. With neither, there is no closing shot.
- `project.settings.brand_closing_shot = {shot_id, mode, kit_id}` is owned by the server. PATCH ignores it.

**Planning** (only when the project has a kit, via `project.settings.brand_kit_id`)
- The outline (`/ai/outline`, Quick Create) gets the kit's `prompt_context` plus an "this is an advert" note.
- `suggest-shots`, `storyboard` (both modes) and the autopilot's storyboard get a brand brief:
  - the context;
  - the placeable assets with short ids (`logo`, `product1`…);
  - the rules: real surfaces, at most two per shot, at least one hero, never a watermark, calm camera for hero moments.
- `ShotList` and `SceneFrames` items carry `brand_placements: [{asset_id, surface, prominence}]`.
  - Handles map back to media ids. Unknown assets are dropped, and each shot keeps at most 3.
  - Stored as `{asset_id, asset_type, surface, prominence, source: "ai"}`.
- **Locks:**
  - `PATCH /shots/{id} {brand_placements}` stores each item as sent: `source` (`"ai"|"user"`) and any extra keys are kept. An item without `source` is stored as `"user"`.
  - User-sourced placements are locked. `ShotOut.brand_placements_locked` is true when the shot has any of them.
  - A shot with user placements counts as touched, so a re-plan of its scene becomes the usual `shots` Suggestion.
  - An empty list is an empty field, which the AI may fill (same rule as `ai_may_write`).
- **`POST /api/projects/{id}/ai/brand-moments`** → `202 Job` (`ai_brand_moments`). It re-plans placements over the existing shots in one reasoning call:
  - shots with user placements get a Suggestion `{target_type: "shot", field: "brand_placements", current_text/proposed_text: JSON}`;
  - other shots are written directly;
  - result `{shot_ids, suggestion_ids, closing_shot_id}`;
  - 422 without a kit, 409 without shots.
  - Accepting the Suggestion stores the placements as `source: "user"`. `SuggestionResult` gained `shot: ShotOut`.

**Closing shot**
- After `storyboard` and `suggest-shots` write shots, `ensure_closing` appends one closing shot to the last storyboarded scene: `source: "ai"`, `seam_in: "cut"`, `prompt_mode: "manual"`. It is idempotent:
  - it stays last;
  - re-planning a scene keeps it;
  - changing the mode replaces it.
- `ShotOut.closing` (and the same value as `brand_closing`): `"ai_packshot"|"logo_reveal"|null` marks it.
- `ai_packshot`:
  - an `insert` shot of 4 s with deterministic start, end and motion prompts (the product on a clean surface, the logo on the packaging, slow steady push-in);
  - hero placements for the product and the logo;
  - normal keyframes and take.
- `logo_reveal`:
  - a 3 s shot with no keyframes: generating keyframes for it returns 409;
  - its take is a `brand_reveal` CPU job: target shot, `kind: "take"`, `params.source: "logo_reveal"`, rendered from the real logo file;
  - the clip uses the reel's draft size for the project aspect, 24 fps, with a silent 48 kHz stereo track;
  - the worker approves it when it lands (`approved_by: "brand_closing"`), so Reel and stitch include it like any take;
  - `POST /shots/{id}/takes` on this shot returns the reveal job instead of queueing LTX.
- In Quick Create, the closing shot's length comes out of the last scene, so the film keeps the length that was asked for.

**Keyframes with placements** (`storyboard.prepare_shot_generation`, used by studio and autopilot)
- When the shot has `brand_placements` and the project has a kit, the edit model is used: `params.edit_model`, or the project's, or Qwen-Image-Edit 2511.
- References come from `brand_reference_set`, ordered hero placements, then characters and location, then background placements, capped at the model's `max_refs`.
  - They are resolved to generation ids, with labels such as `"the Leaf Coffee logo"` and the character's name.
  - `params.brand = {kit_id, placements, dropped}`.
- `params.brand_prompt` (the surface phrases) is appended to the frame prompt, including prompts compiled later by the worker.
- A hero **logo** placement sets `params.brand_check = {kit_id, logo_media_id, surface}`.
- Takes of a shot with any hero placement get a steady-camera tail on the motion prompt ("Slow, steady camera move, no shake…").

**Logo check**
- Studio: when a keyframe with `brand_check` finishes, a worker hook runs `check_logo` and stores `params.logo_check = {checked, passed, present, legible, distorted, score, issues, reason?, needs_review}`. `needs_review` is true only when the check ran and failed; the UI shows "check the logo".
- Autopilot:
  - a frame whose logo check fails is not vision-scored and costs a re-roll, up to `AUTO_RETRIES`;
  - if every try fails, the frame with the best logo score is approved with `auto_check: "logo_flagged"` and `auto_issues`;
  - "couldn't check" (`checked: false`) never blocks.
- "Regenerate with logo" is `POST /generations/{id}/regenerate {mode: "note", note}` on a keyframe of a shot with placements.
  - The brand references, `brand_check` and the surface fragment are rebuilt from the shot's current placements.
  - The fragment goes back on even if the LLM's rewrite dropped it.
  - The old `logo_check` isn't copied, so the new frame is checked afresh.

**Advert templates** (`templates/video.json`)
- `video-product-ad-30s`, `video-brand-story-60s` and `video-vertical-teaser-15s` have `requires_brand: true`. It is a hint, not enforced. It shows in `GET /templates` (`TemplateOut.requires_brand`) and in the start prefill.
- They also have `planner` notes.
- `POST /quick` accepts `template_id` (404 if unknown) and `brand_closing`. The template's planner notes go into the outline prompt ("Format notes: …").
- Tested end to end on the mock driver with a kit, for both packshot and logo-reveal closings.

## Limits
- **Urdu and RTL text:** shaped by Pillow+libraqm when it is available. Otherwise `arabic-reshaper` + `python-bidi` fall back to joined glyphs in visual order (Naskh style; Nastaliq ligatures need raqm).
  - The kit's font must contain Urdu glyphs. With no kit font, the renderer tries Noto Naskh/Sans Arabic or DejaVu on Linux, and Arial/Segoe UI on Windows.
  - Glyph coverage isn't checked yet; missing glyphs show as boxes.
- Watermark `variant: auto` picks the light or dark logo from the brightness under the logo position. For video this is sampled on one frame at about 1 s.
- The grade is a brightness-neutral midtone push toward the palette's mean colour (the same curve in Pillow and in ffmpeg `lutrgb`). It is gentle at 0.25.
