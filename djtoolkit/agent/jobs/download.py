"""Agent job: download a single track via aioslsk.

Payload fields:
  search_string  str   — primary Soulseek query
  artist         str
  title          str
  duration_ms    int
  track_id       int   — used only for logging
"""

from __future__ import annotations

import asyncio
import logging

from djtoolkit.config import Config
from djtoolkit.downloader.aioslsk_client import (
    _make_settings,
    _build_search_queries,
    _search_all,
    _rank_candidates,
    _download_track,
    _simplify_for_search,
)

log = logging.getLogger(__name__)


async def run(cfg: Config, payload: dict) -> dict:
    """Download a single track. Returns {local_path, file_format, file_size}."""
    from aioslsk.client import SoulSeekClient

    track = {
        "id": payload.get("track_id", 0),
        "artist": payload.get("artist", ""),
        "title": payload.get("title", ""),
        "duration_ms": payload.get("duration_ms", 0),
        "search_string": payload.get("search_string", ""),
    }

    settings = _make_settings(cfg)

    # Build query variants (same logic as the batch downloader)
    queries = _build_search_queries(track)

    async with SoulSeekClient(settings) as client:
        await client.login()

        results: list = []
        for query in queries:
            query_map = {track["id"]: query}
            round_results = await _search_all(client, query_map, cfg.soulseek.search_timeout_sec)
            results.extend(round_results.get(track["id"], []))
            if results and _rank_candidates(track, results, cfg, query):
                break  # got scorable results — stop trying fallback queries

        if not results:
            raise RuntimeError(f"No Soulseek results for: {track['artist']} – {track['title']}")

        local_path = await _download_track(client, cfg, track, results, queries[0])

    if not local_path:
        raise RuntimeError(f"Download failed (no peers matched): {track['artist']} – {track['title']}")

    import os
    from pathlib import Path
    p = Path(local_path)
    return {
        "local_path": str(local_path),
        "file_format": p.suffix.lstrip(".").lower(),
        "file_size": os.path.getsize(local_path) if os.path.exists(local_path) else 0,
    }
