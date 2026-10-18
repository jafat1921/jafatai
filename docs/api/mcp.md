---
title: "Mix AI Cinema Studio: MCP server"
status: Active
created: 2026-10-14
contract: contract-v27-token-api.md (M12c, Update 3)
---

# Using the studio from Claude (MCP)

The studio runs an MCP server, so Claude Code, Claude Desktop and other MCP clients can use it as tools:
make pictures, video, music, sound effects and speech, build characters and sheets, write and render podcasts,
start a Quick Create film, then fetch the results.

- **Address:** `https://<your-studio>/api/mcp` (Streamable HTTP, stateless, JSON answers).
- **Auth:** `Authorization: Bearer mxa_…`, an API token from **Settings → API tokens**. No cookie sign-in.
- **Same rules as the REST API:** the token's scopes and your role apply, and every tool runs the same code as
  the matching REST route.

While `PUBLIC_API` is off (the default) only the admin can make tokens, so only the admin's clients get in.

## Setup

Make a token with **Read** and **Generate** (add **Manage** only if you want Claude to delete things; no tool
needs it today). The **Connect to Claude** card on the tokens page has these snippets with your address filled in.

### Claude Code

```bash
claude mcp add --transport http mixai https://<your-studio>/api/mcp --header "Authorization: Bearer <your-token>"
```

### Claude Desktop

Settings → Developer → Edit config, add to `claude_desktop_config.json`, restart. Needs Node.js (`npx`).

```json
{
  "mcpServers": {
    "mixai": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://<your-studio>/api/mcp", "--header", "Authorization:${MIXAI_AUTH}"],
      "env": { "MIXAI_AUTH": "Bearer <your-token>" }
    }
  }
}
```

### Other clients

Point any Streamable HTTP client at the address and send the header on every request.

### Self-signed certificates

If the studio's HTTPS certificate is self-signed, Node-based clients (Claude Code, `mcp-remote`) refuse it.
Trust the certificate on that computer (or use a real one). For a quick test only you can set
`NODE_TLS_REJECT_UNAUTHORIZED=0` in the client's environment; don't leave it on.

## Tools

Tools a token can't use aren't listed for it. Anything slow returns job ids at once.

| Tool | Scope | What it does |
|---|---|---|
| `generate_image` | generate | Text to image (1-4 pictures). Optional `part_of` keeps the result out of the studio's lists (contract v37). |
| `edit_image` | generate | Edit finished pictures with an instruction; extra pictures are references. |
| `upscale` | generate | Upscale a picture (2x/4x/2k/4k) or a video (1080p/1440p/4k). |
| `make_3d_model` | generate | A textured 3D model (GLB) from one of `image_id`, `prompt` (a picture is made first), `character_id`, `view_ids` ({front, left, back, right}, front required, Pixal3D only) or `logo_id` (a badge extruded on the CPU in seconds: `depth`, `bevel`, `finish`, `back`): `engine` pixal3d or trellis2, `quality` draft or final; `better_back` makes side and back views first for people and figures (contract v40 §8). |
| `generate_video` | generate | Text or image to video; long durations render in chunks. Optional `part_of` (e.g. `story:<id>`) as for images. |
| `make_song` / `make_music` / `make_sfx` | generate | Song with lyrics, instrumental music, a sound effect. |
| `speak` | generate | Text to speech in a library voice, a gallery voice or a described one. |
| `transcribe` | generate | Timed transcript of an audio or video item; the text arrives with the finished job. |
| `separate_stems` | generate | Vocals + the rest, or four stems, as new Library items. |
| `create_character` | generate | A Character Studio character, plus its reference portrait. |
| `make_character_sheet` | generate | Queue the Essential or Full sheet once the portrait is done. |
| `set_character_voice` | generate | Give a character a voice (`list_voices`). |
| `write_podcast_episode` | generate | Create an episode with hosts and a topic, and script it. |
| `render_podcast` | generate | `step=voices` speaks every line, then `step=mix` makes the episode file. |
| `create_project_from_idea` | generate | Quick Create: the autopilot makes a whole film; `language`, `cast_ids`, `scenes`, `scene_seconds`, `title_intro`, `title` for a feature (contract v4a). |
| `list_projects` | read | The film projects. |
| `get_job` | read | Status, progress and, when done, a `download_url` (or the transcript). |
| `wait_for_job` | read | Waits up to 60 s for a job, then returns it; call again if it's still running. |
| `search_library` | read | Find Library items by words and kind (`model` for 3D models). |
| `get_media` | read | An item's details and a `download_url`; pictures also come back inline. |
| `list_voices` | read | Your voice library and the built-in gallery (`gallery:<id>`). |

**Resources:** `mixai://media/{id}`, `mixai://characters/{id}` (profile, voice and sheet panels) and
`mixai://projects/{id}` (settings, cast, running jobs). **Prompt:** `storyboard_idea` turns an idea into a
shot list and offers to make it.

### Download links

`download_url` is a signed link, `https://<your-studio>/api/files/<signed>`, that works without the token for
**10 minutes**. It names one file in your workspace and nothing else. When it expires, call `get_job` or
`get_media` again for a fresh one.

## Examples

Things to ask Claude once it's connected:

- "Make four 16:9 pictures of a lighthouse in a storm with mixai, wait for them, and show me the best one."
- "Create a character called Maya, a marine biologist in her thirties with short grey hair. When the portrait is
  ready, make her Essential sheet and give her a warm British gallery voice."
- "Write a five-minute conversation podcast about coral bleaching with two hosts, render the voices, then mix it
  and give me the download link."
- "Storyboard this idea, then make it as a 30 second film: a diver finds a lost city under the reef."

A typical tool sequence: `generate_image` → `wait_for_job` (repeat until `status` is `done`) → `get_media` or the
job's `download_url`.

## Errors

- **HTTP 401:** no token, or it's wrong, expired or revoked.
- **Tool error "needs the 'generate' scope":** the token lacks the scope, or your role is viewer.
- **Other tool errors** carry the REST route's message, e.g. "Make and approve a portrait first".
