"""Service configuration from environment variables."""

import os
from dataclasses import dataclass, field


@dataclass(frozen=True)
class Settings:
    cors_origins: list[str] = field(default_factory=list)


def get_settings() -> Settings:
    raw_origins = os.environ.get(
        "CORS_ORIGINS",
        "http://localhost:3000,https://djtoolkit.net,https://www.djtoolkit.net",
    )
    return Settings(
        cors_origins=[o.strip() for o in raw_origins.split(",") if o.strip()],
    )
