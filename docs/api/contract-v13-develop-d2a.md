# API contract v13: Develop params v2 (M10 phase 2 / D2a)

No database migration. Params gain a version, and every new key is optional. Records without a version (v1) keep working.

## Params version 2
- `version: 2` is now sent with every params body. `GET /photo/schema` reports `version: 2`.
- **Exposure is in EV** (−5..+5, step 0.01), like Lightroom.
- v1 used a ±100 slider for ±1.5 EV. A record with no `version`, or `version < 2`, is converted on read: `ev = v1 × 0.015`. The upgrade happens:
  - on the server, in `normalise()`;
  - on the client, in `upgradeParams()` (develop records, snapshots, the settings clipboard, "Previous").
- `sparse()` / `compact()` always keep `version`. They drop values that sit at their neutral position, including the non-zero neutrals in the table below.

## New keys
| Key | Range / shape | Neutral | Notes |
|---|---|---|---|
| `profile` | `{id, amount 0..200}` or null | null (`color`) | Baked 33³ table, applied after white balance and exposure |
| `treatment` | `"color"` \| `"bw"` | `color` | B&W uses `bw` and skips vibrance and saturation |
| `bw.<band>` | −100..100 per HSL band | 0 | B&W mix |
| `pcurve.{highlights,lights,darks,shadows}` | −100..100 | 0 | Parametric region curve |
| `pcurve.{s1,s2,s3}` | 5..95 | 25 / 50 / 75 | Region splits |
| `points.{rgb,red,green,blue}` | `[[x,y],…]` with x and y in 0..255 | straight | Fritsch–Carlson point curves; a channel curve follows the RGB curve |
| `refineSat` | 0..100 | 100 | Pulls back the saturation the curves added |
| `pointColor[]` | ≤ 8 × `{hue 0..360, sat 0..1, val 0..1, dh, ds, dl ±100, hueRange, satRange, lumRange 0..100 (50)}` | [] | Point Color |
| `grading.{shadows,midtones,highlights,global}` | `{h 0..360, s 0..100, l ±100}` | 0 | Colour grading |
| `grading.blending` / `grading.balance` | 0..100 / ±100 | 50 / 0 | |
| `calibration.{shadowsTint,redHue,redSat,greenHue,greenSat,blueHue,blueSat}` | ±100 | 0 | Primaries matrix in linear light |
| `vignetteMidpoint` / `vignetteRoundness` / `vignetteFeather` / `vignetteHighlights` | 0..100 / ±100 / 0..100 / 0..100 | 50 / 0 / 50 / 0 | Post-crop vignette |
| `vignetteStyle` | `highlight` \| `color` \| `paint` | `highlight` | |
| `grainAmount` / `grainSize` / `grainRoughness` | 0..100 | 0 / 25 / 50 | Seeded by frame position, so the same on every render |

## Groups
Groups are used for Copy, Paste, Sync and the panel switches (`off`):

| Group | Keys |
|---|---|
| `basic` | adds `profile`, `treatment` |
| `curve` | adds `pcurve`, `points`, `refineSat` |
| `hsl` | adds `pointColor`, `bw` |
| `effects` | adds the vignette shape and grain keys |
| `grading` (new) | `grading` |
| `calibration` (new) | `calibration` |

## New routes
| Method | Path | Returns |
|---|---|---|
| GET | `/photo/profiles` | `[{id, label, group}]` |
| GET | `/photo/luts/profile/{id}` | `{size, data}`. `data` is base64 of size³ × RGB uint8, red fastest. This loads straight into a WebGL `TEXTURE_3D`. The response is cacheable for a day. |
| GET | `/photo/luts/look/{look_id}` | The same shape, for a look with a `.cube`. Returns 404 when the look has none. |

## Preset import (XMP / lrtemplate)
These settings now map:
- EV exposure;
- parametric curve and splits;
- point curves (`ToneCurvePV2012*`, from both formats);
- `GrayMixer*`, `ColorGrade*`, `SplitToning*` (into the grading wheels);
- vignette amount, midpoint, roundness, feather, highlights and style;
- grain;
- calibration.

Texture and Dehaze are still reported as unmapped until D2b.

## Parity
`frontend/src/test/develop-parity.json` holds real engine renders. The browser maths (`maths.ts`) must stay within 2.5/255 of it. The WebGL shader is a line-by-line copy of `maths.ts`. To regenerate the fixture: `UPDATE_PARITY=1 pytest tests/test_develop_parity.py`.
