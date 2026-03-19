# djtoolkit/agent/jobs/audio_analysis.py
"""Agent job: run audio analysis on a local file.

Payload fields:
  local_path   str  — absolute path to the audio file
  track_id     int
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path

from djtoolkit.config import Config

log = logging.getLogger(__name__)


async def run(cfg: Config, payload: dict) -> dict:
    """Run BPM/key/energy/danceability/loudness analysis. Returns feature dict."""
    from djtoolkit.enrichment.audio_analysis import analyze_single

    local_path = Path(payload["local_path"])
    if not local_path.is_file():
        raise FileNotFoundError(f"File not found: {local_path}")

    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, analyze_single, local_path)
