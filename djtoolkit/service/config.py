"""Service configuration from environment variables."""

import os
from dataclasses import dataclass, field


@dataclass(frozen=True)
class Settings:
    supabase_url: str = ""
    supabase_service_role_key: str = ""
    cors_origins: list[str] = field(default_factory=list)


def get_settings() -> Settings:
    raw_origins = os.environ.get(
        "CORS_ORIGINS",
        "http://localhost:3000,https://djtoolkit.net,https://www.djtoolkit.net",
    )
    return Settings(
        supabase_url=os.environ.get("SUPABASE_URL", ""),
        supabase_service_role_key=os.environ.get("SUPABASE_SERVICE_ROLE_KEY", ""),
        cors_origins=[o.strip() for o in raw_origins.split(",") if o.strip()],
    )
