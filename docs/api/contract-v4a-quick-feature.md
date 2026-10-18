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
returns `runtime_s` alongside `project_id`, `title` and the job.

```json
{"idea": "…", "language": "ur", "cast_ids": ["<id>", "<id>"], "scenes": 4, "scene_seconds": 150,
 "aspect_ratio": "16:9", "style": "cinematic", "dialogue": true, "title_intro": true}
```
