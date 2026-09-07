"""Bhashini (Digital India / ULCA) translation wrapper.

Two-step flow per Bhashini's public docs (dibd-bhashini.gitbook.io):
  1. POST getModelsPipeline -> resolves a serviceId + inference endpoint + key
     for a given (source, target) language pair. Cached in-memory since it
     rarely changes for a fixed pipeline.
  2. POST the resolved inference endpoint with the actual text -> translation.

Credentials: sign up at https://bhashini.gov.in, verify email, then generate
userId + ulcaApiKey from your profile page. Free, self-serve.

Fails soft: any error returns the original text untouched so a translation
outage never breaks the chat itself.
"""
import httpx

from app.config import settings

CONFIG_URL = "https://meity-auth.ulcacontrib.org/ulca/apis/v0/model/getModelsPipeline"
PIPELINE_ID = "64392f96daac500b55c543cd"  # Bhashini's standard public pipeline

# Languages exposed in the frontend dropdown -> ISO-639 codes Bhashini expects
SUPPORTED_LANGUAGES = {
    "en": "English", "hi": "Hindi", "bn": "Bengali", "ta": "Tamil",
    "te": "Telugu", "mr": "Marathi", "gu": "Gujarati", "kn": "Kannada",
    "ml": "Malayalam", "pa": "Punjabi", "or": "Odia", "ur": "Urdu",
}

_config_cache: dict[tuple[str, str], dict] = {}


async def _get_pipeline_config(client: httpx.AsyncClient, source: str, target: str) -> dict:
    key = (source, target)
    if key in _config_cache:
        return _config_cache[key]

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


async def translate(text: str, source: str, target: str) -> str:
    """Translate `text` from `source` to `target` (ISO-639 codes). Soft-fails to original text."""
    if not text.strip() or source == target:
        return text
    if not settings.bhashini_user_id or not settings.bhashini_api_key:
        return text  # not configured — no-op rather than error

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            cfg = await _get_pipeline_config(client, source, target)
            resp = await client.post(
                cfg["callback_url"],
                headers={"Content-Type": "application/json", **cfg["auth_header"]},
                json={
                    "pipelineTasks": [{
                        "taskType": "translation",
                        "config": {
                            "language": {"sourceLanguage": source, "targetLanguage": target},
                            "serviceId": cfg["service_id"],
                        },
                    }],
                    "inputData": {"input": [{"source": text}]},
                },
            )
            resp.raise_for_status()
            out = resp.json()
            return out["pipelineResponse"][0]["output"][0]["target"]
    except Exception:
        return text  # degrade gracefully — chat still works in English
