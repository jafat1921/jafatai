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
| `omnivoice` | **CC-BY-NC** | Accepted only while `AUDIO_ALLOW_NONCOMMERCIAL` is on; see v28c |

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

## Addendum (v28b): preview copy
- The story video result has `preview`: the same video at 640×360 (16:9) or 360×640 (9:16), H.264 + AAC at about 0.5 Mbit/s with `+faststart`, e.g. `story_16x9_preview.mp4`. It downloads through the same files route.
- `GET /api/stories/{job_id}/files/{name}` honours `Range` (206 Partial Content), so players can seek and interrupted downloads can resume.
- The Caddy example (`deploy/Caddyfile.mixai`) compresses text types only, so media is passed through as-is.

## Addendum (v28c): Urdu narration

Owner-approved 2026-10-15. Everything above stands except where listed here.

### OmniVoice on `POST /api/stories/audio`

- `engine: "omnivoice"` is accepted while `AUDIO_ALLOW_NONCOMMERCIAL` is on (the server default). With it
  off the answer is **422** `"OmniVoice isn't available on this server"`, and the list of engines in the
  unknown-engine 422 leaves it out.
- `language`: OmniVoice takes any well-formed code (it speaks 600+ languages), so `ur`, `pa`, `sd`, `ps`
  and the rest go through. The other engines keep their lists; `chatterbox` + `ur` is still a 422, which
  now names OmniVoice as the engine that speaks it.
- `cast`: each speaker is `design{description, seed?}` (a `preset` is a 422). The description is read the
  way `POST /api/audio/speak` reads it: cut down to OmniVoice's own attributes (gender, age, pitch, accent,
  whisper), e.g. "warm elderly Lahori narrator, female" becomes "female, elderly, indian accent". The seed
  keeps each speaker the same person across the book. Still **one runner call per book** (one model load),
  each line with its speaker's seed and voice.
- `emotion` on OmniVoice: `whisper` adds the whisper attribute for that line; the others are ignored
  (OmniVoice's design list has no other delivery).
- The result carries `"licence": "non-commercial"` when OmniVoice spoke the book. It is absent for
  `voxcpm`, `chatterbox` and `kokoro`.

### `aerab` on the request

`aerab: bool`, default `true`, as on `POST /api/audio/speak`.

- Lines in `ur`, `ar`, `fa`, `ps`, `sd`, `pnb` that carry no marks get aerab / tashkeel before they are
  spoken, through the app's verified pass: the LLM only proposes the marks, they are moved onto the
  writer's own letters, and a line whose letters it changed is spoken as written.
- A line that already carries marks is left exactly as sent.
- The unmarked lines of the whole book go to the LLM together, 40 lines a call (a 30-page, 300-line book
  is about 8 calls, not 300, plus a short strict retry for any line still sparsely marked).
- `pages[].lines[].text` in the result is the text as spoken, marked, so the story video's captions (and
  its `.srt`) show the aerab. Lines that needed nothing come back as sent.
- `aerab: false` speaks every line exactly as written. With the LLM unreachable the book is still
  narrated, unmarked.
- `check`: `match` ignores the marks (Whisper never writes them).

### Questions from the draft

(a) **Marking prose yourself.** `POST /api/text/aerab` with `{"text": "…" (1–60,000 characters),
"language": "ur" | null}` (null or `"auto"`: the letters decide) answers `TextAerabOut`:
`{"text", "marked", "kept", "low_coverage", "language"}`. `marked` counts lines that got marks, `kept`
lines left as written because the marking pass changed their letters, `low_coverage` lines still sparsely
marked after the strict retry. Use it for prose; `POST /api/audio/lyrics/aerab` is for lyrics (≤ 6,000
characters, `{"lyrics"}`). A text with no Arabic-script lines is a 422; the LLM offline is a 503.

(b) **Scope.** Both `POST /api/stories/audio` and `POST /api/text/aerab` need the token's `generate`
scope (every POST does); `read` is enough for `GET /api/jobs/{id}` and the files route.

(c) **Timing.** Measure on the server. The code has no per-line estimate for OmniVoice; the only number is
the runner's time limit (600 s + 20 s a line), which is a ceiling, not a forecast.

### Changes from the draft

1. OmniVoice was a 422 on the story routes, always; it is now accepted behind `AUDIO_ALLOW_NONCOMMERCIAL`,
   with the neutral 422 wording when the switch is off (no licence text in the message).
2. `licence` is a new, optional result field, set only for OmniVoice.
3. `aerab` is a new request field (default `true`). Before v28c every Arabic-script line was sent for
   marks, marked or not, and the result kept the text as sent; now only unmarked lines are marked and the
   result returns the marked text.
4. Aerab runs over the whole book at once (40 lines a call) rather than a call per page: fewer calls for
   the same result.

### Tests

`backend/tests/test_stories.py` (v28c): OmniVoice accepted with the switch on and the neutral 422 with it
off; an Urdu book on OmniVoice with designed voices (one runner call, per-line seeds, instructs cut to
OmniVoice's attributes, whisper on one line) and the `licence` marker; no marker on VoxCPM2; the aerab
pass marking bare lines in one LLM call and leaving the writer's marked line alone, with the marked text in
the result; `aerab: false` making no LLM call; `match` ignoring marks. The LLM is the faked transport the
aerab tests use.

### Note (2026-10-15): aerab on prose, see v23b

- The marking pass now aligns the LLM's letters with the writer's and keeps the marks wherever they agree, so a line is no longer spoken bare because the model swapped one letter (ي for ی, a dropped ZWNJ, an added tatweel). Under 80% agreement the line is still spoken as written. The spoken letters are always the writer's own.
- Long lines go to the LLM sentence by sentence, about 700 characters a call, so a book is more, shorter calls than "40 lines a call" above; the text comes back with its spacing exactly as sent.
- For marking prose yourself, `POST /api/text/aerab` now answers within about 45 s with `complete` / `remaining_chars` (and `coverage`), and `POST /api/text/aerab/jobs` marks a whole book as a job (poll `GET /api/jobs/{id}`; `result` has the `TextAerabOut` fields). Answer (a) above stands otherwise.

## Addendum (v28d): pauses, bare pages, page effects

Four optional request fields; a request without them behaves exactly as before, and old jobs re-render the
same.

### `pause_after` on `POST /api/stories/audio`

`pages[].lines[].pause_after`: seconds of silence after that line, `0`–`10` (default `0`; outside the range is
a 422 naming `pause_after`). It goes after the line's audio and before whatever follows it: the next line's
`gap_line`, or, on a page's last line, the page's `gap_page`.

- `pages[].lines[].end` is still the end of the spoken audio; the pause is **not** inside it. The next line on
  the page starts `gap_line + pause_after` after it.
- The pause belongs to its page: a last-line pause is in the page file, so `pages[].duration` grows by it,
  and `full.pages[].end` (and so the next page's `start`) move by it. `full.pages` spans still include
  `gap_page` as well.
- Everything later shifts with it: later line times are page-relative (unchanged by a pause on another page),
  `full.duration` grows by the sum of all pauses, and in the story video the page's span, chapter starts,
  burned captions and the `.srt` all follow the new spans. A caption ends with its line's audio, so it is
  off screen during the pause.

### `captions` on a video page

`pages[].captions`: default `true`. `false`: that page has no caption box burned in; the rest of the video is
unchanged. The `.srt` keeps the page's lines (it is the full transcript, as with `captions: false` on the
whole video). The top-level `captions: false` still turns them off everywhere.

### `effect` on a video page

`pages[].effect`: `null` (default, the usual slow zoom 1.00 → 1.06), or

| `effect` | Still picture | Video clip |
|---|---|---|
| `welcome` | Grows from 0.85 to 1.0 over the first 0.6 s with a small overshoot (easeOutBack, peaks ≈ 1.015), then the usual slow zoom over the rest of the page | Nothing extra |
| `pop` | Quick 0.9 → 1.0 over 0.4 s with a soft bounce (≈ 1.006), then holds still | Nothing extra |
| `reveal` | Fades in from white over 0.5 s, then holds still | Fades in from white over 0.5 s |
| `fade` | No zoom; comes in on the usual 0.4 s cross-fade (from black when it is the very first part) | Same |

While a welcome or pop picture is smaller than the frame, the border is the Atelier ground colour. All of
it is in the same one-pass ffmpeg graph per page (`zoompan` on the still padded by 1/0.85, plus `fade`), so a
page costs about what it did. The 0.4 s cross-fades between parts are unchanged for every effect. The
title and end cards keep their own looks.

### `audio_from` on `POST /api/stories/video`

`audio_from`: `"full"` (default) or `"pages"`.

- `"full"`: unchanged. The video runs on `full.mp3` / `full_music.mp3`, every page of the book, in the book's
  order.
- `"pages"` (trailer-style Shorts: non-consecutive pages such as `intro`, `title`, `p3`, `p5`, `p8`, `cta`):
  - The soundtrack is the sent pages' own files (`<key>.mp3`) joined **in the order sent**, each followed by
    the narration's `gap_page`. Only the sent pages play; a book page with no entry is left out.
  - Each page lasts its page `duration` + `gap_page` (a last-line `pause_after` is inside `duration`), so
    the video runs Σ(duration + gap_page) plus any title and end card.
  - Captions use each page's `lines[]` times moved to that page's new start (pauses kept); `chapters[].start`
    and the `.srt` use the new starts.
  - With `use_music: true` the narration's music bed (the same Library track) is looped with cross-faded
    seams to the new length and laid under it the way `full_music.mp3` was made (same level, ducking, fades,
    −16 LUFS). With `use_music: false` it is voice only.
  - `max_seconds` still keeps whole pages from the start of the **sent** order.
  - A sent page with no audio of its own (not in the audio job, or its file swept) is a **422** naming the
    page. `use_music: true` with no bed (or the bed's Library file gone) is a 422.

### Page keys

Keys are any 1–60 of `A-Z a-z 0-9 _ -`, as before: `intro`, `title`, `p1`…`pN`, `end`, `lesson`,
`q1`, `a1` … `q5`, `a5` all work. Nothing treats `p<n>` keys specially. The pages play in the order they
were sent to `POST /api/stories/audio` with `audio_from: "full"` (the video request's `pages` order doesn't
matter then) and in the video request's order with `"pages"`; the
chapters are named after the keys, and any page, `intro` included, may be a video clip (v28a).

### Tests

`backend/tests/test_stories.py` (v28d): `pause_after` keeps `lines[].end` and moves the next line, the page
duration, the page span, the next page and `full.duration` by the pauses; 0 and 10 accepted, −0.1 and 10.5 a
422; `intro`…`a5` keys narrated and planned in the caller's order; `burned_cues` drops only a bare page's
captions; the filter strings for each effect (and none on a clip for welcome/pop); a real 16:9 render with a
welcome clip first, welcome, pop, reveal and fade stills and a bare page (graphs, chapters, duration, the
`.srt` keeping the bare page's line). `audio_from: "pages"`: sent order kept, spans add up to the page
durations plus `gap_page`, captions moved to the new starts with a pause kept, chapters, the `max_seconds`
whole-page trim, a real 9:16 render over the bed, the 422 for a missing page or a swept page file, and
`"full"` giving the same plan as before.
