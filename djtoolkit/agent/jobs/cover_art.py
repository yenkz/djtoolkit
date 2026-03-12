"""Agent job: fetch and embed cover art into a local audio file.

Payload fields:
  local_path   str  — absolute path to the audio file
  artist       str
  album        str
  title        str  (optional, used as fallback search term)
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path

from djtoolkit.config import Config

log = logging.getLogger(__name__)


async def run(cfg: Config, payload: dict) -> dict:
    """Fetch + embed cover art. Returns {cover_art_written, source_used}."""
    local_path = payload.get("local_path")
    if not local_path or not Path(local_path).exists():
        raise FileNotFoundError(f"File not found: {local_path}")

    # Build a minimal track dict matching what art.py expects
    track = {
        "local_path": local_path,
        "artist": payload.get("artist", ""),
        "album": payload.get("album", ""),
        "title": payload.get("title", ""),
        "id": payload.get("track_id", 0),
    }

    loop = asyncio.get_running_loop()

    def _fetch_and_embed():
        from djtoolkit.coverart.art import fetch_cover_art, embed_cover_art
        img_data, source = fetch_cover_art(track, cfg)
        if not img_data:
            return False, None
        embed_cover_art(local_path, img_data)
        return True, source

    written, source = await loop.run_in_executor(None, _fetch_and_embed)

    return {
        "cover_art_written": written,
        "source_used": source,
    }
