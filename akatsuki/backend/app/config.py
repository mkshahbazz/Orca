"""Typed environment configuration (pydantic-settings)."""
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    openai_api_key: str = ""
    supabase_url: str = ""
    supabase_service_role_key: str = ""
    database_url: str = ""
    port: int = 8000


settings = Settings()
