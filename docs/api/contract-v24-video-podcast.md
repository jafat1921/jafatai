---
title: "Contract v24: AI video podcast (VP1 + VP2)"
status: Active
created: 2026-10-11
extends: contract-v20-podcast.md, contract-v24a-subtitles.md
migration: 0017_video_podcast
plan: docs/PLAN-m11d-video-podcast.md
---

# Contract v24: AI video podcast

An episode with a mix becomes a multi-camera video: each host is a Character, they sit in a generated set,
a small library of camera angles is made once, and every line is a lip-synced take (LTX-2.3 image + audio
to video) cut to the mix timeline. The episode mix plays underneath, so the video is exactly as long as the
episode.

Migration **0017** adds `video_podcast`. Each one owns a hidden `Project` (`authoring_mode = "podcast"`)
that holds its Characters, the set Location, the angle keyframes and the takes, so generation, approval,
regenerate and the Library work as for any project. Podcast projects never appear in `GET /projects`, the
dashboard's recent projects or the @-mention project list.

The existing `POST /podcast/episodes/{id}/video` is still the **Audiogram** (v20 / v24a). The AI video lives
under `/podcast/ai-video`.

## Shapes

`VideoPodcastOut`:
```
{id, episode_id, project_id, title, language,
 stage,                 // the stage the pipeline is on: cast | set | keyframes | plan | render | assemble | done
 status,                // idle | running | review | failed
 review,                // "hosts" | "look" | null: the pipeline is waiting for the user to look and continue
 stages: [{key, label, status, detail, started_at, finished_at}],
                        // status: pending | running | review | done | failed | skipped
 settings, hosts, set, angles, plan, plan_stats,
 duration_s,            // the episode mix length (null before the mix)
 mix_stale,             // the mix changed after the plan was made: replan
 outputs: {draft: OutputOut | null, final: OutputOut | null},
 job: JobOut | null,    // the last orchestrator job
 eta_s: int | null, created_at, updated_at}
```

`settings`:
```
{aspect: "16:9" | "9:16" | "1:1",
 style: "realistic studio",
 subtitles: "none" | "soft" | "burn",
 set_preset: "modern_studio" | "cosy_room" | "news_desk" | "rooftop" | "desi_baithak",
 set_prompt: "",               // extra words for the set
 cover_intro: false, cover_outro: false,   // the show cover over the music intro / outro instead of the wide shot
 cover_media_id: null}         // else the episode's, else the show's cover
```

`hosts`: one per episode host, in the episode's order:
```
{host_id, name, role, persona,
 source: "persona" | "photo" | "existing",
 character_id, photo_media_id, photo_url, from_character_id,
 consent: {name, statement, at, user_id} | null,
 portrait: GenerationOut | null,      // approved, else the newest one (any status)
 sheet_views: {front?: GenerationOut, three_quarter?: GenerationOut}}
```

`set`: `{location_id, preset, prompt, description, establishing: GenerationOut | null}`.

`angles`: the angle library, per host `close` (close-up), `three_quarter` (3/4 close-up) and `listen`
(listening reaction), then shared `wide` and `medium` (two-shot; a three-shot with three hosts):
```
{key: "<host_id>:close" | "<host_id>:three_quarter" | "<host_id>:listen" | "wide" | "medium",
 label, host_id | null, shot_id, frame: GenerationOut | null}
```

`plan`: shots in time order, covering the whole episode from 0 to `duration_s` with no gaps:
```
{id,                  // also the id of the Shot row the takes belong to
 type: "lipsync" | "medium" | "reaction" | "wide" | "cover",
 angle,               // an angle key ("" for cover)
 speaker_id, line_id, // the line being spoken (null over music and the intro / outro)
 start, end, duration,// seconds on the episode mix
 chapter_id, text,    // the line's text, for the list
 lipsync: bool,       // lipsync and medium shots are lip-synced to the line's dry voice
 marked: bool,        // re-render on the next render even if nothing changed
 takes: {draft: GenerationOut | null, final: GenerationOut | null},   // newest take of each quality
 needs: {draft: bool, final: bool},   // a render at that quality would (re)make this shot
 thumb_url}           // the angle keyframe's thumb
```
`plan_stats`: `{shots, lipsync, reaction, wide, medium, cover, seconds}`.

`OutputOut`: `{media_id, generation_id, url, quality, duration_s, built_at, subtitles, renderer,
fonts_missing: [], fallback_shots: [], width, height}`.

## Endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/podcast/episodes/{id}/ai-video` | The episode's AI video, or 404 when there isn't one |
| POST | `/podcast/episodes/{id}/ai-video` | `{aspect?}` creates it (201) or returns the existing one (200). The hidden project and one Character per host are made; nothing is generated yet. 409 when the episode has no hosts |
| GET | `/podcast/ai-video/{id}` | |
| PATCH | `/podcast/ai-video/{id}` | `{hosts?, settings?, plan?}` (below). 409 while a job runs |
| DELETE | `/podcast/ai-video/{id}` | The record and its hidden project go; Library videos stay |
| POST | `/podcast/ai-video/{id}/continue` | 202 job `video_podcast`. Runs from the current stage to the next review stop, or to the end of the plan stage. Continuing past a review approves the newest ready portrait / frame of anything not approved yet |
| POST | `/podcast/ai-video/{id}/regenerate` | `{what: "portrait" \| "set" \| "angle", key?, note?}` `key` is a host id or an angle key. 202 `GenerationOut`. Approve with `POST /generations/{id}/approve` as usual |
| GET | `/podcast/ai-video/{id}/characters` | Characters from every other project in the workspace, for "Use existing": `[{id, name, description, project_id, project_title, portrait_url}]` |
| POST | `/podcast/ai-video/{id}/replan` | Rebuilds the plan from the rules (edits are lost). Needs a mix |
| PATCH | `/podcast/ai-video/{id}/shots/{shot_id}` | `{type?, angle?, marked?}` |
| POST | `/podcast/ai-video/{id}/shots/{shot_id}/split` | `{at?}` seconds on the mix (default: the middle). Both halves are at least 0.5 s |
| POST | `/podcast/ai-video/{id}/shots/merge` | `{shot_ids: [a, b, ...]}` neighbouring shots become the first one |
| GET | `/podcast/ai-video/{id}/estimate?quality=draft\|final&shot_ids=a,b` | `{quality, shots, seconds, low_s, high_s, basis, label}` GPU time for the shots a render would make; `label` is "≈ 2.5 h on the video GPU" |
| POST | `/podcast/ai-video/{id}/render` | `{quality: "draft" \| "final", shot_ids?}` 202 job. Renders what's needed, then assembles. With `shot_ids`, exactly those shots are re-rendered |
| POST | `/podcast/ai-video/{id}/assemble` | `{quality: "draft" \| "final"}` 202 job. Cuts the existing takes again (after a subtitle or cover change) |

PATCH `hosts` is `{<host_id>: HostChoice}`:
- `{source: "persona"}`: the LLM writes an appearance from the persona and a portrait is generated.
- `{source: "photo", media_id, consent: {name, statement}}`: a Library image of a real person becomes the
  portrait through the edit model. `statement` must read exactly
  "I have the right to use this person's likeness, and they agreed to it being animated." (422 otherwise,
  and 422 without a name). The record is kept with the time and the user.
- `{source: "existing", character_id}`: the character (from any project of the workspace) is copied, with
  its approved portrait.

Changing a host, the set preset / prompt or the aspect puts the pipeline back to that stage; the
generations already made are kept.

PATCH `plan` is the whole array (`[{id?, type, angle, start, end, marked?}]`); it's sorted, snapped to
1/24 s, checked to cover 0 … `duration_s` without gaps or overlaps (422 otherwise), and the speaker and line
of each shot are filled in from the mix.

## Stages (`video_podcast` job, general lane)

The job is resumable: the state lives on the record, its generations are ordinary `generate` jobs, and it
defers itself while they run (the autopilot pattern: `parent_job_id`, `wake_parent`).

1. **cast** (Hosts): portraits (t2i from the LLM appearance, or the edit model from the photo, or copied),
   then sheet views `front` and `three_quarter` from each portrait. Then **review: hosts**.
2. **set** (Set): a Location from the preset and prompt, and its establishing frame (the seats and mics for
   the number of hosts, nobody in them).
3. **keyframes** (Look): one `keyframe_start` per angle, made with the edit model from the host portrait (the
   3/4 sheet view for the 3/4 angle) and the establishing frame. Then **review: look**.
4. **plan** (Shots): the shot plan from the mix timeline (rules below). The job stops here; render is the
   user's call, after the estimate.
5. **render**: one take per shot that needs one, on the video lane. Lip-sync shots use the `ltx23_ia2v`
   workflow with the line's dry TTS take cut to the shot's window; reaction and wide shots use `ltx23_i2v`
   (draft) or `ltx23_two_stage` (final) without audio. Draft is 832×480 (16:9) in one pass; final is
   1280×704 with the x2 spatial upscaler and a second pass. A failed take is tried once more.
6. **assemble** (a `video_podcast_assemble` job, general lane): every shot's take is cut to the plan's times
   and muted, the clips are joined, the episode mix goes underneath, the subtitles are burned
   (`subtitles.burn`) or added as a soft `mov_text` track, the chapters come from the mix, and the result is
   a new version of the draft or final Library video (title "<episode> (AI video, draft|final)").

A take "needs" a render when the shot's signature (type, angle, times, the line's take, the angle frame,
the aspect) differs from its newest take of that quality, when it's marked, or when its newest take failed.
So a second final render only re-renders shots that changed since, or were marked. Assembling a final with
a shot that has no final take uses its draft take and lists it in `fallback_shots`.

## Plan rules

- The intro (before the first line) and the outro (after the last) are the wide shot, or the cover when
  `cover_intro` / `cover_outro` is on. Music and ad clips with no host are wide.
- Each line is shown from its start to the next line's start (its gap included). It's split into equal
  lip-sync chunks of at most 10 s, alternating close-up and 3/4 per host.
- A chapter's first line opens on 2 s of the wide shot when the line is at least 4 s long.
- In a line of three or more chunks, every third chunk is the medium two-shot (still lip-synced).
- About every 3 lines (two or more hosts), a line of at least 4.5 s gets a 1.5–3 s listening reaction of
  the host who spoke last, in the middle of the line. It's silent and not lip-synced.
- Shots under 0.5 s are folded into the shot before.
- Shot prompts never carry the spoken words (lip sync comes from the audio; aerab stays in the subtitles).

## Workflow `ltx23_ia2v`

API-format conversion of Comfy's `video_ltx2_3_ia2v` template (without its optional prompt enhancer).
Manifest inputs: `prompt`, `negative`, `first_image`, `speech_audio` (a file input, uploaded like
`context_video` and read by `LoadAudio`), `audio_start_s` and `duration_s` (`TrimAudioDuration`),
`width` / `height` (the output and the image), `latent_width` / `latent_height` (the first pass), `num_frames`
(8n+1), `fps` (24), `seed`, `single_stage`. The speech is encoded with `LTXVAudioVAEEncode` and frozen
(`SetLatentNoiseMask` with a 0 `SolidMask`), so only the picture is generated. `single_stage: true` drops
the spatial upscaler and the second pass (the draft); the manifest's `two_stage` feature lists those nodes,
so a server without the upscaler still runs drafts.

## As built (VP1 + VP2)
- `POST /podcast/episodes/{id}/ai-video` returns 201 when it made the record and 200 when it already existed.
  Replan, PATCH shot, split and merge all return the whole `VideoPodcastOut`.
- Output sizes are the take sizes, so nothing is letterboxed: draft 832×480 (16:9), 480×832, 640×640; final
  1280×704, 704×1280, 960×960.
- A lip-sync shot that starts a frame before its line (frame snapping) gets that much silence in front of the
  voice instead of an early voice: the padded voice file is `speech_<take>_<pad s>_<lead ms>.wav` in the hidden
  project's `podcast/` folder, and the take's `audio_start_s` points into it.
- A final render makes every shot that has no final take with a matching signature (so the first final makes
  them all, later ones only the changed or marked shots). Draft takes are never reused by a final render, only
  by a final *cut* whose shot has no final take (`fallback_shots`).
- `ltx23_ia2v` saves with `VHS_VideoCombine` like our other LTX graphs (the template uses `CreateVideo` +
  `SaveVideo`), scales the start image with `ImageScale` (the template uses two `ResizeImageMaskNode`s) and
  decodes the first pass's audio latent (the frozen speech) rather than the second pass's. The take's own audio is
  muted in the cut anyway.
- Frontend: `/audio/podcast/:id/video` (`features/audio/podcast/video/`), opened from the Publish step's
  "AI video podcast" card. Hooks are `useAiVideo*` (`hooks/useVideoPodcast.ts`).

## Update: continuous cameras (M11d-2)

Plan: `docs/PLAN-m11d2-continuous-cameras.md`. No migration: the new plan lives in the existing `plan` JSON
column as an object; the old per-line shot list is rebuilt into it on read (its takes are not reused).

The edit is no longer one short take per line. Each host has **one camera that rolls continuously** through
each episode segment, as a long take lip-synced to that host's own dry voice laid on the segment timeline
(silence where the others speak, so the host listens and nods). A wide camera adds short takes at the intro,
chapter openings and outro. The edit is a **cut list** that switches between these always-in-sync tracks,
so changing a cut never needs a render.

Stage 4 is now labelled **Cameras & cut** (key `plan` unchanged).

### Shapes

`plan` (was an array of shots):
```
{segments: [{id, index, chapter_id, title, start, end, duration}],
                        // the episode split at chapters, and chapters longer than 120 s split again at a gap
                        // between lines; together they cover 0 … duration_s
 tracks: [Track],       // host tracks (one per host per segment), then the wide takes
 cuts: [Cut],           // time order, covering 0 … duration_s with no gaps
 cameras: [{key, label, kind: "host" | "wide" | "cover", host_id, thumb_url}],
 snaps: [seconds]}      // the voice gaps a cut snaps to (between lines, and pauses inside them)
```
`Track`:
```
{id,                    // also the Shot row its takes belong to
 kind: "host" | "wide", camera,          // camera: a host id, or "wide"
 host_id, segment_id, angle_key,         // angle_key: "<host_id>:close" or "wide"
 start, end, duration,  // seconds on the mix
 pieces,                // LTX pieces this track renders in (about 10 s each, overlapped)
 lines,                 // the host's line ids in the segment ([] for wide)
 used,                  // a cut shows it; host tracks always count, a wide take only when a cut uses it
 thumb_url,             // the angle keyframe
 takes: {draft: GenerationOut | null, final: GenerationOut | null},
 progress: {draft: Progress | null, final: Progress | null},
 needs: {draft: bool, final: bool}}
Progress = {pieces, done, current: int | null, failed: int | null, status}
                        // current / failed are 1-based piece numbers
```
`Cut`: `{id, camera, start, end, duration, speaker_id, text, segment_id}`; `camera` is a host id, `"wide"`
or `"cover"`.

`plan_stats`: `{segments, tracks, host_tracks, wide_tracks, cuts, pieces, seconds}`.

Estimate: `{quality, tracks, takes, pieces, seconds, generated_s, low_s, high_s, basis, label}`; `seconds` is
the footage the render makes, `generated_s` counts the overlaps too.

### Endpoints (changed)

| Method | Path | Notes |
|---|---|---|
| PATCH | `/podcast/ai-video/{id}` | `cuts: [{id?, camera, start, end}]` replaces the cut list (`plan` is no longer accepted). Checked like before: 0 … `duration_s`, no gaps, every cut at least 2.5 s (a lone episode shorter than that is one cut), `wide` only where a wide take rolls, `cover` anywhere |
| POST | `/podcast/ai-video/{id}/cuts/switch` | `{at, camera}`: the cut under `at` is split at the nearest voice gap (or pause) and the part from there to the next switch shows `camera`. 422 if a side ends up under 2.5 s |
| PATCH | `/podcast/ai-video/{id}/cuts/{cut_id}` | `{camera}` |
| DELETE | `/podcast/ai-video/{id}/cuts/{cut_id}` | Removes the switch at the cut's start: it joins the cut before (the first one joins the next). Returns the record |
| POST | `/podcast/ai-video/{id}/replan` | Rebuilds segments, tracks and the automatic cut list |
| GET | `/podcast/ai-video/{id}/estimate?quality=&track_ids=a,b` | |
| POST | `/podcast/ai-video/{id}/render` | `{quality, track_ids?, from_piece?}`. `track_ids` re-renders exactly those tracks; `from_piece` (1-based, one track only) keeps that track's pieces before it and renders from there on (its newest take of that quality must still match the track's inputs, else 409) |

The `/shots/...` endpoints are gone.

### Rules

- **Segments**: the mix chapters (one segment when there are none); a chapter longer than 120 s is split at
  the gap between two lines nearest an even split, preferring a gap where the speaker changes, so the camera
  changes there anyway. Segment edges sit in the middle of the gap between lines.
- **Host track audio**: per host per segment, built with ffmpeg from that host's line takes placed at their
  mix offsets, silence elsewhere, exactly the segment's length (48 kHz mono WAV, kept beside the hidden
  project as `podcast/tracks/<track id>_<audio hash>.wav`).
- **Cuts**: the speaker's camera while they talk (each line runs from the gap before it to the gap after
  it); a 2.5–4 s cutaway to the listener (the host who spoke last) about every 3–4 lines, and inside a turn
  longer than 15 s; the wide take at the intro (or the cover), at every chapter opening (about 3 s) and at the
  outro (or the cover); no cut under 2.5 s (shorter ones fold into the cut before); every cut point snaps to
  a voice gap, else to a pause inside a line found in the host track audio (silencedetect), else stays on its
  frame.
- **Wide takes** are single LTX pieces of at most 10 s (`ltx23_i2v` draft, `ltx23_two_stage` final), no audio.
- **Host tracks** are long takes (`app.longtake`): pieces of about 10 s from `plan_chunks`, overlapped by the
  context frames and joined with the crossfade and colour match. Piece 1 is `ltx23_ia2v` from the angle
  keyframe; every later piece is `ltx23_ia2v_extend`: the previous piece's tail as context frames, the
  track audio for the whole window (context + new frames) encoded and frozen, and the angle keyframe as a
  light guide on the last frame against face drift. Draft is 832×480 single stage, final 1280×704 two
  stage. Pieces are kept on disk: a failed or cancelled track resumes from its first unfinished piece.
- A track **needs** a render when its signature (camera, times, angle keyframe, track audio hash, aspect,
  quality) differs from its newest take of that quality, or that take failed. A final render therefore
  only re-renders the tracks whose keyframe, voice or segment changed since the last final.
- **Assemble** cuts each camera's track at the cut list's times (a cut that crosses a segment edge takes each
  part from its own segment's track), mutes them, and lays the mix, subtitles, chapters and cover as before.
  `fallback_shots` lists the cut numbers that used a draft track in a final cut.
- **Estimate**: (host tracks' generated seconds × ia2v factor + wide seconds) × the per-second rate
  (`longtake.measured_rate`, else `GPU_S_PER_OUTPUT_S`) × the quality factor (final 2.5), plus a per-piece
  overhead and one model load.

### Workflow `ltx23_ia2v_extend`

`ltx23_extend`'s context-frame continuation (`VHS_LoadVideo` → `ImageScale` → `LTXVImgToVideoInplace` over
the empty latent) with `ltx23_ia2v`'s frozen speech (`LoadAudio` → `TrimAudioDuration` →
`LTXVAudioVAEEncode` → `SetLatentNoiseMask` with a 0 `SolidMask`) and the angle keyframe as an
`LTXVAddGuide` on the last frame (`guide_strength`, default 0.2), cropped off again with `LTXVCropGuides`.
Models as `ltx23_ia2v` (dev fp8 + distilled LoRA). Inputs: `prompt`, `negative`, `context_video`,
`guide_image`, `speech_audio`, `audio_start_s`, `duration_s`, `width` / `height`, `latent_width` /
`latent_height`, `num_frames`, `fps`, `seed`, `context_strength`, `guide_strength`, `single_stage`. The
context video's own audio is not used: the frozen window already holds the same speech.
