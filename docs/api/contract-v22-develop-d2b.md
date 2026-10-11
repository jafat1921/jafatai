# API contract v22: Develop D2b (Lightroom parity, second half)

No database migration, and params stay at `version: 2`: every key below is optional and additive. Records from before D2b render the same (tests prove it to within one 8-bit step against a copy of the old engine).

## New and changed params
| Key | Range / shape | Neutral | Where it runs |
|---|---|---|---|
| `texture` | −100..100 | 0 | Server (mid-frequency band, a few full-resolution pixels) |
| `dehaze` | −100..100 | 0 | Server (dark-channel prior, guided-filter transmission; negative adds haze) |
| `clarity` | unchanged | 0 | Server; now in the **basic** group (Lightroom's Presence block) |
| `sharpen.{amount 0..150, radius 0.5..3.0, detail 0..100, masking 0..100}` | | 0 / 1.0 / 25 / 0 | Server |
| `nr.{luminance, detail, contrast, color, colorDetail, smoothness}` | 0..100 each | 0 / 50 / 0 / 0 / 50 / 50 | Server |
| `lens.caAuto` | bool | false | Values in `caRed` / `caBlue` |
| `lens.caRed`, `lens.caBlue` | −100..100 (±100 = ±0.5 % radial scale of that channel) | 0 | Server **and** WebGL (three texture taps) |
| `lens.distortion` | −100..100 (+ corrects barrel) | 0 | Server and WebGL |
| `lens.vignette`, `lens.vignetteMidpoint` | −100..100 (±1 stop at the corner), 0..100 | 0 / 50 | Point op, linear light, before calibration and WB, measured on the lens frame (not the crop) |
| `lens.{purpleAmount 0..20, purpleHueLo, purpleHueHi, greenAmount 0..20, greenHueLo, greenHueHi}` | hue sliders 0..100 (purple → 200..340°, green → 60..180°) | 0 / 30 / 70 / 0 / 40 / 60 | Point op + server edge mask (see Defringe) |
| `transform.upright` | `off` \| `auto` \| `level` \| `vertical` \| `full` | `off` | |
| `transform.uprightMatrix` | 9 numbers, row-major, forward uv homography (source → canvas), or null | null | Measured by the server |
| `transform.{vertical, horizontal, aspect, offsetX, offsetY}` | −100..100 | 0 | Server and WebGL |
| `transform.rotate` | −10..10° | 0 | |
| `transform.scale` | 50..150 | 100 | |
| `transform.constrain` | bool | false | Lightroom's one Constrain Crop (Lens Manual, Transform and Crop show the same switch) |

**Legacy keys.** `sharpness` (0..100) and `noiseReduction` (0..100) are still accepted. When the new group is unset they are converted on read, on both sides (`develop.normalise`, `maths.upgradeParams`), to the settings that render identically:
- `sharpen = {amount: 37.5 + 112.5·s, radius: 0.7 + s, detail: 100, masking: 0}`, where s = sharpness / 100;
- `nr = {luminance: n, color: n}`, with the other sliders at their neutral values.

After conversion the legacy key reads 0.

## Groups
| Group | Keys |
|---|---|
| `basic` | adds `texture`, `clarity` and `dehaze` (in that order, before vibrance) |
| `detail` | `sharpen`, `nr` (plus the legacy keys) |
| `lens` (new, switchable) | `lens` |
| `transform` (new, switchable) | `transform` |

`geometry` (crop, rotate, flip) still has no switch. Copy leaves `transform` unticked by default, like Lightroom. Paste and `POST /photo/sync` drop `uprightMatrix`, and the auto CA values, so each photo is measured on its own.

## Geometry chain
For each output pixel, working backwards:

frame uv → (crop · rotate · flip · constrain zoom: affine) → canvas uv → (Transform: homography) → lens uv → (distortion: `f = 1 + k·r²`, with k = −0.25·distortion/100 and r measured to the half-diagonal) → captured uv → (CA: red and blue scaled about the centre) → sample.

- **Canvas.** The canvas is the transformed picture at the source's own size, so crop boxes stay in source pixels.
- **Manual transform.** These are camera rotations, `K R K⁻¹` with a focal length of one long side: Vertical and Horizontal are ±20° tilts (negative Vertical widens the top), and Rotate turns about the optical axis. The result is re-centred and kept at its size at the centre, then Aspect, Scale and offset are applied (offset ±100 = ±25 %).
- **Constrain.** It finds the largest zoom ≤ 1 that keeps the canvas border on the picture, by bisection over 128 border points.
- **Server.** `geometry.py` does one bilinear remap straight to the output size. Crop, rotate and flip on their own keep the old exact PIL path.
- **WebGL.** `uGeo` is now the affine, `uWarp` a projective 3×3 (divided by w), plus `uDist`, `uCa` and `uSrcAspect`.
- **Pinned together.** The parity fixture's `geometry` block maps a 5×5 grid through the server's `Warp`; `geometry.ts` lands within 1e-4 of it.
- **Bug fix.** The quarter-turn rounding is now Python's half-to-even on both sides. At exactly ±45° the browser used to frame differently from the server.

## Upright and auto CA
| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/photo/{id}/upright` | `{mode}` | `{mode, matrix, angle, lines, note}` (`angle` is the level correction in degrees, for Crop's Auto straighten) |
| POST | `/photo/{id}/lens/ca` | — | `{caRed, caBlue, edges}` |

How the measurements work:
- **Lines.** A gradient-steered Hough transform (numpy only; OpenCV isn't installed).
- **Level.** The weighted median tilt of near-horizontal lines, with near-vertical lines at half weight.
- **Vertical.** The least-squares vanishing point of the near-vertical lines; the camera rotation that sends it to infinity.
- **Full.** Vertical, then a turn about the new vertical axis for the horizontal vanishing point.
- **Auto.** Vertical when the verticals lean ≤ 15°, otherwise Level.
- **CA.** For each of red and blue against green, the best normalised correlation of high-passed channels along strong edges, over ±0.75 %, refined with a parabola.

Results are cached per source. A params body that names a mode without its numbers (a preset, a paste, an `.xmp`) is measured at preview and at queue time (`service.fill_auto`), so the stored version always carries the matrix.

## Defringe (the documented choice)
- **The point formula** lives in `colour.defringe_weight` = `maths.defringeWeight` = the shader. It desaturates toward linear luma by `amount/20 × hue band (10° soft edges) × smoothstep(0.05, 0.2, S)`. It is in the parity fixture.
- **The edge mask.** The server multiplies the weight by a mask (local luma range over about 2 px, dilated), so a purple object away from edges keeps its colour.
- **Why not in the preview.** The mask is cheap on the server but needs neighbours, so the preview shows the formula everywhere and the sliders say "exact on release" until the server render arrives.

## Preview debug
`POST /photo/{id}/preview` takes `debug: "sharpen_mask"`. The response is the Masking mask in grey: white is sharpened, and with Masking 0 the whole frame is white. In the UI this is **Show mask** in Detail.

## RAW 16-bit master
- **On import.** A RAW is decoded once by rawpy:
  - `output_bps=16`, `gamma=(1,1)`, `no_auto_bright`, `highlight_mode=ReconstructDefault`;
  - the gain is our own auto-bright: the 99th percentile of max(R,G,B) goes to white, clamped to 1..8.
- **Files.** The import writes `name.master.tif`, a baseline 16-bit linear TIFF that records the gain in its ImageDescription (`mixai-master v1 gain=…`). The JPEG working copy is made from the same pixels (`enc(min(lin·gain, 1))`), so the two match at identity.
- **In Develop.** `develop.open_image` prefers the master and returns `Pixels(linear=True)`, with values above 1.0 where the JPEG clipped. Negative Exposure brings them back, and on masters only, negative Highlights adds a shoulder that rolls them into range.
- **Speed.** Previews box-reduce the memory-mapped master to the proxy size first.
- **Not affected.** Analysis, Auto, palette and the one-click effects still read 8-bit display pixels.
- **Deleting.** Deleting the media item also deletes the master.

## Preset import (XMP / lrtemplate)
These settings now map:

| Lightroom keys | Our params |
|---|---|
| `Texture`, `Dehaze` | `texture`, `dehaze` |
| `Sharpness`, `SharpenRadius`, `SharpenDetail`, `SharpenEdgeMasking` | `sharpen.*` (`Sharpness` 0..150 is `sharpen.amount`; it no longer maps to the legacy slider) |
| `LuminanceSmoothing`, `LuminanceNoiseReductionDetail` / `Contrast`, `ColorNoiseReduction`, `ColorNoiseReductionDetail` / `Smoothness` | `nr.*` |
| `LensManualDistortionAmount`, `VignetteAmount`, `VignetteMidpoint`, `Defringe{Purple,Green}{Amount,HueLo,HueHi}`, `AutoLateralCA` | `lens.*` |
| `Perspective{Vertical,Horizontal,Rotate,Aspect,Scale,X,Y}`, `PerspectiveUpright` (0 off, 1 auto, 2 level, 3 vertical, 4 full, 5 guided → auto), `CropConstrainToWarp` | `transform.*` |
| `CropAngle` | `rotate`, same sign [verify] |
| `CropLeft/Top/Right/Bottom` | `crop`, only when the picture's size is known (`xmp.parse(..., size=)`); otherwise reported as unmapped |

`UprightVersion` and the other `Upright*` bookkeeping keys are metadata and are never reported.

## Client
- **Crop tool:**
  - aspect presets 1×1, 4×5, 5×7, 2×3, 3×4, 8.5×11, 16×9, 16×10, Original, a custom W × H ratio, and Free;
  - X swaps the orientation and keeps the crop area;
  - Angle, with Auto (uses `/upright` level) and a Straighten tool (drag a line on the picture);
  - overlays: thirds, grid, diagonal, triangle, golden ratio, golden spiral and none (O cycles them, Shift+O turns them);
  - Constrain to image (`transform.constrain`) and Crop opacity (remembered per browser).
- **Panels:**
  - Basic gains a Presence block;
  - Detail (4 sharpening sliders + Show mask, 6 NR sliders);
  - Lens corrections, with a Profile tab (Remove CA, CA fine-tune) and a Manual tab (distortion, constrain, defringe with a fringe eyedropper, lens vignetting);
  - Transform (Upright Off / Auto / Level / Vertical / Full, 7 manual sliders, constrain).
- **Panel shortcuts.** Ctrl+1…9 now follow Lightroom's order: Basic, Tone curve, Colour mixer, Colour grading, Detail, Lens, Transform, Effects, Calibration.
