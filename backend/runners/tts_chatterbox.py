"""Chatterbox (Resemble AI, MIT) in the tts-chatterbox venv. English uses the English model, every other
language the multilingual one. Its output carries Resemble's Perth watermark."""
import runner_io as rio


def run(job: dict) -> dict:
    lang = (job.get("language") or "en").split("-")[0]
    dev = rio.device(job)
    rio.progress(0.02, "Loading Chatterbox")
    if lang == "en":
        from chatterbox.tts import ChatterboxTTS

        model = ChatterboxTTS.from_pretrained(device=dev)
        extra = {}
    else:
        from chatterbox.mtl_tts import SUPPORTED_LANGUAGES, ChatterboxMultilingualTTS

        if lang not in SUPPORTED_LANGUAGES:
            raise ValueError(f"Chatterbox doesn't speak '{lang}'")
        model = ChatterboxMultilingualTTS.from_pretrained(device=dev)
        extra = {"language_id": lang}

    kw = {"exaggeration": float(job["exaggeration"]) if job.get("exaggeration") is not None else 0.5,
          "cfg_weight": float(job["guidance"]) if job.get("guidance") is not None else 0.5, **extra}
    if job.get("ref_audio"):
        kw["audio_prompt_path"] = job["ref_audio"]

    def synth(text):
        rio.seed_all(job.get("seed"))
        return model.generate(text, **kw)

    return rio.speak_all(job, synth, lambda: int(model.sr))


if __name__ == "__main__":
    rio.main(run)
