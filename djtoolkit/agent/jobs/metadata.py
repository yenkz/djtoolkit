"""Agent job: write metadata tags to a local audio file and rename it.

Payload fields:
  local_path       str   — absolute path to the file
  metadata_source  str   — 'spotify' | 'audio-analysis'
  track            dict  — all track metadata fields (title, artist, album, year,
                           genres, tempo, key, mode, artists, ...)
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path

from djtoolkit.config import Config
from djtoolkit.metadata.writer import _write_tags, _target_filename

log = logging.getLogger(__name__)


async def run(cfg: Config, payload: dict) -> dict:
    """Write tags and rename file. Returns {local_path, metadata_written}."""
    local_path = payload.get("local_path")
    if not local_path or not Path(local_path).exists():
        raise FileNotFoundError(f"File not found: {local_path}")

    track = payload.get("track", {})
    path = Path(local_path)

    loop = asyncio.get_running_loop()

    # Write tags (CPU-bound mutagen calls)
    ok = await loop.run_in_executor(None, _write_tags, path, track)
    if not ok:
        raise RuntimeError(f"mutagen tag write failed for {local_path}")

    # Rename to normalised 'Artist - Title.ext' form
    target_name = _target_filename(
        track.get("artist", ""),
        track.get("title", ""),
        path.suffix,
    )
    target_path = path.parent / target_name
    if target_path != path and not target_path.exists():
        path.rename(target_path)
        path = target_path

    return {
        "local_path": str(path),
        "metadata_written": True,
    }
