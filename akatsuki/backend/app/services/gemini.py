"""Google Gemini client — the fallback LLM provider for the ORCA pipeline.

Talks to the official Gemini REST API (`generativelanguage.googleapis.com`,
v1beta) with `httpx`, which is already a dependency of this project. Nothing
here knows about agents, weather or confidence: it is a pure text-in / text-out
provider so `app/llm.py` can treat OpenAI and Gemini identically.

Why REST rather than the `google-genai` package: model ids are retired for new
callers on a schedule this deployment cannot track (we watched `2.5-flash`
start returning 404 mid-session), and the wire format below is stable across
that churn. Everything is confined to this file, so swapping in the SDK later
means editing `_call`/`_stream` and nothing else.

Model chain, and why it is a chain:

  The free tier meters *per model* (5 requests/minute on `3.5-flash`), so a
  single model id cannot carry a chat that needs a router call and a synthesis
  call. Walking several available models multiplies the usable capacity, and a
  model that is temporarily overloaded (503) or retired (404) costs one attempt
  instead of the whole request. After the chain is exhausted, one bounded second
  pass gives a burst limit time to clear before the provider is called broken.

Honesty rules this module keeps:
  * a missing key is reported, never masked;
  * every failure is logged at ERROR with the HTTP status and response body;
  * a stream that breaks after tokens have been sent raises rather than
    silently restarting, so the user never sees the answer begin twice.
"""
import asyncio
import json
import logging
import re
from collections.abc import AsyncIterator
from typing import Any

import httpx

from app.config import settings

log = logging.getLogger("marine.gemini")

BASE_URL = "https://generativelanguage.googleapis.com/v1beta"
TIMEOUT_S = 60.0
# Two passes over the model chain: the first tries every model, the second gives
# a per-minute burst limit a moment to clear. Longer waits are not worth it — the
# user would rather be told the provider is rate limited than wait in silence.
PASSES = 2
PASS_PAUSE_S = 2.5

# Statuses that mean "try the next model / try again", not "your request or key
# is wrong". 404 appears when a model id is retired for new callers.
RETRYABLE_STATUS = (404, 429, 500, 502, 503, 504)

_RETRY_DELAY = re.compile(r"retry(?:Delay|in)?[\"':\s]*([0-9.]+)s", re.IGNORECASE)


class GeminiError(RuntimeError):
    """Any Gemini failure, carrying the technical detail for the logs and UI."""


_client: httpx.AsyncClient | None = None


def startup() -> bool:
    """True when a Gemini key is present (does no network I/O)."""
    return bool(settings.gemini_api_key.strip())


def is_configured() -> bool:
    return startup()


def _key() -> str:
    key = settings.gemini_api_key.strip()
    if not key:
        raise GeminiError("GEMINI_API_KEY is not configured on the server.")
    return key


async def _get_client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(
            base_url=BASE_URL,
            timeout=httpx.Timeout(TIMEOUT_S, connect=15.0),
            headers={"Content-Type": "application/json"},
        )
    return _client


async def shutdown() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


def _chain() -> list[str]:
    return settings.gemini_models()


def _payload(
    system: str,
    user: str,
    *,
    json_mode: bool,
    temperature: float,
    max_output_tokens: int | None = None,
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "contents": [{"role": "user", "parts": [{"text": user}]}],
        "generationConfig": {"temperature": temperature},
    }
    if system.strip():
        body["systemInstruction"] = {"parts": [{"text": system}]}
    if json_mode:
        body["generationConfig"]["responseMimeType"] = "application/json"
    if max_output_tokens:
        body["generationConfig"]["maxOutputTokens"] = max_output_tokens
    return body


def _describe(resp: httpx.Response) -> str:
    """A short, log-safe description of a failed response (never the key)."""
    try:
        detail = resp.text[:500]
    except Exception:  # pragma: no cover - body already consumed
        detail = "<unreadable body>"
    return f"HTTP {resp.status_code}: {detail}"


def _retry_hint(resp: httpx.Response) -> float | None:
    """The provider's own 'retry in Ns', when it gives one.

    Only used to decide whether a second pass is worth attempting — never to
    make the user wait out a long quota window.
    """
    try:
        text = resp.text
    except Exception:
        return None
    match = _RETRY_DELAY.search(text)
    return float(match.group(1)) if match else None


def _text_from(response: dict) -> str:
    """Concatenate the answer parts, ignoring thoughts and signatures."""
    candidates = response.get("candidates") or []
    if not candidates:
        feedback = (response.get("promptFeedback") or {}).get("blockReason")
        raise GeminiError(
            f"Gemini returned no candidate for this request{f' (blocked: {feedback})' if feedback else ''}."
        )
    parts = ((candidates[0].get("content") or {}).get("parts")) or []
    chunks: list[str] = []
    for part in parts:
        if part.get("thought"):
            continue
        text = part.get("text")
        if isinstance(text, str) and text:
            chunks.append(text)
    return "".join(chunks)


def _strip_fences(text: str) -> str:
    """JSON mode occasionally still arrives wrapped in a ```json fence."""
    stripped = text.strip()
    if stripped.startswith("```"):
        stripped = stripped.split("\n", 1)[-1] if "\n" in stripped else stripped
        stripped = stripped.lstrip("`")
        if stripped.lower().startswith("json"):
            stripped = stripped[4:]
        if stripped.endswith("```"):
            stripped = stripped[:-3]
    return stripped.strip()


async def _generate(
    system: str,
    user: str,
    *,
    json_mode: bool,
    temperature: float,
    max_output_tokens: int | None = None,
) -> str:
    """Generate once, walking the model chain (twice at most) before giving up."""
    client = await _get_client()
    headers = {"x-goog-api-key": _key()}
    body = _payload(
        system, user, json_mode=json_mode, temperature=temperature,
        max_output_tokens=max_output_tokens,
    )
    models = _chain()
    last_error: str | None = None
    retryable = False

    for attempt in range(PASSES):
        if attempt:
            await asyncio.sleep(PASS_PAUSE_S)
        for index, model in enumerate(models):
            try:
                resp = await client.post(
                    f"/models/{model}:generateContent", json=body, headers=headers
                )
            except httpx.HTTPError as exc:  # network / DNS / timeout
                last_error = f"{model}: {type(exc).__name__}: {exc}"
                retryable = True
                log.error("Gemini request to %s failed: %s", model, last_error)
                continue

            if resp.status_code == 200:
                if index or attempt:
                    log.warning("Gemini answered on fallback model %s (pass %d)", model, attempt + 1)
                return _text_from(resp.json())

            last_error = f"{model}: {_describe(resp)}"
            retryable = resp.status_code in RETRYABLE_STATUS
            log.error("Gemini %s rejected the request — %s", model, last_error)
            if not retryable:
                break
            if index + 1 < len(models):
                await asyncio.sleep(0.3)
        if not retryable:
            break

    raise GeminiError(f"Gemini request failed. {last_error or 'no model available'}")


async def chat_json(system: str, user: str) -> dict:
    """Structured JSON answer (same contract as llm.chat_json)."""
    raw = await _generate(system, user, json_mode=True, temperature=0.0)
    try:
        parsed = json.loads(_strip_fences(raw))
    except json.JSONDecodeError as exc:
        raise GeminiError(f"Gemini returned invalid JSON: {exc}. Raw: {raw[:300]}") from exc
    if not isinstance(parsed, dict):
        raise GeminiError(f"Gemini returned JSON of type {type(parsed).__name__}, expected an object.")
    return parsed


async def chat_text(system: str, user: str, temperature: float = 0.3) -> str:
    """Free-form markdown answer."""
    return await _generate(system, user, json_mode=False, temperature=temperature)


async def chat_text_stream(system: str, user: str, temperature: float = 0.3) -> AsyncIterator[str]:
    """Streaming variant — yields answer text as it arrives.

    Falls back through the model chain on retryable failures *before the first
    token*. Once tokens have been emitted the stream is committed: silently
    restarting mid-answer would duplicate text in the user's window.
    """
    client = await _get_client()
    headers = {"x-goog-api-key": _key()}
    body = _payload(system, user, json_mode=False, temperature=temperature)
    models = _chain()
    last_error: str | None = None
    emitted = False
    retryable = False

    for attempt in range(PASSES):
        if attempt and not emitted:
            await asyncio.sleep(PASS_PAUSE_S)
        for index, model in enumerate(models):
            try:
                async with client.stream(
                    "POST",
                    f"/models/{model}:streamGenerateContent?alt=sse",
                    json=body,
                    headers=headers,
                ) as resp:
                    if resp.status_code != 200:
                        await resp.aread()
                        retryable = resp.status_code in RETRYABLE_STATUS
                        last_error = f"{model}: {_describe(resp)}"
                        log.error("Gemini stream %s rejected — %s", model, last_error)
                        if not retryable:
                            raise GeminiError(f"Gemini request failed. {last_error}")
                        continue

                    if index or attempt:
                        log.warning(
                            "Gemini streamed on fallback model %s (pass %d)", model, attempt + 1
                        )
                    async for line in resp.aiter_lines():
                        if not line.startswith("data:"):
                            continue
                        chunk = line[5:].strip()
                        if not chunk or chunk == "[DONE]":
                            continue
                        try:
                            parsed = json.loads(chunk)
                        except json.JSONDecodeError:
                            continue
                        try:
                            text = _text_from(parsed)
                        except GeminiError:
                            continue  # a signature/thought-only chunk carries no text
                        if text:
                            emitted = True
                            yield text
                    return
            except GeminiError:
                raise
            except httpx.HTTPError as exc:
                retryable = True
                last_error = f"{model}: {type(exc).__name__}: {exc}"
                log.error("Gemini stream to %s failed: %s", model, last_error)
                if emitted:
                    raise GeminiError(f"Gemini stream broke mid-answer. {last_error}") from exc
                continue
        if not retryable or emitted:
            break

    raise GeminiError(f"Gemini request failed. {last_error or 'no model available'}")
