# djtoolkit/agent/jobs/cover_art.py
"""Agent job: fetch and embed cover art into a local audio file.

Payload fields:
  local_path   str  — absolute path to the audio file
  artist       str
  album        str
  title        str  (optional, used as fallback search term)
  spotify_uri  str | None
"""

from __future__ import annotations

import asyncio
import logging
from functools import partial
from pathlib import Path

from djtoolkit.config import Config

log = logging.getLogger(__name__)


async def run(cfg: Config, payload: dict) -> dict:
    """Fetch + embed cover art.

    Returns {cover_art_written: bool, artwork_url?: str, preview_url?: str, spotify_uri?: str}.
    """
    from djtoolkit.coverart.art import _fetch_art, _embed

    local_path = Path(payload.get("local_path", ""))
    if not local_path.exists():
        raise FileNotFoundError(f"File not found: {local_path}")

    artist = payload.get("artist", "")
    album = payload.get("album", "")
    title = payload.get("title", "")
    spotify_uri = payload.get("spotify_uri")

    ca = cfg.cover_art
    sources = [s.strip() for s in ca.sources.split() if s.strip()]

    fetch_fn = partial(
        _fetch_art, artist, album, title, sources,
        spotify_uri=spotify_uri,
        spotify_client_id=ca.spotify_client_id,
        spotify_client_secret=ca.spotify_client_secret,
        lastfm_api_key=ca.lastfm_api_key,
    )

    loop = asyncio.get_running_loop()
    art_result = await loop.run_in_executor(None, fetch_fn)

    if not art_result.image:
        return {"cover_art_written": False}

    await loop.run_in_executor(None, _embed, local_path, art_result.image)
    result: dict = {"cover_art_written": True}
    if art_result.spotify_uri and not spotify_uri:
        result["spotify_uri"] = art_result.spotify_uri
    if art_result.artwork_url:
        result["artwork_url"] = art_result.artwork_url
    if art_result.preview_url:
        result["preview_url"] = art_result.preview_url
    return result
