# API contract v18: Dub a video, and Transcribe (M11b / B4)

Migration **0015** adds `dub_project` and `transcript`. It builds on v16: voices, speech, the `stt_whisper` runner and the venv runner. Separation uses the `audio-utils` venv (audio-separator; MelBand/BS-RoFormer vocal model).

## Transcribe
- `POST /api/transcribe` with `{media_id (audio or video), language? (auto), words: true, cleanup: false}` returns 202 `{transcript_id, job}`. The job is `transcribe`, on the audio lane.
- `GET /api/transcripts/{id}` returns `{id, media_id, language, text, segments: [{start, end, text, words?: [{start, end, w}]}], cleanup_text?, status}`.
- `GET /api/transcripts/{id}/subtitles?format=srt|vtt` returns the subtitle file as an attachment.
- `POST /api/transcripts/{id}/cleanup` returns 202. The local LLM removes fillers, keeps names and terms, and stores the result in `cleanup_text`.

## Dub project
`DubOut`:
- `{id, video_id, title, source_language, targets: ["ur", …], stage, stages: {name: {status, progress, error?}}, speakers, segments, glossary, settings, tracks, created_at, updated_at}`
- **Stages, in order:** `extract`, `separate`, `transcribe`, `speakers`, `translate`, `cast`, `render`, `fit`, `verify`, `mix`.
  - Each stage's status is `pending | running | done | failed | review`.
  - After `transcribe` and after `translate`, the pipeline **stops at `review`**: the user checks and edits the segments, then continues.
- `speakers`: `[{id, label, voice_id?, sample_media_id?}]`
  - `sample_media_id` is a short clip of that speaker cut from the separated voice. It's offered as a new clone voice: consent is still required.
- `segments`: `[{id, start, end, speaker_id, source_text, target: {lang: {text, take_id?, fit, status, verify?: {wer, overrun_s}}}}]`
  - `fit` is `smart | stretch | strict`.
- `glossary`: `[{source, target: {lang: text}, note?}]`. These are pinned in every translation prompt.
- `settings`: `{quality: "fast" | "careful", fit: "smart", keep_background: true, background_db: 0, voice_match: "per_speaker"}`
- `tracks`: `{lang: {media_id, generation_id, built_at}}` holds the finished dubbed audio per language. A failed or cancelled run never replaces a finished track.

| Method | Path | Notes |
|---|---|---|
| POST | `/dubs` | `{video_id, targets, source_language?, speakers?: "auto" \| n, settings?}` creates the project and starts the pipeline (202) |
| GET | `/dubs`, `/dubs/{id}` | |
| PATCH | `/dubs/{id}` | `segments` (edits; changed segments go `stale`), `speakers` (cast), `glossary`, `settings`, `targets` |
| POST | `/dubs/{id}/continue` | Resumes from the current stage. Stages already done are skipped (cached files). |
| POST | `/dubs/{id}/regen` | `{lang, segment_ids?}` re-renders stale segments or the listed ones, then re-fits, re-verifies and re-mixes |
| POST | `/dubs/{id}/segments/split` · `/merge` | `{segment_id, at}` · `{segment_ids}` |
| POST | `/dubs/{id}/export` | 202 job. Body `{langs, default_lang, subtitles: "none" \| "srt" \| "burn", include_original: true, stems: false}` produces a **new video version**: MP4 with one AAC track per language (titled and tagged with the language), the original track if asked, and soft subtitles (or burned in). |

**Stage jobs** are `dub_stage`, carrying `payload.stage`. GPU stages (separate, transcribe, render, verify) use the audio lane; the others use the general lane.

**Timing fit:**
- `smart` speeds up by up to 1.25× with atempo, then asks the LLM for a shorter line if it still overruns.
- `stretch` fits the slot exactly with atempo (0.8–1.5×).
- `strict` trims at the slot end with a 60 ms fade.
- `verify` re-transcribes each dubbed segment and flags WER > 0.35 or overrun > 0.3 s.

**Speakers:** clustering of per-segment voice embeddings, so no pyannote token is needed.
- If the speaker count is a number, segments are clustered into that many speakers.
- With `auto`, a distance threshold decides.
- A TODO notes proper diarisation for later.
