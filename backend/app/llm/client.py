"""Thin async client for the LLM roles (reasoning / creative / vision).

Talks to Ollama's native /api/chat when it can, because only that endpoint honours
num_ctx (the default context OOMs small boxes) and think=false (gemma4 and qwen3
think by default, which eats the whole token budget on short calls). Anything else
OpenAI-compatible works through /chat/completions.
"""
import asyncio
import json
import logging
import re
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Literal, TypeVar

import httpx
from pydantic import BaseModel, ValidationError

from app.config import get_settings

log = logging.getLogger("mixai.llm")

Role = Literal["reasoning", "creative", "vision"]
T = TypeVar("T", bound=BaseModel)

_THINK_RE = re.compile(r"<think>(.*?)</think>", re.S | re.I)
_transport: httpx.AsyncBaseTransport | None = None
_native_cache: dict[str, bool] = {}
# models this process has already talked to; the first call may include a cold load
_warm: set[str] = set()


class LLMError(RuntimeError):
    pass


@dataclass
class ChatResult:
    content: str
    thinking: str
    model: str
    usage: dict = field(default_factory=dict)
    seconds: float = 0.0
    data: Any = None
    finish_reason: str = ""

    def call_info(self, role: str) -> dict:
        return {"role": role, "model": self.model, "seconds": round(self.seconds, 2), **self.usage}


def set_transport(transport: httpx.AsyncBaseTransport | None) -> None:
    """Tests swap in an httpx.MockTransport here."""
    global _transport
    _transport = transport
    _native_cache.clear()
    _warm.clear()


def model_for(role: Role) -> str:
    s = get_settings()
    name = {"reasoning": s.llm_model_reasoning, "creative": s.llm_model_creative, "vision": s.llm_model_vision}[role]
    if not name:
        raise LLMError(f"No model is set for the {role} role (LLM_MODEL_{role.upper()} in .env)")
    return name


def server_root() -> str:
    base = get_settings().llm_base_url.rstrip("/")
    return base[:-3] if base.endswith("/v1") else base


def split_thinking(content: str, *extra: str | None) -> tuple[str, str]:
    """Pull <think> blocks out of the answer and merge any separate reasoning fields."""
    thinking = [t.strip() for t in extra if t and t.strip()]
    if get_settings().llm_reasoning_format.lower() == "deepseek" and content:
        found = _THINK_RE.findall(content)
        content = _THINK_RE.sub("", content)
        # some templates eat the opening tag and only the closing one survives
        if "</think>" in content:
            head, _, content = content.partition("</think>")
            found.append(head)
        thinking += [f.strip() for f in found if f.strip()]
    return content.strip(), "\n\n".join(thinking)


def extract_json(text: str) -> str:
    t = text.strip()
    fence = re.search(r"```(?:json)?\s*(.*?)```", t, re.S)
    if fence:
        t = fence.group(1).strip()
    if t and t[0] not in "{[":
        start = min((i for i in (t.find("{"), t.find("[")) if i >= 0), default=-1)
        if start >= 0:
            t = t[start:]
    return t


def _client(timeout: float) -> httpx.AsyncClient:
    s = get_settings()
    headers = {"Authorization": f"Bearer {s.llm_api_key}"} if s.llm_api_key else {}
    return httpx.AsyncClient(timeout=httpx.Timeout(timeout, connect=10.0), headers=headers, transport=_transport)


async def _use_native(client: httpx.AsyncClient) -> bool:
    mode = get_settings().llm_api.lower()
    if mode in ("ollama", "native"):
        return True
    if mode == "openai":
        return False
    root = server_root()
    if root not in _native_cache:
        try:
            r = await client.get(f"{root}/api/version", timeout=5.0)
            _native_cache[root] = r.status_code == 200 and "version" in r.json()
        except (httpx.HTTPError, ValueError):
            _native_cache[root] = False
    return _native_cache[root]


def _unreachable() -> LLMError:
    return LLMError(f"Ollama isn't reachable at {server_root()}. Is it running?")


async def _post(client: httpx.AsyncClient, url: str, body: dict, model: str, timeout: float) -> dict:
    try:
        r = await client.post(url, json=body)
    except httpx.ConnectError as e:
        raise _unreachable() from e
    except httpx.TimeoutException as e:
        raise LLMError(f"{model} didn't answer within {int(timeout)} s") from e
    except httpx.HTTPError as e:
        raise LLMError(f"LLM request failed: {e}") from e
    if r.status_code >= 400:
        try:
            detail = r.json().get("error")
            if isinstance(detail, dict):
                detail = detail.get("message")
        except ValueError:
            detail = r.text[:300]
        detail = str(detail or f"HTTP {r.status_code}")
        if r.status_code == 404 and "not found" in detail.lower():
            raise LLMError(f"Model '{model}' isn't installed on the LLM server (ollama pull {model})")
        raise LLMError(f"LLM server error ({r.status_code}): {detail}")
    return r.json()


async def _raw_chat(
    client: httpx.AsyncClient,
    model: str,
    messages: list[dict],
    *,
    schema: dict | None,
    temperature: float,
    max_tokens: int,
    think: bool,
    timeout: float,
) -> ChatResult:
    s = get_settings()
    t0 = time.monotonic()
    if await _use_native(client):
        body: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "stream": False,
            "think": think,
            "options": {"temperature": temperature, "num_predict": max_tokens, "num_ctx": s.llm_num_ctx},
        }
        if schema:
            body["format"] = schema
        try:
            data = await _post(client, f"{server_root()}/api/chat", body, model, timeout)
        except LLMError as e:
            # older models reject the think flag outright; they don't think anyway
            if "think" not in str(e).lower():
                raise
            body.pop("think")
            data = await _post(client, f"{server_root()}/api/chat", body, model, timeout)
        msg = data.get("message") or {}
        content, thinking = split_thinking(msg.get("content") or "", msg.get("thinking"), msg.get("reasoning"))
        usage = {"prompt_tokens": data.get("prompt_eval_count"), "completion_tokens": data.get("eval_count")}
        finish = "length" if data.get("done_reason") == "length" else (data.get("done_reason") or "")
    else:
        body = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        if not think:
            # honoured by Ollama's compat layer and by most vLLM/llama.cpp builds; ignored elsewhere
            body["reasoning_effort"] = "none"
        if schema:
            body["response_format"] = {"type": "json_schema", "json_schema": {"name": "answer", "schema": schema}}
        data = await _post(client, f"{s.llm_base_url.rstrip('/')}/chat/completions", body, model, timeout)
        choice = (data.get("choices") or [{}])[0]
        msg = choice.get("message") or {}
        content, thinking = split_thinking(
            msg.get("content") or "", msg.get("reasoning"), msg.get("reasoning_content"), msg.get("thinking")
        )
        u = data.get("usage") or {}
        usage = {"prompt_tokens": u.get("prompt_tokens"), "completion_tokens": u.get("completion_tokens")}
        finish = choice.get("finish_reason") or ""
    return ChatResult(
        content=content,
        thinking=thinking,
        model=model,
        usage=usage,
        seconds=time.monotonic() - t0,
        finish_reason=finish,
    )


def _repair_messages(bad: str, schema: dict, error: str) -> list[dict]:
    return [
        {
            "role": "system",
            "content": "You repair broken JSON. Reply with one JSON value only: no prose, no markdown fences.",
        },
        {
            "role": "user",
            "content": (
                f"This JSON schema must be satisfied:\n{json.dumps(schema)}\n\n"
                f"The previous answer failed validation with: {error}\n\n"
                f"Previous answer:\n{bad[:12000]}\n\nReturn the corrected JSON."
            ),
        },
    ]


def _validate(model_cls: type[T], text: str) -> T:
    return model_cls.model_validate_json(extract_json(text))


async def chat(
    role: Role,
    messages: list[dict],
    *,
    schema: type[T] | None = None,
    temperature: float = 0.7,
    max_tokens: int = 1024,
    timeout: float | None = None,
    think: bool | None = None,
    retry_empty: bool = True,
) -> ChatResult:
    """One chat call for a role. With `schema`, `result.data` is a validated instance or LLMError is raised."""
    s = get_settings()
    model = model_for(role)
    if think is None:
        # only the reasoning role is allowed to think; creative/vision answers must land in content
        think = role == "reasoning" and s.llm_reasoning_format.lower() != "none"
    timeout = timeout or s.llm_timeout_s
    json_schema = schema.model_json_schema() if schema else None

    async with _client(timeout) as client:
        res = await _raw_chat(
            client, model, messages, schema=json_schema, temperature=temperature,
            max_tokens=max_tokens, think=think, timeout=timeout,
        )
        if not res.content and res.finish_reason == "length" and retry_empty:
            # the whole budget went on thinking; one retry with room to spare and thinking off
            log.warning("%s spent its %d-token budget thinking; retrying without thinking", model, max_tokens)
            first_thinking = res.thinking
            res = await _raw_chat(
                client, model, messages, schema=json_schema, temperature=temperature,
                max_tokens=max_tokens * 2, think=False, timeout=timeout,
            )
            res.thinking = res.thinking or first_thinking
            if not res.content:
                raise LLMError(f"{model} used its whole token budget without answering (max_tokens={max_tokens * 2})")
        _warm.add(model)
        if not res.content and not schema and retry_empty:
            raise LLMError(f"{model} returned an empty answer")

        if schema is None:
            return res
        try:
            res.data = _validate(schema, res.content)
            return res
        except (ValidationError, ValueError) as e:
            first_error = str(e).splitlines()[0][:300]
            log.warning("invalid JSON from %s (%s); running one repair pass", model, first_error)

        repair_model = model_for("creative")
        fixed = await _raw_chat(
            client, repair_model, _repair_messages(res.content, json_schema, first_error),
            schema=json_schema, temperature=0.0, max_tokens=max(max_tokens, 1024), think=False, timeout=timeout,
        )
        try:
            res.data = _validate(schema, fixed.content)
        except (ValidationError, ValueError) as e:
            raise LLMError(
                f"{model} didn't return valid {schema.__name__} JSON, and the repair pass failed too: "
                f"{str(e).splitlines()[0][:200]}"
            ) from e
        res.content = fixed.content
        res.seconds += fixed.seconds
        res.usage["repaired"] = True
        return res


def is_warm(role: Role) -> bool:
    try:
        return model_for(role) in _warm
    except LLMError:
        return False


async def _with_ticks(coro, tick: Callable[[], None] | None, every: float):
    task = asyncio.ensure_future(coro)
    if tick is None:
        return await task
    while True:
        done, _ = await asyncio.wait({task}, timeout=every)
        if done:
            return task.result()
        try:
            tick()
        except BaseException:
            # cancellation / shutdown raised from the job context: stop the HTTP call too
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass
            raise


def chat_sync(role: Role, messages: list[dict], *, tick: Callable[[], None] | None = None, tick_every: float = 4.0, **kw) -> ChatResult:
    """For the (synchronous) worker and sync routes. `tick` runs every few seconds while waiting."""
    return asyncio.run(_with_ticks(chat(role, messages, **kw), tick, tick_every))


async def list_models() -> list[str]:
    async with _client(10.0) as client:
        try:
            if await _use_native(client):
                r = await client.get(f"{server_root()}/api/tags")
                r.raise_for_status()
                return [m.get("name", "") for m in r.json().get("models", [])]
            r = await client.get(f"{get_settings().llm_base_url.rstrip('/')}/models")
            r.raise_for_status()
            return [m.get("id", "") for m in r.json().get("data", [])]
        except httpx.ConnectError as e:
            raise _unreachable() from e
        except (httpx.HTTPError, ValueError) as e:
            raise LLMError(f"Couldn't list models: {e}") from e
