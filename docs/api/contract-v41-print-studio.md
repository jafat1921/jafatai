---
title: "Contract v41: Print Studio"
status: Active
created: 2026-10-18
extends: contract-v36 (Ad Studio), contract-v37 (studio parts, media_item.home), contract-v38/v39 (admin)
migration: 0029_print_studio
---

# Contract v41: Print Studio

Shop signs, posters and boards, flyers and menus, and window stickers at their real size. Ad Studio's creative
director, guard and picture pipeline, with a print renderer behind them: any size in centimetres, a layout from
the real aspect ratio, a working preview and a print-size render from the same scene, and print files (PDF with
bleed and crop marks, PNG and JPG at the dpi, an editable SVG, layer PNGs).

**Admins only.** Every route answers 404 to anyone else, refuses API tokens (403, `session_only`) and is left out
of the OpenAPI document. The UI is `/admin/print` and `/admin/print/:id`, inside the admin section; the rail entry
shows for admins only.

## 1. Model (migration 0029)

`ad_campaign.kind`: `"ad"` (default, Ad Studio) or `"print"`. A print job is an AdCampaign with `kind = "print"`;
Ad Studio's list leaves print jobs out and `/api/ads/{id}` answers 404 for one. The brief holds the print fields
below; `concepts` hold one design option each; `ads` hold one design record per option.

The option's preview (long side 2400 px, the bleed included) is a Library image with `home = "print"` (contract
v37: never in a general list), a new version per re-render, tags `print, print-studio, <job>`. Print files are
generations of their own: `target_type "print_file"`, `target_id` = the design id, `kind "print"`, with
`params.format` and `params.hash` (the spec they were made from).

## 2. Endpoints (`/api/print`, admins, session only)

| method | path | body | returns |
|---|---|---|---|
| GET | `/print/options` | | jobs, size presets, dpis, distances (with their minimum letter height), families, layouts per shape, decor, font presets, image models, file formats |
| POST | `/print` | `CreateIn` | 201 job; the `ad_campaign` job is queued (payload `print: true`) |
| GET | `/print` | | summaries, newest first |
| GET | `/print/{id}` | | job |
| DELETE | `/print/{id}` | | 204; 409 while working. Previews stay in the Library |
| POST | `/print/{id}/continue` | | 202 Job: approve (review on) or retry a failed stage |
| PATCH | `/print/{id}/concepts/{cid}` | `{approved?, headline?, cta?}` | job; designs re-laid out when the copy changed |
| POST | `/print/{id}/concepts/{cid}/regenerate` | `{what: "picture"\|"copy"}` | job; queued |
| PATCH | `/print/{id}/designs/{did}` | `DesignPatch` | design; re-rendered on the CPU as the next preview version; its files go stale |
| POST | `/print/{id}/designs/{did}/preview` | `DesignPatch` | `image/png` ≤ 960 px, nothing saved |
| POST | `/print/{id}/files` | `{design_ids: [..] \| null}` | 202 Job: the files stage for those designs (null: every finished one); fresh files are kept |
| GET | `/print/{id}/designs/{did}/files/{pdf\|png\|jpg\|svg\|zip}` | | the file, `Content-Disposition` e.g. `stjarnans-livs-option-1-25x70cm.pdf`; 404 until made |
| POST | `/print/{id}/designs/{did}/resize` | `ResizeIn` | 201 a new print job: the same concept, copy, edits and picture at the new size |

### CreateIn

| field | type | default | notes |
|---|---|---|---|
| `job` | `sign\|board\|flyer\|sticker` | `sign` | |
| `width_cm`, `height_cm` | 3–500 | required | the trim |
| `dpi` | 100/150/200/300 | 150 signs and boards, 300 flyers and stickers | 422 when the file would pass 160 MP, naming the dpi that fits |
| `bleed_mm` | 0–20 | 3 | |
| `shape` | `rect\|round` | `rect` | round needs width = height (422) |
| `viewing_distance` | `near\|street\|road` | street (signs, boards), near (flyers, stickers) | 0.6 / 5 / 20 m |
| `business_type` | ≤ 160 | "" | e.g. "livs / mini market" |
| `lines` | `{name (1–120), tagline, offers[] ≤ 12, opening_hours, phone, address, website}` | | set exactly as written |
| `language` | ISO 639 | `en` | the UI guesses it from the lines; Arabic-script languages: aerab on what the AI writes, RTL |
| `style`, `brief` | ≤ 300 / 2000 | "" | |
| `brand_kit_id` | | none | palette, logo, fonts |
| `product_media_ids` ≤ 3, `photo_media_ids` ≤ 6 | | [] | products: the edit model builds the photo round them; photos: the owner's own, used as they are |
| `variants` | 1–6 | 3 | the UI offers 3–6 |
| `families` | `typographic\|photo\|illustration` [] | by job | default plan: signs lean type-only, boards photo-led |
| `font_preset`, `image_model`, `quality` (draft\|final), `review` (false), `export_all` (false), `print_safe` (false) | | | |

### DesignPatch

`texts` (`name, tagline, headline, offers[], hours, phone, address, website, cta`), `layout` (one of the shape's,
else 422), `decor` (`none|awning|frame`), `hero` (`name|headline`), `caps`, `font_preset`, `colours`
(`ground, ink, accent` as `#RRGGBB`), `logo.position` (`auto|none`), `focus {x, y}`, `print_safe`, `reset`.

### ResizeIn

`width_cm`, `height_cm`, `job?`, `dpi?`, `bleed_mm?`, `viewing_distance?`, `export_all`. The concept keeps its copy,
colours and type; its layout moves to the new shape's when it doesn't fit; the picture is upscaled again for the
new size.

## 3. Job shape

```json
{"id", "kind": "print", "title", "language", "rtl", "stage", "status": "running|review|failed|done|idle", "review",
 "stages": [{"key": "concepts|pictures|layout|files", "label", "status", "detail"}],
 "brief": {...}, "size": {"width_cm", "height_cm", "dpi", "bleed_mm", "shape", "px": [w, h], "trim_px": [w, h],
                          "mp", "label": "25 × 70 cm · 150 dpi · 1476 × 4134 px", "family": "wide|tall|square|sheet",
                          "min_cap_mm"},
 "brand_kit", "concepts": [{"id", "n", "approved", "family", "layout", "decor", "hero", "headline", "cta", "font",
                            "caps", "offers", "colours", "guard", "copy_check", "pictures": {"photo|art": {...}}}],
 "designs": [{"id", "concept_id", "n", "status", "version", "image_url", "thumb_url", "width", "height", "overrides",
              "spec", "report", "files": {"status": "none|ready|stale", "files": {"pdf": {"url", "bytes", ...}}}}],
 "job"}
```

`report`: `family, layout, contrast {role: ratio}, all_pass, min_text {cap_mm, cap_cm, role, need_mm, distance,
pass}, colours, gamut [{role, hex, safe, chroma, ceiling}], dropped [roles], below_min, fonts {role: cap mm},
boxes {trim, safe}` (fractions of the full canvas, for the overlays), `canvas, shape, used, fallback`.

## 4. Pipeline (`ad_campaign` job, payload `print: true`)

1. **Concepts**: one LLM call (`creative`, schema `PrintConcepts`, prompts in `app/llm/print_prompts.py`) writing
   one design per entry of the family plan: hero line (optional), CTA, colour pair, type, decor, photo or
   illustration prompt. Signage rules: few words, one hero line, legible from the distance, ink on ground ≥ 7:1,
   business-type knowledge (a livs: greens, warm yellows, "Öppet alla dagar"), the owner's lines never rewritten.
   Ad Studio's native-editor check and guard follow (no invented numbers, offers, channels); an empty hero line
   stays empty. Strict aerab on what the AI writes for Arabic-script languages.
2. **Pictures**: photo designs get a t2i photo (candidates on final, the best kept) or the owner's photo;
   illustration designs a flat illustration on white (keyed to transparency). Then Real-ESRGAN up to what the print
   needs, at most 4× and 8192 px on the long side (the anime model for illustrations); Lanczos does the rest. A
   failed picture leaves the design type-only rather than stopping the job.
3. **Layout** (`app/print_studio/layout.py`): a scene in millimetres from the real ratio: wide (`band`, `awning`,
   `photo_side`), tall (`stack`, `hero_top`, `photo_middle`), square (`centre`, `photo_circle`; round stickers keep
   the copy in the inscribed square), sheet (`menu`, `menu_photo`). Every text row is fitted to its column and
   never set below the distance minimum (capital height ≈ 3 mm per metre, at least 1.5 mm); optional lines go
   first (website, address, offers, button), the name never. Text sits only on solid colour; every line is nudged
   to WCAG AA (4.5:1). The background and photos run into the bleed. RTL mirrors.
4. **Files** (`brief.export_all`, or `POST /files`): the scene rendered at print size and written as below.

## 5. Files

- **PDF**: page 1 MediaBox = trim + bleed + slug (≥ 10 mm), `BleedBox` = trim + bleed, `TrimBox` = trim; the
  artwork a JPEG (quality 95, 4:4:4) tagged with an sRGB ICC colour space; eight crop marks in registration colour in
  the slug, clear of the bleed; a slug line with trim, bleed, dpi and colour notes. Page 2: a proof sheet (the design
  with the trim and safe lines, the size, colour and check notes). No CMYK conversion.
- **PNG / JPG**: the full canvas (bleed included) at the dpi, DPI written into the file, sRGB ICC embedded.
- **SVG** (`width/height` in mm): layers Background, Photo, Logo, Text (Inkscape layer groups, read as layers by
  Illustrator), a hidden Guides layer (trim, safe, a round sticker's cut line); real `<text>` in the bundled fonts,
  embedded as `@font-face` data, the pictures embedded at no more than print resolution.
- **ZIP**: `1-background.png`, `2-photo.png`, `3-logo.png`, `4-text.png` (each full page, transparent but the
  background, at the dpi), `design.json`, `README.txt`.

Measured locally (106 × 160 cm at 150 dpi, 6295 × 9484 px with a 5120 × 7680 photo): render 0.5 s, peak about
260 MB over the loaded photo; all five files about 9 s.

## 6. Fonts (SIL OFL, `backend/app/assets/fonts/<family>/OFL.txt`)

Added: Bebas Neue, Anton, Oswald[wght], Archivo Black (å ä ö checked). Print presets: `bold` (Archivo Black +
Montserrat), `condensed` (Bebas Neue + Oswald), `impact` (Anton + Oswald/Inter), `modern`, `friendly`, `elegant`.
Arabic-script copy uses Ad Studio's Naskh/Nastaliq faces whatever the preset.

## 7. MCP (admins only)

Hidden from `tools/list` for anyone else, and a call answers `Unknown tool: <name>` (before argument checks), so
the feature isn't revealed.

- `make_print_design(width_cm, height_cm, lines{name, tagline, offers[], opening_hours, phone, address, website},
  job, dpi, bleed_mm, viewing_distance, shape, business_type, language, style, brand_kit_id, product_media_ids,
  photo_media_ids, options 1–6, families, export=true)`: runs straight through (no review) and makes every
  option's files; returns `design_id` and the job.
- `get_print_design(design_id)`: status, stages, and per option its preview and `files {pdf, png, jpg, svg, zip}`
  as ten-minute signed links, plus the checks.
- `print_other_size(design_id, option, width_cm, height_cm, job?, dpi?, export=true)`: a new job at the new size.

Jobs made through MCP are the owner's and show in Print Studio (MCP rows aren't API rows, contract v34).
