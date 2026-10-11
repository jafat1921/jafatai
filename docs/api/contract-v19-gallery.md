# API contract v19: Voice Gallery (M11c / C1)

Plan: [PLAN-m11c-gallery-podcast](../PLAN-m11c-gallery-podcast.md), section C1. No migration: the gallery is a JSON catalogue (`backend/app/data/voice_gallery.json`, loaded and checked by `app/voice_gallery.py`). It builds on v16 (voices, speech, engines).

## The catalogue
Every entry is one ready-made voice:

| Field | Notes |
|---|---|
| `id` | Slug, unique (`ur-lahore-narrator`, `af_heart`, …). Kokoro voices keep their Kokoro id. |
| `name` | Display name, e.g. "Aamir, Lahore narrator" |
| `languages` | Codes; the first is the voice's main language (samples and Speak default to it) |
| `gender` | `male \| female \| neutral` |
| `age` | `child \| young \| adult \| elder` |
| `accent` | Free text, e.g. "Lahori Urdu", "British RP" |
| `styles` | Tags from: `narrator news warm deep energetic calm storyteller whisper radio villain teacher podcast poetry kids` |
| `engine` | `omnivoice` (designed), `voxcpm` (designed) or `kokoro` (preset) |
| `instruct` | Designed voices only: OmniVoice attribute-style text ("male, middle-aged, low pitch, slow, warm, Pakistani accent"); for VoxCPM2 it becomes the `(description)` prefix |
| `seed` | Designed voices only: fixed int, half of the voice's identity |
| `preset` | Kokoro only: the Kokoro voice id |

The catalogue is checked at load (and in tests): unique ids, designed voices have `instruct` and `seed`, the engine exists and has the feature (`design` / `preset_voices`), every language is one the engine speaks.

`voices.KOKORO_PRESETS` (and so `GET /voices/engines` → `presets`) now comes from the catalogue: all 54 Kokoro voices.

## `voice_id: "gallery:<id>"`
Anywhere a voice id is resolved, `gallery:<id>` works without adding the voice first:
- `POST /audio/speak` (`voice_id`), `POST /voices/design/preview` is unchanged.
- Dialogue cast and line `voice_id` (contract v17), so also Podcast hosts (contract v20).
- Dub speakers' `voice_id` (contract v18).

It resolves to the catalogue's recipe (a design `{description: instruct, seed, engine}` or a preset `{engine: "kokoro", id}`), exactly as a library voice of that kind would. `language` defaults to the voice's main language. Generation `params.voice_id` stays `"gallery:<id>"`. An unknown gallery id is a 422 ("That gallery voice doesn't exist"). Server code: `voices.find_voice(db, workspace_id, voice_id)` and `voices.find_voices(db, workspace_id, ids)` return a `VoiceProfile` (a transient, unsaved one for gallery ids) — use these instead of `db.get(VoiceProfile, …)`.

## API

### `GET /api/voices/gallery?q=&language=&gender=&age=&style=&engine=`
Each filter takes one value. `q` matches name, accent, styles, language names and the instruct text. Returns:

```json
{
  "items": [GalleryVoiceOut],
  "total": 130,
  "facets": {
    "language": [{"value": "ur", "label": "Urdu", "count": 16}],
    "gender": [...], "age": [...], "style": [...], "engine": [{"value": "omnivoice", "label": "OmniVoice", "count": 60}]
  }
}
```
Facet counts are computed with every *other* filter applied (picking Urdu still shows how many Hindi voices there are), sorted by count, then label. Items are in catalogue order.

`GalleryVoiceOut`:
`{id, voice_id: "gallery:<id>", name, language, languages, gender, age, accent, styles, engine, kind: "design" | "preset", instruct?: str, seed?: int, preset?: str, sample_url: "/api/voices/gallery/<id>/sample", sample_ready: bool, added_voice_id: str | null, starred: bool}`

`added_voice_id` is the workspace's `VoiceProfile` made from this entry (if any); `starred` is that voice's star.

### `GET /api/voices/gallery/{id}/sample`
- **200** `audio/mpeg`: the cached sample (`<data_dir>/voice_gallery/<id>.mp3`, about 5 s, levelled to −16 LUFS).
- **202** `{job: JobOut, status: "preparing"}` when it isn't rendered yet. The first request queues one `voice_sample` job (audio lane, payload `{gallery_id}`); requests while it is queued or running return the same job. Poll the same URL (or watch the job) until it answers 200.
- 404 for an unknown id.

### `POST /api/voices/gallery/{id}/add`
Body (optional): `{starred?: bool}`. Creates a `VoiceProfile` in the workspace (201) or returns the existing one (200): idempotent per workspace and gallery id.
- Designed → `kind: "design"`, `design: {description: instruct, seed, engine, gallery: id}`.
- Kokoro → `kind: "preset"`, `preset: {engine: "kokoro", id, gallery: id}`.
- `name`, `language` (main), `gender_hint`, `notes` (accent · styles) come from the catalogue.
- `starred: true` stars it (also on an existing one). Unstar with `PATCH /voices/{voice_id}`.

The ★ on a gallery card is "add with `starred: true`"; there is no separate favourites store.

## Samples
- Job `voice_sample` (audio lane): speaks the language's sample line (`voice_gallery.SAMPLE_LINES`, Urdu in Urdu script with aerab added like speech) through the worker's driver, then writes the levelled MP3.
- `python -m app.manage voice-samples [--engine omnivoice|kokoro|voxcpm] [--force] [--only id,id]` renders the missing samples (all with `--force`) with **one runner call per engine** (Kokoro: one per language). The runners accept per-segment `instruct` / `seed` / `voice` / `language` when the job has `"per_segment": true`.
- The Dub workspace's own speaker select still lists library voices only; the API accepts `gallery:<id>` there too.
- `scripts/install-voice-models.sh samples` runs it on the server.

## Frontend
- `/audio/gallery` (sidebar Voice: Speak · Voices · Gallery · Design; Audio menu entry "Voice gallery").
- `features/audio/voice/GalleryPage.tsx`; data in `lib/gallery.ts`, hooks `useGallery`, `useGalleryVoices`, `useGallerySample`, `useAddGalleryVoice` in `hooks/useGallery.ts`.
- `VoiceChip` (features/audio/voice/VoiceChips.tsx) has a **Gallery** section with search and a language filter (defaults to the `language` prop). Pass `language` to it; it fetches the gallery itself. Picking an entry calls `onChange("gallery:<id>")`.
- Dialogue's `CastPanel` and `LineList` take an optional `language` prop and pass it to their `VoiceChip`s (the editor passes `script.language`); embed them with it.
- Pages that validate a picked voice should use `useVoiceChoices()` (library voices plus gallery voices as `Voice` objects with `id: "gallery:<id>"`) instead of `useVoices().data`.
- `isGalleryId(id)`, `galleryAsVoice(g)` in `lib/gallery.ts`.
