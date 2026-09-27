"""Bhashini (Digital India / ULCA) translation wrapper.

Two-step flow per Bhashini's public docs (dibd-bhashini.gitbook.io):
  1. POST getModelsPipeline -> resolves a serviceId + inference endpoint + key
     for a given (source, target) language pair. Cached in-memory since it
     rarely changes for a fixed pipeline.
  2. POST the resolved inference endpoint with the actual text -> translation.

Credentials: sign up at https://bhashini.gov.in, verify email, then generate
userId + ulcaApiKey from your profile page. Free, self-serve.

A pre-issued inference key (BHASHINI_INFERENCE_KEY) can also be supplied; it is
used directly when the pipeline-config step cannot be reached, so translation
keeps working even if only the inference credential is available.

Fails soft: any error returns the original text untouched so a translation
outage never breaks the chat itself.
"""
import httpx

from app.config import settings

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


def is_configured() -> bool:
    """True when translation credentials are present (pipeline or static key)."""
    return bool(
        (settings.bhashini_user_id and settings.bhashini_api_key)
        or settings.bhashini_inference_key
    )


def _static_inference_config() -> dict:
    """Fallback config built from a pre-issued inference key (no serviceId needed)."""
    return {
        "service_id": None,
        "callback_url": INFERENCE_URL,
        "auth_header": {"Authorization": settings.bhashini_inference_key},
    }


async def _get_pipeline_config(client: httpx.AsyncClient, source: str, target: str) -> dict:
    key = (source, target)
    if key in _config_cache:
        return _config_cache[key]

    if not (settings.bhashini_user_id and settings.bhashini_api_key):
        # Only a static inference key is available — skip the resolve step.
        if settings.bhashini_inference_key:
            return _static_inference_config()
        raise RuntimeError("Bhashini credentials are not configured")

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
    except Exception:
        if settings.bhashini_inference_key:
            return _static_inference_config()
        raise


async def translate(text: str, source: str, target: str) -> str:
    """Translate `text` from `source` to `target` (ISO-639 codes). Soft-fails to original text."""
    if not text.strip() or source == target:
        return text
    if not is_configured():
        return text  # not configured — no-op rather than error

    try:
        async with httpx.AsyncClient(timeout=15) as client:
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
            resp.raise_for_status()
            out = resp.json()
            return out["pipelineResponse"][0]["output"][0]["target"]
    except Exception:
        return text  # degrade gracefully — chat still works in English
