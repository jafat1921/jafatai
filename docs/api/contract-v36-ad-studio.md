---
title: "Contract v36: Ad Studio"
status: Active
created: 2026-10-15
extends: contract-v7 (brand kits), contract-v33 (stage-job pattern), contract-v34 (via_api), contract-v35 (logo on a surface)
migration: 0023_ad_studio, 0024_brand_socials (addendum §7)
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

## 7. Addendum: contact, socials and digital formats (migration 0024)

Adverts are for social media and the web, not print: there is no QR code, and the footer leans digital.

### Brand kit

`contact` keys: `phone`, `whatsapp` (a number; may equal the phone), `email`, `website`, `booking_url`,
`location` (address or area), `opening_hours` (≤ 60). Whitespace tidied, empty keys dropped.

`socials`: up to 10 `{platform, handle, url?, show_in_ads}` (`show_in_ads` defaults to true), platform one of
`instagram facebook tiktok linkedin x youtube pinterest snapchat threads whatsapp`. The handle has its spaces
removed; a pasted profile link moves to `url` and the handle is read from it (`linkedin.com/company/acme` →
`acme`, `tiktok.com/@acme` → `@acme`, `wa.me/4672…` → `+4672…`). Every platform but LinkedIn shows an `@`;
WhatsApp's handle is the number (6–15 digits). Without a `url` the profile link is built from the handle.
Repeats (same platform and handle) collapse; a bad handle is 422.

Old kits: the one-line `contact.social` becomes `socials[0]` (platform read from a link, else Instagram), in
migration 0024 and whenever an old body still sends `contact.social`. `BrandKitOut` and the campaign's
`brand_kit` carry `socials`; `missing_contact` is now `["website"]` (no website or booking link) and/or
`["socials"]`.

### Formats

`formats` takes up to 7 of `4:5`, `9:16` (stories, reels, TikTok; safe zones as before), `1:1`, `16:9`,
`1.91:1` (1200×628 link ads), `2:3` (1000×1500 Pinterest) and `yt` (1280×720 YouTube thumbnail, the 16:9
layout at that size). Photos: `2:3` uses the portrait photo, `1.91:1` and `yt` the wide one. A `yt` ad has
no footer unless one is asked for.

### Footer picks

`CreateIn.footer_items` (whole campaign) and `AdPatch.footer_items` (one ad; merged over the campaign's):
`{"contact": ["website", "phone", …] | null, "socials": ["instagram:ixperts.se", …] | null}`; a social key is
`platform:handle` without `@`/`+`, lower case. Default: `website`, `booking_url`, `phone`, `whatsapp` and the
socials with `show_in_ads`. The address, email and hours show only when picked.

`AdPatch.follow`: `{"show": bool, "text": str ≤ 40}`. Default on for `9:16`, off elsewhere; an empty text is
"Follow us" in the ad language (`Följ oss`, `Folge uns`, `ہَمیں فالو کَریں`…).

`spec` gains `socials` (the chosen ones), `follow` and `footer_items` (what is picked, as keys); `contact` holds
only the chosen fields.

### Footer layout (`app/ads/footer.py`)

Reading order: website, booking link, the "Follow us" line, the socials, phone, WhatsApp, email, hours,
address. Phone and WhatsApp on the same number share one line with both icons: `Ring/WhatsApp 072 846 73 94`
(the call word per language; Arabic-script ads show the icons only). When every social has the same handle the
icons sit in a row followed by the handle once (`@ixperts.se`); otherwise each icon has its own handle.

| format | rows |
|---|---|
| 9:16 | up to 3: the "Follow us" line, then the icons + handle row (both 1.25× / 1.1× larger), then the contacts; inside the story safe zones |
| 4:5, 2:3 | one row, or two (contacts, then socials) |
| 1:1 | one compact row |
| 16:9, 1.91:1, yt | one bar |

It never overflows: the type shrinks to its floor, then wraps where the format allows, then differing handles
fold into one icon row with the first handle, then the least important item goes (address first, then hours,
email, WhatsApp, phone, the follow line; the website last), and a single label still too wide is cut with
"…". `report.footer` = `{rows, items, dropped, folded, size}`; `footer_dropped` stays as the count.

Icons: phone, globe, pin, envelope, clock (hours), calendar (booking) and a WhatsApp fallback are drawn with
Pillow. Platform marks are Simple Icons SVGs (CC0, `backend/app/assets/icons/`) drawn with resvg; without
resvg each falls back to a drawn mark. Simple Icons has no LinkedIn mark, so LinkedIn is always a drawn "in"
tile.

### The copywriter and the guard

The concept prompt lists the kit's channels by name ("Instagram, WhatsApp, phone, website"); a CTA may use
one in the ad's language ("Boka via WhatsApp", "Följ oss på Instagram") and the copy may not write any handle,
number, address or email. The guard then removes, from kicker/headline/body/cta: handles not in the kit,
web addresses whose host isn't the kit's website, booking link or a social profile, emails not in the kit,
mentions of a platform the kit has no account on (with the little word before it: "via WhatsApp",
"på TikTok"), and phone numbers other than the kit's (local `0…` forms of the kit's numbers count).
`guard.channels_removed` lists what went.

## 8. Addendum: art direction after the first live campaign

The first real campaign (Swedish, autumn, a cleaning brand) worked end to end but read badly: stiff,
translated-sounding copy, palette hex codes painted into a photo as text, a white plate behind the logo on dark
photos, posed stock-like photo prompts, a story footer floating mid-screen and a CTA indistinguishable from
the offer. No migration; the API shape only grows.

### Copywriter model

`ADS_LLM_MODEL` (empty by default) names the model for the concept call and the self-check. Empty: the
largest installed model from `ADS_LLM_MODELS` (default `gemma4:26b,qwen2.5:14b-instruct,gemma4:e4b`) plus
`LLM_MODEL_CREATIVE`, sized from the Ollama tag (`26b`, `14b-instruct`, `e4b` = 4); list order breaks ties.
When the model list can't be read the creative role's model is used. `deepseek-r1` is left out by default (a
thinking model). The job result records it as `copywriter`. `llm.chat(..., model=)` is the per-call override.

### Concept prompt and self-check

The creative-director prompt now asks for native spoken idiom (no literal translations or borrowed English
phrasing), one clear insight per concept, no empty abstractions, a headline of at most 5 words, and carries a
short GOOD / BAD example set for `sv` and `en` (generic, not client lines; other languages see the English set
as a register guide). The brand context gives the palette as colour names, never hex.

A second call (schema `AdCopyCheck`: `{lines: [{concept, field, score 1-5, issue, rewrite}]}`) has a native
editor score every kicker/headline/body/cta and rewrite lines scoring 3 or lower. Rewrites go through the
offer/number/channel guard like the first draft. A failed check keeps the draft. Concepts gain
`copy_check: [{field, score, issue, before?, after?}]` and `photo_model`.

Punctuation (`copy.tidy`, applied by the guard): no trailing full stop on a kicker, a question ends on its
question mark ("?." and " ?" are fixed), doubled marks and ".." collapse ("..." is kept).

### Photos

- Prompts never carry hex values, handles, links, emails, phone numbers or the brand's name/tagline:
  `app/ads/colours.py` names colours (`#26243F` -> "deep navy", `#FF8484` -> "soft coral") and `scrub()`
  cleans the LLM's prompt, the kit's style text, the placement and the logo-edit instruction.
- t2i prompts start with an editorial lifestyle / natural light line and end with "No text, no letters, no
  numbers, no logos, no signs, no name badges anywhere in the picture." The product edit path allows only the
  product's own label. The negative adds numbers, name badges, colour swatches and hex codes.
- Photo-prompt rules: real moments (people working naturally, or the lived-in result), local cues of the
  market, no random props or badges, and an explicit copy-space region per layout (frosted/badge upper start
  side, side_wash start half, bottom_bar bottom third, minimal upper half, split none).
- `brief.image_model` defaults to `"auto"`: each concept picks `zimage_turbo` (people, homes) or
  `qwen_image_2512` (detailed interiors, products) via `photo_model`; any explicit model is kept for every
  concept. `/api/ads/options` lists Auto first.

### Layout

- **Logo**: on auto the primary logo stays when it reads (3:1 against where it lands). Otherwise, on a
  background where white reads better, the kit's light logo; with no light logo the primary's dark ink
  (luminance < 0.35, not saturated) is recoloured to white, keeping saturated accents and the transparency
  (white backgrounds are still keyed out first). A plate is the last resort. `report.logo` = `{variant:
  primary|light|dark|recoloured, plate, contrast, box}`.
- **CTA vs offer**: palette roles gain `primary` (the first palette colour deep enough for white type, else
  the ink). The CTA is a solid button in `primary` with white text, a modest radius and an arrow (pointing
  left in RTL); on a surface of the same colour (a bottom bar, a story fade) it turns white with the primary
  label. The offer stays a pill in a tint of the accent. `report.buttons` = `{cta: {shape: "button", bg, fg,
  arrow: true, inverted}, offer: {shape: "pill", bg, fg, arrow: false}}`.
- **Story footer**: in 9:16 the footer is a rounded card inset from the sides, inside the safe zones (top
  13 %, bottom 18 %), lifted a shade off the footer colour. Below and around it the photo fades into the footer
  colour (`treatment: "story_fade"`); a split block and a bottom bar run on to the bottom edge instead.
  `report.footer` adds `box` and `card`.

### Quality report

Every ad's `report.quality`:

```json
{"contrast": {"headline": {"ratio": 7.1, "need": 3.0, "pass": true}, "logo": {...}, ...},
 "all_pass": true,
 "dropped": {"offers": [], "numbers": [], "channels": [], "copy_trimmed": [], "footer": []},
 "copy_check": [{"field": "kicker", "score": 2, "issue": "literal translation", "before": "...", "after": "..."}],
 "treatment": ["panel", "story_fade"]}
```

Empty `dropped` lists are left out.
