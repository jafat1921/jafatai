"""faster-whisper in the stt-whisperx venv: a transcript with word timings for a reference clip."""
import runner_io as rio


def run(job: dict) -> dict:
    from faster_whisper import WhisperModel

    dev = rio.device(job)
    rio.progress(0.02, "Loading Whisper")
    model = WhisperModel(job.get("model") or "large-v3", device="cuda" if dev.startswith("cuda") else "cpu",
                         compute_type="float16" if dev.startswith("cuda") else "int8")
    segments, info = model.transcribe(job["audio"], language=job.get("language") or None, word_timestamps=True,
                                      vad_filter=True)
    total = float(getattr(info, "duration", 0) or 0)
    out = []
    # segments is a generator: the decoding happens while we iterate
    for seg in segments:
        out.append({"start": round(seg.start, 3), "end": round(seg.end, 3), "text": seg.text.strip(),
                    "words": [{"start": round(w.start, 3), "end": round(w.end, 3), "word": w.word,
                               "probability": round(w.probability, 3)} for w in (seg.words or [])]})
        if total:
            rio.progress(0.1 + 0.85 * min(1.0, seg.end / total), "Transcribing")
    return {"text": " ".join(s["text"] for s in out).strip(), "language": info.language,
            "language_probability": round(float(info.language_probability or 0), 3), "duration_s": total,
            "segments": out}


if __name__ == "__main__":
    rio.main(run)
