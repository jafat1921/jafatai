# API contract v14: Audio Studio (M11 / A1)

No migration. `media_item.kind` (String(10)) gains the value `"audio"`. Plan: [PLAN-m11-audio](../PLAN-m11-audio.md).

## Media and generations
- `MediaItem.kind`: `image | video | audio`. Audio items have `duration_s`. Width and height are null.
- Each audio item has a `thumb_url`, which is a waveform PNG (800×160, gold on transparent).
- Generation kinds: `song`, `music`, `sfx`. `speech` follows in A3. The output is `audio/flac`.
- Uploads accept `audio/wav`, `audio/x-wav`, `audio/mpeg`, `audio/mp4` (m4a/aac), `audio/aac`, `audio/ogg` (ogg/opus), `audio/flac`, `audio/x-flac` and `audio/webm`, up to 200 MB. Each one becomes a `kind:"audio"` item with its probed `duration_s`.

## Lane
- Jobs for audio generations run in the new lane `audio`.
- Both GPU workers serve it (`--lanes image,audio` and `--lanes video,audio`, systemd `mixai-worker@image-audio` and `@video-audio`), so whichever worker is idle claims the job.
- The worker talks to its own GPU's ComfyUI: the image URLs for the image worker, the video URLs for the video worker.
- A single all-lanes worker (local dev) uses the image URLs.

## Models (`GET /api/models?type=audio`)
| id | label | capabilities | max_duration_s | notes |
|---|---|---|---|---|
| `ace15_turbo` | ACE-Step 1.5 | `song`, `lyrics`, `vocals`, `timbre_ref` | 240 | Default song model |
| `minimax_music3` | MiniMax Music 3 | `song`, `lyrics`, `vocals` | 240 | `extra.noncommercial: true`. Listed only when `AUDIO_ALLOW_NONCOMMERCIAL=true`. |
| `sa3_small_music` | Stable Audio 3 Small Music | `music` | 120 | Default music model |
| `sa3_medium` | Stable Audio 3 Medium | `music`, `long` | 380 | |
| `sa3_small_sfx` | Stable Audio 3 Small SFX | `sfx` | 120 | Default SFX model |

`model: "auto"` (or omitting it) picks the default model for the `kind`.

## Generate: `POST /api/audio/generate` → 202 `{items: MediaItemOut[], jobs: JobOut[], model_resolved}`

| Field | Type | Notes |
|---|---|---|
| `kind` | `song \| music \| sfx` | Required |
| `prompt` | 1..2000 | Style tags or description |
| `lyrics` | ≤ 6000 | Song only. Section markers `[verse]`, `[chorus]`, `[bridge]`, `[intro]`, `[outro]`, `[instrumental]`. Empty means instrumental. |
| `language` | `en \| ur \| hi \| ar \| pa \| es \| fr \| zh \| ja \| ko …` | Song only. Default `en`. |
| `vocal` | `male \| female \| duet \| none` | Song only. Added to the style tags. |
| `bpm` | 40..220 or null | Optional |
| `category` | `music \| instrument \| loop \| sfx \| oneshot` | Optional hint |
| `duration_s` | 1..380 | Checked against the model's `max_duration_s` |
| `model` | id or `auto` | |
| `count` | 1..4 | One item and one job per take; seeds go `seed`, `seed+1`, … |
| `seed` | int or null | |
| `steps` | 1..100 or null | |
| `timbre_ref_id` | audio item id or null | ACE-Step only |
| `title` | ≤ 200 | Optional |
| `folder_id` | | Same "generate into" rule as images and video |

Errors are 422 with a readable message, for example a wrong kind for the model, an over-length duration, or MiniMax while it's disabled.

## Lyrics: `POST /api/audio/lyrics` → 200 `{lyrics, tags}`
- Body: `{topic (1..500), language, mood?, style?, sections?: string[] (default ["verse","chorus","verse","chorus","bridge","chorus"])}`.
- Uses the local LLM (Ollama). Urdu is written in Urdu script unless `language` is `ur-latn` (Roman Urdu).
- If the LLM is offline: 503 `"The lyrics writer is offline"`.

## Estimate
`GET /api/estimate?kind=audio&model=&duration_s=&count=` uses the same response as the other kinds.

## Prompt templates
`GET /api/prompt-templates?type=audio` has the categories Song, Score, Sound effects and Ambience.

## Not in A1
These come in later phases: Score a Clip and audio edits (A2), Voice / TTS (A3), Stems and Transcribe (A4).
