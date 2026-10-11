---
title: "Contract v24a: burned subtitles (VP0)"
status: Active (VP0 backend)
created: 2026-10-11
extends: contract-v0..v23
migration: none
plan: docs/PLAN-m11d-video-podcast.md
---

# Contract v24a: burned subtitles (`app/subtitles.py`)

There's one subtitle burner, and every feature that burns subtitles calls it: the Audiogram
(`podcast/publish.py`), the Dub export (`dub/export.py`), Transcribe → "make subtitles", and the AI video
podcast. No other module builds a `subtitles=` / `ass=` ffmpeg filter.

## Python API

```python
from app import subtitles as st

st.Cue(start: float, end: float, text: str, speaker: str | None = None)   # a NamedTuple
# a plain (start, end, text) tuple, as transcripts.cues() returns, works wherever a Cue does;
# so does a dict with start/end/text(/speaker)

st.burn(src_video: Path, dst: Path, cues, *, language: str | None = None,
        width: int | None = None, height: int | None = None, timeout: int = 7200,
        encode: list[str] | None = None) -> dict
# -> {"renderer": "ass" | "pillow" | "none", "fonts_missing": ["Noto Nastaliq Urdu", ...]}
```

- `src_video` keeps its audio: every audio stream is copied, never re-encoded. The picture is re-encoded
  (`encode` defaults to `mixdown.VIDEO_REENCODE`: libx264 veryfast crf 18, yuv420p).
- `width` / `height` are the output size, and they set the subtitle size. Leave them out and the source is probed.
- `language` is the subtitle language (`ur`, `ar`, `fa`, `ps`, `sd`, `pnb`, `hi`, `en`, ...). If it's left
  out or set to `auto`, each cue's letters decide.
- `renderer` says how the cues were drawn. `"none"` means there were no cues, so `dst` is just a copy of the source.
- `fonts_missing` lists the font families the cues needed that weren't found in `subtitle_fonts_dir` or by
  fontconfig. The video is still made with a fallback font. Show it as a warning on the job.
- Raises `RuntimeError` only when neither renderer could make the video.

Helpers:

| Function | Purpose |
|---|---|
| `font_for(language, text) -> str` | `ur` → Noto Nastaliq Urdu; `ar fa ps sd pnb` → Noto Naskh Arabic; `hi mr ne` → Noto Sans Devanagari; anything else → Noto Sans |
| `font_file(family) -> Path \| None` | the font file on this machine |
| `wrap(text, width=None, language=None) -> list[str] \| None` | at most 2 lines. Only base letters count toward the length (aerab marks don't). Width: 34 for Nastaliq, 42 for everything else |
| `srt_text(cues)` / `vtt_text(cues)` | subtitle file text |
| `write_srt(path, cues)` / `write_vtt(path, cues)` | write those files (UTF-8) |
| `soft_track_args(index, language, title) -> list[str]` | ffmpeg metadata args for a soft `mov_text` track. Soft subtitles stay plain text, and the player shapes them |
| `ass_text(cues, width, height, language=None) -> str` | the ASS document that `burn` writes |

## How it renders

1. **ASS + libass** (the default). It needs ffmpeg's `ass` filter with the `shaping` option. The ASS file
   is written at PlayRes = output size, with one style per font. Font size is 5.2 % of the frame height
   for Latin and Devanagari, 5.6 % for Naskh and 6.2 % for Nastaliq. The text is white on a semi-opaque
   black box (`BorderStyle=3`), `Alignment=2`, with `MarginV` at 6 % of the height. Arabic-script styles
   use `Encoding=-1`, so libass picks the base direction itself. Text stays in logical order, and lines
   are broken with `\N`. The burn runs as `ass=filename=subs.ass:fontsdir=…:shaping=complex`, with the
   job's work directory as the cwd.
2. **Pillow** (the fallback). It's used when ffmpeg has no `ass` filter, when there's no complex shaping
   and the text needs it, when the libass burn fails, or when `SUBTITLE_RENDERER=pillow`. Each distinct
   cue is drawn once as a transparent strip with `brand_render.shaped`. RTL lines are right-aligned
   inside a centred box. The strips are joined into one overlay track with the concat demuxer, gaps
   included, and that track is overlaid in a single pass.

## Settings (`.env`)

| Key | Default | |
|---|---|---|
| `SUBTITLE_FONTS_DIR` | `/usr/share/fonts/truetype/noto` | scanned for the Noto files; `install-server.sh` installs `fonts-noto-core fonts-noto-extra` |
| `SUBTITLE_RENDERER` | `auto` | `auto` \| `ass` \| `pillow` |

## User-facing rename

The fixed waveform video is called **Audiogram** in the UI and in job messages. Endpoint paths, job types
and the `outputs.video` key don't change.
