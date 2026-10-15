---
title: "Contract v36: Ad Studio"
status: Active
created: 2026-10-15
extends: contract-v7 (brand kits), contract-v33 (stage-job pattern), contract-v34 (via_api), contract-v35 (logo on a surface)
migration: 0023_ad_studio
---

# Contract v36: Ad Studio

Brand-aware adverts for any product or service: an AI creative director writes concepts in the target
language, each concept gets a photo with copy space, and the layout engine sets the exact copy, the real logo,
the brand colours and a contact footer over it, per format. Edits re-render on the CPU.

UI: **Image → Ad Studio** (`/image/ads`, `/image/ads/:id`).

## 1. Brand kit additions (migration 0023)

`BrandKitIn` / `BrandKitPatch` / `BrandKitOut` gain:

| field | type | notes |
|---|---|---|
| `contact` | `{phone?, website?, location?, email?, social?}` | free text, whitespace tidied; empty keys are dropped on save, `BrandKitOut.contact` holds only the filled ones |
| `claims` | `string[]` (≤ 30, each ≤ 160) | approved offer lines ("From 215 kr/hour", "No lock-in"); de-duplicated, blanks dropped |

The ad footer shows phone, website (scheme stripped), location, email, social, in that order; the last ones go
first when the footer runs out of width.

## 2. Endpoints (`/api/ads`, tag `ads`)

| method | path | body | returns |
|---|---|---|---|
| GET | `/ads/options?kit_id=` | | formats, styles, font presets (with `brand` when the kit has fonts), logo positions, image models, variant range |
| POST | `/ads` | `CreateIn` | 201 campaign; the `ad_campaign` job is queued |
| GET | `/ads` | | campaign summaries, newest first (via_api rows hidden from the app) |
| GET | `/ads/{id}` | | campaign |
| DELETE | `/ads/{id}` | | 204; 409 while working. The ads stay in the Library |
| POST | `/ads/{id}/continue` | | 202 Job: approve the concepts (at least one ticked, else 422) and make photos + ads; also retries a failed stage, and makes newly ticked concepts after a finished run |
| PATCH | `/ads/{id}/concepts/{cid}` | `ConceptPatch` | campaign. User edits are kept as written (no guard). If the concept already has ads they are re-rendered on the spot |
| POST | `/ads/{id}/concepts/{cid}/regenerate` | `{what: "copy"\|"photo"\|"layout", layout?}` | campaign. copy: LLM rewrites this concept (photo kept), job queued. photo: new photo (copy kept), job queued. layout: the given or next style, re-rendered on the spot (no job) |
| PATCH | `/ads/{id}/ads/{ad_id}` | `AdPatch` | ad; re-rendered on the CPU as the next version of its Library image. 409 while working or with no photo |
| POST | `/ads/{id}/ads/{ad_id}/preview` | `AdPatch` | `image/png` (≤ 960 px), nothing saved: the editor's live view |
| GET | `/ads/{id}/zip` | | `application/zip`: `concept-<n>_<WxH>.png` per ad plus `ad.json`; 409 when nothing is finished |

### CreateIn

| field | type | default | notes |
|---|---|---|---|
| `title` | str ≤ 200 | subject | |
| `brand_kit_id` | str? | default kit, else the only kit, else none | 404 for an unknown id |
| `subject` | str 1–200 | required | the service or product |
| `description`, `brief` | str ≤ 600 / 2000 | "" | empty brief = automatic concepts |
| `occasion`, `market`, `tone` | str ≤ 120 | "" | |
| `language` | ISO 639 | `en` | copy language; Arabic-script languages get aerab and RTL |
| `must_say` | str ≤ 200 | "" | |
| `offers` | str[] ≤ 6 | [] | the ONLY offers the copy may use (pick from kit claims or type) |
| `formats` | `("4:5"\|"9:16"\|"1:1"\|"16:9")[]` 1–4 | `["4:5"]` | 1080×1350, 1080×1920, 1080×1080, 1920×1080 |
| `variants` | 2–8 | 3 | concepts |
| `product_media_ids` | str[] ≤ 3 | [] | finished Library images; 422 otherwise. The photo becomes an edit with them as references |
| `image_model` | str | `zimage_turbo` | `qwen_image_2512`, `hidream_o1` also offered; 422 for a non-image or unavailable model |
| `font_preset` | str? | `brand` when the kit has fonts, else `modern` | `modern`, `clean`, `friendly`, `elegant`, `editorial`, `brand` |
| `review` | bool | true | stop after the concepts |
| `logo_on_surface` | bool | true | allow the concept's logo-on-surface edit |

### ConceptPatch
`approved?`, `kicker?`, `headline?` (`\n` = line break), `body?`, `cta?`, `offers?` (≤ 3), `layout?` (style),
`photo_prompt?` (used by the next photo).

### AdPatch (all optional)

```json
{"texts": {"kicker": "", "headline": "", "body": "", "offers": [""], "cta": "", "badge_big": "15%", "badge_small": "RABATT"},
 "style": "frosted|side_wash|bottom_bar|split|badge|minimal",
 "font_preset": "modern",
 "colours": {"text": "#22223B", "accent": "#E2685C", "button": "#E2685C", "button_text": "#FFFFFF",
             "footer": "#22223B", "footer_text": "#FFFFFF", "pill": "#...", "block": "#..."},
 "logo": {"position": "tl|tr|tc|bl|br|none", "variant": "auto|primary|light|dark"},
 "footer": true, "focus": {"x": 0.5, "y": 0.5}, "reset": false}
```

Edits merge into the ad's `overrides`; `reset: true` clears them first. Colours must be `#RRGGBB` (422).
Positions are written for left-to-right copy and mirror for RTL.

## 3. Campaign shape

```json
{"id", "title", "language", "rtl", "stage": "concepts|photos|layout|done", "status": "running|review|failed|done|idle",
 "review": "concepts"|null,
 "stages": [{"key", "label", "status": "pending|running|review|done|failed", "detail"}],
 "brief": {...CreateIn fields},
 "brand_kit": {"id", "name", "palette", "contact", "claims", "has_fonts", "has_logo", "missing_contact": ["phone", "website", "location"]} | null,
 "concepts": [{"id", "n", "approved", "edited", "insight", "kicker", "headline", "body", "cta", "offers", "layout",
               "photo_prompt", "placement", "logo_surface", "error",
               "guard": {"offers_dropped": [], "numbers_removed": []},
               "photos": {"portrait|square|wide": {"base": Gen|null, "logo": Gen|null, "final": "gen id"|null, "note"}}}],
 "ads": [{"id", "concept_id", "format", "status": "pending|ready|failed", "error", "media_id", "generation_id",
          "version", "image_url", "thumb_url", "width", "height", "overrides", "report", "spec", "stale"}],
 "ad_json_url", "zip_url", "job": Job|null, "created_at", "updated_at"}
```

`Gen` = `{id, status, media_url, thumb_url, version}`. `report` = `{contrast: {role: ratio}, treatment: [],
fonts: {role: px}, fit: {scale, headline_scale, trimmed}, logo: {variant, plate}, footer_dropped?}`.

`spec` is the effective layer spec (concept copy + kit + overrides): `format, style, font_preset, language,
rtl, texts, colours, palette, logo, footer, contact, focus, photo_id`. `ad.json` holds every ad's spec and
overrides; each Library version also carries its spec in `params.ad_spec`.

## 4. Pipeline (`ad_campaign` job, general lane)

1. **Concepts**: one LLM call (`creative`, schema `AdConcepts`) for N concepts: insight, kicker, headline
   (≤ 6 words, `\n` hints), body, offers, cta, layout, photo_prompt, placement, logo_surface. Native copy in the
   language. **Offer guard**: offers not matching an approved line are dropped; any number or percentage in
   kicker/headline/body/cta not present in the approved offers, the must-say line or the subject goes (with its
   currency/unit). Arabic-script copy gets the strict aerab pass. Review stop unless `review` is off.
2. **Photos**: one per concept per orientation: portrait (4:5 and 9:16; generated 9:16 when a story is
   wanted, else 4:5), square, wide. t2i on the chosen model with a copy-space composition clause, the kit's
   look, and a no-text negative. With product photos: the edit model (Auto → Qwen-Image-Edit) with the
   products as pictures 1..n. A concept with `logo_surface` then gets a logo edit (photo + kit logo, the brand
   template logo rule); after two failed tries the plain photo is used. Generations: `target_type
   "ad_photo"`, `target_id` = concept id.
3. **Layout** (`app/ads/layout.py`, Pillow): styles × formats; 9:16 keeps copy and logo out of the top 13 %
   and bottom 18 %. Copy is fitted by box in size steps (long words shrink the headline first, then
   hyphenate; extra lines are trimmed last) and never overflows. Each text element is checked against the
   pixels under it, WCAG AA (4.5:1 copy, 3:1 headline/CTA/badge); failing copy gets a panel, then a firmer one.
   Logo with a white background is keyed to transparency; the light variant goes on dark areas, else a plate.
   Footer icons are drawn (no icon font). RTL: right-aligned, shaped, mirrored layout.
4. **Output**: each ad is a Library image (`tags: ["ad", "ad-studio", format]`), new version per re-render.

Rows made with an API token are API rows (contract v34): the campaign, its jobs, photos and Library items.

## 5. Fonts (SIL OFL, `backend/app/assets/fonts/<family>/` with `OFL.txt`)

Montserrat, Inter, Poppins, Playfair Display, DM Serif Display, Noto Naskh Arabic, Noto Nastaliq Urdu.
Presets: Modern (Montserrat), Clean (Inter), Friendly (Poppins), Elegant (Playfair + Inter), Editorial
(DM Serif + Inter); `brand` uses the kit's uploaded fonts when they have the script's letters. Urdu sets in
Nastaliq (Naskh where Pillow has no raqm), other Arabic-script languages in Naskh.

## 6. MCP

`make_ad_campaign(subject, language, offers, brief, occasion, market, tone, formats, variants, brand_kit_id,
product_media_ids)` runs with review off; returns `campaign_id` and the job.
