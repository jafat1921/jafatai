"""TranslateGemma against today's creative model, run ON THE GPU SERVER (reads LLM_* from .env like the app).

    cd backend && uv run python ../scripts/compare-translate.py [--file lines.txt] [--target ur] [--source en]
        [--gemma translategemma:27b] [--creative <model>] [--batch] [--no-aerab]

Built-in English samples (a story line, an ad line, dialogue, a poetic line), plus one line per row of --file.
Each line goes to both models on its own: TranslateGemma with its model-card prompt (app.llm.translate), the
creative model with the dub prompt the app used before (a roomy time budget so length doesn't squeeze it).
Prints them side by side with seconds per call, then both again after the verified aerab pass for Urdu and the
other Arabic-script targets. --batch also sends all lines as one numbered chunk to TranslateGemma and says
whether the numbering came back intact. Paste the output back to the team.
"""
import argparse
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

from app import aerab  # noqa: E402
from app.config import get_settings  # noqa: E402
from app.dub import text as tx  # noqa: E402
from app.llm import LLMError, chat_sync, model_for  # noqa: E402
from app.llm import translate as tl  # noqa: E402

SAMPLES = [
    ("story", "The old lighthouse keeper climbed the stairs one last time, carrying the lamp his father had left him."),
    ("ad", "Fresh from the farm to your table, every single morning."),
    ("dialogue", "Don't worry, I'll be back before the rain starts. Keep the door locked."),
    ("poetic", "The night wore the moon like a borrowed ring, and the river kept every secret we told it."),
]


def gemma_line(model: str, line: str, src: str, tgt: str) -> tuple[str, float]:
    t0 = time.monotonic()
    out = tl.translate([line], src, tgt, model=model)[0]
    return out, time.monotonic() - t0


def creative_line(model: str, line: str, src: str, tgt: str) -> tuple[str, float]:
    # twice the time a relaxed reader needs, so the budget hint never forces a shorter line
    slot = max(3.0, 2 * len(line.split()) / tx.WPS_DEFAULT)
    item = {"id": "1", "start": 0.0, "end": slot, "text": line, "speaker": "Speaker"}
    t0 = time.monotonic()
    res = chat_sync("creative", tx.translate_messages([item], src, tgt, []), schema=tx.Lines, model=model, **tx.ASK)
    got = {x.id: " ".join(x.text.split()) for x in res.data.lines}
    return got.get("1", ""), time.monotonic() - t0


def run(label: str, fn, model: str, line: str, src: str, tgt: str) -> tuple[str, float]:
    try:
        return fn(model, line, src, tgt)
    except LLMError as e:
        print(f"  !! {label} failed: {e}")
        return "", 0.0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="compare-translate.py", description="TranslateGemma vs the creative model")
    ap.add_argument("--file", type=Path, help="extra lines, one per row (blank rows skipped)")
    ap.add_argument("--source", default="en")
    ap.add_argument("--target", default="ur")
    ap.add_argument("--gemma", default=get_settings().translate_llm_model or "translategemma:27b")
    ap.add_argument("--creative", default="", help="default: LLM_MODEL_CREATIVE")
    ap.add_argument("--batch", action="store_true", help="also try every line in one numbered chunk")
    ap.add_argument("--no-aerab", action="store_true")
    a = ap.parse_args(argv)
    sys.stdout.reconfigure(encoding="utf-8")

    creative = a.creative or model_for("creative")
    rows = list(SAMPLES)
    if a.file:
        rows += [("file", ln.strip()) for ln in a.file.read_text(encoding="utf-8").splitlines() if ln.strip()]

    s = get_settings()
    s.translate_llm_model = a.gemma
    found = tl.translator(a.source, a.target)
    print(f"LLM server: {s.llm_base_url}")
    print(f"TranslateGemma: {a.gemma} ({'installed' if found else 'NOT installed or language unsupported'})")
    print(f"creative: {creative}")
    print(f"{a.source} -> {a.target}, prompt code {tl.lang_tag(a.target)[0]}\n")

    results = []
    for kind, line in rows:
        print(f"[{kind}] {line}")
        g, gs = run("TranslateGemma", gemma_line, a.gemma, line, a.source, a.target)
        c, cs = run("creative", creative_line, creative, line, a.source, a.target)
        print(f"  gemma    {gs:6.1f}s  {g}")
        print(f"  creative {cs:6.1f}s  {c}\n")
        results.append((kind, g, c))

    if a.batch:
        lines = [line for _, line in rows]
        numbered = "\n".join(f"{k}. {x}" for k, x in enumerate(lines, 1))
        t0 = time.monotonic()
        try:
            answer = tl._ask(a.gemma, numbered, a.source, a.target, None)
        except LLMError as e:
            answer = f"(failed: {e})"
        took = time.monotonic() - t0
        parsed = tl.parse_numbered(answer, len(lines))
        print(f"batch of {len(lines)}: {took:.1f}s, numbering {'intact' if parsed else 'BROKEN (app redoes per line)'}")
        print(answer + "\n")

    if not a.no_aerab and aerab.applies(a.target, "\n".join(g + "\n" + c for _, g, c in results)):
        print("after the aerab pass (aerab.finish_lines_sync, as the app does):")
        for who, col in (("gemma", 1), ("creative", 2)):
            texts = [r[col] for r in results]
            t0 = time.monotonic()
            marked = aerab.finish_lines_sync(texts, a.target, what=f"compare {who}")
            print(f"  {who} ({time.monotonic() - t0:.1f}s)")
            for (kind, *_), m in zip(results, marked):
                print(f"    [{kind}] {m}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
