---
title: "Contract v28: Story API for BlogCreatorPro (FEAT-018)"
status: Active
created: 2026-10-14
extends: contract-v27 (token API), contract-v16 (speech engines), contract-v20 (podcast bed and ducking), contract-v24a (burned subtitles)
draft: blogcreatorpro/docs/design/mixai-story-api.md
---

# Contract v28: Story API

BlogCreatorPro (BCP) sends a written, illustrated story book and gets back a narrated audiobook and
read-along videos. Calls use the token API (contract v27): `Authorization: Bearer mxa_…`, the `generate`
scope for the two POSTs, `read` for the GETs. Both POSTs start **one job** and answer
`202 {"job": JobOut}`. Poll `GET /api/jobs/{id}`: `status` is `queued`, `running`, `done`, `failed` or
`cancelled`; `progress` runs 0 to 1; `message` is meant for people ("Speaking page 4 of 25"); `error` says
why it failed; `result` (below) is set when it is done.

## Voices and licences

The work is commercial, so only engines whose weights allow commercial use are accepted:

| `engine` | Weights | Notes |
|---|---|---|
| `voxcpm` (VoxCPM2) | Apache-2.0 | **The default.** Designed voices: the description plus a seed |
| `chatterbox` | MIT | Output carries a Perth watermark. It has no voice design: the seed is used, the description is not |
| `kokoro` | Apache-2.0 | Preset voices (`preset`, e.g. `bf_emma`) |
| `omnivoice` | **CC-BY-NC** | **422** on these routes, always |

OmniVoice's licence label now reads "CC-BY-NC (weights, non-commercial); code Apache-2.0" everywhere.

### `AUDIO_ALLOW_NONCOMMERCIAL` (app-wide)

Default `true` (nothing changes while testing). With `false`:
- OmniVoice is left out of `GET /api/voices/engines` and refused with 422 wherever it is named (speak, design
  preview, dialogue, dub, library voices designed on it).
- "auto" and every built-in default fall back to `voxcpm` (character voice design included).
- Gallery voices built on OmniVoice disappear from `GET /api/voices/gallery`; `gallery:<id>` for one is a 422.
- MiniMax-Music3 is hidden and refused, as before (this setting already covered it; its default used to be
  `false`).

`GET /api/voices/engines` rows carry `"noncommercial": true` for OmniVoice.

## 1. `POST /api/stories/audio`

```json
{
  "language": "en",
  "engine": "voxcpm",
  "cast": {
    "narrator": {"design": {"description": "warm, gentle British storyteller, female, 40s", "seed": 123}},
    "Pip":      {"design": {"description": "small excited boy, about 6, high bright voice", "seed": 456}}
  },
  "pages": [
    {"key": "p1", "lines": [
      {"speaker": "narrator", "text": "Pip ran to the window.", "emotion": null},
      {"speaker": "Pip", "text": "\"It's snowing!\"", "emotion": "excited"}
    ]}
  ],
  "music": {"prompt": "soft lullaby, music box and strings, calm, no vocals", "model": "ace15", "level": "soft"},
  "gap_line": 0.35,
  "gap_page": 1.2,
  "check": true
}
```

| Field | Rule |
|---|---|
| `language` | Default `en`. Must be one the engine speaks (422 names one that does) |
| `engine` | `voxcpm` (default), `chatterbox`, `kokoro`; `omnivoice` → 422 |
| `cast` | 1–13 speakers, name ≤ 60 characters. Each is exactly one of `design{description 1–500, seed?}` (voxcpm, chatterbox) or `preset` (kokoro, a Kokoro voice in `language`). A missing seed is picked once and reported in `seeds` |
| `pages` | 1–200; `key` 1–60 of `A-Z a-z 0-9 _ -`, unique (it names the page file) |
| `lines` | 1–60 per page; `text` 1–1,000; `speaker` must be a `cast` key |
| `emotion` | `null`, `happy`, `sad`, `excited`, `scared`, `angry`, `whisper`, `calm`. VoxCPM2: a hint added to the speaker's description for that line. Chatterbox: the exaggeration knob (whisper/calm 0.3 … angry 1.2). Kokoro: ignored |
| `music` | Optional. `model` `ace15` (ACE-Step 1.5, sung with no lyrics, so instrumental) or `sa3` (Stable Audio 3 music); `level` `off`, `soft` (bed ~22 dB under the voice, default) or `normal` (~16 dB) |
| `gap_line` | 0–5 s, default 0.35 |
| `gap_page` | 0–10 s, default 1.2 |
| `check` | Default `false` |

### The job (`story_audio`, audio lane)

1. With music: the bed is queued as an ordinary music generation (it lands in the Library, tagged `story`)
   the moment the request comes in, so it can render on the other GPU while the book is spoken.
2. Every line of the book goes to the engine in **one runner call** (one model load), each line with its
   speaker's seed and voice (`per_segment`). The runner reports each line; the job message is
   "Speaking page n of m". `ensure_vram` frees ComfyUI memory first when the card is too full.
3. Each page: its lines back to back with `gap_line` between. Written as `<key>.mp3`, 192k mono 44.1 kHz,
   voice only.
4. `full.mp3`: the pages back to back, each followed by `gap_page`. One gain brings the whole book to
   −16 LUFS (−1 dBFS limiter) and the same gain goes on every page file, so a page sounds exactly like its
   stretch of the book.
5. `check`: faster-whisper (large-v3) transcribes every page in one runner call; `match` is the word-level
   similarity (lower case, punctuation removed, `SequenceMatcher` ratio) between the page text and what it
   heard, 0 to 1.
6. Music: when the bed's generation hasn't finished, the job steps back into the queue ("Waiting for the
   music bed") and comes back without speaking the book again. The bed is looped to the book's length
   (cross-faded seams), set under the voice, ducked while anyone speaks (the podcast bed graph:
   `sidechaincompress`, 8 dB), faded in (1.5 s) and out (2 s), and the mix is levelled to −16 LUFS:
   `full_music.mp3`, 192k stereo 44.1 kHz.

### Result

```json
{
  "pages": [{"key": "p1", "file": "p1.mp3", "duration": 6.42,
             "lines": [{"start": 0.0, "end": 1.9, "speaker": "narrator", "text": "Pip ran to the window."}],
             "match": 0.97}],
  "full": {"file": "full.mp3", "duration": 212.4,
           "pages": [{"key": "p1", "start": 0.0, "end": 7.62}]},
  "full_music": {"file": "full_music.mp3"},
  "engine": "voxcpm",
  "seeds": {"narrator": 123, "Pip": 456}
}
```

- Line times are seconds within the page; `pages[].duration` is the page file (no `gap_page`).
- `full.pages` are seconds within the book and run end to start: each page's span includes its `gap_page`.
- `match` only when `check` was on. `full_music` only when there was music (not `off`).
- `seeds` lists the designed voices (Kokoro presets have none).
- `warnings: [..]` appears only when the music bed failed; the narration is still delivered.

## 2. `POST /api/stories/video`

```json
{
  "audio_job": "<id of a finished story_audio job>",
  "aspect": "16:9",
  "use_music": true,
  "pages": [{"key": "p1", "media_id": "<Library item id from POST /api/media/upload>"}],
  "title_card": {"media_id": "…", "title": "Pip and the First Snow", "seconds": 4},
  "end_card": {"text": "The End", "seconds": 4},
  "captions": true,
  "max_seconds": null
}
```

| Field | Rule |
|---|---|
| `audio_job` | A `story_audio` job of this workspace: 404 when it isn't one, 409 until it is `done` |
| `aspect` | `16:9` (1920×1080, default) or `9:16` (1080×1920) |
| `use_music` | Default `true`: `full_music.mp3`, else `full.mp3`. 422 when the narration has no music |
| `pages` | `{key, media_id}`; each key must be in the audio job, once. Every page that ends up in the video needs a picture (any finished Library image; BCP uploads JPEG ≤ 1920 px) |
| `title_card` | **Optional.** `title` 1–200, `seconds` 1–15 (default 4), `media_id` optional (the first page's picture otherwise) |
| `end_card` | Optional. `text` (default "The End"), `seconds` 1–15 (default 5) |
| `captions` | Default `true` |
| `max_seconds` | Optional, 5 – 14,400. A Short: whole pages from the start while title card + those pages + end card fit; 422 when not even the first page does |

BCP sends no `title_card`: its title and end pages arrive as normal audio pages.

### The job (`story_video`, general lane, ffmpeg)

- Each page is on screen exactly as long as its span in `full.pages` (audio plus its `gap_page`).
  - 16:9: the picture fitted on a blurred, darkened copy of itself.
  - 9:16: the picture (on its own blurred copy) in the top 60%; the bottom 40% is the caption area.
  - A slow zoom 1.00 → 1.06 on every page and the title card; 0.4 s cross-fades between all parts
    (each part runs 0.4 s long into the next, so the page starts stay on the narration's clock).
- Captions: one per line, from the line times, burned through `subtitles.burn` (Noto fonts, libass with
  HarfBuzz shaping or the Pillow fallback; Swedish and Arabic-script text included), bigger than the app's
  usual subtitles and wrapped at 22 characters on 9:16.
- Title card: the cover with the title on a rounded dark band (16:9) or in the caption area (9:16); the
  narration starts when it ends, fading in over its first second.
- End card: plain Atelier ground with the text; the audio is silent under it.
- Audio: trimmed at the last page for a Short, with a 0.6 s fade-out.
- Output: H.264 yuv420p, `+faststart`, 30 fps, AAC 192k; MP4 chapters (one per page, titled with its key);
  an `.srt` of the captions next to it (always written, captions on or off).

### Result

```json
{"file": "story_16x9.mp4", "duration": 221.4, "width": 1920, "height": 1080,
 "chapters": [{"key": "p1", "start": 4.0}], "srt": "story_16x9.srt"}
```

`chapters[].start` is each page's start in the video (BCP builds the YouTube chapters from it). The 9:16 files
are `story_9x16.mp4` / `.srt`. `fonts_missing` appears when a caption font wasn't installed.

## 3. `GET /api/stories/{job_id}/files/{name}`

`read` scope. `name` is exactly a file value from the job's result (`p1.mp3`, `full.mp3`, `full_music.mp3`,
`story_16x9.mp4`, `story_16x9.srt`…). Anything else, another workspace's job, a job that isn't a story or
isn't done: **404**. The path is also checked to stay inside the job's folder.

Files live in `workspaces/<ws>/stories/<job_id>/` and are **deleted after 7 days** (swept whenever a story
job starts in that workspace); after that the route answers 404 and a video of that narration fails with a
readable error.

## Changes from the draft

1. `title_card` and `end_card` are optional; `title_card.media_id` is optional too (first page's picture).
2. `chatterbox` accepts `design` but only its seed matters (Chatterbox has no voice design and this API
   takes no reference clip). The draft tied `design` to voxcpm only.
3. `full_music` is left out of the result when there's no music (instead of `null`), and `warnings` is added
   if the bed failed.
4. `pages[].duration` excludes `gap_page`; `full.pages` spans include it (as in the draft's example numbers).
5. Captions sit in a box with square corners: libass draws `BorderStyle 3` boxes square. The title band is
   rounded.
6. Downloads: the `/api/stories/{job_id}/files/{name}` route only; no Library items or signed links (signed
   links live ten minutes, too short to keep in a job result).
7. No MCP tools for stories yet.
8. `AUDIO_ALLOW_NONCOMMERCIAL` already existed (for MiniMax-Music3, default `false`); it now also governs
   OmniVoice and its default is `true`. A server whose `.env` says `AUDIO_ALLOW_NONCOMMERCIAL=false` now
   also loses OmniVoice (Urdu, Punjabi, Sindhi and Pashto speech then have no engine).

## Addendum (v28a): video pages

Asked for by BCP, owner-approved. Request and result shapes, captions, chapters, title and end pages are
unchanged.

- `pages[].media_id` may be a **video** Library item (the item id from `POST /api/videos/generate` →
  `items[0].id`, or an uploaded clip) as well as a picture. It must be in the workspace and finished
  (`ready` / `approved`); anything else (audio, missing, still rendering) is a **422** naming the page.
  Stills and clips can be mixed freely in one story.
- A video page lasts exactly its span, as a still does:
  - longer clip: trimmed, keeping the start;
  - shorter clip: slowed down when ≤ 15% covers the gap (no freeze at all), otherwise played at normal
    speed and held on its last frame (`tpad stop_mode=clone`) for the rest.
  - The clip's own sound is dropped; no zoom; the 0.4 s cross-fades between parts are unchanged.
  - Any size is scaled and centre-cropped to cover the frame (e.g. LTX 1344×768 into 1920×1080), no blurred
    background; 30 fps, yuv420p.
- Stills whose shape is within 3% of the frame (16:9 into 16:9, 9:16 into 9:16) now fill it (cover crop)
  instead of sitting on their blurred copy; on 9:16 that also drops the top-60% layout, and the captions sit
  over the picture as on 16:9. Other stills keep the old layouts.
- With no `title_card.media_id` and a video first page, the title card uses the clip's first frame. A
  `title_card.media_id` itself must still be a picture.

### Changes from the draft

1. Short clips: one treatment per clip, not both. Slowing by up to 15% is used only when it covers the whole
   gap; when it can't, the clip plays at normal speed and then holds (a slowed clip that still freezes looked
   worse than a plain hold).
2. On a full-frame 9:16 title card the title sits on the rounded dark band (there's no caption area under
   the picture to put it in).

## Tests

`backend/tests/test_stories.py` (v28a): `video_clip` held / slowed / trimmed to the exact length, 1920×1080,
30 fps, no audio; matching-aspect stills fill the frame and others keep the old layouts; a 16:9 story with a
still and a held clip and a 9:16 one with a trimmed 768×1344 clip first (title card from its frame) and a
full-frame 9:16 still (duration, size, chapters); an audio item or unknown id as a page → 422. Clips are made
with ffmpeg `lavfi`; these tests skip when ffmpeg isn't available.

`backend/tests/test_stories.py`: generate token posts / read-only token gets 403; OmniVoice 422; validation
limits; a faked `venv_runner.run` producing page files, line times, `full` page offsets, one runner call
with per-line seeds, the ducking graph and `match`; real ffmpeg (imageio-ffmpeg locally) for a two-page
16:9 and a 9:16 Short with `max_seconds` (duration, size, chapters); the download whitelist, traversal,
workspace and 7-day sweep; `AUDIO_ALLOW_NONCOMMERCIAL=false` hiding/refusing OmniVoice and switching the
default.
