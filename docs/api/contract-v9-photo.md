---
title: "API contract v9: Photo Studio (M9a: Develop, history, Auto, Looks, look on video)"
status: Active (M9a backend)
created: 2026-10-09
extends: contract-v0..v8
migration: 0010 (new table `look`, additive)
plan: docs/PLAN-m9-photo-studio.md
---

# API contract v9: Photo Studio (M9a)

Everything here is CPU work. Jobs run on the **general** lane (`job.lane = "general"`), never on a GPU.
All routes need a signed-in user. Reads work for any role; anything that writes needs an editor.

**Ids.** Wherever a route takes `{generation_id}` (or `{gen_id}`), a Library item id also works: it stands
for that item's current version (same rule as `/api/generations/{id}/upscale`).

**Which images work.** A finished (`ready` or `approved`) generation whose media type is `image/*`:
project frames (portrait, establishing, keyframes, sheet views), Image studio results and image uploads.
Anything else is a 422.

---

## 1. Develop parameters

One JSON object. Every key is optional: a missing key means "leave alone", and `{}` is the identity.
The keys and ranges are the NoorViz ones, so NoorViz presets map 1:1.

```json
{
  "version": 1,
  "exposure": 0, "contrast": 0, "highlights": 0, "shadows": 0, "whites": 0, "blacks": 0,
  "temperature": 0, "tint": 0, "vibrance": 0, "saturation": 0,
  "clarity": 0, "sharpness": 0, "noiseReduction": 0, "vignette": 0,
  "curve": {"blacks": 0, "shadows": 0, "mids": 0, "highlights": 0, "whites": 0},
  "hsl": {"red": {"h": 0, "s": 0, "l": 0}, "orange": {…}, "yellow": {…}, "green": {…},
          "aqua": {…}, "blue": {…}, "purple": {…}, "magenta": {…}},
  "crop": null, "rotate": 0, "flipH": false, "flipV": false,
  "lightPoints": [],
  "palette": [],
  "lut": null
}
```

| Key | Range | Notes |
|---|---|---|
| `version` | `1` | Schema version of the maths below. The server fills it in. |
| `exposure` | -100..100 | ±100 = ±1.5 stops |
| `contrast` `highlights` `shadows` `whites` `blacks` | -100..100 | |
| `temperature` `tint` | -100..100 | relative shift, not Kelvin |
| `vibrance` `saturation` | -100..100 | `saturation: -100` is fully monochrome |
| `clarity` | -100..100 | spatial (server only) |
| `sharpness` `noiseReduction` | 0..100 | spatial (server only) |
| `vignette` | -100..100 | negative = dark corners |
| `curve.*` | -100..100 | output offset at input 0, .25, .5, .75, 1 (±100 = ±0.5) |
| `hsl.<band>.h/s/l` | -100..100 | bands: red 0°, orange 30°, yellow 60°, green 120°, aqua 180°, blue 240°, purple 270°, magenta 300° |
| `crop` | `null` or `{x, y, width, height}` | source pixels, after EXIF orientation, before rotate |
| `rotate` | -180..180 | degrees, **positive = clockwise**. Multiples of 90 turn the frame; anything else is straightened and cropped to the largest rectangle of the same aspect |
| `flipH` `flipV` | bool | applied after rotate |
| `lightPoints[]` | max 16 | `{x, y, exposure: -100..100, falloff?, refW?, refH?}` (see below) |
| `palette[]` | max 16 | `{centerR, centerG, centerB: 0..255, enabled: bool, h, s, l: -100..100}` (from `GET …/palette`) |
| `lut` | `null` or `{look_id, amount: 0..100}` | applies a `.cube` look (section 6). Our extension; NoorViz has no such key |

Out-of-range values are a 422. Unknown keys are ignored (so older clients keep working).

**Light points.** `x`, `y` and `falloff` are measured on the developed frame (after crop, rotate, flip)
drawn at `refW`×`refH`. Leave `refW`/`refH` out to mean the developed frame at full resolution.
`falloff` defaults to 25% of the long edge.

### GET /api/photo/schema

Everything the panel needs to build itself:

```json
{
  "version": 1,
  "defaults": { …the object above… },
  "ranges": {
    "exposure": {"min": -100, "max": 100, "step": 1, "default": 0, "label": "Exposure", "spatial": false},
    "sharpness": {"min": 0, "max": 100, "step": 1, "default": 0, "label": "Sharpening", "spatial": true},
    "curve.mids": {…}, "hsl.h": {…}, "hsl.s": {…}, "hsl.l": {…}, "rotate": {"min": -180, "max": 180, "step": 0.1, …},
    "lightPoints.exposure": {…}, "lut.amount": {"min": 0, "max": 100, "default": 100, …}
  },
  "groups": [
    {"id": "basic", "label": "Basic", "keys": ["temperature", "tint", "exposure", "contrast", "highlights", "shadows", "whites", "blacks", "vibrance", "saturation"]},
    {"id": "curve", "label": "Tone curve", "keys": ["curve.blacks", "curve.shadows", "curve.mids", "curve.highlights", "curve.whites"]},
    {"id": "hsl", "label": "Colour mixer", "keys": ["hsl"]},
    {"id": "detail", "label": "Detail", "keys": ["clarity", "sharpness", "noiseReduction"]},
    {"id": "effects", "label": "Effects", "keys": ["vignette"]},
    {"id": "local", "label": "Local light · Selective colour", "keys": ["lightPoints", "palette"]},
    {"id": "geometry", "label": "Crop & rotate", "keys": ["crop", "rotate", "flipH", "flipV"]},
    {"id": "look", "label": "Look", "keys": ["lut"]}
  ],
  "hsl_bands": [{"id": "red", "label": "Red", "hue": 0}, …],
  "spatial_keys": ["clarity", "sharpness", "noiseReduction", "lightPoints"],
  "formats": [{"id": "jpeg", "label": "JPEG", "media_type": "image/jpeg"}, {"id": "png", …}, {"id": "png16", …}, {"id": "tiff16", …}],
  "effects": [{"id": "deyellow", "label": "De-yellow", "hint": "…"}, …]
}
```

`spatial: true` means the value depends on neighbouring pixels. A WebGL preview can skip those and ask
the server (`/preview`) once the user lets go of the slider.

### The maths (so a WebGL preview matches the server)

All values are 0..1. `enc`/`dec` are the exact sRGB transfer functions. `Y(rgb) = 0.2126 R + 0.7152 G + 0.0722 B`.
Steps run in this order; the domain is shown for each one.

1. **Decode** the file, apply its EXIF orientation, convert an embedded ICC profile to sRGB.
2. **Geometry**: crop, then rotate (with an inscribed crop), then flip.
3. **Noise reduction** *(spatial, sRGB)*: a guided filter on luma plus a chroma blur.
4. **To linear**: `lin = dec(v)`.
5. **White balance** *(linear)*: `t = temperature/100`, `m = tint/100`;
   `g = [(1+0.3t)(1+0.15m), 1-0.15m, (1-0.3t)(1+0.15m)]`; gains `G = g^2.2 / Y(g^2.2)` (so grey keeps its brightness).
6. **Exposure** *(linear)*: `lin *= 2^(1.5 * exposure/100)`.
7. **Light points** *(linear, spatial)*: per pixel `stops = Σ 1.5·e/100 · exp(-d²/2f²) · exp(-(Yp-Ya)²/2σ²)`, `lin *= 2^stops`,
   where `Yp = enc(Y(lin))` for the pixel, `Ya` the same under the point and `σ = clamp(0.6·std(Yp), 12/255, 30/255)`.
8. **Clip** to 0..1 and encode: `p = enc(lin)`.
9. **Palette** *(sRGB, 0..255 distances)*: soft membership `w_k = exp(-|p-c_k|²/2σ²)`, `σ = max(20, 0.55 · mean pairwise centre distance)`;
   HSV shift by the weighted h/s/l, then blend toward luma by the weight of disabled clusters (NoorViz algorithm).
10. **Tone** *(sRGB, per channel)*, one curve `T`:
    - contrast: `a = 0.5·contrast/100`, `t = x + a·(x-0.5)·4x(1-x)`;
    - curve offset `o(t)`: piecewise linear through `0.5·curve.*/100` at t = 0, .25, .5, .75, 1;
    - regional: `0.35·(bl·G(t,.05,.10) + sh·G(t,.25,.18) + hi·G(t,.70,.18) + wh·G(t,.92,.10))`, `G(t,μ,s)=exp(-(t-μ)²/2s²)`, sliders /100;
    - `T(x) = clip(t + o(t) + regional, 0, 1)`, sampled at 16384 points and made **monotonic with a running maximum**.
11. **HSL** *(sRGB, HSV)*: the hue picks two neighbouring band centres and blends their sliders linearly
    (a band has no effect past its neighbours' centres). Weight `w = smoothstep(0.02, 0.10, S)` so greys are untouched.
    `H += w·30°·h/100`, `S = clip(S·(1 + w·s/100))`, `V = clip(V·(1 + 0.5·w·l/100))`.
12. **To linear**, then **vibrance / saturation** *(linear, around Y)*: `S` = HSV saturation of `p` (step 11 output),
    `f = (1 + 0.6·vibrance/100·(1-S)) · (1 + saturation/100)`, `lin = Y + (lin - Y)·f`, clipped to 0..1.
13. **Look LUT** *(sRGB)*: trilinear lookup in the `.cube`, mixed with the input by `amount/100`.
14. **Vignette** *(linear)*: `d = sqrt((x/W-0.5)² + (y/H-0.5)²) / 0.75`, `α = 0.8·|v|·smoothstep(0.5, 1, d)`;
    dark: `lin *= 1-α`; light: `lin += (1-lin)·α`.
15. **Encode**, then **clarity** and **sharpening** *(sRGB luma, spatial)*: clarity adds `0.8·c·(Y - blur_σ(Y))·(1-(2Y-1)²)`
    with σ = 1% of the long edge; sharpening adds `(0.5+1.5s)·(Y - blur(Y))` with σ = (0.7+s) px at full resolution.
    The same delta goes on R, G and B, so colours don't fringe.
16. **Quantise** to 8 or 16 bits.

Spatial radii scale with the working size, so a 1280 px preview looks like a scaled-down full render.

---

## 2. Preview, histogram, analysis, palette, Auto (all synchronous)

### POST /api/photo/{generation_id}/preview

```json
{"params": {…DevelopParams…}, "max_side": 1280}
```
`max_side` 64..2560, default 1280. Returns `image/jpeg` (quality 90) of the developed frame.
Headers: `X-Develop-Ms` (server time), `X-Source-Size: 6000x4000`, `X-Output-Size: 1280x853`,
`Cache-Control: no-store`. The source is decoded once into a 2560 px proxy and kept in an in-process
cache, so sliders after the first call are fast (target < 300 ms at 1280 px).
A heavy crop is cut from the proxy, so it can look softer in preview than in the saved version.

### GET /api/photo/{generation_id}/histogram?params={json}  ·  POST …/histogram {"params": {…}}

Histogram of the developed image (a 512 px render):

```json
{"r": [256 floats], "g": [256], "b": [256], "luma": [256],
 "clipped": {"shadows": 0.002, "highlights": 0.013}}
```
Values are counts scaled so the tallest bin of all four is 1.0. `clipped` is the fraction of pixels with any
channel at 0 (shadows) or 255 (highlights). Use the POST form when the params are long.

### GET /api/photo/{generation_id}/analysis

```json
{"width": 6000, "height": 4000, "megapixels": 24.0, "aspect_ratio": 1.5,
 "brightness": 87.2, "contrast": 41.0, "median_luma": 0.31,
 "channel_means": [92.1, 86.0, 70.4], "is_grayscale": false,
 "color_cast": "yellow", "cast_strength": 0.31,
 "is_underexposed": false, "is_overexposed": false, "is_low_contrast": false,
 "sharpness": 1.12, "is_likely_blurry": false, "is_likely_damaged": false,
 "clipped": {"shadows": 0.001, "highlights": 0.02}, "luma_std": 0.16, "face_count": null}
```
`brightness`/`contrast` are 0..255 (mean / std of sRGB luma), `sharpness` is the NoorViz edge proxy
(sharp ≈ 1.2-1.8, soft < 0.7, blurred < 0.5). `face_count` stays `null` until M9b.

### GET /api/photo/{generation_id}/palette?k=8

Dominant colours of the **unedited** image (k-means on a 128 px probe, k 2..16), largest first.
Feed them back as `params.palette` entries:

```json
{"clusters": [{"centerR": 182, "centerG": 140, "centerB": 96, "hex": "#b68c60", "coverage": 0.31,
               "enabled": true, "h": 0, "s": 0, "l": 0}, …]}
```

### POST /api/photo/{generation_id}/auto

Smart Auto: analyses the image and **suggests** params. Nothing is applied or saved.

```json
{"params": {"version": 1, "exposure": 38, "contrast": 12, "shadows": 20, "temperature": -9, "vibrance": 14, …},
 "analysis": {…as above…},
 "notes": ["Underexposed: +0.6 stops", "Yellow cast: cooler by 9", "Flat: contrast +12"]}
```
Only the keys Auto wants to move are returned. Merge them over the user's current params (or over `{}`).

---

## 3. Saving: render and effects (jobs → new versions)

### POST /api/photo/{generation_id}/render

```json
{"params": {…}, "format": "jpeg", "quality": 95, "note": "warmer"}
```

| Field | |
|---|---|
| `format` | `jpeg` (default) · `png` (8-bit) · `png16` · `tiff16` (uncompressed, 16-bit) |
| `quality` | JPEG only, 60..100, default 95 |
| `note` | optional, stored on the new version |

Returns **202** with a `Job` (`type: "photo_render"`, `lane: "general"`). The job makes a **new version** of the
same item: same `target_type`/`target_id`, same `kind` (an `upload` becomes `image`, like upscales),
`parent_id` = the generation you rendered from, `status: "ready"`. The new version's params carry:

```json
"develop": {"params": {…normalised, version 1…}, "parent": "<generation it was applied to>",
            "base": "<first non-developed ancestor>", "format": "jpeg", "quality": 95},
"size": [6000, 4000],
"created_by": {"user_id": "…", "flow": "photo"}
```
Library items move to the new version when the job finishes (as with upscales); project frames are `ready`
and wait for approval like any other take. Posting the same params for the same source while a job is queued
returns that job. EXIF is kept on JPEG (orientation reset); every file is sRGB (JPEG/PNG carry the profile).
`media_type` is `image/jpeg`, `image/png` or `image/tiff`. Browsers can't show TIFF: use `thumb_url` for it.

**Non-destructive editing.** To keep editing a developed version without stacking edits, render from
`params.develop.base` with the stored `params.develop.params` changed. Rendering from the developed version
itself applies the new params on top of the earlier result.

### POST /api/photo/{generation_id}/effect

```json
{"name": "deyellow", "strength": 1.0, "format": "jpeg", "note": null}
```
`name`: `deyellow` · `pop` · `bw` · `sepia` · `warm` · `cool` · `soften_skin` · `denoise` · `auto_restore`.
`strength` 0..1 (default 1) mixes the effect with the input. Returns 202 + Job (`type: "photo_render"`), a new
version like `/render`, with `params.effect = {"name", "strength", "parent"}` instead of `develop`.

### GET /api/photo/{media_or_gen}/history

Every version of the item (Library item id, or any generation id of a project target), newest first:

```json
{"target_type": "media", "target_id": "…", "current_id": "<gen id>",
 "versions": [
   {"generation": {…GenerationOut…}, "current": true,
    "edit": "develop", "develop": {…params.develop…}, "effect": null, "look": null},
   {"generation": {…}, "current": false, "edit": "effect", "develop": null, "effect": {"name": "bw", …}, "look": null},
   {"generation": {…}, "current": false, "edit": null, …}
 ]}
```
`edit` is `develop`, `effect`, `look` (a video graded by a look), `upscale` or `null` (generated/uploaded).
`current` is the Library item's current version, or the approved one for project targets.
Queued/generating versions are listed too (with their job id) so the filmstrip can show progress.

### POST /api/photo/{generation_id}/revert

Takes a **generation** id (a Library item id is a 404: the item's current version is already current).
Makes an older (finished) version current again. Nothing is deleted or re-rendered:
- **Library item**: the item's current version becomes this one (`media_item.generation_id`).
- **Project target**: the same as `POST /api/generations/{id}/approve` (the old version becomes approved; the
  previously approved one goes back to `ready`).
Returns the history object above. A rejected version is a 409: restore it first with
`POST /api/generations/{id}/restore`.

---

## 4. Looks

A look is a named set of develop params, or an imported `.cube`, or both.

```json
{"id": "…", "name": "Teal & Orange", "description": "…", "category": "Mood",
 "source": "builtin", "params": {…DevelopParams…},
 "has_cube": false, "cube_size": null, "editable": false,
 "spatial": ["clarity", "sharpness"],
 "thumb_url": "/api/looks/<id>/thumb", "created_at": "…", "updated_at": "…"}
```
- `source`: `builtin` (shipped, read-only, same for every workspace), `user` (saved from the panel) or `imported`.
- `params` holds only what the look changes (sparse), e.g. `{"contrast": 30, "hsl": {"red": {"s": 10}}}`.
- `spatial`: which non-zero params a `.cube` and a video grade can't carry exactly (section 5).
- **Applying a look to a photo** is a client-side merge: put `look.params` over the current params. For a look
  with a cube, also set `params.lut = {"look_id": look.id, "amount": 100}`.

| Route | |
|---|---|
| `GET /api/looks` | built-ins first, then this workspace's looks (newest first) |
| `GET /api/looks/{id}` | one look |
| `POST /api/looks` | `{name, params, description?, category?, generation_id?}` → 201. `generation_id` makes the thumbnail from that image |
| `PATCH /api/looks/{id}` | any of `name`, `params`, `description`, `category`. Built-ins are 403 (save a copy instead) |
| `DELETE /api/looks/{id}` | 204; built-ins are 403. Versions already made with it are untouched |
| `GET /api/looks/{id}/thumb?generation_id=` (use `thumb_url`, it carries a cache-busting `?v=`) | `image/jpeg` 256 px. With `generation_id`: the look on that image (live tile previews). Without: the saved thumbnail, or the look on a built-in reference picture |
| `GET /api/looks/{id}/cube?size=33` | `.cube` download (size 2..65) |
| `POST /api/looks/import` | multipart, one or more files (any field name) |
| `POST /api/looks/{id}/apply-video` | section 5 |

### POST /api/looks/import

Accepts `.xmp`, `.lrtemplate` and `.cube` (each ≤ 16 MB; up to 20 files). Response 201 (422 if every file failed):

```json
{"looks": [{…Look…}],
 "reports": [
   {"file": "Moody.xmp", "ok": true, "kind": "xmp", "look_id": "…", "name": "Moody",
    "mapped": ["Exposure2012", "Contrast2012", "HueAdjustmentBlue", …],
    "unmapped": ["SplitToningShadowHue", "Texture", "Dehaze"], "notes": []},
   {"file": "film.cube", "ok": true, "kind": "cube", "look_id": "…", "name": "film", "cube_size": 33, …},
   {"file": "readme.txt", "ok": false, "error": "Only .xmp, .lrtemplate and .cube files can be imported"}
 ]}
```
Lightroom mapping (process 2012+; older 2010 keys where they match): Basic (`Exposure2012` in stops → our
±1.5-stop scale, `Contrast2012`, `Highlights2012`, `Shadows2012`, `Whites2012`, `Blacks2012`, `Vibrance`, `Saturation`,
`Temperature`/`Tint` for a custom white balance or `IncrementalTemperature`/`IncrementalTint`), Detail (`Clarity2012`,
`Sharpness`, `LuminanceSmoothing`), Vignette (`PostCropVignetteAmount`), Parametric curve (`ParametricShadows/Darks/Lights/Highlights`,
approximate), HSL (`Hue/Saturation/LuminanceAdjustment<Band>`) and `ConvertToGrayscale`. `unmapped` lists the
setting keys with a non-default value we don't apply (split toning, colour grading, point curves, texture, dehaze, grain,
lens corrections…). Metadata keys (name, UUID, version, process version…) are never listed.

`.cube`: 3D LUTs only (`LUT_3D_SIZE` 2..65, optional `DOMAIN_MIN/MAX`, `TITLE`). A 1D LUT is rejected. The look's
name is the `TITLE`, else the file name; its params are `{}`.

### GET /api/looks/{id}/cube?size=33

The look baked into a 3D LUT: the develop pipeline run on an identity lattice (sRGB in, sRGB out), then the look's
own `.cube` if it has one. **Spatial steps are left out** (clarity, sharpening, noise reduction, vignette, light
points); when any of them is non-zero the file header says so in a `#` comment. `Content-Disposition` is
`attachment; filename="<name>.cube"`.

`POST /api/photo/cube` `{"params": {…}, "size": 33, "title": "My grade"}` bakes params that aren't saved as a look.

---

## 5. Apply a look to a video

### POST /api/looks/{id}/apply-video

```json
{"generation_id": "<video generation or Library item id>", "intensity": 1.0}
```
Works on a stitched film (`render`), a take (`take`) or a Library video (`video`/uploaded video).
`intensity` 0..1 (default 1) mixes the graded LUT with identity. Returns 202 + Job (`type: "look_video"`,
`lane: "general"`), and the job makes a new version of the same target and kind (an upload becomes `video`) with:

```json
"look": {"id": "…", "name": "Teal & Orange", "intensity": 1.0, "source_id": "<source generation>",
         "unsharp": "unsharp=13:13:0.090:3:3:0", "spatial_skipped": ["vignette"]},
"size": [1920, 1080], "duration_s": 61.0, "segments": [ … ]
```
- ffmpeg `lut3d` (tetrahedral) with the baked 33³ cube; clarity and sharpening become `unsharp`.
  Vignette, noise reduction and light points are not carried (listed in `spatial_skipped`).
- Same size, frame rate and frame count. Audio streams and chapters are copied untouched (`-c copy`).
- Long videos are done in 60 s segments checkpointed under the job's folder; a restarted job carries on at the
  first missing segment, like video upscales. Renders keep their title with ` · <look name>` appended.
- The same request while one is queued returns that job.

---

## Errors

| Code | When |
|---|---|
| 404 | generation / look not found or not in this workspace |
| 409 | source not finished; revert to a rejected version |
| 403 | editing or deleting a built-in look |
| 413 | an import file over 16 MB |
| 422 | bad params, not an image (or not a video for apply-video), unreadable file, bad `.cube`/`.xmp` |
