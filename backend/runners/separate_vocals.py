"""audio-separator in the audio-utils venv. Dub runs a MelBand / BS-RoFormer vocal model to split the dialogue
from everything else; the Stems tool also runs Demucs models that write four (or six) stems.

Job: {audio, out_dir, model, model_dir, device, all_stems?}. Returns {stems: {name: path}}, every stem the
model wrote keyed by the lower-case "(Name)" in its file name, plus {vocals, instrumental} unless
all_stems is set (that pair is what Dub needs)."""
import os
import re

import runner_io as rio

_NAMED = re.compile(r"\(([^()]+)\)")


def _pick(paths: list[str], *names: str) -> str | None:
    for p in paths:
        low = os.path.basename(p).lower()
        if any(f"({n})" in low or f"_{n}" in low for n in names):
            return p
    return None


def stems_of(paths: list[str], source: str) -> dict[str, str]:
    """Maps song_(Vocals)_htdemucs_ft.wav to {"vocals": path}. The source's own name is cut off first, so a
    file name with brackets in it can't pass for a stem name."""
    base = os.path.splitext(os.path.basename(source))[0]
    out: dict[str, str] = {}
    for p in paths:
        name = os.path.basename(p)
        if name.startswith(base):
            name = name[len(base):]
        m = _NAMED.search(name)
        if m:
            out.setdefault("_".join(m[1].lower().split()), p)
    return out


def run(job: dict) -> dict:
    from audio_separator.separator import Separator

    out_dir = job["out_dir"]
    os.makedirs(out_dir, exist_ok=True)
    os.makedirs(job.get("model_dir") or out_dir, exist_ok=True)
    rio.progress(0.05, "Loading the separation model")
    sep = Separator(model_file_dir=job.get("model_dir") or out_dir, output_dir=out_dir, output_format="WAV")
    # downloads the checkpoint into model_file_dir the first time
    sep.load_model(model_filename=job.get("model") or "model_bs_roformer_ep_317_sdr_12.9755.ckpt")
    rio.progress(0.2, "Separating the stems" if job.get("all_stems") else "Separating the voices")
    files = [p if os.path.isabs(p) else os.path.join(out_dir, p) for p in sep.separate(job["audio"])]
    stems = stems_of(files, job["audio"])
    names = ", ".join(os.path.basename(f) for f in files) or "no files"
    if job.get("all_stems"):
        if not stems:
            raise RuntimeError(f"The model wrote no stems I can name: {names}")
        rio.progress(1.0, "Separated")
        return {"stems": stems}
    vocals = _pick(files, "vocals", "vocal")
    rest = _pick(files, "instrumental", "other", "no_vocals")
    if vocals is None or rest is None:
        raise RuntimeError(f"Couldn't tell the stems apart: {names}")
    rio.progress(1.0, "Separated")
    return {"vocals": vocals, "instrumental": rest, "stems": stems}


if __name__ == "__main__":
    rio.main(run)
