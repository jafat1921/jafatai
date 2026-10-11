"""Kokoro-82M (hexgrad, Apache-2.0) in the tts-kokoro venv: preset voices only, fast, 24 kHz."""
import runner_io as rio

RATE = 24000
# Kokoro's own language codes; a voice id's first letter is its language (af_heart -> a)
LANG_CODES = {"en": "a", "es": "e", "fr": "f", "hi": "h", "it": "i", "ja": "j", "pt": "p", "zh": "z"}


def run(job: dict) -> dict:
    import numpy as np
    from kokoro import KPipeline

    voice = job.get("voice") or "af_heart"
    rio.progress(0.02, "Loading Kokoro")
    pipelines = {}

    def pipeline_for(v):
        # one pipeline per language; the gallery batches American and British voices together
        code = v[0] if v[:1] in "abefhijpz" else LANG_CODES.get(job.get("language") or "en", "a")
        if code not in pipelines:
            pipelines[code] = KPipeline(lang_code=code, repo_id="hexgrad/Kokoro-82M", device=rio.device(job))
        return pipelines[code]

    pipeline_for(voice)
    speed = float(job.get("speed") or 1.0)

    def synth(text, seg=None):
        v = (seg or {}).get("voice") or voice
        # Kokoro yields one result per chunk it split the text into
        chunks = [rio.to_numpy(r.audio).reshape(-1) for r in pipeline_for(v)(text, voice=v, speed=speed)
                  if r.audio is not None]
        if not chunks:
            raise RuntimeError("Kokoro returned no audio")
        return np.concatenate(chunks)

    return rio.speak_all(job, synth, RATE)


if __name__ == "__main__":
    rio.main(run)
