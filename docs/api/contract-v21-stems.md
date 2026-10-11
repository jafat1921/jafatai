# API contract v21: Stems

No migration. Builds on v18 (the `separate_vocals` runner in the `audio-utils` venv, audio-separator) and v15 (sources, versions, peaks and analysis).

A Library audio item, or a video item's sound, is split into stems. Each stem becomes a **new Library audio item** of its own; the source is never changed.

## Modes
| `mode` | Stems | Model (setting) |
|---|---|---|
| `two` (default) | `vocals`, `instrumental` | `DUB_SEPARATION_MODEL` (BS-RoFormer, the one Dub uses) |
| `four` | `vocals`, `drums`, `bass`, `other` | `STEMS_FOUR_MODEL`, default `htdemucs_ft.yaml` (Demucs) |

Both models download into `DUB_SEPARATION_MODEL_DIR` on first use (`scripts/install-voice-models.sh separator` fetches both). A four-stem model that writes more (for example `htdemucs_6s`: guitar, piano) gives an item for every extra stem too, after the four.

## Split
- `POST /api/audio/{item_id}/stems` with `{mode?: "two" | "four", version?: generation_id}` returns **202** `{job, items: []}`.
  - `item_id` is an audio **or** video item. Its current version is used, or `version` picks another of its versions.
  - The job type is `audio_stems`, on the **audio** lane (GPU; either worker claims it). `job.payload`: `{source_id, generation_id, mode, model, user_id}`.
  - Errors: 404 `Track not found` (missing or another workspace's); 404 for a version that isn't the item's; 422 `Pick an audio clip or a video to split`; 422 `This video has no sound to split` / `This clip has no audio stream to split`; 409 when the item isn't finished yet, or when a split of the same item in the same mode is already queued or running (`This track is already being split that way`).
- The worker decodes the source to 48 kHz stereo PCM with ffmpeg (video: the sound only), runs the model, and saves every stem as **FLAC, 48 kHz**.
- On success each stem is a new item:
  - `kind: "audio"`, `origin: "generated"`, `folder_id` the source's, title `"<source title> — Vocals"` (Instrumental, Drums, Bass, Other…).
  - `tags: ["stems", "stems:<source item id without dashes>"]` (38 characters, inside the 40-character tag limit).
  - Its one version has `params: {kind: "stem", stem, source_id, source_generation_id, mode, model, split_id: <job id>, duration_s, created_by: {user_id, flow: "stems"}}`.
- `job.result`: `{mode, model, source_id, items: [item ids, in stem order], generation_ids, stems: {stem: item id}, seconds}`.
- A finished-job hook draws each stem's waveform thumb and measures its loudness, so the tiles and quality badges show straight away.
- A split that fails creates no items and leaves no files behind.

## List
`GET /api/audio/{item_id}/stems` returns:

```json
{
  "source_id": "…",
  "splits": [{"id": "<job id>", "mode": "four", "created_at": "…", "stems": ["vocals", "drums", "bass", "other"], "items": [MediaItemOut, …]}],
  "items": [MediaItemOut, …],
  "jobs": [JobOut, …]
}
```

- `splits` are newest first, their items in stem order. `items` is every stem of every split, flat.
- `jobs` are this item's splits still queued or running; the client polls while it isn't empty.
- Stems are found by their `stems:<id>` tag, so they also show in the Library (`GET /api/media?kind=audio&tag=stems:<id>`).

## Runner (`backend/runners/separate_vocals.py`)
- Job `{audio, out_dir, model, model_dir, device, all_stems?}`.
- Returns `{stems: {name: path}}`: every file the model wrote, keyed by the lower-case `(Name)` in its file name (the source's own name is cut off first, so brackets in a title don't count).
- Without `all_stems` it also returns `{vocals, instrumental}` and fails if it can't find both: Dub's contract (v18) is unchanged.
- Drivers: `separate(src, out_dir, model, cb)` (two stems, as Dub) and `separate_stems(src, out_dir, model, cb) -> {name: Path}` (four). ComfyDriver hands both to `app.dub.engines`; MockDriver fakes them (the mix as vocals, a pulse, a hum and a quiet bed).

## Frontend
- `/audio/stems` (Audio sidebar, Tools → Stems; the Audio Tools menu): pick audio or a video (or upload), or arrive with `?source=<id>`; choose the mode; Split. Progress comes from the job; the stems show as audio tiles (play, download menu, Open in Editor, Use in Score a Clip), with "Previous splits of this track" below.
- Audio and video tile menus have **Split stems** → `/audio/stems?source=<id>`.
