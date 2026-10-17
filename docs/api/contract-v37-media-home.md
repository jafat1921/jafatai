---
title: "Contract v37: Studio parts (media home)"
status: Active
created: 2026-10-17
extends: contract-v5 (Library), contract-v34 (via_api), contract-v27 (public API), mcp.md
migration: 0026_media_home
---

# Contract v37: Studio parts

A Library item can be a **working part** of one studio rather than a final output: a character sheet board,
a poetry song, a dub voice sample, a page clip an outside app makes for its story. Parts stay out of the
general lists (generator histories, pickers, the Library, Photo Studio) and are still reachable by id and from
their own studio. Final outputs show everywhere, as before.

## 1. `MediaItem.home` (migration 0026)

| value | meaning |
|---|---|
| `null` | a final output, listed everywhere |
| `character` | Character Studio: sheet board, test clip, voice preview |
| `poetry` | Poetry Short: the sung poem (the finished video stays final) |
| `story` | story music bed, and outside story clips (backfill) |
| `dub` | Dub Studio: a speaker's voice sample (the dubbed track stays final) |
| `voice` | Voice design samples |
| `brand` | brand kit uploads: logo, product photos, fonts |
| anything else | an outside caller's `part_of` label, e.g. `story:9f1c...` |

`MediaItemOut` gains `home: string | null`.

Stays final (`home` null): Ad Studio ads, poetry final video, video podcast, podcast publish and audiogram,
dialogue mix, dubbed track, logo reveal, brand-template pictures, stems, and everything from the plain
generators.

## 2. Listing (`GET /api/media`)

| param | effect |
|---|---|
| (neither) | only `home IS NULL` |
| `home=<value>` | only that studio's parts; project results are left out |
| `home=any` | every part, any studio (the Library's "Studio parts" filter) |
| `include_home=a,b` | the normal list plus the parts of those studios (References and image pickers send `character`) |

`home` wins over `include_home`. The admin `via` switch (contract v34) is unchanged and applies on top.
Photo Studio's grid hides parts too, except inside an album someone filed them in. `GET /api/media/{id}`
returns any item regardless of `home`.

## 3. Marking a part from outside: `part_of`

Optional `part_of` (string, at most 80 characters) on:

- REST `POST /api/images/generate` (`ImageGenerateIn`), `POST /api/videos/generate` (`VideoGenerateIn`),
  `POST /api/audio/speak` (`SpeakIn`);
- MCP `generate_image`, `generate_video`, `speak`.

It is stored as `home` (whitespace tidied; blank means none). The result keeps its normal id and download
link; list it again with `GET /api/media?home=<the same value>`.

## 4. Backfill (migration 0026)

Rows made before the column get a home from what they already carry, first match wins:

1. tag `character sheet` or `test clip`, or a title ending `· voice preview` → `character`
2. title starting `BlogCreatorPro ` → `story`
3. audio tagged exactly `["poetry"]` → `poetry`
4. tag `story` → `story`
5. current version made by flow `dub_sample` → `dub`; by `voice_design` → `voice`
6. tag `brand` and origin `upload` → `brand`

Downgrade drops the column.

## 5. Frontend

- Live updates: an SSE media push with a `home` only lands in a list that asked for that home.
- Library filter chip **Studio parts** (`home=any`).
- Character Studio's voice preview sends `part_of: "character"`.
