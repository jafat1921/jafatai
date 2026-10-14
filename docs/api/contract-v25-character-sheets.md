---
title: "Contract v25: Character Studio and character sheets (M12a)"
status: Active
created: 2026-10-14
extends: contract-v1-storyboard.md, contract-v24-video-podcast.md
migration: 0018_character_studio
plan: docs/PLAN-m12-characters-voices-api.md (Part A, Update, Update 2)
---

# Contract v25: Character Studio and character sheets

Characters get a studio of their own (`/characters` in the app). A character has a profile, a portrait, a
reference **sheet** made of separate panels, a **board** laid out from those panels, and (M12b) a voice.

Studio characters are shared: a film casts one through `project_cast` instead of copying it, so an edit in
the studio shows in every film that uses it.

## Data (migration 0018)

| Column | Meaning |
|---|---|
| `character.project_id` | now nullable. `NULL` = a Character Studio character |
| `character.profile` | JSON, the identity block (fields below) |
| `character.voice_id` | a library voice id or `gallery:<id>` (M12b uses it) |
| `character.sheet` | JSON, the sheet state (below). The API never returns it raw |
| `project_cast(project_id, character_id, added_at)` | a studio character cast in a film |
| `shot.ref_panels` | JSON `{character_id: panel_key}`, the user's reference picks |
| `shot.dialogue` | JSON `[]`, M12b |

The `uq_generation_one_approved` index now leaves `sheet_view` out. Sheet panels are approved **one per
panel**; `POST /generations/{id}/approve` on a `sheet_view` demotes only the other versions of the same
`params.panel`. The podcast's plain sheet views (no `params.panel`) are keyed by `params.view`.

**A film's cast** is its own characters plus the linked ones. Everything that reads the cast uses that
union: `GET /projects/{id}/characters`, shot `character_ids` checks, `storyboard.references_for`, @-mentions,
the AI cast extraction and the autopilot. `ProjectOut.counts.characters` counts both.

## Profile fields

`role, affiliation, nationality, height, age, gender, languages, personality, accent, wardrobe`. They're
strings of up to 300 characters. Any other key is a 422. Sending a field blank clears it. The values can
be in any language. In Urdu and other Arabic-script languages, the UI's aerab button marks them, and the
AI fill runs the verified aerab pass itself.

## CharacterOut (changed)

```
{id, project_id: str | null, name, description, source, locked,
 profile: {...}, voice_id: str | null,
 studio: bool,                       // project_id is null
 approved_portrait: GenerationOut | null,
 portrait: GenerationOut | null,     // approved, else the newest finished one
 panels_ready: int,                  // sheet panels with a finished picture
 board_thumb_url: str | null,
 films: [{id, title}],               // on the studio routes only (GET/PATCH /characters/..., GET /characters)
 created_at, updated_at}
```

## Routes

### A film's cast
| Route | |
|---|---|
| `GET /projects/{id}/characters` | own + linked, in creation order |
| `POST /projects/{id}/characters` | a film's own character (as before; also takes `profile`) |
| `POST /projects/{id}/cast {character_id}` → 201 CharacterOut | link a studio character. 409 if it's another film's own character ("Save it to Character Studio first") |
| `DELETE /projects/{id}/cast/{character_id}` → 204 | unlink. It also comes off this film's shots (`character_ids`, `ref_panels`) |

### Character Studio
| Route | |
|---|---|
| `GET /characters?q=&scope=studio\|all` | the library, newest edit first. `scope=all` adds films' own characters (for pickers) |
| `POST /characters {name, description?, profile?}` → 201 | a studio character |
| `POST /characters/from-photo {name, media_id, description?, consent: {name, statement}}` → 201 | see "From a photo" |
| `GET /characters/{id}` | with `films` |
| `PATCH /characters/{id} {name?, description?, locked?, profile?, voice_id?}` | `profile` merges. `voice_id: ""` clears it, and an unknown voice is a 422 |
| `POST /characters/{id}/save-to-studio` | a film's own character becomes a studio one and stays linked to that film |
| `DELETE /characters/{id}?project_id=` → 204 | **with** `project_id` for a character that isn't that film's own: only unlinks it. **Without** it, it's deleted everywhere (portrait, panels, links, shot references). Show `films` in the confirm first |
| `POST /characters/{id}/ai/profile` → 202 JobOut | job `ai_character_profile`. It fills only the **empty** profile fields, and puts suggested `props`, `accessories` and `details` into the sheet lists that are still empty. `job.result = {character_id, filled: [fields], profile, lists}` |
| `GET /characters/{id}/pack` | zip download (see "Packs") |
| `POST /characters/import` (multipart, field `file`, a `.zip` up to 300 MB) → 201 CharacterOut | a new studio character. 422 if it isn't a pack, 415 if it isn't a zip |

The `portrait` generations work as before: `POST /generations {target_type: "character", kind: "portrait"}`.
A studio character's generations have `project_id: null`.

### The sheet
| Route | |
|---|---|
| `GET /character-sheet/catalogue` | `{sections:[{key,label}], counts:{section:[allowed counts]}, lists:{outfits:3, details:4, props:3, accessories:6}, presets:{essential:{counts,panels:10}, full:{counts,panels:30}}, backdrops:["grey","dark"], seconds_per_panel:[20,40]}` |
| `GET /characters/{id}/sheet` | `SheetOut` |
| `POST /characters/{id}/sheet {preset, counts?, lists?, backdrop?}` → 202 `SheetOut + {queued}` | queues every panel of the preset that has **no** picture yet. Panels that already have one are kept. 409 without a portrait |
| `PATCH /characters/{id}/sheet {titles?, labels?, footer?, ruler?, backdrop?, lists?}` | board text and settings. A blank title or label goes back to the default. If a board exists, it's redrawn |
| `POST /characters/{id}/sheet/panels/{key}/regenerate {note?}` → 201 GenerationOut | a new version of one panel, from the **current** portrait / hero. The note is added to the prompt |
| `POST /characters/{id}/sheet/board {layout: "dossier"\|"studio"}` → 202 JobOut | lay out the board now. 409 if no panel is finished |
| `GET /characters/{id}/sheet/board/download?format=png\|pdf` | the current board, 404 before there is one |

`SheetOut`:
```
{character_id, preset: "essential" | "full" | "custom" | null,
 counts: {section: n}, lists: {outfits:[], details:[], props:[], accessories:[]},
 backdrop: "grey" | "dark", titles: {section: text}, footer: {team?, number?}, ruler: bool,
 panels: [{key, section, section_title, label, default_label,
           source: "portrait" | "hero" | "none",
           status: "none" | "waiting" | "queued" | "generating" | "ready" | "approved" | "failed",
           current: GenerationOut | null,     // approved, else the newest finished
           live_job_id, versions,
           stale: bool}],                     // made from an older portrait / hero than the one in use now
 palette: ["#rrggbb", ...],                   // up to 6, from the hero (else the portrait), backdrop left out
 estimate: {panels, seconds_low, seconds_high},   // what is still to make, at 20–40 s a panel
 has_portrait: bool,
 board: {media_id, layout, generation: GenerationOut | null, status: "none" | "queued" | "running" | "ready"}}
```
`waiting` = a panel drawn from the full-body hero, waiting for the hero to finish.

## Panels

Each panel is a `Generation(target_type="character", kind="sheet_view")`. Its `params` are
`{panel, view, source, source_id, reference_ids, width, height, angles_lora?}`, or, for an object panel,
`{panel, object: true, width, height, model?}`. The prompt is the whole edit instruction. The ComfyUI driver
sends it as it is to `qwen_image_edit_2511` (adding the multiple-angles LoRA when `angles_lora` is set).
Object panels are text-to-image on the default image model.

| Section | Keys | Made from |
|---|---|---|
| hero | `hero` | portrait |
| turnaround | `turn_front`, `turn_three_quarter`, `turn_side`, `turn_back` | hero (angles LoRA) |
| motion | `motion_walk` | hero |
| head | `head_{down,level,up}_{lprofile,l34,front,r34,rprofile}` (15), or the 5 `head_level_*` | portrait (angles LoRA) |
| expressions | `expr_neutral, expr_smile, expr_serious, expr_surprised` (+ `sad, angry, worried, determined`) | portrait |
| closeup | `closeup` | portrait |
| gestures | `gesture_wave, gesture_point, gesture_count, gesture_fist` | hero |
| postures | `posture_relaxed, posture_tense, posture_confident` | hero |
| outfits | `outfit_1..3` (named in `lists.outfits`) | hero |
| details | `detail_1..4` (wardrobe close-ups) | hero |
| props | `prop_1..3` | text (product shot, no person) |
| accessories | `accessory_1..6` | text |

Presets:
- **essential**: hero, turnaround, 4 expressions and the close-up (10 panels).
- **full**: hero, turnaround, walking pose, the 15-angle head grid, 8 expressions and the close-up (30 panels), plus the named lists.
- **custom**: `counts` per section. Each count snaps down to what that section allows (see the catalogue), and the lists apply too.

The **backdrop** (`grey` | `dark`) goes into every panel prompt, so all the panels share it.

When the hero finishes, the worker queues the panels that were waiting for it and refreshes the palette.
When no panel is in flight any more, it queues a board. Approving, unapproving or rejecting a panel also
redraws the board.

## The board

- The board is a CPU job, `character_board`, on the general lane, with no GPU time billed.
- It's saved as a Library image item: title "<name> · character sheet", tag `character sheet`. Each redraw
  is a new version, and only the two newest are kept.
- Layouts are export styles only; the app UI itself stays Antique Atelier:
  - `dossier`: dark, 3840×2160.
  - `studio`: light, 4096×4096.
- What's on it:
  - The header: the name, a tagline (role · affiliation · nationality) and the kicker.
  - The left column: the hero, the palette swatches and the profile in two columns.
  - The right side: one block per section, packed onto shelves, with tiles sized to fit whatever sections exist.
  - An optional height ruler beside the turnaround, from `profile.height`. It reads cm, m or ft/in.
  - An optional footer: `team · number`.
- Text is drawn with the subtitle Noto fonts (Nastaliq for Urdu, Naskh for Arabic-script, Devanagari)
  and shaped with raqm, or with arabic_reshaper + bidi. Section titles and labels can be in any language.
- PDF is the same picture at 300 dpi.

## Shot references

`storyboard.references_for` picks, per character, the panel that fits the shot. It falls back down the
list to the first panel that has a finished picture, then to the approved portrait. It still keeps the cap
of 3 references (characters first, then the location).

| Shot | Wanted |
|---|---|
| angle `ots` / type `over_shoulder` / "over the shoulder" | head profile, then turnaround side |
| wide (`ls`, `ews`, `mls`, or type wide / establishing / long take) | turnaround front; back if "from behind", side if "profile", ¾ if "three-quarter", walking pose if "walks" |
| close (`cu`, `ecu`, close_up, extreme_close_up, insert) | an emotion word's expression panel, else the close-up |
| medium | an emotion word's expression panel, else the portrait |

The emotion words are angry/furious, smile/laughs, sad/cries, surprised/shocked, worried/afraid,
determined and serious/stern, matched as whole words in the description, prompt, start prompt and camera
text. A user pick in `shot.ref_panels` beats all of this.

`PATCH /shots/{id} {ref_panels: {character_id: key | "auto" | ""}}` merges into the picks, and `auto` or a
blank removes one. `ShotOut.ref_panels` returns them.

`GET /shots/{id}/refs`:
```
{max_refs: 3, refs: [{kind: "character" | "location", id, name, panel, panel_label, auto,
                      generation: GenerationOut | null, used: bool,
                      options: [{key, label, section_title}]}]}   // "portrait" plus every finished non-object panel
```

## From a photo

`POST /characters/from-photo` needs the photo as a Library image (upload it with `POST /media/upload`) and a
consent record. `consent.statement` must read exactly:

> I have the right to use this photo, and the person in it agreed to it being made into a character.

It creates a studio character, stores `{media_id, generation_id, consent: {name, statement, at, user_id}}`
in its sheet state, and queues a `portrait` edit of the photo that keeps the identity on a clean grey
studio background. The user approves it like any portrait, and the sheet follows from it.

## Packs

`character.json` (`format: "mixai.character"`, `version: 1`) holds:
- the name, description and profile;
- the sheet settings (preset, counts, lists, extras, keys, backdrop, titles, labels, footer, ruler, palette) and the layout;
- `portrait: {file, prompt, approved}`;
- `panels: [{key, file, prompt, approved, source}]`;
- `board`;
- `voice`.

The files are `portrait.png`, `panels/<key>.png` and `board.png`.

`voice` is one of:
- `{gallery: id}`;
- a library voice's definition (name, kind, language, notes, gender hint, design / preset, ref text);
- for a clone, also `reference: "voice/reference.<ext>"` and its `consent`.

A clone's clip is left out (`reference: null`) when it has no consent record.

Import:
- Every picture is re-encoded to PNG; a picture that can't be read is a 422.
- Panel and portrait approval comes back as it was.
- The board is redrawn rather than copied.
- A voice in the same workspace is reused. A designed or preset voice is recreated. A clone comes back only
  with its clip and a matching consent statement, as a new upload; otherwise the character just has no voice.

## Autopilot

`POST /quick {character_sheets: true}` (off by default) queues an Essential sheet for every cast member
once the portraits are approved. The autopilot doesn't wait for the sheets.

## Video podcast

`GET /podcast/ai-video/{id}/characters` lists studio characters first, with `project_title: "Character Studio"`
and `studio: true`. Picking one copies its portrait in, as before.

## GPU server checks
- `qwen_image_edit_2511` and `qwen-image-edit-2511-multiple-angles-lora.safetensors` are the ones the podcast already uses.
- The head grid's up/down tilts and the gesture panels are new asks of that model. Check that the face holds.
- Object panels use the default image model, the same as Create Image.
