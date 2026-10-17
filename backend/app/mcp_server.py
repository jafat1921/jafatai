"""The MCP server (M12c, Update 3): the studio as tools for Claude and other MCP clients, at /api/mcp.

Streamable HTTP, stateless, plain JSON answers, so Caddy needs no special handling and nothing is kept between
calls. Auth is the API token (Authorization: Bearer mxa_...) with the REST scopes; tools a token can't use are
left out of tools/list. Every tool calls the route function it mirrors, so validation, ownership and queueing
stay in one place. Route errors (HTTPException) come back as tool errors with the same message.
"""
import asyncio
import json
from collections.abc import Iterator
from contextlib import asynccontextmanager, contextmanager
from dataclasses import replace
from typing import Annotated, Any, Literal

import anyio
from fastapi import HTTPException
from fastapi.encoders import jsonable_encoder
from mcp.server.mcpserver import Context, Image, MCPServer, UserMessage
from mcp.server.mcpserver.exceptions import ResourceError, ToolError
from mcp.server.transport_security import TransportSecuritySettings
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session
from starlette.requests import Request
from starlette.responses import JSONResponse

from app import file_links, thumbs
from app import character_sheet as cs
from app import library as lib
from app.api import audio, characters, generations, jobs, library, podcast, projects, quick, stems, videos, voices
from app.api import gallery as gallery_api
from app.api import transcribe as transcribe_api
from app.api.quick import QuickIn
from app.api.media import resolve_media_path
from app.api.stems import StemsIn
from app.autopilot import portrait_fallback
from app.config import get_settings
from app.db import SessionLocal
from app.dialogue_schemas import RenderIn
from app.dub.schemas import TranscribeIn
from app.models import Character, Generation, Job, Transcript
from app.podcast.schemas import EpisodeIn, Format, Host
from app.schemas import (AudioGenerateIn, CharacterCreate, CharacterPatch, GenerationCreate, ImageAspect, ImageEditIn,
                         ImageGenerateIn, JobOut, MediaItemOut, SheetIn, SpeakDesignIn, SpeakIn, UpscaleIn, VideoAspect,
                         VideoGenerateIn, _iso)
from app.security import CurrentUser, bearer_token, resolve_token
from app.services import READY_STATES, job_out
from app.transcripts import TRANSCRIBE_JOB

DONE = ("done", "failed", "cancelled")
WAIT_MAX_S = 60
INLINE_MAX_BYTES = 750_000  # bigger pictures go inline as their 512 px preview
STATE_KEY = "mixai.mcp"  # the ASGI scope slot the endpoint leaves the token's (scopes, role) in

INSTRUCTIONS = """Mix AI Cinema Studio: make pictures, video, music, speech and characters on the studio's own GPUs.

Anything slow returns job ids straight away. Call wait_for_job (up to 60 s a call, repeat as needed) or get_job,
and when a job is done it carries a download_url. get_media gives the same for any Library item. Download links
last ten minutes; ask again for a fresh one. Ids from one tool (media_id, generation_id, character_id) can be
passed to the others."""

server = MCPServer("mixai", title="Mix AI Cinema Studio", instructions=INSTRUCTIONS, version="1.0",
                   log_level="WARNING")

# tool name -> the token scope it needs; tools/list leaves out what the caller's token can't use
TOOL_SCOPE: dict[str, str] = {}


def tool(scope: str, **kw):
    def deco(fn):
        TOOL_SCOPE[fn.__name__] = scope
        return server.tool(**kw)(fn)
    return deco


def allowed(scopes: frozenset[str] | None, role: str, scope: str) -> bool:
    if scopes is None or scope not in scopes:
        return False
    # roles still apply: a viewer whose token was made back when they were an editor can only read
    return scope == "read" or role != "viewer"


# ---------------------------------------------------------------- who is calling

def _raw_token(ctx: Context) -> str | None:
    req = ctx.request_context.request
    return bearer_token(req) if isinstance(req, Request) else None


@contextmanager
def acting(ctx: Context, scope: str, err: type[Exception] = ToolError) -> Iterator[tuple[Session, CurrentUser]]:
    """A DB session and the token's user for one tool call. The token is checked again on every call, so
    revoking it cuts off a client mid-conversation. Resources pass ResourceError so failures read the same."""
    raw = _raw_token(ctx)
    with SessionLocal() as db:
        cur = resolve_token(db, raw) if raw else None
        if cur is None:
            raise err("Invalid, expired or revoked API token")
        if not allowed(cur.scopes, cur.role, scope):
            raise err(f"This token can't do that: it needs the '{scope}' scope"
                            + (" and an editor role" if cur.role == "viewer" and scope != "read" else ""))
        # what an MCP client makes shows in the studio like the user's own work (contract v34)
        cur = replace(cur, channel="mcp")
        try:
            yield db, cur
        except HTTPException as e:
            db.rollback()
            detail = e.detail if isinstance(e.detail, str) else json.dumps(jsonable_encoder(e.detail))
            raise err(detail) from None


def _origin(ctx: Context) -> str:
    req = ctx.request_context.request
    # uvicorn runs with --proxy-headers, so behind Caddy this is the public https origin
    return str(req.base_url).rstrip("/") if isinstance(req, Request) else ""


# ---------------------------------------------------------------- shaping answers for a model to read

def _job(j: Job | JobOut) -> dict:
    j = j if isinstance(j, JobOut) else job_out(j)
    out = {"job_id": j.id, "type": j.type, "status": j.status, "progress": round(j.progress or 0, 2),
           "message": j.message}
    if j.error:
        out["error"] = j.error
    if j.generation_id:
        out["generation_id"] = j.generation_id
    if j.project_id:
        out["project_id"] = j.project_id
    return out


ITEM_KEYS = ("title", "kind", "status", "generation_id", "media_type", "width", "height", "duration_s", "created_at")


def _item(i: MediaItemOut) -> dict:
    data = i.model_dump(mode="json")
    return {"media_id": i.id, **{k: data[k] for k in ITEM_KEYS if data.get(k) is not None}}


def _batch(out, **extra) -> dict:
    return {"items": [_item(i) for i in out.items], "jobs": [_job(j) for j in out.jobs], **extra,
            "next": "wait_for_job with each job_id; the finished job carries a download_url"}


def _file_info(db: Session, g: Generation, origin: str) -> dict:
    out = {"generation_id": g.id, "media_type": g.media_type}
    if g.status in READY_STATES and resolve_media_path(g.file_path or "", g.workspace_id, get_settings().data_dir):
        out["download_url"] = file_links.url_for(g, origin)
        out["download_expires_in_s"] = file_links.TTL_S
    return out


def _job_report(db: Session, cur: CurrentUser, job_id: str, origin: str) -> dict:
    j = jobs.get_job(job_id, db=db, cur=cur)
    out = _job(j)
    if j.status != "done":
        return out
    if j.generation_id:
        g = db.get(Generation, j.generation_id)
        if g is not None:
            out.update(_file_info(db, g, origin))
    if j.type == TRANSCRIBE_JOB:
        t = db.get(Transcript, (db.get(Job, j.id).payload or {}).get("transcript_id") or "")
        if t is not None:
            out["transcript"] = {"transcript_id": t.id, "language": t.language, "text": t.text,
                                 "duration_s": t.duration_s}
    if j.result and j.type != "autopilot":
        out["result"] = jsonable_encoder(j.result)
    return out


# ---------------------------------------------------------------- generate

# contract v37: a clip or picture made as one piece of something bigger stays out of the studio's lists
PART_OF = ("What this is a piece of, e.g. story:<id>. It stays out of the studio's general lists; fetch it "
           "by id with get_media")

@tool("generate", title="Generate images")
def generate_image(
    ctx: Context,
    prompt: Annotated[str, Field(min_length=1, max_length=4000, description="What to draw")],
    aspect: Annotated[ImageAspect, Field(description="Output shape, about 1 megapixel")] = "1:1",
    count: Annotated[int, Field(ge=1, le=4, description="Pictures to make; one job each")] = 1,
    negative: Annotated[str | None, Field(max_length=2000, description="Things to keep out")] = None,
    style: Annotated[str | None, Field(description="A style id, e.g. cinematic, anime, watercolor")] = None,
    seed: Annotated[int | None, Field(ge=0, le=2**31 - 1)] = None,
    model: Annotated[str | None, Field(max_length=60, description="A model id, or empty for the default")] = None,
    part_of: Annotated[str | None, Field(max_length=80, description=PART_OF)] = None,
) -> dict:
    """Make pictures from a text prompt. Returns the new Library items and one job per picture."""
    with acting(ctx, "generate") as (db, cur):
        out = library.generate_images(ImageGenerateIn(prompt=prompt, aspect=aspect, count=count, negative=negative,
                                                      style=style, seed=seed, model=model, part_of=part_of),
                                      db=db, cur=cur)
        return _batch(out, model=out.model_resolved)


@tool("generate", title="Edit an image")
def edit_image(
    ctx: Context,
    source_ids: Annotated[list[str], Field(min_length=1, max_length=8, description="Finished image ids (media_id "
                                                                                   "or generation_id); the first "
                                                                                   "is the one edited, the rest are "
                                                                                   "references")],
    instruction: Annotated[str, Field(min_length=1, max_length=4000, description="What to change")],
    aspect: Annotated[ImageAspect | None, Field(description="Empty keeps the first picture's shape")] = None,
    count: Annotated[int, Field(ge=1, le=4)] = 1,
    seed: Annotated[int | None, Field(ge=0, le=2**31 - 1)] = None,
) -> dict:
    """Edit pictures with an instruction ("make it night", "put the hat from picture 2 on her")."""
    with acting(ctx, "generate") as (db, cur):
        out = library.edit_images(ImageEditIn(source_ids=source_ids, instruction=instruction, aspect=aspect,
                                              count=count, seed=seed), db=db, cur=cur)
        return _batch(out, model=out.model_resolved)


@tool("generate", title="Upscale")
def upscale(
    ctx: Context,
    id: Annotated[str, Field(description="A finished image or video: media_id or generation_id")],
    target: Annotated[Literal["2x", "4x", "2k", "4k", "1080p", "1440p"] | None,
                      Field(description="Images: 2x, 4x, 2k or 4k (default 2x). Videos: 1080p, 1440p or 4k "
                                        "(default 1080p)")] = None,
    engine: Annotated[Literal["redraw", "faithful", "quick", "anime", "cartoon", "best", "fast"] | None,
                      Field(description="Images: redraw, faithful, quick, anime or cartoon. Videos: best, fast or "
                                        "quick. Empty picks the default")] = None,
) -> dict:
    """Upscale a picture or a video. The result is a new version of the same Library item."""
    with acting(ctx, "generate") as (db, cur):
        j = generations.upscale_generation(id, UpscaleIn(engine=engine, target=target), db=db, cur=cur)
        return _job(j)


@tool("generate", title="Generate a video")
def generate_video(
    ctx: Context,
    prompt: Annotated[str, Field(min_length=1, max_length=4000, description="The scene and its motion")],
    duration_s: Annotated[float, Field(ge=1, le=300, description="Seconds; long ones render in chunks")] = 5.0,
    aspect: Annotated[VideoAspect | None, Field(description="Empty: the start image's shape, else 16:9")] = None,
    image_id: Annotated[str | None, Field(description="Start frame: a finished image's media_id or "
                                                      "generation_id")] = None,
    end_image_id: Annotated[str | None, Field(description="Last frame; needs image_id")] = None,
    quality: Annotated[Literal["standard", "hq"] | None, Field(description="hq is slower")] = None,
    seed: Annotated[int | None, Field(ge=0, le=2**31 - 1)] = None,
    part_of: Annotated[str | None, Field(max_length=80, description=PART_OF)] = None,
) -> dict:
    """Make a video clip from a prompt, optionally starting from a picture. Takes minutes; returns one job."""
    with acting(ctx, "generate") as (db, cur):
        out = videos.generate_video(VideoGenerateIn(prompt=prompt, duration_s=duration_s, aspect=aspect,
                                                    image_id=image_id, end_image_id=end_image_id, quality=quality,
                                                    seed=seed, part_of=part_of), db=db, cur=cur)
        return {"items": [_item(out)], "jobs": [_job(out.job)] if out.job else [], "model": out.model_resolved}


def _audio(ctx: Context, body: AudioGenerateIn) -> dict:
    with acting(ctx, "generate") as (db, cur):
        out = audio.generate_audio(body, db=db, cur=cur)
        return _batch(out, model=out.model_resolved)


@tool("generate", title="Make a song")
def make_song(
    ctx: Context,
    prompt: Annotated[str, Field(min_length=1, max_length=2000, description="Genre, mood, instruments, voice")],
    lyrics: Annotated[str, Field(max_length=6000, description="With [verse] / [chorus] section markers")] = "",
    language: Annotated[str, Field(pattern=r"^[a-z]{2,3}(-[a-z]{2,4})?$", description="ISO 639-1 of the "
                                                                                      "lyrics")] = "en",
    vocal: Literal["male", "female", "duet", "none"] | None = None,
    duration_s: Annotated[float, Field(ge=10, le=380)] = 60.0,
    bpm: Annotated[int | None, Field(ge=40, le=220)] = None,
    count: Annotated[int, Field(ge=1, le=4)] = 1,
) -> dict:
    """Make a song with sung lyrics. Urdu and Arabic lyrics get their vowel marks added before singing."""
    return _audio(ctx, AudioGenerateIn(kind="song", prompt=prompt, lyrics=lyrics, language=language, vocal=vocal,
                                       duration_s=duration_s, bpm=bpm, count=count))


@tool("generate", title="Make music")
def make_music(
    ctx: Context,
    prompt: Annotated[str, Field(min_length=1, max_length=2000, description="Genre, mood, instruments, tempo")],
    duration_s: Annotated[float, Field(ge=1, le=380)] = 30.0,
    bpm: Annotated[int | None, Field(ge=40, le=220)] = None,
    count: Annotated[int, Field(ge=1, le=4)] = 1,
) -> dict:
    """Make instrumental music (no vocals): beds, scores, loops."""
    return _audio(ctx, AudioGenerateIn(kind="music", prompt=prompt, duration_s=duration_s, bpm=bpm, count=count))


@tool("generate", title="Make a sound effect")
def make_sfx(
    ctx: Context,
    prompt: Annotated[str, Field(min_length=1, max_length=2000, description="The sound, e.g. 'a heavy wooden "
                                                                           "door creaks open'")],
    duration_s: Annotated[float, Field(ge=1, le=60)] = 4.0,
    count: Annotated[int, Field(ge=1, le=4)] = 1,
) -> dict:
    """Make a sound effect."""
    return _audio(ctx, AudioGenerateIn(kind="sfx", prompt=prompt, duration_s=duration_s, count=count))


@tool("generate", title="Speak text")
def speak(
    ctx: Context,
    text: Annotated[str, Field(min_length=1, max_length=5000, description="What to say")],
    voice_id: Annotated[str | None, Field(description="From list_voices (a library id or gallery:<id>). Give this "
                                                      "or voice_description")] = None,
    voice_description: Annotated[str | None, Field(max_length=500, description="Describe a new voice instead, e.g. "
                                                                               "'warm older man, British accent'")]
    = None,
    language: Annotated[str | None, Field(pattern=r"^[a-z]{2,3}(-[a-z]{2,4})?$", description="ISO 639-1; empty "
                                                                                             "uses the voice's")]
    = None,
    speed: Annotated[float, Field(ge=0.5, le=2.0)] = 1.0,
    part_of: Annotated[str | None, Field(max_length=80, description=PART_OF)] = None,
) -> dict:
    """Text to speech in a library voice, a gallery voice or a described one."""
    design = SpeakDesignIn(description=voice_description) if voice_description and not voice_id else None
    with acting(ctx, "generate") as (db, cur):
        out = audio.speak(SpeakIn(text=text, voice_id=voice_id, design=design, language=language, speed=speed,
                                  part_of=part_of), db=db, cur=cur)
        return _batch(out, engine=out.engine_resolved)


@tool("generate", title="Transcribe")
def transcribe(
    ctx: Context,
    media_id: Annotated[str, Field(description="A Library audio or video item")],
    language: Annotated[str | None, Field(max_length=12, description="ISO 639-1 of the speech; empty detects "
                                                                     "it")] = None,
) -> dict:
    """Transcribe speech with timings. When the job is done, get_job returns the text."""
    with acting(ctx, "generate") as (db, cur):
        out = transcribe_api.transcribe(TranscribeIn(media_id=media_id, language=language), db=db, cur=cur)
        return {"transcript_id": out["transcript_id"], **_job(out["job"])}


@tool("generate", title="Separate stems")
def separate_stems(
    ctx: Context,
    media_id: Annotated[str, Field(description="A Library audio item, or a video with sound")],
    mode: Annotated[Literal["two", "four"], Field(description="two: vocals + the rest. four: vocals, drums, bass, "
                                                              "other")] = "two",
) -> dict:
    """Split a track into stems. The stems arrive as new Library items when the job is done."""
    with acting(ctx, "generate") as (db, cur):
        return _job(stems.split(media_id, StemsIn(mode=mode), db=db, cur=cur)["job"])


# ---------------------------------------------------------------- characters

@tool("generate", title="Create a character")
def create_character(
    ctx: Context,
    name: Annotated[str, Field(min_length=1, max_length=200)],
    description: Annotated[str, Field(max_length=4000, description="Looks, clothes, manner. The portrait and "
                                                                   "sheet start from this")] = "",
    profile: Annotated[dict[str, str] | None, Field(description="Identity fields: age, gender, role, nationality, "
                                                                "height, languages, accent...")] = None,
    make_portrait: Annotated[bool, Field(description="Queue a reference portrait now; a sheet needs one")] = True,
) -> dict:
    """Add a character to the Character Studio library, and start its reference portrait."""
    with acting(ctx, "generate") as (db, cur):
        c = characters.create_studio_character(CharacterCreate(name=name, description=description, profile=profile),
                                               db=db, cur=cur)
        out = {"character_id": c.id, "name": c.name}
        if make_portrait:
            row = db.get(Character, c.id)
            g = generations.create_generation(GenerationCreate(target_type="character", target_id=c.id,
                                                               kind="portrait", prompt=portrait_fallback(row)),
                                              db=db, cur=cur)
            out["portrait"] = _job(db.get(Job, g.job_id))
            out["next"] = "When the portrait job is done, make_character_sheet"
        return out


@tool("generate", title="Make a character sheet")
def make_character_sheet(
    ctx: Context,
    character_id: str,
    preset: Annotated[Literal["essential", "full"], Field(description="essential: about 10 panels, a few minutes. "
                                                                      "full: about 30, 15-20 minutes")]
    = "essential",
    backdrop: Literal["grey", "dark"] | None = None,
) -> dict:
    """Queue a reference sheet (turnaround, expressions, close-up...), each panel drawn from the portrait.
    Needs a finished portrait. Panels already made are kept."""
    with acting(ctx, "generate") as (db, cur):
        out = characters.make_sheet(character_id, SheetIn(preset=preset, backdrop=backdrop), db=db, cur=cur)
        return {"character_id": character_id, "queued": out["queued"], "estimate": out.get("estimate"),
                "panels": [{"key": p["key"], "status": p["status"], "job_id": p["live_job_id"]}
                           for p in out["panels"]],
                "next": f"Read mixai://characters/{character_id} to follow the panels"}


@tool("generate", title="Set a character's voice")
def set_character_voice(
    ctx: Context,
    character_id: str,
    voice_id: Annotated[str, Field(max_length=80, description="From list_voices; empty clears it")],
) -> dict:
    """Give a character a voice; film dialogue and test clips speak in it."""
    with acting(ctx, "generate") as (db, cur):
        c = characters.patch_character(character_id, CharacterPatch(voice_id=voice_id), db=db, cur=cur)
        return {"character_id": c.id, "name": c.name, "voice_id": c.voice_id}


# ---------------------------------------------------------------- podcast

@tool("generate", title="Write a podcast episode")
def write_podcast_episode(
    ctx: Context,
    topic: Annotated[str, Field(min_length=1, max_length=2000, description="What the episode is about")],
    hosts: Annotated[list[Host], Field(min_length=1, max_length=4, description="Who speaks; voice_id from "
                                                                               "list_voices")],
    title: Annotated[str, Field(min_length=1, max_length=200)] = "New episode",
    format: Format = "conversation",
    language: Annotated[str | None, Field(pattern=r"^[a-z]{2,3}(-[a-z]{2,4})?$")] = None,
    target_minutes: Annotated[float, Field(ge=0.5, le=120)] = 5.0,
) -> dict:
    """Create a podcast episode and have the writer script it. Then render_podcast."""
    with acting(ctx, "generate") as (db, cur):
        ep = podcast.create_episode(EpisodeIn(title=title, format=format, language=language,
                                              target_minutes=target_minutes, hosts=hosts, topic=topic), db=db, cur=cur)
        j = podcast.write(ep.id, db=db, cur=cur)
        return {"episode_id": ep.id, **_job(j), "next": "When the script is written, render_podcast step=voices"}


@tool("generate", title="Render a podcast")
def render_podcast(
    ctx: Context,
    episode_id: str,
    step: Annotated[Literal["voices", "mix"], Field(description="voices: speak every line (one job each). mix: "
                                                                "once they're done, put the episode together")]
    = "voices",
) -> dict:
    """Render a written episode: first its voices, then the mix (one audio file)."""
    with acting(ctx, "generate") as (db, cur):
        if step == "mix":
            return {"episode_id": episode_id, **_job(podcast.mix(episode_id, db=db, cur=cur))}
        out = podcast.render(episode_id, RenderIn(), db=db, cur=cur)
        return {"episode_id": episode_id, "queued": out.queued, "failed": out.failed,
                "jobs": [_job(j) for j in out.jobs], "next": "When the line jobs are done, render_podcast step=mix"}


# ---------------------------------------------------------------- projects

@tool("read", title="List film projects")
def list_projects(ctx: Context) -> dict:
    """The workspace's film projects, newest first."""
    with acting(ctx, "read") as (db, cur):
        rows = projects.list_projects(db=db, cur=cur)
        return {"projects": [{"project_id": p.id, "title": p.title, "status": p.status, "logline": p.logline,
                              "aspect_ratio": p.aspect_ratio, "runtime_s": p.target_runtime_s,
                              "updated_at": _iso(p.updated_at)} for p in rows[:100]]}


@tool("generate", title="Make a film from an idea")
def create_project_from_idea(
    ctx: Context,
    idea: Annotated[str, Field(min_length=3, max_length=4000, description="The film in a few sentences")],
    duration_s: Annotated[float, Field(ge=5, description="Target runtime in seconds")] = 30,
    aspect_ratio: Literal["16:9", "9:16", "1:1"] = "16:9",
    style: Literal["cinematic", "documentary", "animated", "commercial"] = "cinematic",
    dialogue: bool = True,
) -> dict:
    """Quick Create: the autopilot writes, casts, storyboards and renders a whole short film. Takes a long time;
    poll the job, or read mixai://projects/{project_id}."""
    with acting(ctx, "generate") as (db, cur):
        out = quick.quick_create(QuickIn(prompt=idea, duration_s=duration_s, aspect_ratio=aspect_ratio, style=style,
                                         dialogue=dialogue), db=db, cur=cur)
        return {"project_id": out.project.id, "title": out.project.title, **_job(out.job)}



@tool("generate", title="Make an ad campaign")
def make_ad_campaign(
    ctx: Context,
    subject: Annotated[str, Field(min_length=1, max_length=200, description="The service or product")],
    language: Annotated[str, Field(pattern=r"^[a-z]{2,3}(-[a-z]{2,4})?$", description="ISO 639-1 of the copy")]
    = "en",
    offers: Annotated[list[str], Field(max_length=6, description="The only prices, discounts or promises the "
                                                                 "copy may use, word for word")] = [],
    brief: Annotated[str, Field(max_length=2000)] = "",
    occasion: Annotated[str, Field(max_length=120)] = "",
    market: Annotated[str, Field(max_length=120)] = "",
    tone: Annotated[str, Field(max_length=120)] = "",
    formats: list[Literal["4:5", "9:16", "1:1", "16:9", "1.91:1", "2:3", "yt"]] = ["4:5"],
    variants: Annotated[int, Field(ge=2, le=8)] = 3,
    brand_kit_id: str | None = None,
    product_media_ids: Annotated[list[str], Field(max_length=3)] = [],
) -> dict:
    """Ad Studio: concepts by an AI creative director, a photo each, and finished adverts with the brand kit's
    logo, colours and contact footer, laid out per format. Runs in one go; the ads land in the Library."""
    from app.api.ads import CreateIn, create_campaign

    with acting(ctx, "generate") as (db, cur):
        out = create_campaign(CreateIn(subject=subject, language=language, offers=offers, brief=brief,
                                       occasion=occasion, market=market, tone=tone, formats=formats,
                                       variants=variants, brand_kit_id=brand_kit_id,
                                       product_media_ids=product_media_ids, review=False), db=db, cur=cur)
        return {"campaign_id": out["id"], "title": out["title"], **_job(db.get(Job, out["job"]["id"])),
                "next": "When the job is done, search_library for the ads (tag 'ad')"}


@tool("generate", title="Make a Poetry Short")
def make_poetry_short(
    ctx: Context,
    topic: Annotated[str, Field(max_length=500, description="What the poem is about (or give poem)")] = "",
    poem: Annotated[str, Field(max_length=4000, description="Your own poem, used word for word")] = "",
    language: Annotated[str, Field(pattern=r"^[a-z]{2,3}(-[a-z]{2,4})?$")] = "ur",
    title: Annotated[str, Field(max_length=200)] = "",
    mood: Annotated[str, Field(max_length=200)] = "",
    style: Annotated[str, Field(max_length=300, description="Music style tags for the singer")] = "",
    vocal: Literal["female", "male"] = "female",
    length_s: Annotated[float, Field(ge=30, le=90)] = 60,
    character: Annotated[str, Field(max_length=500, description="Short description of the person on screen")] = "",
    character_id: str | None = None,
    setting: Annotated[str, Field(max_length=600)] = "",
    aspect: Literal["9:16", "16:9", "1:1"] = "9:16",
    quality: Literal["draft", "final"] = "draft",
) -> dict:
    """A poem sung by ACE-Step, timed line by line and cut to slow cinematic scenes with the verses burned in.
    Runs straight through (no review stops); takes 15-30 minutes. Follow it with get_poetry_short."""
    from app.api.poetry import CreateIn, create_short

    with acting(ctx, "generate") as (db, cur):
        out = create_short(CreateIn(topic=topic, poem=poem, language=language, title=title, mood=mood, style=style,
                                    vocal=vocal, length_s=length_s, character=character, character_id=character_id,
                                    setting=setting, aspect=aspect, quality=quality, review=False), db=db, cur=cur)
        return {"short_id": out["id"], "title": out["title"], "job_id": (out["job"] or {}).get("id"),
                "next": "get_poetry_short until status is done, then get_media on video.media_id"}


@tool("generate", title="Carry on a Poetry Short")
def continue_poetry_short(ctx: Context, short_id: str) -> dict:
    """Retry a failed stage of a Poetry Short (or approve the one under review) and run on from there."""
    from app.api.poetry import continue_short

    with acting(ctx, "generate") as (db, cur):
        return {"short_id": short_id, **_job(continue_short(short_id, db=db, cur=cur))}


@tool("read", title="Get a Poetry Short")
def get_poetry_short(ctx: Context, short_id: str) -> dict:
    """Where a Poetry Short is: each stage's status, the poem, and the finished video once rendered."""
    from app.api.poetry import get_short

    with acting(ctx, "read") as (db, cur):
        s = jsonable_encoder(get_short(short_id, db=db, cur=cur))
        o = s.get("outputs") or {}
        return {"short_id": s["id"], "title": s["title"], "status": s["status"], "stage": s["stage"],
                "stages": [{k: st.get(k) for k in ("key", "status", "detail")} for st in s["stages"]],
                "poem": s["poem"]["lyrics"],
                "video": {k: o.get(k) for k in ("media_id", "duration_s", "width", "height")} if o else None,
                **({"job": _job(db.get(Job, s["job"]["id"]))} if s.get("job") else {})}

# ---------------------------------------------------------------- jobs

@tool("read", title="Get a job")
def get_job(ctx: Context, job_id: str) -> dict:
    """A job's status and progress (0-1). Once done it has a download_url (or the transcript)."""
    with acting(ctx, "read") as (db, cur):
        return _job_report(db, cur, job_id, _origin(ctx))


@tool("read", title="Wait for a job")
async def wait_for_job(
    ctx: Context,
    job_id: str,
    timeout_s: Annotated[int, Field(ge=1, le=WAIT_MAX_S, description="Give up waiting after this long")] = 30,
) -> dict:
    """Wait until a job finishes, up to 60 seconds, then return it. If it's still running, call again."""
    origin = _origin(ctx)

    def check() -> dict:
        with acting(ctx, "read") as (db, cur):
            return _job_report(db, cur, job_id, origin)

    waited = 0.0
    while True:
        out = await anyio.to_thread.run_sync(check)
        if out["status"] in DONE or waited >= timeout_s:
            out["waited_s"] = round(waited)
            return out
        step = min(2.0, timeout_s - waited)
        await anyio.sleep(step)
        waited += step


# ---------------------------------------------------------------- library and voices

@tool("read", title="Search the Library")
def search_library(
    ctx: Context,
    query: Annotated[str | None, Field(max_length=200, description="Words in the title or prompt")] = None,
    kind: Literal["image", "video", "audio"] | None = None,
    limit: Annotated[int, Field(ge=1, le=60)] = 20,
) -> dict:
    """Find pictures, videos and audio in the Library, newest first."""
    with acting(ctx, "read") as (db, cur):
        page = library.list_media(kind=kind, origin=None, q=query, tag=None, project_id=None, include=None,
                                  folder_id=None, favourite=False, limit=limit, cursor=None, home=None,
                                  include_home=None, db=db, cur=cur)
        return {"items": [_item(i) for i in page.items], "more": page.next_cursor is not None}


def _preview(db: Session, g: Generation) -> Image | None:
    if not (g.media_type or "").startswith("image/") or g.status not in READY_STATES:
        return None
    src = resolve_media_path(g.file_path or "", g.workspace_id, get_settings().data_dir)
    if src is None:
        return None
    if src.stat().st_size <= INLINE_MAX_BYTES and g.media_type in ("image/png", "image/jpeg", "image/webp"):
        return Image(data=src.read_bytes(), format=g.media_type.split("/")[1])
    small = thumbs.ensure(src, g.media_type, 512)
    return Image(data=small.read_bytes(), format="png" if small.suffix == ".png" else "webp") if small else None


def _media(db: Session, cur: CurrentUser, id: str, origin: str) -> tuple[dict, Generation | None]:
    found = lib.detail(db, cur.workspace_id, id)
    if found is not None:
        g = db.get(Generation, found.generation_id) if found.generation_id else None
        out = {**_item(found), "versions": len(found.versions)}
        prompt = (found.params or {}).get("user_prompt") or (g.prompt if g else None)
    else:
        # a character portrait, sheet panel or other generation that isn't a Library item of its own
        g = db.get(Generation, id)
        if g is None or g.workspace_id != cur.workspace_id:
            raise HTTPException(404, "Media not found")
        out = {"generation_id": g.id, "kind": g.kind, "target_type": g.target_type, "target_id": g.target_id,
               "created_at": _iso(g.created_at)}
        prompt = g.prompt
    if prompt:
        out["prompt"] = prompt[:2000]
    if g is not None:
        out.update(_file_info(db, g, origin))
    return out, g


@tool("read", title="Get a media item")
def get_media(
    ctx: Context,
    id: Annotated[str, Field(description="A media_id or generation_id")],
    preview: Annotated[bool, Field(description="Include a picture inline when it's an image")] = True,
) -> list:
    """A Library item's details and a download_url (valid ten minutes). Images also come back inline."""
    with acting(ctx, "read") as (db, cur):
        out, g = _media(db, cur, id, _origin(ctx))
        pic = _preview(db, g) if preview and g is not None else None
        return [json.dumps(out, indent=2, ensure_ascii=False), *([pic] if pic else [])]


@tool("read", title="List voices")
def list_voices(
    ctx: Context,
    query: Annotated[str | None, Field(max_length=120)] = None,
    language: Annotated[str | None, Field(max_length=12, description="ISO 639-1")] = None,
    gallery: Annotated[bool, Field(description="Also list the built-in gallery voices")] = True,
) -> dict:
    """Voices for speak, set_character_voice and podcast hosts: your library and the gallery."""
    with acting(ctx, "read") as (db, cur):
        mine = voices.list_voices(q=query, language=language, kind=None, starred=None, db=db, cur=cur)
        out = {"library": [{"voice_id": v.id, "name": v.name, "language": v.language, "kind": v.kind,
                            "notes": v.notes[:200]} for v in mine]}
        if gallery:
            res = gallery_api.gallery(q=query, language=language, gender=None, age=None, style=None,
                                               engine=None, db=db, cur=cur)
            out["gallery"] = [{"voice_id": v["voice_id"], "name": v["name"], "language": v["language"],
                               "gender": v["gender"], "age": v["age"], "accent": v["accent"]}
                              for v in res["items"][:80]]
        return out


# ---------------------------------------------------------------- resources and the prompt

def _json(data: Any) -> str:
    return json.dumps(jsonable_encoder(data), indent=2, ensure_ascii=False)


@server.resource("mixai://media/{media_id}", name="media", mime_type="application/json",
                 description="A Library item or generation: details and a ten-minute download_url")
def media_resource(media_id: str, ctx: Context) -> str:
    with acting(ctx, "read", ResourceError) as (db, cur):
        return _json(_media(db, cur, media_id, _origin(ctx))[0])


@server.resource("mixai://characters/{character_id}", name="character", mime_type="application/json",
                 description="A character: profile, voice, portrait and the sheet panels")
def character_resource(character_id: str, ctx: Context) -> str:
    with acting(ctx, "read", ResourceError) as (db, cur):
        c = characters.get_character(character_id, db=db, cur=cur)
        sheet = cs.sheet_out(db, db.get(Character, character_id))
        return _json({
            "character_id": c.id, "name": c.name, "description": c.description, "profile": c.profile,
            "voice_id": c.voice_id, "portrait_generation_id": c.portrait.id if c.portrait else None,
            "sheet": {"preset": sheet["preset"], "backdrop": sheet["backdrop"], "estimate": sheet["estimate"],
                      "panels": [{"key": p["key"], "label": p["label"], "status": p["status"],
                                  "generation_id": p["current"].id if p["current"] else None,
                                  "job_id": p["live_job_id"]} for p in sheet["panels"]],
                      "board_media_id": sheet["board"]["media_id"]},
        })


@server.resource("mixai://projects/{project_id}", name="project", mime_type="application/json",
                 description="A film project: its settings, cast and progress counts")
def project_resource(project_id: str, ctx: Context) -> str:
    with acting(ctx, "read", ResourceError) as (db, cur):
        p = projects.get_project(project_id, db=db, cur=cur)
        cast = characters.list_characters(project_id, db=db, cur=cur)
        live = db.scalars(select(Job).where(Job.project_id == project_id, Job.status.in_(("queued", "running")))).all()
        return _json({**p.model_dump(exclude={"settings"}), "cast": [{"character_id": c.id, "name": c.name}
                                                                     for c in cast],
                      "running_jobs": [_job(j) for j in live]})


@server.prompt(name="storyboard_idea", title="Storyboard this idea")
def storyboard_idea(idea: str, duration_s: str = "30") -> list:
    """Turn a film idea into a shot-by-shot storyboard, then offer to make it."""
    return [UserMessage(
        f"Storyboard this idea as a short film of about {duration_s} seconds:\n\n{idea}\n\n"
        "Write a one-line logline, the cast (name and a visual description each), then the scenes. For every shot "
        "give its length in seconds, the framing (wide, medium, close-up...), the camera move, what happens and any "
        "spoken line with its speaker. Keep the shot lengths adding up to the runtime. When I'm happy with it, use "
        "create_project_from_idea with the logline and the scene list so the studio renders it, or create_character "
        "and generate_image for the cast and key frames first."
    )]


# ---------------------------------------------------------------- tools/list per token, and the HTTP endpoint

LISTINGS = {"tools/list": "tools", "resources/list": "resources", "resources/templates/list": "resourceTemplates",
            "prompts/list": "prompts"}


async def scope_filter(ctx, call_next):
    """Hide what the token can't use. tools/call checks again in acting(), so hiding is only cosmetic."""
    res = await call_next(ctx)
    key = LISTINGS.get(ctx.method)
    if key is None or res is None:
        return res
    req = ctx.request
    scopes, role = (req.scope.get(STATE_KEY) if isinstance(req, Request) else None) or (None, "viewer")
    data = res.model_dump(by_alias=True, exclude_none=True) if isinstance(res, BaseModel) else dict(res)
    if key == "tools":
        data["tools"] = [t for t in data.get("tools", []) if allowed(scopes, role, TOOL_SCOPE.get(t["name"], "manage"))]
    elif not allowed(scopes, role, "read"):
        data[key] = []
    return data


server.middleware.append(scope_filter)


def _check_token(raw: str) -> tuple[frozenset[str] | None, str] | None:
    with SessionLocal() as db:
        cur = resolve_token(db, raw)
        return (cur.scopes, cur.role) if cur else None


class Endpoint:
    """ASGI app for /api/mcp: refuses anything without a live token, then hands over to the SDK."""

    def __init__(self):
        # keyed by event loop: one per running app (several at once in tests, each on its own loop)
        self.managers: dict = {}

    async def __call__(self, scope, receive, send):
        request = Request(scope)
        raw = bearer_token(request)
        found = await anyio.to_thread.run_sync(_check_token, raw) if raw else None
        if found is None:
            # no cookie fallback here: an MCP client always sends its token
            msg = "Invalid, expired or revoked API token" if raw else "Send Authorization: Bearer <API token>"
            await JSONResponse({"detail": msg}, 401, headers={"WWW-Authenticate": "Bearer"})(scope, receive, send)
            return
        if request.method == "GET":
            # stateless: there's no server-to-client stream to open, and an idle one would only hold a connection
            await JSONResponse({"detail": "POST JSON-RPC messages here"}, 405,
                               headers={"Allow": "POST, DELETE"})(scope, receive, send)
            return
        manager = self.managers.get(asyncio.get_running_loop())
        if manager is None:
            await JSONResponse({"detail": "The MCP server isn't running"}, 503)(scope, receive, send)
            return
        scope[STATE_KEY] = found
        await manager.handle_request(scope, receive, send)


endpoint = Endpoint()


@asynccontextmanager
async def running():
    """One session manager per app lifespan (the SDK's can only run once, and tests start the app many times)."""
    server.streamable_http_app(
        streamable_http_path="/", stateless_http=True, json_response=True,
        # the token is the guard; DNS-rebinding checks would only reject the server's real IP/hostname
        transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
    )
    manager = server.session_manager
    loop = asyncio.get_running_loop()
    async with manager.run():
        endpoint.managers[loop] = manager
        try:
            yield
        finally:
            endpoint.managers.pop(loop, None)
