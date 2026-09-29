"""LLM provider layer: OpenAI primary, Gemini fallback.

The agent pipeline does not know which provider answered it. `chat_json`,
`chat_markdown` and `chat_markdown_stream` are the only entry points, and each
one tries OpenAI first and then Gemini *in-process*:

    OpenAI ──success──> return
       │
       └──failure (quota / exhausted credits / outage / auth / timeout)
              │
              └──> Gemini ──success──> return (same run, same agent graph)
                       │
                       └──failure──> LLMProvidersExhausted
                                     (surfaced to the user as a real error)

Consequences that matter:

* There is never a second agent graph or a second scheduler — the fallback is a
  provider swap inside one call, so no request is ever processed twice by both
  models. A router that OpenAI answered is not re-classified by Gemini.
* A missing OpenAI key is not an error: if Gemini is configured the request is
  simply served by Gemini.
* If both providers fail, the exception carries both technical details and the
  UI shows a genuine service error. No weather, PFZ, hazard or fishing text is
  ever fabricated to fill the gap.

Clients are built lazily (see `startup`), so an empty key surfaces as a clear
runtime error instead of a silent boot crash.

Embeddings stay OpenAI-only on purpose: `text-embedding-3-small` is 1536 dims
and the `marine_advisories` pgvector index is built for exactly that width.
Silently switching embedding providers would silently break retrieval.

Model notes: `gemini-3.5-flash` is the configured primary; newer ids
(`3.7`/`3.8`) are intermittently overloaded and are tried as fallbacks, and the
chain is configurable through `GEMINI_MODEL` / `GEMINI_FALLBACK_MODELS`.
"""
import json
import logging
from collections.abc import AsyncIterator

from openai import AsyncOpenAI

from app.config import settings
from app.services import gemini

log = logging.getLogger("marine.llm")

CHAT_MODEL = "gpt-4o"
EMBEDDING_MODEL = "text-embedding-3-small"
EMBEDDING_DIMS = 1536


class LLMError(RuntimeError):
    """Base class for AI-provider failures surfaced to the user interface."""


class LLMNotConfigured(LLMError):
    """Raised when no provider credentials were ever supplied."""


class LLMUnavailable(LLMError):
    """Raised when a provider rejects/blocks a request (quota, outage, ...)."""


class LLMProvidersExhausted(LLMError):
    """Raised when the primary provider failed and the fallback failed too.

    The message names both providers and keeps their technical detail so the
    failure is diagnosable from the UI as well as the logs.
    """


_client: AsyncOpenAI | None = None
# Which provider served the most recent request — reported by /health and
# written to the log so an operator can see the fallback being used.
_last_provider: str | None = None


def startup() -> bool:
    """Validate credentials and (re)build the OpenAI client.

    Deliberately does **no** network I/O: it only confirms that the required
    secrets are present so the switch happens after the environment is loaded.
    Returns True when at least one provider is usable.
    """
    global _client
    if settings.openai_api_key.strip():
        _client = AsyncOpenAI(api_key=settings.openai_api_key)
    else:
        _client = None
        log.warning("OPENAI_API_KEY is not set — trying Gemini first for every request")
    if gemini.is_configured():
        log.info("Gemini fallback configured (models=%s)", ", ".join(settings.gemini_models()))
    else:
        log.warning("GEMINI_API_KEY is not set — no fallback if OpenAI fails")
    return is_configured()


def shutdown() -> None:
    global _client
    _client = None


def openai_configured() -> bool:
    return bool(settings.openai_api_key.strip())


def gemini_configured() -> bool:
    return gemini.is_configured()


def is_configured() -> bool:
    """True when *some* provider can answer."""
    return openai_configured() or gemini_configured()


def provider_status() -> dict:
    """Small, honest summary for /health (no secrets)."""
    return {
        "primary": "openai" if openai_configured() else ("gemini" if gemini_configured() else None),
        "openai": openai_configured(),
        "gemini": gemini_configured(),
        "gemini_models": settings.gemini_models() if gemini_configured() else [],
        "last_used": _last_provider,
    }


def _track(name: str) -> None:
    global _last_provider
    _last_provider = name


async def _get_client() -> AsyncOpenAI:
    global _client
    if _client is None:
        if not openai_configured():
            raise LLMNotConfigured(
                "OPENAI_API_KEY is not configured on the server — the AI service is unavailable."
            )
        _client = AsyncOpenAI(api_key=settings.openai_api_key)
    return _client


def _combined(primary: Exception, fallback: Exception) -> LLMProvidersExhausted:
    """One exception carrying both provider failures."""
    log.error("all LLM providers failed — openai=%r gemini=%r", primary, fallback)
    return LLMProvidersExhausted(
        f"OpenAI failed: {primary} | Gemini failed: {fallback}"
    )


async def embed_text(text: str) -> list[float]:
    """Single text -> embedding vector (1536 dims, OpenAI only)."""
    client = await _get_client()
    try:
        resp = await client.embeddings.create(model=EMBEDDING_MODEL, input=text)
        _track("openai")
        return resp.data[0].embedding
    except LLMError:
        raise
    except Exception as exc:
        raise LLMUnavailable(str(exc)) from exc


async def _openai_json(system: str, user: str) -> dict:
    client = await _get_client()
    try:
        resp = await client.chat.completions.create(
            model=CHAT_MODEL,
            temperature=0,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        )
        return json.loads(resp.choices[0].message.content or "{}")
    except LLMError:
        raise
    except Exception as exc:
        raise LLMUnavailable(str(exc)) from exc


async def _openai_markdown(system: str, user: str, temperature: float) -> str:
    client = await _get_client()
    try:
        resp = await client.chat.completions.create(
            model=CHAT_MODEL,
            temperature=temperature,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        )
        return resp.choices[0].message.content or ""
    except LLMError:
        raise
    except Exception as exc:
        raise LLMUnavailable(str(exc)) from exc


async def chat_json(system: str, user: str) -> dict:
    """Structured JSON reply — OpenAI first, Gemini on failure."""
    primary: Exception | None = None
    if openai_configured():
        try:
            out = await _openai_json(system, user)
            _track("openai")
            return out
        except Exception as exc:
            primary = exc
            log.error("OpenAI chat_json failed, falling back to Gemini: %s", exc)
    if not gemini_configured():
        raise primary if isinstance(primary, LLMError) else LLMNotConfigured(
            "OPENAI_API_KEY is not configured on the server and no fallback provider is available."
        )
    try:
        out = await gemini.chat_json(system, user)
        _track("gemini")
        return out
    except Exception as fallback:
        raise _combined(primary or LLMNotConfigured("OpenAI is not configured."), fallback) from fallback


async def chat_markdown(system: str, user: str, temperature: float = 0.3) -> str:
    """Free-form markdown reply — OpenAI first, Gemini on failure."""
    primary: Exception | None = None
    if openai_configured():
        try:
            out = await _openai_markdown(system, user, temperature)
            _track("openai")
            return out
        except Exception as exc:
            primary = exc
            log.error("OpenAI chat_markdown failed, falling back to Gemini: %s", exc)
    if not gemini_configured():
        raise primary if isinstance(primary, LLMError) else LLMNotConfigured(
            "OPENAI_API_KEY is not configured on the server and no fallback provider is available."
        )
    try:
        out = await gemini.chat_text(system, user, temperature)
        _track("gemini")
        return out
    except Exception as fallback:
        raise _combined(primary or LLMNotConfigured("OpenAI is not configured."), fallback) from fallback


async def chat_markdown_stream(system: str, user: str, temperature: float = 0.3) -> AsyncIterator[str]:
    """Streaming markdown reply.

    Streaming is the one case where the fallback must happen *before* any token
    reaches the client, otherwise the answer would restart mid-sentence. So:
    OpenAI is opened first; if it fails before the first chunk, Gemini streams
    instead. If OpenAI fails part-way through, the error propagates — a
    half-answer is reported as broken rather than silently duplicated.
    """
    primary: Exception | None = None
    if openai_configured():
        started = False
        try:
            client = await _get_client()
            stream = await client.chat.completions.create(
                model=CHAT_MODEL,
                temperature=temperature,
                stream=True,
                messages=[
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
            )
            async for chunk in stream:
                if chunk.choices and chunk.choices[0].delta.content:
                    started = True
                    _track("openai")
                    yield chunk.choices[0].delta.content
            return
        except LLMError as exc:
            if started:
                raise
            primary = exc
            log.error("OpenAI stream failed before first token, trying Gemini: %s", exc)
        except Exception as exc:
            if started:
                raise LLMUnavailable(str(exc)) from exc
            primary = LLMUnavailable(str(exc))
            log.error("OpenAI stream failed before first token, trying Gemini: %s", exc)

    if not gemini_configured():
        if isinstance(primary, LLMError):
            raise primary
        raise LLMNotConfigured(
            "OPENAI_API_KEY is not configured on the server and no fallback provider is available."
        )

    try:
        async for token in gemini.chat_text_stream(system, user, temperature):
            _track("gemini")
            yield token
    except Exception as fallback:
        raise _combined(primary or LLMNotConfigured("OpenAI is not configured."), fallback) from fallback
