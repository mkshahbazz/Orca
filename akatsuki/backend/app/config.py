"""Typed environment configuration (pydantic-settings)."""
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    openai_api_key: str = ""
    # Google Gemini — the fallback LLM provider. When OpenAI fails (quota,
    # outage, auth) the *same* agent pipeline continues on Gemini; see llm.py.
    gemini_api_key: str = ""
    # Primary Gemini model, then the fallbacks tried in order. The free tier
    # meters *per model* (5 requests/minute on 3.5-flash), and a chat needs a
    # router call plus a synthesis call, so the chain is deliberately wide: each
    # model adds its own quota, and one that is overloaded (503) or retired for
    # new callers (404) costs a single attempt instead of the whole request.
    # Retired ids are excluded on purpose — `gemini-2.5-flash` now 404s.
    gemini_model: str = "gemini-3.5-flash"
    gemini_fallback_models: str = (
        "gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-3.6-flash,"
        "gemini-3-flash-preview,gemini-flash-lite-latest,gemini-3.7-flash,gemini-3.8-flash"
    )
    # Optional Open-Meteo customer API key. The free endpoints are rate-limited
    # by IP, and this service shares its egress IP with everything else on the
    # host, so a key (which bills against the account's own quota) removes that
    # coupling. Without it the free endpoints are used exactly as before.
    open_meteo_api_key: str = ""
    supabase_url: str = ""
    supabase_service_role_key: str = ""
    # Public Storage bucket that holds fisher-contributed photos/video.
    supabase_storage_bucket: str = "community-media"
    database_url: str = ""
    port: int = 8000
    # comma-separated list, e.g. "https://your-app.vercel.app,https://yourdomain.com"
    cors_origins: str = "http://localhost:3000,http://127.0.0.1:3000"
    # Bhashini (bhashini.gov.in) — ulcaApiKey from your profile page; the
    # userID is issued alongside it (required to resolve inference endpoints)
    bhashini_user_id: str = ""
    bhashini_api_key: str = ""
    # Static/piped inference key. Bhashini normally returns this per pipeline
    # call, but a pre-issued inference key can be supplied here so translation
    # still works if the pipeline-config step is unreachable.
    bhashini_inference_key: str = ""

    def gemini_models(self) -> list[str]:
        """Primary model first, then the ordered fallbacks (deduplicated)."""
        chain = [self.gemini_model.strip()]
        chain += [m.strip() for m in self.gemini_fallback_models.split(",")]
        return [m for m in dict.fromkeys(chain) if m]


settings = Settings()
