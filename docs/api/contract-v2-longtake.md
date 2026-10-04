---
title: API contract v2: Long takes and duration control (Milestone 4)
status: Active
created: 2026-10-04
extends: contract-v0.md, contract-v1-storyboard.md
---

# API contract v2: Long takes and duration control

## Goal
Takes of **any length the user picks** (presets 10 / 20 / 30 / 60 / 90 / 120 s, or a custom value up to `LONGTAKE_MAX_S`, default 300 s), produced as **one continuous video with audio**, from the shot's approved START frame to its approved END frame. Short takes (≤ `CHUNK_MAX_S`) keep today's single-pass path.

## Settings (.env, optional)
| Key | Default | Meaning |
|---|---|---|
| `LONGTAKE_MAX_S` | `300` | Upper limit for one take |
| `CHUNK_S` | `8` | Target length of each generated chunk (rounded to LTX 8n+1 frames) |
| `CHUNK_OVERLAP_S` | `1` | Overlap used for continuity and the crossfade at each join |
| `CHUNK_CONTEXT_FRAMES` | `9` | How many tail frames of the previous chunk condition the next chunk |

## Shot changes
- `duration_s` now allows **1 to LONGTAKE_MAX_S**. Shots longer than `CHUNK_MAX_S` (one single-pass chunk, about 10 s) are **long takes**, with `shot_type` set to `long_take` automatically unless the user chose a type.
- New field `beats: [{t_start, t_end, prompt, source, locked}]`. These are the per-chunk action prompts, editable. They are empty until generated, and every user edit locks that beat.
- `PATCH /shots/{id}` accepts `duration_s` and `beats`. Changing `duration_s` marks the beats stale. Unlocked beats are regenerated on the next render.
- `POST /shots/{id}/ai/beats` → `Job`. The creative LLM splits `motion_prompt` (plus the shot description, characters and location) into one beat per chunk for the current duration. Beats follow the lock rules: locked beats are kept and the rest are rewritten around them.
- `GET /shots/{id}/estimate?duration_s=` → `{chunks, frames_total, est_gpu_s, est_wall_s}`. Based on about 6 GPU-s per output second plus a model-load allowance; the backend may refine this from measured history.

## Takes
`POST /shots/{id}/takes {count?, duration_s?}`:
- `duration_s` overrides the shot duration for this request; it defaults to the shot's.
- **Long takes default to `count=1`**, since they are expensive. The UI warns if count > 1.
- The take is a `Generation(kind="take")` whose `params` include `duration_s`, `chunks:[{idx, t_start, t_end, frames, status, file?, seed, gpu_seconds?}]` and `assembly:{status}`.

**Pipeline** (in the worker; one parent take job):
1. Ensure beats exist (generate them if missing).
2. **Chunk 0:** I2V from the approved START frame (plus the END frame as the last-frame guide *only if* the whole take fits in one chunk).
3. **Chunk k > 0:** condition on the **last `CHUNK_CONTEXT_FRAMES` frames** of chunk k−1, so motion continues across the join. Preferred method: LTX latent extension (`LTXVExtendSampler` or a multi-frame guide via `LTXVAddGuide`/`LTXVAddGuidesFromBatch`). Fallback: I2V from the last frame of chunk k−1. The chosen method is recorded in params.
4. **Last chunk:** uses the approved END frame as its last-frame guide.
5. **Join:**
   - Overlap the chunks by `CHUNK_OVERLAP_S`, with a video `xfade` plus a triangular audio `acrossfade` over the overlap.
   - Fade length is `min(overlap, shortest/3, 2 s)`.
   - Colour-match each chunk to chunk 0 (a mild histogram or levels match with ffmpeg).
   - Output one h264 + AAC mp4 at 24 fps.
6. **Checkpointing:** each finished chunk file is kept under `DATA_DIR/.../takes/{generation_id}/chunk_{idx}.mp4`. When a job is re-queued after a crash or restart it **resumes at the first unfinished chunk**.
7. **Progress:** `job.message` like "Chunk 3 of 8 · 37%". SSE `generation` events carry the updated `params.chunks`.

**Re-roll one chunk:**
- `POST /generations/{id}/chunks/{idx}/regenerate {prompt?, seed?}` → `Job`. It regenerates chunk *idx* and **all later chunks**, because they depend on its tail, then reassembles.
- The UI must say how many chunks will be redone.

## Limits and honesty
- Long takes need the shot's START frame approved. END is recommended; without it the take ends wherever the motion goes.
- The UI shows the estimate before queueing, and the queue shows chunk progress.

## Implementation notes (M4a, backend) — these pin down details the sections above leave open
- **Continuity method:** `LONGTAKE_METHOD=extend` (default) uses the template `ltx23_extend`. The previous chunk's last `CHUNK_CONTEXT_FRAMES` frames, plus their audio, are uploaded as a short clip (`VHS_LoadVideo`). The frames go into the first latent frames with `LTXVImgToVideoInplace` (strength 1). The audio is encoded and kept through `LTXVAudioVideoMask` (pad), so audio continues too. `LONGTAKE_METHOD=i2v` is the fallback: I2V from the last frame, with hard joins. `params.continuity` records which was used.
- **Overlap:** the frames two chunks share are the context window: 9 frames, 0.375 s by default. The crossfade runs over those frames. `CHUNK_OVERLAP_S` only caps it: fade = `min(context/fps, CHUNK_OVERLAP_S, shortest/3, 2 s)`. Chunk sizes are 8n+1 and spread evenly. The joined length is exactly `frames_for(duration_s)` (for example 20 s → 3 chunks, 60 s → 8, 300 s → 40).
- **Long take:** `frames_for(duration) > 257`, about 10.7 s. Shot `duration_s` is 1..`LONGTAKE_MAX_S`. A long shot gets `shot_type=long_take` on create, or on PATCH of `duration_s`, unless a type is sent.
- **Colour match:** a YUV offset per chunk, measured on the frames the two chunks share and chained back to chunk 0. It is clamped to ±12 luma / ±6 chroma. `params.assembly.colour_offsets` records it.
- **Params:** `longtake: true`, `chunks[{idx,start_frame,frames,t_start,t_end,status,prompt,seed,file,gpu_seconds,template}]`, `assembly{status,fade_frames,frames,colour_offsets,join_seconds}`, `longtake_stats{gpu_seconds,gpu_per_output_s,method}`, `beats_source`.
- **Beats:** beats run back to back, each from its chunk's start to the next chunk's start. PATCH `beats` locks every beat whose prompt changed. A duration change sets `stale:true` on each beat. A rewrite keeps locked beats, placed by their rescaled midpoint. If the LLM is unavailable during a render, every chunk uses the take prompt.
- **Chunk re-roll** creates a **new take version** (`parent_id` = the old take). Chunks before idx are reused (hard-linked or copied). Response: `202 Job`, whose message says how many chunks will be redone. `409` if the take isn't a long take or is still rendering. `422` for a bad idx.
- **Estimate:** the response also has `duration_s`, `long_take`, `method` and `rate_gpu_s_per_output_s`. The rate comes from the measured history when there is any.
