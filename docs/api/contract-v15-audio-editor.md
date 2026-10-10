# API contract v15: Audio editor, analysis and Score a Clip (M11b / B1)

Plan: [PLAN-m11b-audio-pro](../PLAN-m11b-audio-pro.md). No migration.

All ffmpeg work runs on the general (CPU) lane. Edited audio becomes a **new version** of the same Library item, the same way Photo Studio develops do. A mix becomes a new version of the **video** item.

## Edit stack (`AudioEdit`, version 1)
Every field is optional, and an empty object means "as it is".

| Field | Shape | Notes |
|---|---|---|
| `version` | `1` | |
| `trim` | `{start, end}` (s) or null | Keep only this region |
| `cuts` | `[{start, end}]` | Regions removed after the trim, in source time |
| `gain_db` | −24..24 | |
| `fade_in` / `fade_out` | `{s: 0..30, curve: "tri" \| "qsin" \| "exp" \| "log"}` | ffmpeg `afade` curves |
| `speed` | 0.5..2.0 | Tempo change; pitch kept (`atempo`) |
| `pitch` | −12..12 semitones | Length kept |
| `silence_trim` | bool | Strips leading and trailing silence below −50 dB |
| `loop_to` | seconds or null | Repeats with a 50 ms crossfade up to this length, then fades out |
| `append` | `[audio item id]` (≤ 8) | Joined after the result, 20 ms crossfade |
| `chain` | `{preset, amount 0..100}` or null | presets: `broadcast`, `cinematic`, `podcast`, `warm`, `raw`, `radio`, `telephone`, `hall` |
| `loudness` | `{target}` or null | `web` −14 LUFS / −1 dBTP, `podcast` −16 / −1, `broadcast` −23 / −2 (EBU R128), `acx` −19 (RMS −18..−23 band) / −3; two-pass `loudnorm` |
| `markers` | `[{t, label ≤ 40}]` (≤ 100) | Stored only; doesn't change the sound |

The steps are applied in this order: trim → cuts → silence_trim → speed / pitch → chain → gain → loop_to → append → fades → loudness.

## Peaks and analysis
- `GET /api/audio/{item_id}/peaks?n=` (n 200..20000, default 4000) returns `{duration_s, sample_rate, channels, peaks: [[min, max], …]}`. Values are −1..1, from the mono sum, with n buckets. They are cached beside the file and invalidated by the file's mtime.
- `GET /api/audio/{item_id}/analysis` returns `{lufs_i, lra, true_peak_db, sample_peak_db, clipped_pct, silences: [{start, end}], flags}`. Results are cached.
  - `flags` can be `clipping` (any sample ≥ −0.1 dBFS over more than 0.01 % of samples), `too_loud` (lufs_i > −9), `too_quiet` (lufs_i < −30), and `long_silence` (a silence over 3 s that isn't at the start or end).
- Media list and item outputs for audio may include `analysis` once it has been computed: `{lufs_i, true_peak_db, flags}`. This is what the quality badges use.
- `{item_id}` is a Library audio item id. Its current version is used, or `?version=<generation_id>` picks another version of the same item.

## Preview (synchronous, for the editor)
- `POST /api/audio/{item_id}/preview` with `{edit, version?}` returns `200 audio/mpeg` at 128 kb/s.
- Headers: `X-Duration-S`, `X-Lufs-I` and `X-True-Peak-Db` (measured on the preview), plus `X-Render-Ms`.
- 422 means a bad edit (readable message); 413 means the source is over 20 min ("use Save").

## Save as a version
- `POST /api/audio/{item_id}/render` with `{edit, version?, note?}` returns 202 `{item, job}`.
- The job type is `audio_render` (general lane). On success the Library item points at the new version.
- The generation has `kind:"audio"`, `parent_id` set to the source version, and `params:{edit, source_id}`. History shows it as "Edited".

## Export (download in any format)
- `GET /api/audio/{item_id}/export?format=&loudness=&version=` streams the converted file as an attachment.
- `format` is one of: `wav16`, `wav24`, `wav32f`, `flac`, `mp3_128`, `mp3_192`, `mp3_320`, `opus`.
- `loudness` is the optional target from the table above.

## Score a Clip (mix)
- Body `MixIn`:
  - `video_id`: Library video item.
  - `original`: `{keep: bool, gain_db}`.
  - `tracks`: up to 4 × `{media_id, offset_s ≥ 0, gain_db, mute, fade_in_s, fade_out_s, loop: bool, duck: bool}`.
  - `duck`: `{amount_db 0..24 (default 10), under: "original"}`. Tracks marked `duck` dip under the original sound, via `sidechaincompress`.
  - `loudness`: optional target.
- `POST /api/audio/mix/preview` with `MixIn` returns `200 audio/mpeg`: the mixed soundtrack only, at the video's length. The client plays it in sync with the muted video.
- `POST /api/audio/mix` with `MixIn` plus `{stems?: bool, note?}` returns 202 `{item, job}`.
  - The job type is `audio_mix` (general lane). It produces a new **video** version: the video stream is copied, and the mixed audio is AAC 192k.
  - With `stems`, the job's `result.stems` is a zip of the per-track WAVs (downloadable via the job result).
