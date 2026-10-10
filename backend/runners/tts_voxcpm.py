"""VoxCPM2 (OpenBMB, Apache-2.0) in the tts-voxcpm venv: cloning from a clip, or design from a description.

VoxCPM2 picks the language from the text itself; there is no language argument.
"""
import runner_io as rio

MODEL_ID = "openbmb/VoxCPM2"


def run(job: dict) -> dict:
    from voxcpm import VoxCPM

    rio.progress(0.02, "Loading VoxCPM2")
    denoise = bool(job["denoise"]) if job.get("denoise") is not None else True
    model = VoxCPM.from_pretrained(MODEL_ID, load_denoiser=denoise)
    rate = int(model.tts_model.sample_rate)

    kw = {"cfg_value": float(job["guidance"]) if job.get("guidance") is not None else 2.0,
          "inference_timesteps": int(job.get("steps") or 10), "normalize": True}
    ref = job.get("ref_audio")
    if ref:
        kw["reference_wav_path"] = ref
        kw["denoise"] = denoise
        if job.get("ref_text"):
            # with a transcript the clip is also the prompt to continue from: closer timbre and pacing
            # verify on server: reference_wav_path and prompt_wav_path given together
            kw.update(prompt_wav_path=ref, prompt_text=job["ref_text"])
    prefix = ""
    if job.get("instruct") and not ref:
        # the README's voice design: the description in parentheses at the start of the text
        prefix = "(" + " ".join(str(job["instruct"]).replace("(", " ").replace(")", " ").split()) + ")"

    def synth(text):
        rio.seed_all(job.get("seed"))
        return model.generate(text=prefix + text, **kw)

    return rio.speak_all(job, synth, rate)


if __name__ == "__main__":
    rio.main(run)
