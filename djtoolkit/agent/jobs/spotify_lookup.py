# djtoolkit/agent/jobs/spotify_lookup.py
"""Agent job: look up track metadata on Spotify.

Payload fields:
  artist       str
  title        str
  duration_ms  int | None
  spotify_uri  str | None  — if already known, skip search
"""

from __future__ import annotations

import asyncio
import logging

from djtoolkit.config import Config

log = logging.getLogger(__name__)


async def run(cfg: Config, payload: dict) -> dict:
    """Search Spotify for track metadata. Returns metadata dict or {matched: False}."""
    from djtoolkit.enrichment.spotify_lookup import lookup_track

    artist = payload.get("artist", "")
    title = payload.get("title", "")
    duration_ms = payload.get("duration_ms")
    spotify_uri = payload.get("spotify_uri")

    ca = cfg.cover_art

    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(
        None, lambda: lookup_track(
            artist, title,
            duration_ms=duration_ms,
            client_id=ca.spotify_client_id,
            client_secret=ca.spotify_client_secret,
            spotify_uri=spotify_uri,
        )
    )

    if result is None:
        return {"matched": False}
    return result
