---
title: Contract v4a — Quick Create features (language, studio cast, long scenes, opening title)
status: implemented
updated: 2026-10-18
extends: contract-v4-upscale-quick.md, contract-v26-character-voices.md, contract-v3-reel.md, mcp.md
---

# Contract v4a — Quick Create for a feature film

Addendum to v4 (Quick Create / autopilot). Everything in v4 still holds; these fields are optional and an
English short made without them behaves exactly as before.

## POST /api/quick — new fields

| field | type | default | meaning |
|---|---|---|---|
| `language` | ISO 639-1 (`ur`, `hi`, `ar`, …; `xx-yyyy` allowed) | `"en"` | language of every spoken line and any words seen on screen |
| `cast_ids` | `string[]` (≤ 8) | `[]` | Character Studio character ids: the whole speaking cast |
| `scenes` | int 1–12 | `null` | plan exactly this many scenes |
| `scene_seconds` | number 5–600 | `null` | target length of each scene |
| `title_intro` | bool | `language != "en"` or runtime ≥ 60 s | a ~7 s opening title card with a music sting |
| `title` | string ≤ 120 | `null` | the film's title instead of the AI's (`title_auto` off) |

**Runtime:** `scenes × scene_seconds` sets the runtime when both are given (it replaces `duration_s`). Only
`scene_seconds`: `scenes = round(duration_s / scene_seconds)` clamped to 1–12, and the scene length is
recomputed. Only `scenes`: each scene is `duration_s / scenes`. The ceiling is now
`max(LONGTAKE_MAX_S × 4, 1200)` seconds, so a 10-minute (600 s) film is always allowed whatever the long-take limit.

**Errors:** an unknown or other-workspace `cast_ids` entry → `404 "Character not found: <id>"`; a character
that belongs to another film (not saved to Character Studio) → `409`; runtime out of range → `422`.

**Stored:** `project.settings.language` (only when not `en`; no migration, settings are free-form) — every
writer prompt for the film reads it, so studio-side rewrites keep the language too. Cast members are linked
with `project_cast` at once. The job payload carries `language, cast_ids, scenes, scene_seconds, title_intro,
title`.

## Autopilot behaviour

- **Language.** The outline, scene writer and shot planner are told the film is in that language: dialogue and
  on-screen words in it, headings / cues / action / logline / title in English. The outline also returns
  `title_local` (the title in the film's language). Arabic-script languages get the strict aerab rule in the
  writer's system prompt and the verified aerab pass on the scene script, on the shot lines and on
  `title_local`. Frame and motion prompts are always English (FRAME_RULES).
- **Shot lines.** Planned lines become `shot.dialogue` rows `{character_id, text, language}`. `language` is
  kept through `PATCH /shots/{id}` (`DialogueLineIn.language`) and shown in `ShotOut.dialogue`. Speech uses the
  row's language for the stand-in voice pick and the TTS call; non-English lines are always lip-synced (never
  left to the video model's own audio).
- **Cast.** With `cast_ids` the outline is given exactly those people (description, plus profile role / age /
  personality / wardrobe) and told to invent no other speaking part; extras stay in the background without
  lines. Characters the outline names beyond the cast are not created, `ai_extract_characters` is skipped, and
  the "Describing the cast" pass only fills a cast member whose description is empty. Their approved
  portraits / sheet panels are the references (as for any linked character) and their `voice_id` speaks.
  Lines by anyone outside the cast are dropped by the planner (as before).
- **Long scenes.** With `scenes` (or `scene_seconds`) set, scene lengths are not capped at `LONGTAKE_MAX_S`.
  The storyboard runs in `shots` mode with, per scene, `max_shots = ceil(seconds / 7.5)` (≤ 40) and the scene
  length in the planner prompt; shot lengths are then scaled to fill the scene (each 3–20 s; anything over one
  LTX pass renders as a long take). `ai_storyboard` accepts `max_shots_by_scene {scene_id: n}` and
  `scene_seconds {scene_id: s}` in its payload.
- **Queueing.** The autopilot keeps at most 24 keyframes and 12 takes in flight at once and queues the next
  batch when those finish, so a long film doesn't flood the queue.
- **Opening title.** When `title_intro` is on, a 10 s instrumental sting (`sa3_small_music`, a working-part
  Library item, `home="film"`) is queued in the Cast stage. Before stitching the autopilot waits for it and
  writes `project.settings.title_intro`:

  ```json
  {"title": "<title in the film language, with aerab>", "subtitle": "<English title>", "language": "ur",
   "font": "Noto Nastaliq Urdu", "subtitle_font": "Noto Sans", "rtl": true, "seconds": 7.0,
   "fade_in_s": 1.0, "fade_out_s": 1.2, "music_id": "<generation id | null>"}
  ```

## Reel (contract v3) — opening title

`reel_assemble` of a **whole-film** selection draws `project.settings.title_intro` when present: the first
scene's establishing frame (else a frame of the first take), darkened, a slow push-in, the title in the
language's font (Urdu: Nastaliq, shaped RTL) with the English title under it, fade in 1 s / out 1.2 s, the
sting under it (faded, −4 dB) or silence. It is joined in front of the first scene as a chapter named
`Title`; the render's `duration_s` includes it and `render.params.title_intro` records what was drawn
(`length`, `music`, `font`, `font_file`). Range stitches never get it. `PATCH /projects/{id}
{settings: {title_intro: null}}` switches it off for later stitches.

## MCP — create_project_from_idea

Gains `language`, `cast_ids`, `scenes`, `scene_seconds`, `title_intro`, `title` (same rules as above) and
returns `runtime_s` alongside `project_id`, `title` and the job. Also `video_quality` (`"standard"` | `"hq"`)
and `upscale` (`{engine: best|fast|quick, target: 1080p|1440p|4k}`, as `POST /api/quick`).

```json
{"idea": "…", "language": "ur", "cast_ids": ["<id>", "<id>"], "scenes": 4, "scene_seconds": 150,
 "aspect_ratio": "16:9", "style": "cinematic", "dialogue": true, "title_intro": true,
 "video_quality": "hq", "upscale": {"engine": "best", "target": "1080p"}}
```

## Addendum (2026-10-18) — after the first live Urdu trial

- **HQ by default for a feature.** `POST /api/quick` (and the MCP tool) with `scenes` or `scene_seconds` set and
  no `video_quality` stores `project.settings.video_quality = "hq"`; draft-size takes (768×448) looked soft.
  Pass `"standard"` to keep the old behaviour. Shorts are unchanged.
- **Film model.** `FILM_LLM_MODEL` (default `gemma4:26b`; empty = default, `off` = the roles' models) writes and
  plans every step of the film when Ollama has it installed: outline, scene scripts, cast looks, location and
  character reads, portrait prompts, shot lists, frame prompts. Thinking off, keep_alive
  `OLLAMA_KEEP_ALIVE_BIG`. Not installed or not listable: each step keeps its role's model. The vision checks
  keep the vision model. `job.result.film_model` records which was used (`null` = the roles).
- **Scene-scoped voice routes** (any scene, also one added by hand in the editor):
  - `POST /api/scenes/{id}/voice` → 202 `{status: voiced|voicing|silent|no_voice, lines, job_ids}`: speaks the
    scene's lines; a line whose text and voice are unchanged keeps its take (only edited / added lines, or a
    character's new voice, are spoken again).
  - `POST /api/scenes/{id}/plan-shots` → `{shot_ids, new_shot_ids, removed_shot_ids, seconds}`; `409` until every
    line is spoken. Shots cut from unchanged lines (same lines, same voice, same framing) are kept with their
    frames and takes and re-timed; only shots containing a changed line are replaced.
  - `POST /api/scenes/{id}/build` → 202: voice, and once every line is spoken, plan the shots and queue the new
    shots' frames (`status: planned`, `frame_job_ids`). Call again while it answers `voicing`.
  - `GET /api/scenes/{id}/audio` → `{planned, stale, message, seconds}`; `stale` (message "Dialogue changed —
    re-time shots") when a line was edited, added or removed, or a voice changed since the shots were cut.
  - Stored per scene in `project.settings.scene_audio[scene_id]`: beats with `line_id`s, the speech plan, the
    track, and per shot its slice and the lines it was cut from (`[line_id, fp, offset]`). Reordering scenes
    changes nothing; the reel stitches scenes in order, each take carrying its own slice of its scene's track.
  - No frontend action yet (API only).
- **Voice first (every talking film without a brand kit).** After the scripts are written, the Storyboard stage
  speaks every line first ("Voices: n of m lines spoken"): the scene's screenplay becomes ordered beats
  (a spoken speech with the action before it as its picture, or a silent action of 2–4 s; a speech over ~9 s
  is split at a sentence break), each line is a hidden speech take in the speaker's voice
  (`shot_speech.ensure_takes`, stand-in gallery voices as before), and the measured lines are laid on one
  dialogue track per scene (`film_audio/<scene_id>.wav`, 0.3 s lead, 0.35 s between lines, 0.5 s tail).
  The track is cut with the AI video podcast's planner (`podcast.vplan.build`: speaker on camera while they
  talk, listener cutaways, the room before the first line); cuts over 10 s become consecutive shots, every
  other one on the listener while the voice carries on. Shot lengths are the cut lengths, so a scene runs
  as long as its dialogue (no stretching to `scene_seconds`). Each take renders against its exact slice of
  the track: lip-synced (`ltx23_ia2v`, `speech_audio`) when its camera is the speaker, otherwise a silent
  take; either way the slice becomes the take's sound (`params.mux_audio`), so the stitched scene's
  dialogue is continuous. The autopilot runs the same per-scene steps as the routes above;
  `job.result.voices.scenes[scene_id]` is each scene's voice status, and a `silent` or `no_voice` scene (nobody
  speaks; no Voice Gallery voice for its lines) is planned by the shot planner instead. Characters without a
  voice get gallery stand-ins; lines are never left to the video model's own audio here.
- **Shot count is a contract.** On the shot planner's path, in long-scene mode the planner is asked for exactly `ceil(seconds / 7.5)` shots
  (≤ 40) with every script line placed in one shot with its speaker. Fewer back: asked once more with the
  count spelled out; still short, the longest shots are split into consecutive beats (wide / medium /
  close-up / reaction / insert, same place, dialogue split between them) until the count is met and no shot
  is over 20 s. A planner that drops every line gets the script's own lines spread over the shots.
- **Language is enforced.** For a film in a non-Latin script (Urdu, Arabic, Hindi…), a spoken line in a scene
  script or on a shot that comes back in Latin letters is translated with TranslateGemma (`ur` as `ur-PK`)
  and then gets the aerab pass. A line that can't be translated is tagged `language: "en"` so it is at least
  spoken as English.
- **Dialogue density and content-first timing.** The writer gets a spoken-word target per scene (60 % of its
  seconds spoken, at 2.3 words/s for Urdu, 2.5 otherwise); a scene under half of it is written once more with
  the number. After drafting, each scene's length is worked out from its script (words ÷ pace, breaths, silent
  actions); when the film misses its runtime by more than 10 %, the scenes that are off are rewritten once
  against a timing table, and the plan then follows the scripts (`outline.content_seconds`). Shots are not
  stretched to fill. The cast's looks are written right after the outline, before any scene.
- **Planning hygiene.** Every autopilot LLM step runs with thinking off. A schema failure is asked once more
  (the failed answer as the assistant turn, temperature 0.3, twice the tokens when cut off) before the stage
  fails. Shot lists: one visible speaker per talking shot, shot / reverse shot with reactions; a shot with no
  `characters` gets its speakers (else the scene's); every script line ends up in exactly one shot (reworded or
  dropped lines are replaced by the script's own). Scenes over 10 s are always planned as several shots; shots
  are single 3–10 s passes. Take and chunk prompts carry "In frame: <name>: <description>" for every character
  in the shot, and the vision check is given everyone in it.
- **Titles.** `title_local` must be pure target script: parenthetical English is dropped, and a mixed or
  missing one is translated from the English title (else the card shows the English title alone). An English
  title that carries the local one too ("روشنی (The Light of Ramadan)") keeps only its English.
- **Title card fonts.** Each line is drawn with a face that has its letters: English in DM Serif Display
  (bundled), Urdu in Noto Nastaliq (system, else bundled). A line its face can't draw falls back to a bundled
  face for its script; there are no missing-glyph boxes.
- **Cast portraits.** A cast member with no approved portrait but a finished one (or a sheet hero) has the
  newest finished portrait auto-approved (`params.auto_check = "reused"`) instead of a new one being drawn.
- **Retry.** `POST /api/jobs/{id}/retry` records `result.resumed_at`: attempts that failed before it no longer
  count against an image, take or logo-reveal slot's tries, and the stitch's attempt count restarts.
