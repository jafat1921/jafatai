import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "runners"))
import runner_io  # noqa: E402


def test_one_bad_line_does_not_stop_the_book(tmp_path, monkeypatch):
    # OmniVoice crashed the whole narration on a line it had nothing to say for
    monkeypatch.setattr(runner_io, "progress", lambda *a, **k: None)

    def fake_wav(path, audio, rate):  # soundfile lives in the engine venvs, not here
        Path(path).write_bytes(b"wav")
        return round(len(runner_io.to_numpy(audio)) / float(rate), 3)

    monkeypatch.setattr(runner_io, "write_wav", fake_wav)
    said = []

    def synth(text):
        said.append(text)
        if "\u064e" in text:  # marked text fails, as the live crash did; the bare retry works
            raise ValueError("zero-size array to reduction operation maximum which has no identity")
        if "boom" in text:
            raise RuntimeError("engine fell over")
        return np.ones(2400, dtype=np.float32) * 0.1

    lines = ["ایک دن", "۔", "بَادل", "boom", "  —  "]
    job = {"segments": [{"text": t, "out": str(tmp_path / f"{i}.wav")} for i, t in enumerate(lines)]}
    res = runner_io.speak_all(job, synth, 24000)
    assert len(res["segments"]) == 5 and all(Path(s["out"]).exists() for s in res["segments"])
    # punctuation-only and dash-only lines never reach the engine, they become a short pause
    assert "۔" not in said and "  —  " not in said
    # the marked line was retried without its marks, the broken one became a pause with a warning
    assert "بادل" in said
    assert len(res["warnings"]) == 1 and "line 4 ('boom')" in res["warnings"][0]
    assert res["segments"][3]["duration_s"] == 0.4
