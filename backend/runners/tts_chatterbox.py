"""Chatterbox (Resemble AI, MIT) in the tts-chatterbox venv. English uses the English model, every other
language the multilingual one. Its output carries Resemble's Perth watermark."""
import runner_io as rio


def base(code) -> str:
    return (code or "en").lower().split("-")[0]


def run(job: dict) -> dict:
    lang = base(job.get("language"))
    # a mixed script brings segments in other languages; one of them is enough to need the multilingual model
    langs = {lang} | {base(s["language"]) for s in job.get("segments") or [] if s.get("language")}
    dev = rio.device(job)
    rio.progress(0.02, "Loading Chatterbox")
    if langs == {"en"}:
        from chatterbox.tts import ChatterboxTTS

        model = ChatterboxTTS.from_pretrained(device=dev)
        multilingual = False
    else:
        from chatterbox.mtl_tts import SUPPORTED_LANGUAGES, ChatterboxMultilingualTTS

        if lang not in SUPPORTED_LANGUAGES:
            raise ValueError(f"Chatterbox doesn't speak '{lang}'")
        model = ChatterboxMultilingualTTS.from_pretrained(device=dev)
        multilingual = True

    kw = {"exaggeration": float(job["exaggeration"]) if job.get("exaggeration") is not None else 0.5,
          "cfg_weight": float(job["guidance"]) if job.get("guidance") is not None else 0.5}
    if job.get("ref_audio"):
        kw["audio_prompt_path"] = job["ref_audio"]

    def synth(text, seg=None):
        # a story batch (per_segment) carries each line's own seed and emotion intensity
        seg = seg or {}
        rio.seed_all(seg.get("seed", job.get("seed")))
        call = dict(kw)
        if multilingual:
            want = base(seg.get("language") or lang)
            if want not in SUPPORTED_LANGUAGES:
                raise ValueError(f"Chatterbox doesn't speak '{want}'")
            call["language_id"] = want
        if seg.get("exaggeration") is not None:
            call["exaggeration"] = float(seg["exaggeration"])
        return model.generate(text, **call)

    return rio.speak_all(job, synth, lambda: int(model.sr))


if __name__ == "__main__":
    rio.main(run)
