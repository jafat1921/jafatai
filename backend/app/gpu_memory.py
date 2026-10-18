"""Getting VRAM back when ComfyUI runs out of it.

Ollama shares the GPUs with ComfyUI. Its models stay loaded for keep_alive (5 min by default), so a
27B translator or another app's model can leave ComfyUI short mid-film.
"""
import logging

import httpx

from app.config import get_settings

log = logging.getLogger("mixai.gpu")

# what ComfyUI / torch say when an allocation fails; matched case-insensitively
OOM_MARKERS = ("vram grow failed", "out of memory", "allocation on device", "outofmemoryerror")


def is_oom(message: str) -> bool:
    text = (message or "").lower()
    return any(m in text for m in OOM_MARKERS)


def ollama_root(base_url: str | None = None) -> str:
    base = (base_url if base_url is not None else get_settings().llm_base_url).rstrip("/")
    return base[:-3] if base.endswith("/v1") else base


def unload_ollama(base_url: str | None = None, transport: httpx.BaseTransport | None = None) -> list[str]:
    """Ask Ollama to drop every loaded model. Returns the names it was asked to unload; [] when the LLM
    server isn't a native Ollama or can't be reached (nothing to do, and not worth failing the job over)."""
    root = ollama_root(base_url)
    key = get_settings().llm_api_key
    headers = {"Authorization": f"Bearer {key}"} if key else {}
    try:
        with httpx.Client(timeout=httpx.Timeout(10.0, connect=3.0), headers=headers, transport=transport) as c:
            r = c.get(f"{root}/api/ps")
            if r.status_code != 200:
                return []
            names = [m.get("name") or m.get("model") for m in (r.json().get("models") or [])]
            names = [n for n in names if n]
            done = []
            for name in names:
                try:
                    c.post(f"{root}/api/generate", json={"model": name, "keep_alive": 0}, timeout=30.0)
                    done.append(name)
                except httpx.HTTPError as e:
                    log.warning("couldn't unload %s from Ollama: %s", name, e)
    except (httpx.HTTPError, ValueError, AttributeError) as e:
        log.debug("Ollama at %s not asked to unload: %s", root, e)
        return []
    if done:
        log.warning("GPU out of memory: unloaded %s from Ollama", ", ".join(done))
    return done
