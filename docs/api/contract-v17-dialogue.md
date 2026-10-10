# API contract v17: Dialogue and narration (M11b / B3)

Migration **0014** adds `voice_script` (a dialogue / narration project). It builds on the voices and `/audio/speak` engines from v16.

## Script
`ScriptOut`:
- `{id, title, language, engine, project_id?, cast, lines, settings, mix, created_at, updated_at}`
- `cast`: `[{id, name, voice_id, color}]`. The cast member `narrator` always exists.
- `lines`: `[{id, speaker_id, text, voice_id?, speed?, emotion?, pause_after_s, take_id?, fingerprint?, status}]`. `status` is `empty | stale | rendering | ready | failed`.
  - `voice_id` overrides the speaker's voice for that line.
  - `emotion` is a short instruction passed to engines that take one (OmniVoice `instruct`, Chatterbox exaggeration).
  - `take_id` is the generation id of the current take.
  - `fingerprint` is a hash of the text, the resolved voice, engine, language, speed and emotion. A line is `stale` when its fingerprint no longer matches its take.
- `settings`: `{gap_s: 0.35, paragraph_gap_s: 0.8, loudness: "podcast", aerab: true}`
- `mix`: `{media_id, generation_id, built_at, stale: bool}` or null. This is the last good mixed track.

| Method | Path | Notes |
|---|---|---|
| GET | `/scripts` | Newest first, with counts (lines, ready, stale) |
| POST | `/scripts` | `{title, language, engine?, project_id?}` |
| GET | `/scripts/{id}` | |
| PATCH | `/scripts/{id}` | Partial: title, language, engine, cast, lines (the whole array), settings. The server recomputes `status` for each line. |
| DELETE | `/scripts/{id}` | Takes and mixes stay in the Library |
| POST | `/scripts/{id}/split` | `{text, mode: "sentences" \| "paragraphs" \| "lines", speaker_id?}` adds lines. Lines like `NAME: text` or screenplay cues auto-cast new speakers. Returns the script. |
| POST | `/scripts/{id}/import-project` | `{project_id, scene_ids?}` reads the film project's screenplay (reusing the storyboard screenplay parser). Cues become speakers, dialogue becomes lines, and action lines become narrator lines only when `include_action` is true. |
| POST | `/scripts/{id}/render` | `{line_ids?: []}` queues speech for every `stale` or `empty` line (or the listed ones). Returns 202 `{jobs, queued}`. Each take is a hidden Library audio item, tagged `script:<id>`. |
| POST | `/scripts/{id}/mix` | 202 job `script_mix` (general lane): joins the ready takes in order with the gaps, applies loudness, and makes or updates one Library audio item, a new version each time. Returns 409 while any line isn't ready. |
| POST | `/scripts/{id}/stems` | 202 job: zip of one WAV per speaker, aligned to the mix timeline |

**Rules:**
- Speech for lines goes through the same `queue_speech` as `/audio/speak`: aerab for Urdu, tags per engine.
- A line whose voice is a clone voice with an engine that can't clone fails with a readable `error`.
- Line jobs report progress per line, and the editor polls `GET /scripts/{id}`.
