---
title: "Contract v35: Brand templates"
status: Active
created: 2026-10-15
extends: contract-v7 (brand kits), contract-v29/v30 (edit templates), contract-v34 (via_api)
migration: none
---

# Contract v35: Brand templates

Prompt-template cards that put the workspace's own logo on things: a van, a uniform, a flyer. The brand kit
fills the logo (and, on some cards, a product) for the user. They either add one photo of their own, or let
the app make the scene first.

Category: **Brand & marketing**, 17 cards (`image-brand-*`): vehicle wrap, product label, uniform embroidery,
storefront sign, window decal, reception wall, flyer A5, social post (square), social story (9:16), business
card, billboard / bus shelter, merch, branded equipment, before & after, team photo in uniform, website hero,
door hanger / leaflet. Defaults lean towards a cleaning business; nothing in them is cleaning-only.

## 1. Card fields (`backend/app/templates/image.json`)

| field | meaning |
|---|---|
| `target` | `"image-brand"` |
| `brand_refs` | kit assets the card fills in: `["logo"]` or `["logo", "product"]` (the product is optional) |
| `surface` | `"light"` or `"dark"`: what the logo usually lands on |
| `light_ink` | how a dark logo is re-inked on a dark surface: `"white thread"`, `"white print"`, `"white vinyl"`… |
| `ref_labels` | one label for the user's own photo in photo mode (`["Vehicle"]`) |
| `options[].choices[].surface` | optional; a picked choice with a surface overrides the card's (navy fabric → `dark`) |
| `scene` | `{prompt_scaffold, aspect, model?, negative?}`: the scene for "Make the scene for me", with the surface deliberately blank |
| `defaults.instruction_scaffold` | the logo edit; the model is `qwen_image_edit_2511` |
| `preview_prompt` | what the card's preview shows, with a placeholder brand (§6) |

`[slots]` work as before; one picked choice fills the same `[slot]` in both the scene and the logo wording.

### Brand tokens

`{tokens}` are filled **on the server** at submit time, from the kit. The browser sends them as they are.

| token | becomes |
|---|---|
| `{brand}` | the kit name |
| `{logo}` | `the iXperts logo`, plus the logo's description in brackets when the kit has one |
| `{logo_colours}` | the logo rule for the surface (§2) |
| `{colours}` | `navy #22223B and coral #E48C84` (falls back to `clean neutral tones`) |
| `{palette}` | `in the brand colours navy #22223B and coral #E48C84` |
| `{tagline}` / `{tagline_clause}` | the tagline / ` with the tagline "…"`; empty when the kit has none, without leaving a gap |
| `{product_clause}` | ` Picture 3 is the <product>: match its shape, colours and label layout.` or empty |
| `{phone}`, `{website}`, `{social}` | the kit's phone (else WhatsApp), website (else booking link; scheme stripped, `www.` too when long), first social handle shown in ads |
| `{contact}` | at most two of those, short: `ixperts.se · @ixperts.se` (website, then the handle, else the phone) |
| `{contact_clause}` | ` Along the bottom, "<contact>" in clear type.` or empty |
| `{contact_under_clause}` | `, with "<contact>" in smaller clear type below it` or empty |
| `{social_clause}` | `, and a rounded button reading "<handle>"` (the contact line without a handle) or empty |

The contact tokens (contract v36 addendum) give the image model the exact strings, at most two short items so
they come out legible. The digital cards use them in their scenes instead of a `[contact]` slot: **social post
(square)** `{contact_under_clause}`, **social story (9:16)** `{social_clause}`, **website hero**
`{contact_under_clause}`. A kit without contact details simply leaves the clause out. The print cards
(flyer, door hanger, business card) keep their `[contact]` slot.

## 2. The logo, by surface

Reference order is fixed: picture 1 = the user's photo or the made scene, picture 2 = the logo, picture 3 =
the product. Kit logos (contract v7): `light` is made for dark backgrounds, `dark` for light ones.

| surface | logo used (first that exists) | `{logo_colours}` |
|---|---|---|
| light | `dark`, `primary`, `light` | keep the exact letters, shapes and colours |
| dark | `light` | it is the light version: keep it exactly |
| dark | `primary` / `dark` (no light logo) | render the dark letters in `light_ink`, keep the accent colours (palette colours with relative luminance ≥ 0.18, e.g. coral #E48C84) exactly, keep the letter shapes |

The uniform and team cards also say: stitched directly into the fabric, no patch, no sticker, visible thread
texture. That is the fix for the "white sticker patch on a navy shirt" result.

## 3. `POST /api/images/brand` → 202 `ImageBatchOut`

```json
{"template_id": "image-brand-uniform", "mode": "photo", "source_id": "<media id>",
 "brand_kit_id": "<optional>", "product_id": "<optional>", "surface": "dark",
 "instruction": "<optional, the card's by default>", "scene_prompt": "<scene mode, optional>",
 "aspect": "4:3", "count": 1, "seed": 7, "model": "<edit model, optional>", "title": "...", "folder_id": "..."}
```

- **Kit:** `brand_kit_id`, else the default kit, else the only kit.
  - No kit: **409** `No brand kit yet. Make one in Brand Kits and add your logo, then come back to this card.`
  - Several kits and none is the default: **409** asking the caller to pick one.
  - Kit without a usable logo: **409** `“<kit>” has no logo yet. Add one in Brand Kits…`
  - Unknown kit: 404.
- `product_id` must be one of the kit's products, on a card whose `brand_refs` has `product` (else 422).
- `[slots]` still in the wording: 422 `Replace [x] in the … first`.
- `mode: "photo"`: needs `source_id` (422 `Add your photo first`). One edit per `count`, with
  `reference_ids = [photo, logo, product?]`.
- `mode: "scene"`: one Library item per `count`. Each one is a chain (§4).
- The response carries `brand_template: {kit_id, kit_name, logo_variant, surface, mode, product_id}`. The same
  record is kept in every generation's `params.brand_template`.
- `params.brand = {kit_id}` without `auto`, so the kit's automatic watermark pass does **not** run on these
  pictures: the logo is already in them.

## 4. The scene chain

1. v1 of the item is the scene: an ordinary `generate` job on the image model (the card's `scene.model`,
   Qwen-Image 2512 for the cards with text, else Auto). Its `params.brand_chain` holds the logo edit, waiting.
2. When that job is done, the worker hook `brand_templates.on_job_finished` queues v2 on the **same** item:
   `parent_id` = the scene, `edit_of = [{media_id: item, generation_id: scene}]`,
   `reference_ids = [scene, logo, product?]`, `params.brand_template.scene_id`. The child job's payload has
   `chain_of: <scene job id>`. `brand_chain.state` goes from `waiting` to `queued`, with `edit_generation_id`.
3. The item's current version moves to v2 straight away, so the tile shows "working" until the logo is on.
   The scene stays as v1 in the item's versions.
4. A failed scene queues nothing.

**Visibility (v34):** the edit generation and its job copy `via_api` from the scene job (the worker session
stamps it as well). An API-made chain never shows in the app.

## 5. Listing and starting

- `GET /api/prompt-templates?category=Brand%20%26%20marketing` keeps only that category (any category works;
  `My templates` returns the workspace's own).
- `TemplateOut` gains `brand_refs`, `surface` and `scene`; `target` may be `image-brand`.
- `POST /api/prompt-templates/<id>/start` → `target: "image-brand"`, prefill `{instruction, scene_prompt,
  scene_aspect, model, count, aspect, ref_labels, options, brand_refs, surface, template_id, placeholders,
  examples}`. `placeholders` lists the slots of the scene and the wording together.

The frontend opens `/image/brand`. It shows the kit (a picker when there are several, the default
preselected), the logo that will be used for the current surface, the colours and the tagline, and a product
picker on product cards. With no kit or no logo it shows a prompt with a link to Brand Kits instead.
"Make the scene for me" is the default mode. "Use my photo" asks for one picture only.

## 6. Previews

`scripts/gen_prompt_template_previews.py` renders brand cards from `preview_prompt` on Qwen-Image 2512
(Lightning), filling the tokens with a placeholder brand: `YOUR BRAND` in slate blue and warm apricot. No
real logo is needed, and no customer's mark ends up in the shipped previews:

    cd backend && uv run python ../scripts/gen_prompt_template_previews.py --comfy https://<image-gpu> \
        --only image-brand-vehicle-wrap,image-brand-uniform,...
