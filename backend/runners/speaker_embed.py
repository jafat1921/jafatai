"""A simple voice print per speech segment, in the audio-utils venv: MFCC means and spreads (torchaudio).

Not a neural speaker model, but it needs no gated download and separates a man from a woman or two
quite different voices well enough; the backend clusters the vectors. Job: {audio, segments: [[s, e]]}.
"""
import runner_io as rio

RATE = 16000
N_MFCC = 20


def run(job: dict) -> dict:
    import numpy as np
    import soundfile as sf
    import torch
    import torchaudio

    rio.progress(0.05, "Reading the voices")
    rate = sf.info(job["audio"]).samplerate
    mfcc = torchaudio.transforms.MFCC(sample_rate=RATE, n_mfcc=N_MFCC,
                                      melkwargs={"n_fft": 512, "hop_length": 160, "n_mels": 40})
    segs = job.get("segments") or []
    out = []
    for i, (start, end) in enumerate(segs):
        # one segment at a time: a feature-length stem doesn't fit in memory as float32
        audio, _ = sf.read(job["audio"], start=int(start * rate), stop=int(end * rate), dtype="float32",
                           always_2d=True)
        chunk = torch.from_numpy(audio.mean(axis=1)).unsqueeze(0)
        if rate != RATE and chunk.shape[1]:
            chunk = torchaudio.functional.resample(chunk, rate, RATE)
        if chunk.shape[1] < 400:
            out.append([0.0] * (2 * (N_MFCC - 1)))
            continue
        m = mfcc(chunk)[0, 1:]  # drop c0: that's loudness, not voice
        v = torch.cat([m.mean(dim=1), m.std(dim=1)]).numpy().astype(np.float64)
        v -= v.mean()
        norm = np.linalg.norm(v)
        out.append((v / norm if norm else v).round(5).tolist())
        if i % 20 == 0:
            rio.progress(0.1 + 0.85 * i / max(1, len(segs)), "Listening for speakers")
    rio.progress(1.0, "Done")
    return {"embeddings": out, "dim": 2 * (N_MFCC - 1)}


if __name__ == "__main__":
    rio.main(run)
