"""Bhashini (Digital India / ULCA) translation wrapper.

Two authentication paths, in priority order:

  1. Direct inference key (BHASHINI_INFERENCE_KEY) — POSTs straight to
     Dhruva's pipeline inference endpoint with the key as the Authorization
     header. No discovery round-trip, works with a pre-issued key alone.
  2. ULCA pipeline resolution (BHASHINI_USER_ID + BHASHINI_API_KEY) — the
     classic getModelsPipeline flow that resolves a serviceId + callback per
     language pair; results are cached in-memory.

Failure policy: translation is a *promised* part of the answer when the user
picked a language, so failures are NEVER masked by silently returning the
English text. `translate()` raises BhashiniError with the status code and
response body, logged at ERROR with full technical detail; the API layer
turns that into an honest, descriptive error for the user.

Credentials: the inference key comes from https://bhashini.gov.in (Dhruva).
The ULCA pair is issued alongside it (profile page: userId + ulcaApiKey).
"""
import logging

import httpx

from app.config import settings

log = logging.getLogger("marine.bhashini")

CONFIG_URL = "https://meity-auth.ulcacontrib.org/ulca/apis/v0/model/getModelsPipeline"
# Standard Bhashini (Dhruva) pipeline inference endpoint used with a static key.
INFERENCE_URL = "https://dhruva-api.bhashini.gov.in/services/inference/pipeline"
PIPELINE_ID = "64392f96daac500b55c543cd"  # Bhashini's standard public pipeline

# Languages exposed in the frontend dropdown -> ISO-639 codes Bhashini expects
SUPPORTED_LANGUAGES = {
    "en": "English", "hi": "Hindi", "bn": "Bengali", "ta": "Tamil",
    "te": "Telugu", "mr": "Marathi", "gu": "Gujarati", "kn": "Kannada",
    "ml": "Malayalam", "pa": "Punjabi", "or": "Odia", "ur": "Urdu",
}

_config_cache: dict[tuple[str, str], dict] = {}


class BhashiniError(RuntimeError):
    """Translation failed — authentication, network, quota or bad payload."""


def is_configured() -> bool:
    """True when any translation credential is present."""
    return bool(
        settings.bhashini_inference_key
        or (settings.bhashini_user_id and settings.bhashini_api_key)
    )


def _static_config() -> dict:
    """Direct-inference config built from the pre-issued key."""
    return {
        "service_id": None,
        "callback_url": INFERENCE_URL,
        "auth_header": {"Authorization": settings.bhashini_inference_key},
    }


async def _get_pipeline_config(client: httpx.AsyncClient, source: str, target: str) -> dict:
    """Resolve the inference endpoint for a language pair.

    With an inference key configured this goes straight to Dhruva — the
    discovery round-trip needs a userID that may not accompany a static key.
    """
    key = (source, target)
    if key in _config_cache:
        return _config_cache[key]

    if settings.bhashini_inference_key:
        cfg = _static_config()
        _config_cache[key] = cfg
        return cfg

    if not (settings.bhashini_user_id and settings.bhashini_api_key):
        raise BhashiniError(
            "Bhashini credentials are not configured on the server "
            "(set BHASHINI_INFERENCE_KEY, or BHASHINI_USER_ID + BHASHINI_API_KEY)."
        )

    try:
        resp = await client.post(
            CONFIG_URL,
            headers={
                "Content-Type": "application/json",
                "userID": settings.bhashini_user_id,
                "ulcaApiKey": settings.bhashini_api_key,
            },
            json={
                "pipelineTasks": [{
                    "taskType": "translation",
                    "config": {"language": {"sourceLanguage": source, "targetLanguage": target}},
                }],
                "pipelineRequestConfig": {"pipelineId": PIPELINE_ID},
            },
        )
        resp.raise_for_status()
        data = resp.json()

        service_id = data["pipelineResponseConfig"][0]["config"][0]["serviceId"]
        endpoint = data["pipelineInferenceAPIEndPoint"]
        callback_url = endpoint["callbackUrl"]
        auth_header = {endpoint["inferenceApiKey"]["name"]: endpoint["inferenceApiKey"]["value"]}

        resolved = {"service_id": service_id, "callback_url": callback_url, "auth_header": auth_header}
        _config_cache[key] = resolved
        return resolved
    except Exception as exc:
        raise BhashiniError(
            f"could not resolve the Bhashini pipeline for {source}->{target}: {exc}"
        ) from exc


async def translate(text: str, source: str, target: str) -> str:
    """Translate `text` from `source` to `target` (ISO-639 codes).

    Raises BhashiniError on any failure — the caller decides how to surface
    it. We never silently return the untranslated text: a user who asked for
    Hindi must not receive English and not be told.
    """
    if not text.strip() or source == target:
        return text
    if not is_configured():
        raise BhashiniError(
            "translation was requested but Bhashini credentials are not configured "
            "on the server (BHASHINI_INFERENCE_KEY missing)."
        )

    try:
        async with httpx.AsyncClient(timeout=20) as client:
            cfg = await _get_pipeline_config(client, source, target)
            task_config: dict = {
                "language": {"sourceLanguage": source, "targetLanguage": target},
            }
            if cfg.get("service_id"):
                task_config["serviceId"] = cfg["service_id"]
            resp = await client.post(
                cfg["callback_url"],
                headers={"Content-Type": "application/json", **cfg["auth_header"]},
                json={
                    "pipelineTasks": [{"taskType": "translation", "config": task_config}],
                    "inputData": {"input": [{"source": text}]},
                },
            )
            if resp.status_code != 200:
                body = resp.text[:500]
                log.error(
                    "Bhashini inference failed: status=%s source=%s target=%s chars=%d body=%s",
                    resp.status_code, source, target, len(text), body,
                )
                raise BhashiniError(
                    f"Bhashini inference replied {resp.status_code}: {body}"
                )
            out = resp.json()
            try:
                return out["pipelineResponse"][0]["output"][0]["target"]
            except (KeyError, IndexError, TypeError) as exc:
                log.error(
                    "Bhashini reply had an unexpected shape: %s | payload=%s",
                    exc, str(out)[:500],
                )
                raise BhashiniError(
                    f"Bhashini reply could not be parsed: {exc}"
                ) from exc
    except BhashiniError:
        raise
    except Exception as exc:
        log.error(
            "Bhashini translation call failed: source=%s target=%s chars=%d error=%r",
            source, target, len(text), exc,
        )
        raise BhashiniError(f"translation service unreachable: {exc}") from exc
