---
title: "Contract v26: Character voices and lip-synced dialogue (M12b)"
status: Active
created: 2026-10-14
extends: contract-v25-character-sheets.md, contract-v17-dialogue.md, contract-v16-voice.md, contract-v2-longtake.md
migration: none (0018 already added character.voice_id and shot.dialogue)
plan: docs/PLAN-m12-characters-voices-api.md (Part B, and the Update's Test clip tab)
---

# Contract v26: Character voices and lip-synced dialogue

A character speaks in a voice from the Audio studio. A shot carries the lines its characters say. When a
take is rendered, each line is spoken in its character's voice, the lines are laid on one speech track, and
the take is lip-synced to that track. The Character Studio gets a **Test clip** tab to check a face and a
voice together.

## The character's voice

`PATCH /characters/{id} {voice_id}` (contract v25) takes a library voice id or `gallery:<id>`. A voice that
is in neither gives a 422. Sending `""` clears it.

### POST /characters/{id}/voice/design → 201

Makes an OmniVoice **design** voice from the profile, saves it to Voices, and sets it as the character's
voice.

```
in:  {extra?: str (≤200, e.g. "deep, slow"), language?: str, name?: str}
out: {character: CharacterOut, voice: VoiceOut, description: str, understood: [str], ignored: [str]}
```

- **What it reads:** the profile's `gender`, its `age` (a number becomes child / teenager / young adult /
  middle-aged / elderly), and its `accent`, or `nationality + " accent"` when there's no accent. `extra` is
  added after these.
- **How it's turned into a voice:** the text goes through `voice_instruct.normalise`, and only what OmniVoice
  accepts is kept. `voice.design.description` is that cleaned instruct, with a new seed and engine
  `omnivoice`.
- **The voice record:**
  - `voice.name` defaults to "<name>'s voice".
  - `voice.language` is the first language named in `profile.languages` (for example "Urdu, English" gives
    `ur`), or `en`.
  - `voice.gender_hint` is set from the instruct.
- **422** when nothing usable is left. The message points to the Profile tab.

The UI's "Clone" is a link to Voices. Cloning keeps its own consent flow (contract v16).

## Shot dialogue

`shot.dialogue` holds `[{character_id, text, pause_after_s?}]`.

- `ShotOut` gains:
  - `dialogue`: the lines.
  - `dialogue_notice: str | null`: set when a speaker has no usable voice. For example: "Maya has no voice
    yet, so this shot's lines use the video model's own audio instead of lip sync. Pick a voice in
    Character Studio."
- `PATCH /shots/{id} {dialogue: [...]}` replaces the whole list:
  - At most 12 lines.
  - `text` is up to 600 characters and its spaces are collapsed. Blank lines are dropped.
  - `pause_after_s` is clamped to 0–10.
  - Every `character_id` must be in the shot's `character_ids`. The same PATCH may change both. Anything
    else is a 422.
  - Changing the lines on a shot that has takes marks it `stale`.
  - Taking a character out of `character_ids` drops their lines.
- **The storyboard writes the lines:** `ai_storyboard` and `ai_suggest_shots` fill `dialogue` when the scene
  script has spoken lines and the payload doesn't say `dialogue: false`.
  - The autopilot passes its own dialogue switch through.
  - The planner gets the speakers by name and the text word for word from the script. Lines from the
    narrator or a voice-over, or from anyone not in the cast, are left out.
  - A speaker missing from the shot's characters is added to them.
  - The shot list asks for one visible speaker per shot where it can.
- **Aerab:** Urdu and other Arabic-script lines get the aerab writing rule in the planner's prompt, then the
  verified pass (`aerab.finish_lines_sync`). The editor has `AerabButton` on each line. The speech worker
  also marks unmarked lines before it speaks them, as it does for every speech take.

## Rendering a take with dialogue

`storyboard.prepare_shot_generation(kind="take")` records a plan in `params.dialogue`:

```
{status: "pending", mode: "lipsync" | "native", tag: "shot:<shot id without dashes>",
 lines: [{character_id, name, voice_id, text, pause_after_s?}], notice?: str}
```

Any old `speech_audio / lipsync / audio_start_s / speech` in the params is cleared first, so a regenerate
starts fresh.

### mode "lipsync" (every speaker has a voice)

1. **The lines are spoken.** Each line is spoken with `voices.queue_speech` (flow `shot_dialogue`) on a
   Library audio item tagged `shot:<id>`. A line's language is read from its letters when it's written in
   Arabic script. Otherwise it's the voice's own language.
   - Takes are reused by fingerprint (text, voice, language). Two takes of the shot share one set of lines.
     A failed line is never reused.
   - Each line row records `take_id`, `fp` and `language`.
   - `POST /shots/{id}/takes`, `POST /scenes/{id}/render` and `POST /shots/{id}/rerender {what: takes}`
     speak the lines straight away. A line that can't be spoken (for example a Kokoro voice given Urdu)
     is a 422 with the speech code's message.
   - `POST /generations`, regenerate and the autopilot leave the speaking to the take's job.
2. **The take waits for its lines.** The worker's `handle_generate` runs `shot_speech.run_in_job` before
   anything else that renders.
   - It queues any lines not spoken yet.
   - It sets `parent_job_id` on their jobs and `job.result.waiting_on` on the take's job.
   - Then it raises `JobDeferred(priority=-20)`. `autopilot.wake_parent` puts the take back at priority 0
     once its lines are done.
   - It polls for up to 10 s first when the worker has nothing else in its lanes.
   - A failed line fails the take: "<Name>'s line couldn't be spoken (<error>). Check the voice and render
     the take again."
3. **The speech track.** ffmpeg lays the lines end to end with a 0.3 s lead-in and their pauses (0.35 s by
   default; the last line's pause is dropped).
   - The track is mono 48 kHz WAV, padded to the take's length, at `<project>/takes/<gen id>/speech.wav`.
   - `params.speech = {file, duration_s}`.
4. **Duration.** The take's `duration_s` becomes `max(asked, speech + 0.5 s)`. More than `LONGTAKE_MAX_S` is
   a readable failure. The shot's own `duration_s` stretches to match: its beats go stale, and it becomes
   `long_take` when it's long.
5. **The render.**
   - The params get `lipsync: true, speech_audio: <absolute path>, audio_start_s: 0` and a short
     performance line on the prompt ("Maya speaks on camera, the mouth moving with every word…").
   - Up to one LTX pass (257 frames, about 10.7 s), the take runs on **ltx23_ia2v**.
   - A longer take becomes a long take with `continuity: "extend"` whatever `LONGTAKE_METHOD` says.
     `longtake.run_take` gives each chunk its window of the track, and the chunks after the first run on
     `ltx23_ia2v_extend`.
   - `params.dialogue.status` becomes `"ready"`.

### mode "native" (some speaker has no voice)

There's no speech track. The lines go into the prompt as `Name says: "…"` (when they aren't there already),
which is the LTX native audio from before. The worker's aerab pass marks quoted Urdu.
`params.dialogue.status` becomes `"native"`, and the notice is on the shot.

**The UI limits:** lip sync works best with one visible speaker. With two speakers in one shot, the editor
suggests one shot per speaker or an over-the-shoulder shot.

## Hidden speech takes

`library.HIDDEN_TAGS = ("script:", "shot:", "clip:")`. Library listings leave items with these tags out,
unless the `tag` filter asks for one (`GET /media?kind=audio&tag=shot:<id>`). This is the same rule as
dialogue script takes.

## Dialogue studio import

`POST /scripts/{id}/import-project` ties cues to the film's cast (its own and linked characters).

- A cue matches a character by its full name or its first name (MAYA → Maya Khan).
- The script's cast row is found by `character_id`, else by name, else it's created. It gets the character's
  `voice_id` when it has none of its own.
- `CastMember` gains `character_id`, which keeps the row tied to the character after a rename on either side.

## Character Studio test clip

### POST /characters/{id}/test-clip {text ≤300} → 202 TestClipOut

A 5–10 s lip-synced clip of the character saying `text`.

- **The picture:** the sheet's **close-up** panel, else the approved (or newest) portrait.
- **The item:** a Library **video** item ("<name> · test clip", tagged `test clip`).
- **The generation:** kind `video`. It takes the take path through the worker's speech step, with
  `params.dialogue.min_s = 5, max_s = 10`, and is never a long take.
- **The line:** its speech take is hidden (`clip:<character id without dashes>`).
- **The comfy driver** routes a `video` with `speech_audio` to `ltx23_ia2v`.
- **Errors:**
  - 409 when the character has no voice, or has no portrait.
  - 422 when the line runs longer than about 23 words (10 s at 2.5 words a second, less the lead-in and the
    tail).
- The last clip is remembered in `character.sheet.test_clip = {media_id, text, panel}`.

### GET /characters/{id}/test-clip → TestClipOut

```
TestClipOut: {item: MediaItemOut | null, text: str, panel: "closeup" | "portrait" | null,
              job?: JobOut, speech_jobs: [JobOut]}        // job fields only on the POST
```

The UI polls it while `item.status` is queued or generating, then shows a player and a download link
(`/generations/{generation_id}/download`).

## Server checks for the owner

- **A shot with one line in your own cloned voice:** does the lip sync land on the words? Does the take keep
  the START frame's face?
- **A two-line shot with a 0.5 s pause:** check the pause on the speech track.
- **Lines that run past about 11 s:** they should become a lip-synced long take. Check the audio across the
  chunk joins.
- **The Test clip tab:** with the close-up panel, then with only a portrait. Do 5 s and 10 s both work?
- **A Kokoro voice given an Urdu line:** you should get a readable 422 at "Render takes".
