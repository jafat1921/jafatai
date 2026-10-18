"""Is the speech in the language it should be? Whisper (large-v3, the app's own stt-whisperx runner) listens to
recent speech takes, or to a line synthesised on the spot, and says which language it hears.

    cd backend && uv run python ../scripts/check-speech-language.py --last 20 [--workspace <id>]
    cd backend && uv run python ../scripts/check-speech-language.py --say "یہ میری آواز ہے۔" --language ur \\
        --engine omnivoice [--voice gallery:ur-lahore-narrator | --instruct "male, middle-aged"] [--seed 7]

Run it on the GPU box: it needs the engine venvs. Expected is what the app now sends (the letters of the text,
then the take's language); a take made before the language fix can show its old params next to it. Whisper
often hears Urdu as Hindi (the spoken languages are close), so ur/hi is reported as "close", not a mismatch.
Reads DATABASE_URL and the data dir from .env like the app.
"""
import argparse
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

from sqlalchemy import select  # noqa: E402

from app import speech, speech_language, venv_runner, voices  # noqa: E402
from app.db import SessionLocal  # noqa: E402
from app.models import Generation  # noqa: E402
from app.services import generation_file  # noqa: E402

CLOSE = {frozenset(("ur", "hi")), frozenset(("pnb", "pa")), frozenset(("pnb", "ur")), frozenset(("pa", "hi"))}


def verdict(expected: str, heard: str | None) -> str:
    exp = expected.split("-")[0]
    if not heard:
        return "NO SPEECH"
    if heard == exp:
        return "ok"
    return "close" if frozenset((exp, heard)) in CLOSE else "MISMATCH"


def listen(paths: list[Path], work: Path) -> list[dict]:
    wavs = [speech.to_wav(p, work / f"{i}.wav", 16000) for i, p in enumerate(paths)]
    w = voices.WHISPER
    res = venv_runner.run(w["runner"], w["venv"], {"audios": [str(p) for p in wavs], "language": None,
                                                   "model": "large-v3", "device": "cuda"},
                          need_gb=w["vram_gb"], timeout=600 + 30 * len(wavs))
    langs = res.get("languages") or [{} for _ in wavs]
    return [{**lang, "text": text} for lang, text in zip(langs, res.get("texts") or [""] * len(wavs))]


def recent(args) -> list[tuple[Generation, Path]]:
    with SessionLocal() as db:
        q = select(Generation).where(Generation.kind == "speech", Generation.status.in_(("ready", "approved")))
        if args.workspace:
            q = q.where(Generation.workspace_id == args.workspace)
        rows = db.scalars(q.order_by(Generation.created_at.desc()).limit(args.last * 3)).all()
        out = []
        for g in rows:
            p = generation_file(g)
            if p is not None and p.is_file():
                db.expunge(g)
                out.append((g, p))
            if len(out) >= args.last:
                break
        return out


def check_recent(args, work: Path) -> int:
    takes = recent(args)
    if not takes:
        print("No finished speech takes found")
        return 0
    print(f"Listening to {len(takes)} take(s)...")
    heard = listen([p for _, p in takes], work)
    bad = 0
    for (g, _), h in zip(takes, heard):
        p = g.params or {}
        text = p.get("text_spoken") or p.get("text") or g.prompt or ""
        expected = speech_language.dominant(text, p.get("language"))
        pieces = {lang for _, lang in speech_language.runs(text, p.get("language"))}
        v = verdict(expected, h.get("language"))
        bad += v == "MISMATCH"
        print(f"\n{g.id}  {g.created_at:%Y-%m-%d %H:%M}  engine={p.get('engine')}  voice={p.get('voice_id') or '-'}")
        print(f"  text:     {text[:110]}")
        print(f"  params:   language={p.get('language')}  pieces={','.join(sorted(pieces))}")
        print(f"  expected: {expected}   heard: {h.get('language')} ({h.get('probability')})   -> {v}")
        print(f"  whisper:  {(h.get('text') or '')[:110]}")
    print(f"\n{bad} mismatch(es) in {len(takes)} take(s)")
    return 1 if bad else 0


def check_say(args, work: Path) -> int:
    e = voices.get_engine(args.engine or voices.default_engine())
    vspec: dict = {"kind": None}
    seed = args.seed
    if args.voice:
        with SessionLocal() as db:
            v = voices.find_voice(db, args.workspace or "", args.voice)
            if v is None:
                print(f"No voice {args.voice!r} (a library voice needs --workspace)")
                return 2
            vspec = {"kind": v.kind, "name": v.name}
            if v.kind == "design":
                vspec["design"] = v.design
                seed = seed if seed is not None else (v.design or {}).get("seed")
            elif v.kind == "preset":
                vspec["preset"] = (v.preset or {}).get("id")
            else:
                g = db.get(Generation, v.ref_generation_id or "")
                vspec.update(ref_file=g.file_path if g else None, ref_text=v.ref_text or "")
    elif args.instruct:
        vspec = {"kind": "design", "design": {"description": args.instruct}}
    language = speech_language.dominant(args.say, args.language)
    params = {"kind": "speech", "engine": e.id, "language": language, "text": args.say, "speed": 1.0,
              "voice": vspec}
    out = work / "say.flac"
    print(f"Speaking with {e.label}, language {language} "
          f"(pieces: {', '.join(f'{lang}' for _, lang in speech_language.runs(args.say, language))})...")
    speech.synthesise(params, seed, out, lambda f, m: None)
    h = listen([out], work)[0]
    v = verdict(language, h.get("language"))
    print(f"  expected: {language}   heard: {h.get('language')} ({h.get('probability')})   -> {v}")
    print(f"  whisper:  {h.get('text')}")
    if args.keep:
        dst = Path(args.keep)
        shutil.copy(out, dst)
        print(f"  saved {dst}")
    return 1 if v == "MISMATCH" else 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="check-speech-language.py", description=__doc__.splitlines()[0])
    ap.add_argument("--last", type=int, default=10, help="how many recent speech takes to check")
    ap.add_argument("--workspace", help="only this workspace (and where --voice is looked up)")
    ap.add_argument("--say", help="synthesise this line instead and check it")
    ap.add_argument("--language", help="the language to ask for with --say (the letters still decide)")
    ap.add_argument("--engine", help="omnivoice, voxcpm, chatterbox or kokoro (default: the app's)")
    ap.add_argument("--voice", help="a voice id or gallery:<id> for --say")
    ap.add_argument("--instruct", help="a designed voice description for --say, e.g. 'female, young adult'")
    ap.add_argument("--seed", type=int)
    ap.add_argument("--keep", help="copy the --say take here (e.g. /tmp/say.flac) to listen to it")
    args = ap.parse_args(argv)
    work = Path(tempfile.mkdtemp(prefix="speech-lang-"))
    try:
        return check_say(args, work) if args.say else check_recent(args, work)
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
