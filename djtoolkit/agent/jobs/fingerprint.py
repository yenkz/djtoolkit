"""Agent job: fingerprint a single local file via fpcalc + AcoustID lookup.

Payload fields:
  local_path   str  — absolute path to the audio file
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path

from djtoolkit.config import Config
from djtoolkit.fingerprint.chromaprint import calc, lookup_acoustid

log = logging.getLogger(__name__)


async def run(cfg: Config, payload: dict) -> dict:
    """Fingerprint a file. Returns {fingerprint, acoustid, duration, is_duplicate}."""
    local_path = payload.get("local_path")
    if not local_path or not Path(local_path).exists():
        raise FileNotFoundError(f"File not found: {local_path}")

    # fpcalc is CPU-bound — run in thread pool to keep event loop free
    loop = asyncio.get_running_loop()
    fp_data = await loop.run_in_executor(None, calc, local_path, cfg)

    if not fp_data:
        raise RuntimeError(f"fpcalc failed on {local_path}")

    fingerprint = fp_data["fingerprint"]
    duration = fp_data["duration"]

    acoustid = await loop.run_in_executor(
        None,
        lookup_acoustid,
        fingerprint,
        duration,
        cfg.fingerprint.acoustid_api_key,
    )

    return {
        "fingerprint": fingerprint,
        "acoustid": acoustid,
        "duration": duration,
        "is_duplicate": False,  # duplicate detection happens server-side against the catalog
    }
