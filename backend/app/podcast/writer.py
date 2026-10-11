"""The LLM side of an episode (contract v20): writing it, editing selected lines, and show notes.

Short episodes are one JSON answer. Longer ones get an outline first and then one call per chapter, because
a local model asked for twenty minutes of dialogue in one go stops early or loses the thread.
"""
from pydantic import BaseModel, Field

from app import dialogue as dl
from app.models import PodcastEpisode, VoiceScript
from app.podcast import ingest
from app.podcast import service as sv
from app.voices import lang_name

LONG_MINUTES = 6
EDIT_OPS = ("rewrite_chapter", "shorter", "livelier")
# scripts that spend more tokens per word than English does
DENSE = ("ur", "hi", "pa", "ar", "fa", "bn", "ps", "sd")

FORMAT_GUIDE = {
    "interview": "An interview. The host asks short, curious questions and follow-ups; the guest answers at "
                 "length, with examples and stories.",
    "conversation": "A relaxed conversation. The hosts build on each other's points, react naturally and "
                    "sometimes disagree.",
    "debate": "A debate. Hosts take opposing sides, argue and rebut with evidence; a moderator, if there is "
              "one, keeps it fair. End with each side's closing statement.",
    "solo": "A solo episode. One host talks straight to the listener, like a well-told monologue.",
    "news": "A news brief. Tight factual segments, one story per chapter, clear handoffs between hosts.",
    "storytelling": "Storytelling. A narrated story with scenes, tension and a payoff; other hosts may voice "
                    "the characters.",
    "qa": "Questions and answers. One host asks listener-style questions; the others answer clearly.",
}


class WLine(BaseModel):
    host: str = Field(max_length=120)
    text: str


class WChapter(BaseModel):
    title: str
    lines: list[WLine]


class WEpisode(BaseModel):
    title: str
    chapters: list[WChapter]


class OChapter(BaseModel):
    title: str
    beats: list[str] = []


class Outline(BaseModel):
    title: str
    chapters: list[OChapter]


class WLines(BaseModel):
    lines: list[WLine]


class Notes(BaseModel):
    description: str
    key_points: list[str]


class WriteError(RuntimeError):
    pass


def words_for(minutes: float) -> int:
    return max(60, round(float(minutes or 5) * sv.WPM))


def max_tokens(words: int, language: str) -> int:
    per = 4.0 if language in DENSE else 2.2
    return int(min(16000, max(1200, words * per + 600)))


def language_rule(language: str) -> str:
    if language == "ur":
        return ("Write every line in Urdu, in Urdu script (نستعلیق / Arabic letters). Never Roman Urdu, never "
                "Hindi script. English technical words may stay in English where Pakistani speakers say them so.")
    if language == "hi":
        return "Write every line in Hindi, in Devanagari script."
    return f"Write every line in {lang_name(language)}."


def hosts_block(hosts: list[dict]) -> str:
    rows = []
    for h in hosts:
        role = {"cohost": "co-host"}.get(h["role"], h["role"])
        rows.append(f"- {h['name']} ({role})" + (f": {h['persona']}" if h.get("persona") else ""))
    return "\n".join(rows)


def _rules(ep: PodcastEpisode, hosts: list[dict]) -> list[str]:
    names = ", ".join(h["name"] for h in hosts)
    return [
        "You write podcast scripts that sound like real people talking: contractions, short sentences, "
        "reactions, the occasional joke. Lines are meant to be spoken aloud, so no stage directions, no sound "
        "effects, no markdown, no emoji and no speaker names inside the text.",
        f"Format: {FORMAT_GUIDE.get(ep.format, FORMAT_GUIDE['conversation'])}",
        language_rule(ep.language),
        f"The hosts are:\n{hosts_block(hosts)}\nEvery line's \"host\" is exactly one of: {names}.",
        "Each line is one turn of speech, usually 1 to 4 sentences. Let every host speak in their own voice.",
        "Open with a short welcome that names the show or topic, and close with a sign-off.",
    ]


def _material_block(material: str) -> str:
    if not material:
        return ""
    return ("\n\nGround the episode in this material. Use its facts, names and numbers exactly; don't invent "
            f"facts that aren't in it.\n<material>\n{material}\n</material>")


def _topic(ep: PodcastEpisode) -> str:
    return (ep.sources or {}).get("topic") or ep.title


def episode_messages(ep: PodcastEpisode, hosts: list[dict], material: str, words: int) -> list[dict]:
    rules = _rules(ep, hosts) + [
        f"Length: about {words} words in all (about {words // sv.WPM or 1} minutes at 150 words a minute).",
        "Split it into 2 to 5 chapters, each with a short title.",
        'Reply as JSON: {"title": "episode title", "chapters": [{"title": "...", "lines": [{"host": "name", '
        '"text": "what they say"}]}]}.',
    ]
    user = f"Topic: {_topic(ep)}{_material_block(material)}"
    return [{"role": "system", "content": "\n".join(rules)}, {"role": "user", "content": user}]


def outline_messages(ep: PodcastEpisode, hosts: list[dict], material: str, words: int) -> list[dict]:
    n = max(3, min(10, round(words / 600)))
    rules = [
        "You plan podcast episodes.",
        f"Format: {FORMAT_GUIDE.get(ep.format, FORMAT_GUIDE['conversation'])}",
        language_rule(ep.language),
        f"The hosts are:\n{hosts_block(hosts)}",
        f"Plan about {n} chapters for an episode of about {words} words. Each chapter has a short title and 2 to 5 "
        "beats: the points, questions or story moments it covers, in order.",
        'Reply as JSON: {"title": "episode title", "chapters": [{"title": "...", "beats": ["..."]}]}.',
    ]
    user = f"Topic: {_topic(ep)}{_material_block(material)}"
    return [{"role": "system", "content": "\n".join(rules)}, {"role": "user", "content": user}]


def chapter_messages(ep: PodcastEpisode, hosts: list[dict], outline: Outline, idx: int, words: int,
                     material: str, before: list[str]) -> list[dict]:
    ch = outline.chapters[idx]
    plan = "\n".join(f"{n}. {c.title}" for n, c in enumerate(outline.chapters, 1))
    where = "the first chapter: open the episode" if idx == 0 else (
        "the last chapter: close the episode" if idx == len(outline.chapters) - 1 else "a middle chapter: "
        "no welcome and no sign-off")
    rules = _rules(ep, hosts)[:-1] + [
        f"Write chapter {idx + 1} of {len(outline.chapters)} only ({where}). About {words} words.",
        'Reply as JSON: {"lines": [{"host": "name", "text": "what they say"}]}.',
    ]
    user = (f"Episode: {outline.title}\nTopic: {_topic(ep)}\nChapters:\n{plan}\n\n"
            f"This chapter: {ch.title}\nBeats:\n" + "\n".join(f"- {b}" for b in ch.beats))
    if before:
        user += "\n\nThe chapter before ended with:\n" + "\n".join(before[-4:])
    user += _material_block(material)
    return [{"role": "system", "content": "\n".join(rules)}, {"role": "user", "content": user}]


EDIT_ASK = {
    "rewrite_chapter": "Rewrite this chapter. Keep its subject and facts, make it flow better and sound more "
                       "natural, and keep about the same length.",
    "shorter": "Make these lines shorter: about half as many words, keeping the key points and who says what.",
    "livelier": "Make these lines livelier: more energy, reactions, humour and back-and-forth between the hosts, "
                "about the same length.",
}


def edit_messages(ep: PodcastEpisode, hosts: list[dict], op: str, rows: list[tuple[str, str]],
                  chapter_title: str, note: str) -> list[dict]:
    rules = _rules(ep, hosts)[:-1] + [
        EDIT_ASK[op],
        "Only replace the lines you are given; they sit in the middle of the episode, so no welcome or sign-off "
        "unless they already had one.",
        'Reply as JSON: {"lines": [{"host": "name", "text": "what they say"}]}.',
    ]
    user = (f"Episode: {ep.title}\nChapter: {chapter_title}\n" + (f"Note from the producer: {note}\n" if note else "")
            + "\nLines:\n" + "\n".join(f"{who}: {text}" for who, text in rows))
    return [{"role": "system", "content": "\n".join(rules)}, {"role": "user", "content": user}]


def notes_messages(ep: PodcastEpisode, show: str, transcript: str, chapters: list[dict]) -> list[dict]:
    rules = [
        "You write podcast show notes.",
        language_rule(ep.language).replace("every line", "the notes"),
        "Write a description of 2 to 4 sentences that makes someone want to listen, and 3 to 7 key points "
        "(one short sentence each). Only use what is said in the episode.",
        'Reply as JSON: {"description": "...", "key_points": ["..."]}.',
    ]
    plan = "\n".join(f"- {c['title']}" for c in chapters)
    user = f"Show: {show}\nEpisode: {ep.title}\nChapters:\n{plan}\n\nTranscript:\n{transcript}"
    return [{"role": "system", "content": "\n".join(rules)}, {"role": "user", "content": user}]


# ---------------------------------------------------------------- running it

def _ask(messages, schema, tokens, tick, temperature=0.8):
    from app.llm import chat_sync

    return chat_sync("creative", messages, schema=schema, think=False, temperature=temperature,
                     max_tokens=tokens, tick=tick).data


def write_episode(ep: PodcastEpisode, hosts: list[dict], material: str, progress) -> tuple[str, list[dict]]:
    words = words_for(ep.target_minutes)
    tokens = max_tokens(words, ep.language)
    if ep.target_minutes <= LONG_MINUTES:
        progress(0.3, "Writing the episode")
        out = _ask(episode_messages(ep, hosts, material, words), WEpisode, tokens,
                   lambda: progress(0.3, "Writing the episode"))
        return out.title, [c.model_dump() for c in out.chapters]
    progress(0.2, "Planning the chapters")
    outline = _ask(outline_messages(ep, hosts, material, words), Outline, 2000,
                   lambda: progress(0.2, "Planning the chapters"), temperature=0.6)
    if not outline.chapters:
        raise WriteError("The LLM planned no chapters; try again")
    per = max(80, words // len(outline.chapters))
    chapters, before = [], []
    for i, ch in enumerate(outline.chapters):
        msg = f"Writing chapter {i + 1} of {len(outline.chapters)}"
        frac = 0.25 + 0.7 * i / len(outline.chapters)
        part = _ask(chapter_messages(ep, hosts, outline, i, per, material, before), WLines,
                    max_tokens(per, ep.language), lambda: progress(frac, msg))
        progress(frac, msg)
        chapters.append({"title": ch.title, "lines": [ln.model_dump() for ln in part.lines]})
        before = [f"{ln.host}: {ln.text}" for ln in part.lines]
    return outline.title, chapters


def _episode(db, job):
    ep = db.get(PodcastEpisode, (job.payload or {}).get("episode_id") or "")
    if ep is None:
        raise WriteError("The episode no longer exists")
    return ep


def _write(ctx, ep: PodcastEpisode) -> dict:
    hosts = ep.hosts or []
    if not hosts:
        raise WriteError("Add at least one host first")
    src = ep.sources or {}
    text = ingest.material(src)
    summarised = 0
    if text:
        text, summarised = ingest.condensed(text, src.get("topic") or "",
                                            tick=lambda n, k: ctx.progress(0.05 + 0.15 * n / k,
                                                                           f"Reading the material ({n}/{k})"))
    elif not (src.get("topic") or "").strip():
        raise WriteError("Give the episode a topic or some material first")
    title, chapters = write_episode(ep, hosts, text, ctx.progress)
    chapters_out, lines = sv.lines_from_chapters(chapters, hosts)
    if not lines:
        raise WriteError("The LLM wrote no lines; try again")
    s = sv.ensure_script(ctx.db, ep)
    ep.chapters = chapters_out
    s.lines = lines
    if title.strip() and (ep.title or "").strip().lower() in ("", "new episode", "untitled"):
        ep.title = " ".join(title.split())[:200]
    s.title = ep.title[:200]
    dl.refresh(ctx.db, s)
    return {"chapters": len(chapters_out), "lines": len(lines), "words": sv.word_count(lines),
            "summarised_chunks": summarised}


def _edit(ctx, ep: PodcastEpisode, p: dict) -> dict:
    op = p.get("op_edit")
    s = ctx.db.get(VoiceScript, ep.script_id or "")
    if s is None or op not in EDIT_OPS:
        raise WriteError("There's no script to edit")
    lines = list(s.lines or [])
    if op == "rewrite_chapter":
        cid = p.get("chapter_id")
        picked = [ln for ln in lines if ln.get("chapter_id") == cid]
    else:
        want = set(p.get("line_ids") or [])
        picked = [ln for ln in lines if ln["id"] in want]
    picked = [ln for ln in picked if dl.needs_tts(ln) or dl.kind_of(ln) == "recording"]
    if not picked:
        raise WriteError("Those lines aren't in the script any more")
    hosts = ep.hosts or []
    names = {c["id"]: c["name"] for c in s.cast or []}
    rows = [(names.get(ln["speaker_id"], "Narrator"), ln.get("text") or "") for ln in picked]
    cid = picked[0].get("chapter_id")
    ch_title = next((c["title"] for c in ep.chapters or [] if c["id"] == cid), "")
    ctx.progress(0.2, "Rewriting the lines")
    words = sum(len(t.split()) for _, t in rows)
    out = _ask(edit_messages(ep, hosts, op, rows, ch_title, p.get("note") or ""), WLines,
               max_tokens(max(words, 100) * 2, ep.language), lambda: ctx.progress(0.3, "Rewriting the lines"))
    new = []
    for i, r in enumerate(out.lines):
        if not " ".join(r.text.split()):
            continue
        h = sv.host_for(r.host, hosts, i) if hosts else None
        new.append(sv.new_line(h, r.text, cid))
    if not new:
        raise WriteError("The LLM sent back no lines; try again")
    gone = {ln["id"] for ln in picked}
    first = next(i for i, ln in enumerate(lines) if ln["id"] in gone)
    kept = [ln for ln in lines if ln["id"] not in gone]
    # the new lines go where the first picked one was
    at = sum(1 for ln in lines[:first] if ln["id"] not in gone)
    s.lines = kept[:at] + new + kept[at:]
    dl.refresh(ctx.db, s)
    return {"op": op, "replaced": len(picked), "lines": len(new)}


def transcript_text(timeline: list[dict], limit: int = ingest.DIRECT_CHARS) -> str:
    rows = [f"{t.get('name') or 'Host'}: {t['text']}" for t in timeline if (t.get("text") or "").strip()]
    text = "\n".join(rows)
    return text if len(text) <= limit else text[:limit] + "\n[…]"


def _notes(ctx, ep: PodcastEpisode) -> dict:
    from app.models import PodcastShow

    mix = (ep.outputs or {}).get("mix") or {}
    if not mix.get("timeline"):
        raise WriteError("Mix the episode first; the notes need its timings")
    show = ctx.db.get(PodcastShow, ep.show_id) if ep.show_id else None
    ctx.progress(0.2, "Writing the show notes")
    out = make_notes(ep, show.name if show else "", mix, lambda: ctx.progress(0.3, "Writing the show notes"))
    ep.notes = out
    return {"key_points": len(out["key_points"])}


def make_notes(ep: PodcastEpisode, show: str, mix: dict, tick=None) -> dict:
    chapters = mix.get("chapters") or []
    res = _ask(notes_messages(ep, show, transcript_text(mix.get("timeline") or []), chapters), Notes, 1500, tick,
               temperature=0.5)
    return {"description": " ".join(res.description.split()),
            "key_points": [" ".join(k.split()) for k in res.key_points if k.strip()][:10],
            "chapters": [{"title": c["title"], "start": c["start"]} for c in chapters]}


def handle_write(ctx) -> dict:
    db, job = ctx.db, ctx.job
    p = job.payload or {}
    ep = _episode(db, job)
    op = p.get("op") or "write"
    ctx.progress(0.02, "Starting")
    if op == "notes":
        return _notes(ctx, ep)
    if op == "edit":
        return _edit(ctx, ep, p)
    return _write(ctx, ep)
