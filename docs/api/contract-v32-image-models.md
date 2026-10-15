---
title: "Contract v32: test-mode image models, licence gate, grouped picker"
status: Active
created: 2026-10-15
extends: contract-v6 (model catalogue), contract-v30 (IMAGE_ALLOW_NONCOMMERCIAL), contract-v31 (styles)
installer: scripts/install-image-models.sh
---

# Contract v32: image models for testing

Eleven text-to-image models (plus a 9B edit model) join the catalogue so the owner can compare them on the
image GPU. Defaults do not change: Z-Image Turbo stays the image default, Qwen-Image-Edit 2511 the edit
default, and Auto keeps its old picks unless a newer model is confirmed installed.

## 1. Licence gate

`IMAGE_ALLOW_NONCOMMERCIAL` (default `true` while testing) now covers image and edit models, the way
`AUDIO_ALLOW_NONCOMMERCIAL` covers audio. Off: models with `noncommercial` weights are left out of
`GET /api/models` and refused with 422:

    "Anima is turned off on this server: its licence limits commercial use (the owner can allow it with IMAGE_ALLOW_NONCOMMERCIAL)"

Krea 2 counts as non-commercial for the switch (revenue cap plus a content-filter duty) but is labelled
`licence_kind: "conditional"`.

## 2. Catalogue rows (image / edit)

New fields on every image and edit row of `GET /api/models`:

| field | meaning |
|---|---|
| `extra.licence` | the weights licence, in words |
| `extra.licence_kind` | `commercial` · `conditional` · `noncommercial` |
| `extra.noncommercial` | `true` when the switch above hides it |
| `installed` | `false` when ComfyUI lacks nodes or weights (from `/object_info` loader lists), `null` when ComfyUI couldn't be asked |
| `group` | picker section: `fast` · `photo` · `text` · `anime` · `experimental` |
| `best_for` | short hints for the card |

`estimate_source: "rough"` means the time is a guess (the UI prints "(est.)"); it becomes `measured` after
the server has run the model. A speed may run its own graph (Krea 2 Raw, HiDream Full, Qwen 2.1 base): if that
graph's weights are missing, only that speed is unavailable (`speeds[].reason` starts "not installed").

| id | label | badge | group | speeds (default first) | i2i | licence |
|---|---|---|---|---|---|---|
| realvis_xl5 | RealVisXL V5.0 | PHOTO | photo | full 30, lightning 8 | yes | OpenRAIL++-M |
| zimage_base | Z-Image (base) | PHOTO | photo | 28 steps cfg 4 | yes | Apache-2.0 |
| hidream_o1 | HiDream-O1-Image | 2K | photo | dev 28, full 40 | no | MIT |
| ernie_image_turbo | ERNIE-Image Turbo | TEXT | text | 8 steps | no | Apache-2.0 |
| illustrious_xl2 | Illustrious XL v2.0 | ANIME | anime | 28 steps | yes | OpenRAIL-M |
| anima | Anima | ANIME | anime | turbo 8, full 30 | yes | NC weights (outputs commercial) |
| krea2_turbo | Krea 2 | 2K | experimental | turbo 8, raw 52 | no | Krea 2 Community (conditional) |
| flux2_klein_9b | FLUX.2 klein 9B | FAST | experimental | 4 steps | yes | FLUX Non-Commercial |
| qwen_image_21 | Qwen-Image 2.1 | TEXT | experimental | turbo 8, full 25 | no | Qwen Research (NC) |
| chroma1_hd | Chroma1-HD | NEW | experimental | 26 steps cfg 3.5 | no | Apache-2.0 |
| wan22_still | Wan 2.2 Cinematic still | NEW | experimental | 4 steps (Lightning) | no | Apache-2.0 |
| flux2_klein_9b_edit (edit) | FLUX.2 klein 9B | - | - | 4 steps, 1-3 refs | - | FLUX Non-Commercial |

Existing rows gain `group` (Z-Image Turbo and FLUX.2 klein 4B: fast; Qwen-Image 2512: text) and their
Apache-2.0 licence line.

## 3. Auto

Unchanged for existing prompts: text or non-Latin script goes to Qwen-Image 2512 (never Qwen 2.1), four or more
images to FLUX.2 klein 4B, everything else to Z-Image Turbo. New: an anime / manga prompt goes to Illustrious XL,
else Anima, but only when the model is allowed here and the last `/object_info` shows it installed; without a
recent `/object_info` Auto stays on the old pick. `POST /images/img2img` with Auto only picks models that can
redraw. `model_auto_reason` says "anime or manga prompt".

## 4. Styles

`best_model` for the Anime, Anime v2 and Chibi styles is now `illustrious_xl2`. The UI only offers the
"Use …" button when that model is available in the cached catalogue, and never switches the model by itself.

## 5. Picker

The Create Image model chip shows Auto, then the sections Fast · Photoreal · Text & design · Anime &
illustration · Experimental / NC in one scroll area. Each card has the licence line, an NC (or TERMS) pill
whose meaning is also in the radio's name, and "Not installed on the server (…)" with the card disabled
when `installed` is false. Arrow keys move across sections and skip disabled cards.

## 6. Graphs

`backend/app/workflows/<name>/` per family, each manifest listing `requires.nodes` and what is `assumed`:
krea2_t2i, krea2_raw_t2i, hidream_o1_dev_t2i, hidream_o1_t2i, anima_t2i/_i2i, illustrious_xl_t2i/_i2i,
realvis_xl_t2i/_i2i, flux2_klein9b_t2i/_i2i/_edit, qwen_image21_t2i, qwen_image21_full_t2i, ernie_turbo_t2i,
zimage_base_t2i/_i2i, chroma1_hd_t2i, wan22_still_t2i. All core ComfyUI 0.38 nodes, no custom packs.
