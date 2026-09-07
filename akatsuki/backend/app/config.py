"""Typed environment configuration (pydantic-settings)."""
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    openai_api_key: str = ""
    supabase_url: str = ""
    supabase_service_role_key: str = ""
    database_url: str = ""
    port: int = 8000
    # comma-separated list, e.g. "https://your-app.vercel.app,https://yourdomain.com"
    cors_origins: str = "http://localhost:3000,http://127.0.0.1:3000"
    # Bhashini (bhashini.gov.in) — free signup, generate from your profile page
    bhashini_user_id: str = ""
    bhashini_api_key: str = ""


settings = Settings()
