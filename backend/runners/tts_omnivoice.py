"""OmniVoice (k2-fsa, Apache-2.0) in the tts-omnivoice venv: clone, design (instruct) or auto voice."""
import sys

import runner_io as rio

MODEL_ID = "k2-fsa/OmniVoice"


def sample_rate(model) -> int:
    # verify on server: the README saves at a hard-coded 24000 and names no attribute
    for get in (lambda: model.sampling_rate, lambda: model.config.sampling_rate):
        try:
            rate = int(get())
            if rate > 0:
                return rate
        except Exception:  # noqa: BLE001
            continue
    return 24000


def run(job: dict) -> dict:
    import numpy as np
    import torch
    from omnivoice import OmniVoice, OmniVoiceGenerationConfig

    rio.progress(0.02, "Loading OmniVoice")
    dev = rio.device(job)
    model = OmniVoice.from_pretrained(MODEL_ID, device_map="cuda:0" if dev.startswith("cuda") else dev,
                                      dtype=torch.float16 if dev.startswith("cuda") else torch.float32)
    rate = sample_rate(model)
    print(f"omnivoice sample rate {rate}", file=sys.stderr)

    config = OmniVoiceGenerationConfig(
        num_step=int(job.get("steps") or 32),
        guidance_scale=float(job["guidance"]) if job.get("guidance") is not None else 2.0,
        denoise=bool(job["denoise"]) if job.get("denoise") is not None else True,
    )
    kw = {"language": job.get("language") or None, "generation_config": config}
    if job.get("ref_audio"):
        # clone; OmniVoice runs its own ASR on the clip when ref_text is missing
        kw["ref_audio"] = job["ref_audio"]
        if job.get("ref_text"):
            kw["ref_text"] = job["ref_text"]
    elif job.get("instruct"):
        kw["instruct"] = job["instruct"]
    if job.get("duration"):
        kw["duration"] = float(job["duration"])
    elif job.get("speed"):
        kw["speed"] = float(job["speed"])
    # TODO: cache model.create_voice_clone_prompt(...) per voice under the data dir; today every line
    # re-encodes the reference clip

    def synth(text, seg=None):
        seg = seg or {}
        rio.seed_all(seg.get("seed", job.get("seed")))  # same seed per line: a designed voice stays the same person
        call = dict(kw)
        if seg.get("instruct") and not job.get("ref_audio"):
            call["instruct"] = seg["instruct"]
        if seg.get("language"):
            call["language"] = seg["language"]
        try:
            out = model.generate(text, **call)
        except ValueError as err:
            # the app only sends attributes OmniVoice lists, but a newer release could narrow the list again;
            # better its own voice than a failed line
            if "instruct" not in str(err) or not call.get("instruct"):
                raise
            print(f"omnivoice refused instruct {call['instruct']!r}; speaking without it", file=sys.stderr)
            call.pop("instruct")
            out = model.generate(text, **call)
        return np.concatenate([rio.to_numpy(a).reshape(-1) for a in out]) if isinstance(out, list) else out

    res = rio.speak_all(job, synth, rate)
    res["notes"] = [f"sample rate {rate}"]
    return res


if __name__ == "__main__":
    rio.main(run)
