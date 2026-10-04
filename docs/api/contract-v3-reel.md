---
title: API contract v3: Reel (sequence and assembly, Milestone 4)
status: Active
created: 2026-10-04
extends: contract-v0.md, contract-v1-storyboard.md, contract-v2-longtake.md
---

# API contract v3: Reel (sequence and assembly)

## What the Reel stage is
The Reel is the film's **edit**. It contains every shot's **approved take**, in scene and shot order, by default. The user can:
- reorder clips, trim their in and out points, and choose the transition at each join;
- preview the film;
- **assemble** it into one MP4 (draft now; a final upscaled pass comes later).

Assembly is **hierarchical and cached**, as in PLAN section 2 Level 3:
1. **Scene mezzanines:** one mp4 per scene, built from its clips with their transitions.
2. **Film:** the scene mezzanines joined, with scene transitions as short **seam clips**, everything else stream-copied.

Changing one clip rebuilds only its scene's mezzanine plus the film join.

## Data (migration 0004, owned by the Reel backend engineer)
- `reel` (id, project_id, workspace_id, title, settings JSON, created_at, updated_at). One per project, auto-created on first GET.
- `reel_clip` (id, reel_id, shot_id, generation_id (the take used), order, scene_id, trim_in_s=0, trim_out_s=0, transition_in: `cut`|`dissolve`|`fade_black`, transition_s=0.5, enabled, created_at, updated_at).
- `shot.beats` JSON column, default `[]` (used by the long-take engineer; created in this same migration).
- A new **generation kind `mezzanine`** (target_type `scene`) and **kind `render`** (target_type `project`), each with params recording the inputs hash.

## Endpoints
| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/projects/{id}/reel` | — | `Reel` (auto-created and synced; see below) |
| POST | `/projects/{id}/reel/sync` | — | `Reel`. Adds clips for newly approved takes; updates `generation_id` when a shot's approved take changed (marks it changed); keeps the user's order, trims and transitions. Shots without an approved take are listed as `missing` |
| PATCH | `/reel-clips/{id}` | `{trim_in_s?, trim_out_s?, transition_in?, transition_s?, enabled?}` | `ReelClip` |
| POST | `/projects/{id}/reel/reorder` | `{clip_ids:[...]}` | `Reel` (clips may only move within their scene for now; scenes keep scene order) |
| POST | `/projects/{id}/reel/assemble` | `{quality:"draft", scene_ids?, title?}` | `Job`. Stitches the selected scenes (all when omitted): builds stale mezzanines, then joins them → `Generation(kind="render", target_type="project")` with review actions (approve = the "final film"). See "Range stitching & Output" |
| GET | `/projects/{id}/renders` | — | `Render[]` (a Generation plus `title, scene_range, scene_ids, full, duration_s, clips, approved`), newest first |
| PATCH | `/generations/{id}` | `{title}` | `Render`. Renames a stitched video (renders only; 422 otherwise) |
| GET | `/generations/{id}/download` | — | The file as an attachment named `<project>-<title>-v<version>.mp4` |
| GET | `/projects/{id}/reel/estimate` | — | `{clips, duration_s, stale_scenes, est_seconds}` |

**`Reel` shape:**
```
{id, project_id, duration_s,
 scenes: [{scene_id, heading, order, duration_s,
           mezzanine: {status: "fresh"|"stale"|"missing"|"building", generation_id?},
           clips: [ReelClip]}],
 missing: [{shot_id, scene_id, reason: "no approved take"}],
 last_render?: Generation}
```

**`ReelClip` shape:**
```
{id, shot_id, scene_id, order, generation_id, media_url, thumb_url?,
 source_duration_s, trim_in_s, trim_out_s, duration_s (after trim),
 transition_in, transition_s, enabled, changed}
```

## Assembly rules (seam recipe, applied per seam)
- **Normalise every clip** to the project size at draft resolution: 24 fps, yuv420p, AAC 48 kHz stereo. Clips without audio get silence, so audio never drops out.
- **Cut:** a straight join (in the scene mezzanine render).
- **Dissolve:** video `xfade=fade` plus `acrossfade` (triangular curves). Duration = `min(transition_s, shortest_neighbour/3, 2.0)`, never below 0.05 s.
- **Fade through black:** fade out, then fade in, over `transition_s`.
- **Fallback chain:** if a transition fails, use a hard cut; if a stream-copy concat fails, re-encode (libx264 CRF 18, AAC 192k, `+faststart`).
- **Film join:** scene mezzanines are concatenated with the concat demuxer, `-c copy`, using a **per-job** concat list (never a shared temp file). The scene-level transition (the `transition_in` of a scene's first clip) is rendered as a short seam clip.
- **Final loudness:** a two-pass `loudnorm` to -16 LUFS on the film audio, then remuxed.
- **Chapter markers** per scene in the mp4 metadata.
- **Cache:** a mezzanine is rebuilt only when the hash of (clip generation ids + trims + transitions + order) changes.

## Events
- **New SSE event `reel`:** data is `Reel`, emitted after a sync, a change or an assembly status change.
- Job progress messages look like "Scene 3 of 12 · building" or "Joining film".

## Implementation notes (Milestone 4b backend, 2026-10-04)
These clarify or slightly extend the contract above; the frontend can rely on them.
- **Extra `reel_clip` columns:** `workspace_id`, `changed` (bool, cleared when the clip's scene mezzanine is rebuilt) and `source_duration_s` (cached probe). `generation_id` is a plain id, not a foreign key, because takes are bulk-deleted with their shot.
- **`trim_out_s`** is the number of seconds cut from the **end** of the take (not an out-point timestamp). PATCH returns 422 if the trims leave less than 0.25 s, and 409 if the clip's shot no longer has an approved take.
- **Clips without an approved take** keep their edits but drop out of `scenes[].clips` and appear in `missing`. When a take is approved again, the clip comes back with its trims, order and transition; it is marked `changed` if the take differs. Other `missing.reason` values: `"take file missing"`, `"not synced yet"`.
- **Disabled clips** are listed in `scenes[].clips` but are left out of `duration_s` and of assembly.
- **`scenes`** lists every scene, including scenes with no clips (`mezzanine.status: "missing"`). Scenes with no clips are skipped in the film.
- **Fade through black** does not overlap: the outgoing clip fades out over `d/2`, the incoming clip fades in over `d/2`, and `d` is clamped like a dissolve. Only dissolves shorten the timeline.
- **The scene seam** (the first clip's `transition_in`) is not part of that scene's mezzanine hash, so changing it only re-joins the film.
- **Chapters** start where the seam into the scene begins.
- **`POST .../reel/assemble`**: returns 409 when there is nothing to assemble. Stale scenes are always rebuilt, fresh ones reused. (Superseded on 2026-10-04: `scene_ids` now selects the scenes to stitch rather than forcing rebuilds, and the in-flight rule is per selection; see below.)
- The render `Generation` is created when the job is queued (`status: queued → generating → ready`, or `failed` on error or cancel). Its `params` record `input_hash`, `mezzanines[]` (scene, generation, hash), `chapters[]`, `join` (`copy`|`reencode`), `fallbacks[]` and `loudness`. Mezzanine generations record `input_hash` and `clips[]`.
- **`mezzanine` is not accepted by `POST /generations`.** Only the assembly job produces it. `render` is still accepted there (for the mock driver).
- **Usage:** the job records `gpu_seconds = 0` and a `usage_ledger` row with kind `assembly`; the wall time is in `job.result.wall_seconds`.
- **Silent films:** if the joined audio is silence, the loudnorm pass is skipped and the audio is copied as it is.
- **`reel.settings.size`** (`[w, h]`) overrides the draft size. The tests use it for 160x90 renders.
- **SSE `reel`** fires when the reel row or one of its clips changes, and when an assembly job is queued, starts or finishes (progress ticks don't trigger it).

## Range stitching & Output (2026-10-04)
After Render, the user **stitches** approved takes into one video from the Reel, choosing which scenes go in. They can make as many stitched videos as they like ("Full film", "Scenes 1–4", "Act 2"…). The **Output** stage is the gallery of every stitched video.

- **Selection.** `scene_ids` means "stitch only these scenes"; they are always joined in film order, whatever order they were sent in. Empty or omitted means every scene that has a playable clip. Scenes are numbered by their position in the film (1-based, the "Sc N" on the Reel).
- **Validation.** Ids that aren't scenes of the project → 422. Selected scenes with no enabled clip on an approved take → 422 with a message naming them (for example `No approved takes to stitch in: Scene 3 (INT. LAB)`). Nothing stitchable at all → 409. The Reel UI's Range mode leaves such scenes out itself and says so.
- **Titles.** `title` is optional. The automatic title is `Full film` when the selection covers every scene with takes, otherwise the range label: `Scene 3`, `Scenes 2–5` for a contiguous run, or `Scenes 1, 3, 6` for a set. An automatic title follows what the job really stitched (takes can change while it waits); a typed title is kept.
- **Render params** (set when queued, finalised when done): `title`, `title_auto`, `scene_ids` (included scenes, film order), `scene_range`, `full`, `clips`, `duration_s`, `created_by: {user_id, flow: "reel_stitch"}`, plus the existing `input_hash`, `mezzanines`, `chapters`, `join`, `fallbacks`, `loudness`. The prompt reads `<project> · <title>` and the mp4 metadata title `<project> - <title>`. Renders made before this change have none of the new keys and read as `Full film`.
- **Concurrency.** An identical selection that is already queued or running returns that Job (the whole film counts as one selection, however it was asked for). A different selection is queued as its own Job. The worker never runs two stitches of the same project at once (they share scene mezzanines), so the second one waits for the first and then reuses whatever scenes it built.
- **`reel.last_render`** is the newest ready or approved **full-film** stitch; partial stitches appear only in `/renders` and Output.
- **Rename:** `PATCH /generations/{id} {title}` (1–200 characters, trimmed; renders only). It sets `title_auto: false`, bumps `updated_at` (so an SSE `generation` event follows), and returns the `Render`.
- **Download:** `GET /generations/{id}/download` needs a session and serves only files inside the caller's workspace folder (same containment as `/media`), with status ready, approved or rejected. The name is `<project-title>-<title>-v<version>.mp4`, cut down to ASCII letters, digits and hyphens (`Reef-Scenes-2-5-v3.mp4`).
- **Output stage.** Cards newest first, each in a darkroom frame: title, scene range, mm:ss, date, version, and a "Final film" badge on the approved one. Actions: Play (large player dialog), Download (the endpoint above), Rename (inline; Enter saves, Escape cancels), Approve as final or Unapprove (the usual one-approved-per-target rule, so approving one demotes the previous final film), and Reject or Restore with a "Show rejected" toggle. Filter chips: All · Full film · Partial. On phones the page is review-only: play, download and approve.
