---
title: "Contract v33: Poetry Short"
status: Active
created: 2026-10-15
extends: contract-v14 (songs, lyrics), contract-v21 (stems), contract-v24 (stage jobs), contract-v25 (Character Studio), contract-v28 (story video assembly)
plan: docs/PLAN-m15-poetry-short.md
migration: 0021_poetry_short
---

# Contract v33: Poetry Short

A poem, sung by ACE-Step 1.5, timed line by line, cut to 4 to 8 slow cinematic scenes (LTX-2.3 image to
video) with each verse burned in as it is sung (Noto Nastaliq with aerab for Urdu). One page in the Video
studio, `/video/poetry`, and one resumable stage job.

## 1. Stages

`poem → song → timing → scenes → render`. One `poetry_short` job (general lane) runs them; it enqueues the
GPU work as ordinary jobs pointing back at it and defers itself while they run (same pattern as the AI
video podcast). Stage records: `pending | running | review | done | skipped | failed`.

| stage | what happens | review |
|---|---|---|
| poem | The lyrics writer (`/audio/lyrics` prompt, sections by length) writes verses and a chorus, or the user's own poem is used. Arabic-script languages get the verified aerab pass. | yes |
| song | `generate` job, kind `song`, model `ace15_turbo`, the lyrics, style tags, vocal, `length_s`. A Library audio item; a re-sing is a new version of it. | yes |
| timing | `poetry_timing` job (audio lane): vocal stem split, energy regions, Whisper word times; lines fitted in order (see 2). | yes |
| scenes | LLM writes one image and one motion prompt per scene; a keyframe (`generate`, kind `image`) then a clip (`generate`, kind `video`, LTX-2.3 i2v, first frame = keyframe) per scene. | yes |
| render | `poetry_render` job (general lane, ffmpeg): the story-video assembly (`app/montage.py`). | no |

With `review: false` the job runs straight through to the video (one click). With `review: true` (default)
it stops after each of the first four; `POST /continue` approves the one under review.

Two tries each (first plus one re-roll) for the song, every keyframe and every clip. A scene that still
fails stops the scenes stage with the scene numbers; `POST /continue` tries again. If the timing job fails
twice the lines are spread evenly and the timing review says so.

## 2. Line timing

`timing.source`:

- `whisper`: the heard words match the poem (aerab ignored) at a ratio of 0.5 or more and cover at least 70 %
  of the lines; each line runs from its first to its last matched word, missed lines share the gap.
- `phrases`: line ends go into pauses between sung regions. With at least as many pauses as line breaks, the
  pauses closest to a length-weighted split (letters per line) are chosen, in order; with fewer pauses, those
  near a break are used and the rest is split by length inside the regions.
- `even`: no usable pause (one long region, or nothing found): equal shares over the sung regions (the whole
  song when nothing was found).

Lines never overlap, are at least 0.5 s where there's room, and stay inside the song. User edits:
`timing.edited: true`; only the cut is redone.

## 3. Scenes

`round(song_s / 9)` scenes, 4 to 8 (never more than the lines), each starting on a line. Scene windows follow
the current timings: scene 1 starts at 0, each runs to the next scene's first line, the last to the end of the
song. Clip length = window + 0.4 s (the cross-fade) except the last; over one LTX pass (10.67 s) it is a long
take. `quality: final` uses LTX-2.3 HQ for single-pass scenes.

Keyframes: `image_model` (`krea2_turbo` default, `qwen_image_2512`, `zimage_turbo`) at the aspect's ~1 MP
size. With `character_id`, the edit model with one sheet panel as the reference, picked the way a storyboard
shot picks it (`storyboard.character_ref`: "seen from behind" → the back turn, and so on, else the approved
portrait). Every keyframe prompt carries the same person and setting sentences.

Keyframes and clips are `Generation(target_type="poetry_scene", target_id=<scene id>)`.

## 4. Render

Per scene: its clip trimmed, slowed (up to 15 %) or held to fit, cover-cropped to 1080x1920 (9:16),
1920x1080 (16:9) or 1080x1080 (1:1), 30 fps; a scene without a clip uses its keyframe with the slow zoom.
0.4 s cross-fades, the song underneath with a short fade at the end, one caption per line fading in
(`subtitles.burn(fade=0.45)`, libass; the Pillow fallback cuts them in), chapters per verse and chorus.
`title_card: true` puts 3 s of the title over the first keyframe before the song.

Output: a new version of the Short's Library video item (tags `poetry`, `short`), plus
`<generation id>.srt` and `<generation id>_preview.mp4` (360x640, ~0.5 Mbit/s) in
`workspaces/<ws>/poetry/<short id>/`, served through `/api/media/...`.

## 5. Routes

All under `/api/poetry`; editor role for writes, tokens need `generate` for writes and `read` for reads.

| method | path | body | answer |
|---|---|---|---|
| POST | `` | CreateIn | 201 Short (its job queued) |
| GET | `` | | list of summaries |
| GET | `/{id}` | | Short |
| DELETE | `/{id}` | | 204 (song and videos stay in the Library) |
| PATCH | `/{id}/poem` | `{lyrics, title?}` | Short; after the song exists this resets song, timing, scenes, render |
| PATCH | `/{id}/timings` | `{lines: [{start, end}]}` one per line | Short; 422 with "Line 2 starts before line 1 ends" and the like; render goes back to pending |
| PATCH | `/{id}/scenes` | `{scenes: [{id, image_prompt?, motion_prompt?}]}` | Short (prompts saved for the next regenerate) |
| POST | `/{id}/continue` | | 202 Job; approves the stage under review, retries a failed one |
| POST | `/{id}/scenes/{scene_id}/regenerate` | `{what: keyframe \| clip, image_prompt?, motion_prompt?}` | 202 Short; only that scene is remade, then the scenes review |
| POST | `/{id}/song/regenerate` | | 202 Job; new song version, timing again, scenes kept |
| POST | `/{id}/render` | | 202 Job; 409 until poem, song, timing and scenes are done |

Every write answers 409 while the Short's job is queued or running. Cancel and retry go through
`/api/jobs/{id}/cancel|retry` (cancel takes the waiting children too).

CreateIn: `title`, `topic` or `poem` (one is required), `language` (`ur` default), `mood`, `style`,
`vocal` (`female` / `male`), `length_s` 30–90 (60), `character_id` (Character Studio) or `character`
(description), `setting`, `aspect` (`9:16` default, `16:9`, `1:1`), `quality` (`draft` / `final`),
`image_model`, `title_card`, `review` (true), `whisper` (true).

Short:

```json
{"id": "...", "title": "...", "language": "ur", "stage": "timing", "status": "review", "review": "timing",
 "stages": [{"key": "poem", "label": "Poem", "status": "done", "detail": null, "started_at": "...", "finished_at": "..."}],
 "settings": {"...": "CreateIn fields, plus person / place once the scenes are written"},
 "poem": {"lyrics": "[verse]\n...", "tags": "slow ghazal, harmonium", "own": false},
 "lines": [{"i": 0, "text": "...", "section": "verse", "part": "verse:1", "start": 1.2, "end": 4.8}],
 "song": {"media_id": "...", "duration_s": 60.0, "generation": {"...": "Generation"}},
 "timing": {"source": "phrases", "edited": false, "phrases": [[1.2, 4.9]], "separated": true},
 "scenes": [{"id": "...", "n": 1, "first": 0, "last": 2, "start": 0.0, "end": 9.4, "image_prompt": "...",
             "motion_prompt": "...", "status": "done", "error": null, "keyframe": {}, "clip": {}}],
 "outputs": {"media_id": "...", "generation_id": "...", "duration_s": 60.0, "width": 1080, "height": 1920,
             "chapters": [{"title": "Verse 1", "start": 0, "end": 14.2}], "video_url": "/api/media/...",
             "preview_url": "...", "srt_url": "...", "stale": false},
 "job": {"...": "Job"}}
```

`status`: `running | review | failed | done | idle`. Scene `status`: `pending | keyframe | clip | done | failed`.
`outputs.stale` is true when timings or scenes changed after the last cut.

## 6. Jobs and lanes

| type | lane | ledger |
|---|---|---|
| `poetry_short` | general | `autopilot` (0 GPU s; children bill their own) |
| `poetry_timing` | audio | GPU time |
| `poetry_render` | general | `assembly` (0 GPU s) |

## 7. UI

Video studio → Poetry Short (`/video/poetry`): a form (topic or own poem with Add aerab, language, mood,
style, voice, length, character or description, setting, shape, picture model, quality, title card, "Let me
check each step") and the list of Shorts. `/video/poetry/:id`: stepper Poem → Song → Timing → Scenes → Render
with the stage timeline, a review banner, the step gate and approve-and-continue. Timing: per-line start/end
nudges (0.1 s), play from a line, tap to time while it plays. Scenes: keyframe/clip grid, edit the prompt,
"New picture" / "New motion" per scene. Render: preview player, download, .srt, cut again. Poem and lines are
`dir="auto"` with the Short's `lang`.
