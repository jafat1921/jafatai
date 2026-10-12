# API contract v16: Voice studio (M11b / B2)

Plan: [PLAN-m11b-audio-pro](../PLAN-m11b-audio-pro.md). Migration **0013** adds `voice_profile`.

## How the speech engines run
- The speech engines live in their own Python venvs on the GPU server (`AUDIO_VENVS_DIR`, default `/data/venvs`): `tts-omnivoice`, `tts-voxcpm`, `tts-chatterbox`, `tts-kokoro`, `stt-whisperx`, `stt-funasr`, `audio-utils`.
- The worker runs `backend/runners/<runner>.py` with that venv's Python. A JSON job goes in on stdin. Progress comes back as JSON lines on stdout (`{"progress": 0.4, "message": "…"}`), followed by `{"done": {...}}` or `{"error": "…"}`.
- `CUDA_VISIBLE_DEVICES` is the worker's own GPU (`AUDIO_GPU_IMAGE=0`, `AUDIO_GPU_VIDEO=1`).
- If the GPU has less free memory than the engine needs, the worker first asks its ComfyUI to free memory (`POST /free`).
- The mock driver fakes every engine locally: a tone whose length follows the text.
- Speech generations have kind `speech` and run in the audio lane, so either GPU worker can take them.

## Engines (`GET /api/voices/engines`)
| id | label | features | languages | licence |
|---|---|---|---|---|
| `omnivoice` | OmniVoice | `clone`, `design`, `tags` | 600+ (Urdu, Punjabi, Sindhi, Pashto included) | Apache-2.0 |
| `voxcpm` | VoxCPM2 | `clone`, `design` | 30 (Hindi; no Urdu) | Apache-2.0 |
| `chatterbox` | Chatterbox | `clone`, `emotion` | 23 (Hindi; no Urdu) | MIT; output carries a Perth watermark |
| `kokoro` | Kokoro | `preset_voices`, `fast` | about 8 | Apache-2.0 |

Each row: `{id, label, features, languages: [{code, name}], licence, default_for?: ["ur", …], presets?: [{id, name, language}]}`. The default engine is `omnivoice`.

## Voices (the library)
`VoiceOut`:

| Field | Notes |
|---|---|
| `id`, `name`, `language`, `notes` | |
| `gender_hint` | `male \| female \| neutral \| null` |
| `kind` | `clone \| design \| preset` |
| `ref` | `{media_id, generation_id, duration_s, url}` or null |
| `ref_text` | |
| `design` | `{description, seed, engine}` or null |
| `preset` | `{engine, id}` or null |
| `portrait_url` | |
| `starred`, `locked` | |
| `consent` | `{name, statement, at, user_id}` or null |
| `created_at`, `updated_at`, `uses` | |

| Method | Path | Notes |
|---|---|---|
| GET | `/voices?q=&language=&kind=&starred=` | Newest first |
| POST | `/voices` | `{name, language, kind, ref_media_id?, ref_text?, design?, preset?, notes?, gender_hint?, consent?}` |
| PATCH | `/voices/{id}` | Any field; a `locked` voice can't change its ref or design |
| DELETE | `/voices/{id}` | 204. The reference audio item stays in the Library. |
| POST | `/voices/{id}/transcribe` | 202 job (`voice_transcribe`, audio lane, faster-whisper). Fills `ref_text`. |

**Rules:**
- `kind: clone` **requires** `consent` with `name`, and `statement` must be exactly the shown text: "I have the right to use this voice, and the person it belongs to agreed to it being cloned." Otherwise 422.
- `ref_media_id` must be a finished audio item in the workspace, 3–30 s long. A clip under 5 s or over 15 s isn't refused, but the response sets `warnings: ["short" | "long"]`.

## Speak: `POST /api/audio/speak` → 202 `{items, jobs, engine_resolved}`
| Field | Notes |
|---|---|
| `text` | 1..5000. Expression tags `[laughter] [sigh] [breath] [whisper] [pause 0.5s]` are passed through to engines with `tags`; for other engines they're stripped, and `[pause Ns]` becomes silence. |
| `voice_id` | Optional (else `design`, or the engine's default voice) |
| `design` | `{description, seed?}`, for a one-off designed voice |
| `engine` | Engine id or `auto` (OmniVoice; Kokoro for a preset voice) |
| `language` | Code. `ur` turns on aerab for unmarked Urdu, as with songs (`aerab: false` turns it off). |
| `speed` | 0.5..2.0 |
| `duration_s` | Optional fixed length |
| `steps`, `guidance`, `denoise`, `exaggeration` | Engine-specific. `exaggeration` is Chatterbox's emotion strength, 0..2. |
| `count` | 1..4 |
| `seed` | |
| `title`, `folder_id` | |

The result is a Library audio item, `kind: "audio"` with generation kind `speech`. Its `params` record `{engine, voice_id, language, text, text_spoken}`, where `text_spoken` is the text after aerab and tags.

Every media item (`GET /media`, the speak response) carries its current version's `params`, minus `created_by` and the voice's `ref_file`, with the `seed` added. Speak lists only items whose `params.kind` is `speech`; the song, music and SFX pages filter on the same field.

Errors are 422 with a readable message, for example a language the engine doesn't speak ("Chatterbox doesn't speak Urdu. Use OmniVoice."), a `clone` voice used with an engine without `clone`, or a missing voice.

## Design preview
`POST /api/voices/design/preview` with `{description, seed?, engine?, language, text?}` returns the same as speak with `count: 1`. The text defaults to a short pangram in that language. The response includes the `seed` used, so "Save as voice" can keep the identity (`kind: design`).
