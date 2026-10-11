# API contract v20: Podcast Studio (M11c / C2)

Migration **0016** adds `podcast_show` and `podcast_episode`. It builds on v17 (Dialogue: an episode's script is a `VoiceScript`), v16 (voices and speech, including `gallery:<id>` voice ids from v19), v15 (mixdown ducking and loudness) and v18 (SRT formatting).

New backend dependencies: `pypdf` and `python-docx` (document text for the Source step). When either is missing, uploading that type answers 422 "PDF support isn't installed" (or Word); text and Markdown always work.

## Shows
`ShowOut`: `{id, name, description, author, language, cover_media_id?, cover_url?, hosts, music, ads, episodes, created_at, updated_at}`
- `hosts`: default hosts copied into a new episode (same shape as an episode's hosts, below).
- `music`: `{intro_media_id?, outro_media_id?, bed_media_id?}`, the default Produce music.
- `ads`: the ad library, `[{id, name, kind: "jingle" | "sponsor", media_id?, text?, host_id?}]`. A jingle (or a recorded sponsor spot) is a Library audio item; a sponsor read with `text` and no `media_id` is voiced by a host when it's inserted.
- `episodes`: how many episodes the show has.

| Method | Path | Notes |
|---|---|---|
| GET | `/podcast/shows` | Newest first |
| POST | `/podcast/shows` | `{name, language?, description?, author?, cover_media_id?, hosts?, music?, ads?}` |
| GET · PATCH · DELETE | `/podcast/shows/{id}` | PATCH is partial (`ads` and `hosts` are whole arrays). Deleting a show keeps its episodes (they lose the show). |
| POST | `/podcast/shows/{id}/ads` | `{name, kind, media_id?, text?, host_id?}` adds one ad; returns the show |
| DELETE | `/podcast/shows/{id}/ads/{ad_id}` | returns the show |

## Episodes
`EpisodeOut`:
- `{id, show_id?, show_name?, title, format, language, target_minutes, step, sources, hosts, chapters, script_id?, settings, notes?, outputs, jobs, words, minutes, created_at, updated_at}`
- `format`: `interview | conversation | debate | solo | news | storytelling | qa`
- `sources`: `{topic, text, docs: [{id, name, type, chars, pages?}], has_script}`. The extracted document text stays on the server.
- `hosts`: 1–4 of `{id, name, role: host | cohost | guest | narrator, persona, voice_id?, me}`. A host's `id` is its cast id in the script. `voice_id` is any voice id `/audio/speak` takes (a library voice or `gallery:<id>`); it's passed through unchanged. `me: true` means the user records that host's lines.
- `chapters`: `[{id, title}]`, in order. Script lines point at them with `chapter_id`.
- `settings` (Produce):
  ```
  {intro: {media_id?, lead_s: 4, overlap_s: 3, gain_db: 0},
   outro: {media_id?, overlap_s: 2, gain_db: 0, max_s: 30},
   bed: {media_id?, gain_db: -20},
   duck_db: 12, gap_s: 0.35, chapter_gap_s: 1.0,
   loudness: "stereo" | "mono" | "none"}
  ```
  `stereo` is −16 LUFS, `mono` is −19 LUFS (mono file), and both cap the true peak at −1 dBTP.
- `notes`: `{description, key_points: [], chapters: [{title, start}]}` or null. It's editable with PATCH.
- `outputs`:
  - `mix`: `{media_id, generation_id, url, duration_s, built_at, stale, timeline, chapters}`, the last good mixed master (one Library audio item, a new version each mix).
    - `timeline`: `[{line_id, kind, speaker_id, name, text, start, end, chapter_id?}]` in seconds on the master.
    - `chapters`: `[{id, title, start, end}]`.
  - `publish`: `{media_id, generation_id, url, format: "mp3" | "m4a", built_at}`, the tagged file (a second Library audio item).
  - `video`: `{media_id, generation_id, url, aspect: "16:9" | "1:1", burned: bool, built_at}`, a Library video.
- `jobs`: `{write?, mix?, publish?, video?}`, the last job of each kind (`JobOut`), so the stepper can follow them.
- `words` / `minutes`: the script's word count and its length at about 150 words a minute.

| Method | Path | Notes |
|---|---|---|
| GET | `/podcast/episodes?show_id=` | Newest first |
| POST | `/podcast/episodes` | `{title, show_id?, format?, language?, target_minutes?, hosts?}`. Hosts default to the show's. |
| GET · PATCH · DELETE | `/podcast/episodes/{id}` | PATCH: `title, format, language, target_minutes, step, sources {topic?, text?}, hosts, chapters, settings, notes, show_id`. Changing hosts updates the script's cast (names, voices) and turns a "me" host's lines into recording lines. Deleting keeps the script and every Library item. |
| POST | `/podcast/episodes/{id}/sources` | multipart `file` (`.txt`, `.md`, `.pdf`, `.docx`, at most 20 MB and 400,000 characters of text). Returns the episode. |
| DELETE | `/podcast/episodes/{id}/sources/{doc_id}` | |
| POST | `/podcast/episodes/{id}/script` | `{text}` "I have a script". `HOST: words` lines (B3 split, `lines` mode), `# Title` lines start a chapter. Unknown names become hosts (up to 4). Replaces the script's lines. |
| POST | `/podcast/episodes/{id}/write` | 202 job `podcast_write`. The LLM writes the episode from the topic and material. |
| POST | `/podcast/episodes/{id}/edit-lines` | `{op: "rewrite_chapter" \| "shorter" \| "livelier", line_ids?, chapter_id?, note?}` 202 job `podcast_write`. It replaces those lines (or the whole chapter). |
| POST | `/podcast/episodes/{id}/render` | `{line_ids?}`, the same as `/scripts/{id}/render`. Recording, break, music and ad lines with a clip are never sent to TTS. |
| POST | `/podcast/episodes/{id}/record-line` | `{line_id, media_id}`. A Library audio clip becomes that line's take (the line turns `kind: "recording"`). The clip is hidden from the Library like any take. |
| POST | `/podcast/episodes/{id}/insert` | `{kind: "ad" \| "music" \| "break", after_line_id?, ad_id?, media_id?, seconds?, speaker_id?, text?}`. `after_line_id` null means the very start. An ad from the library with only text becomes a speech line for its host. |
| POST | `/podcast/episodes/{id}/mix` | 202 job `podcast_mix`. Returns 409 while any line isn't ready. |
| POST | `/podcast/episodes/{id}/notes` | 202 job `podcast_write` (`op: notes`). Show notes need a mix (for the timestamps). |
| POST | `/podcast/episodes/{id}/publish` | `{format: "mp3" \| "m4a", cover_media_id?, notes: true}` 202 job `podcast_publish` |
| POST | `/podcast/episodes/{id}/video` | `{aspect: "16:9" \| "1:1", burn_subtitles: true, cover_media_id?}` 202 job `podcast_video` |
| GET | `/podcast/episodes/{id}/outputs` | `{mix, publish, video, notes, srt_url, notes_url}` |
| GET | `/podcast/episodes/{id}/subtitles.srt` | SRT built from the mix timeline (no Whisper pass) |
| GET | `/podcast/episodes/{id}/notes.md` | Show notes as Markdown |

All four jobs run on the **general** lane.

## Script lines (additions to v17)
Lines are JSON, so no migration is needed. These fields are additive:
- `kind`: `speech` (the default when it's missing) `| recording | break | ad | music`
- `media_id`: the clip for `recording`, `ad` and `music` lines. A line with a clip uses that clip's generation as its take: its status is `ready` as soon as the clip is, and `render` never queues it.
- `chapter_id`: the episode chapter the line belongs to.
- A `break` line is silence of `pause_after_s` seconds (1 s if that isn't set). An `ad` line without a clip is a sponsor read and is rendered as speech.
- The Dialogue mix (`/scripts/{id}/mix`) plays clips in order and turns breaks into extra gap.

## Writer
- One JSON answer `{title, chapters: [{title, lines: [{host, text}]}]}` for episodes up to 6 minutes. Longer episodes get an outline first (`{title, chapters: [{title, beats}]}`), then one call per chapter.
- The prompt uses the format, the language (Urdu is written in Urdu script; aerab is added when it's voiced), about 150 words a minute of the target length, and each host's name, role and persona.
- **Material** (pasted text and documents) grounds the script. Over 12,000 characters, it's cut into chunks, each one is summarised, and the summaries are used instead.
- Show notes: the LLM writes the description and key points. Chapter timestamps come from the mix.

## Produce (the `podcast_mix` job)
1. The script's playable lines (speech takes, recordings, ad and music clips) are joined in order. Gaps come from the line or the settings, a chapter change adds `chapter_gap_s`, and breaks add their seconds.
2. The intro plays alone for `lead_s`, then carries on under the first lines for `overlap_s` and fades.
3. The bed (looped) runs under the voice. The outro starts `overlap_s` before the voice ends.
4. Every music lane is ducked under the voice by `duck_db` with the B1 sidechain (`mixdown.duck_mix`).
5. Two-pass loudnorm to the preset, then a true-peak limit. The master is FLAC.

## Publish
- **MP3** (192k, ID3v2.3) or **M4A** (AAC 192k), with title, show (album), author (artist), genre Podcast, the description as the comment, cover art (the episode's cover, else the show's), and **chapters** from an ffmetadata file (`[CHAPTER]` entries; MP3 gets ID3 CHAP frames).
- **SRT**: one cue per line from the timeline, wrapped with the v18 rules and split at 7 s.
- **Video podcast**: 1920×1080 (16:9) or 1080×1080 (1:1), at 25 fps. It shows the cover art on a dark ground, an ffmpeg `showwaves` waveform, the speaker's name per line, and burned subtitles (libass). When the `subtitles` filter isn't in the ffmpeg build, the video is made without them and `burned` is false. It's saved as a Library video (a new version each time).

## As built (C2)
- `EpisodeOut` also has `cover_media_id` / `cover_url` (the episode's own cover; publishing falls back to the show's, then to a lettered cover) and `counts` (the script's line counts, as in v17).
- `POST /podcast/episodes` also takes `topic`.
- The speaker's name on the video is a small Pillow-drawn label per speaker (Urdu shaped the same way as brand cards), overlaid while that speaker talks, rather than `drawtext`: it needs no fontconfig and joins Urdu letters properly.
- The Dialogue editor saves `kind`, `media_id` and `chapter_id` with each line, so editing a podcast's script there keeps its recordings and chapters.
- Frontend: `/audio/podcast` (shows and episodes) and `/audio/podcast/:id` (the six-step stepper, as tabs: arrow keys, Home and End). `LineList` takes optional `selection` (tick boxes) and `offset` (numbering across chapters). `Recorder` takes optional `limits` and `hint` (a podcast line can be 0.5 s to 3 min). The Music page shows a "Back to the podcast episode" link for `?from=podcast&episode=<id>`.
