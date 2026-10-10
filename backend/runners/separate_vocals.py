"""audio-separator in the audio-utils venv: a MelBand / BS-RoFormer vocal model splits the dialogue from
everything else. Job: {audio, out_dir, model, model_dir, device}; returns {vocals, instrumental}."""
import os

import runner_io as rio


def _pick(paths: list[str], *names: str) -> str | None:
    for p in paths:
        low = os.path.basename(p).lower()
        if any(f"({n})" in low or f"_{n}" in low for n in names):
            return p
    return None


def run(job: dict) -> dict:
    from audio_separator.separator import Separator

    out_dir = job["out_dir"]
    os.makedirs(out_dir, exist_ok=True)
    os.makedirs(job.get("model_dir") or out_dir, exist_ok=True)
    rio.progress(0.05, "Loading the separation model")
    sep = Separator(model_file_dir=job.get("model_dir") or out_dir, output_dir=out_dir, output_format="WAV")
    # downloads the checkpoint into model_file_dir the first time
    sep.load_model(model_filename=job.get("model") or "model_bs_roformer_ep_317_sdr_12.9755.ckpt")
    rio.progress(0.2, "Separating the voices")
    files = [p if os.path.isabs(p) else os.path.join(out_dir, p) for p in sep.separate(job["audio"])]
    vocals = _pick(files, "vocals", "vocal")
    rest = _pick(files, "instrumental", "other", "no_vocals")
    if vocals is None or rest is None:
        raise RuntimeError(f"Couldn't tell the stems apart: {', '.join(os.path.basename(f) for f in files)}")
    rio.progress(1.0, "Separated")
    return {"vocals": vocals, "instrumental": rest}


if __name__ == "__main__":
    rio.main(run)
