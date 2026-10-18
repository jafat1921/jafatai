"""The model a Quick Create film is written with (FILM_LLM_MODEL).

The live server's creative (gemma4:e4b) and reasoning (deepseek-r1:14b) models ignored shot counts and the
film's language; gemma4:26b, which the owner's story app writes with, doesn't. Used only when installed.
"""
import asyncio
import logging

from app.config import get_settings
from app.llm.client import LLMError, bare_tag, installed_models

log = logging.getLogger("mixai.llm")

_missing_warned: set[str] = set()


def film_model() -> str | None:
    """FILM_LLM_MODEL when the LLM server has it, else None (each step keeps its role's model)."""
    want = get_settings().film_llm_model.strip()
    if not want or want.lower() == "off":
        return None
    try:
        have = asyncio.run(installed_models())
    except LLMError as e:
        log.warning("couldn't list the LLM models (%s); the film uses the roles' models", e)
        return None
    if bare_tag(want) in have:
        return want
    if want not in _missing_warned:
        _missing_warned.add(want)
        log.warning("%s isn't installed (ollama pull %s); the film uses the roles' models", want, want)
    return None


def retry_json(call, messages: list[dict], kw: dict, error: LLMError):
    """One more go after a schema failure: the failed answer as the assistant's turn, a little cooler, and
    twice the room when it was cut off. Raises the original error when there is nothing to show the model."""
    bad = getattr(error, "content", None)
    if not bad or not kw.get("schema"):
        raise error
    again = [*messages, {"role": "assistant", "content": bad[:12000]},
             {"role": "user", "content": f"That answer didn't fit the JSON schema ({str(error)[:300]}). Reply again "
                                         "with the complete JSON only: no prose, no markdown fences."}]
    kw = {**kw, "temperature": 0.3}
    if getattr(error, "truncated", False):
        kw["max_tokens"] = int(kw.get("max_tokens") or 1024) * 2
    log.warning("schema failure, asking once more: %s", str(error)[:200])
    return call(again, **kw)


def overrides(model: str | None, role: str) -> dict:
    """chat() keywords for one film step. The eye (vision) keeps its own model."""
    if not model or role == "vision":
        return {}
    # a big one-shot on a GPU ComfyUI needs next; and gemma thinks by default, which eats the budget
    return {"model": model, "keep_alive": get_settings().ollama_keep_alive_big or None, "think": False}
