"""Job executor — routes job_type to the appropriate module.

Each executor function takes a job payload dict and returns a result dict.
No database writes — the daemon reports results back to the cloud.
"""

from __future__ import annotations

import asyncio
import logging
import shutil
from pathlib import Path
from typing import Any

from djtoolkit.config import Config

log = logging.getLogger(__name__)


async def execute_job(
    job_type: str, payload: dict, cfg: Config, credentials: dict,
) -> dict[str, Any]:
    """Dispatch a job to the appropriate executor. Returns result dict."""
    match job_type:
        case "download":
            return await execute_download(payload, cfg, credentials)
        case "fingerprint":
            return await execute_fingerprint(payload, cfg, credentials)
        case "cover_art":
            return await execute_cover_art(payload, cfg, credentials)
        case "metadata":
            return await execute_metadata(payload, cfg)
        case _:
            raise ValueError(f"Unsupported job type: {job_type}")


# ─── Download ────────────────────────────────────────────────────────────────

async def execute_download(
    payload: dict, cfg: Config, credentials: dict,
) -> dict[str, Any]:
    """Search Soulseek and download a single track.

    Returns {"local_path": str} on success.
    Raises on failure.
    """
    from djtoolkit.downloader.aioslsk_client import (
        _build_search_queries,
        _make_settings,
        _rank_candidates,
        _download_track,
        _wait_for_transfer,
    )

    search_string = payload.get("search_string", "")
    artist = payload.get("artist", "")
    title = payload.get("title", "")
    duration_ms = payload.get("duration_ms")

    # Build a track-like dict for the existing functions
    track = {
        "id": payload.get("track_id", 0),
        "artist": artist,
        "title": title,
        "duration_ms": duration_ms,
        "search_string": search_string,
    }

    # Override config with agent credentials
    cfg.soulseek.username = credentials["slsk_username"]
    cfg.soulseek.password = credentials["slsk_password"]

    queries = _build_search_queries(track)

    settings = _make_settings(cfg)

    # Suppress noisy aioslsk logs
    for _noisy in (
        "aioslsk.network.network", "aioslsk.network.connection",
        "aioslsk.network.peer", "aioslsk.transfer",
        "aioslsk.network.distributed", "aioslsk.distributed",
    ):
        logging.getLogger(_noisy).setLevel(logging.CRITICAL)

    from aioslsk.client import SoulSeekClient

    async with SoulSeekClient(settings) as client:
        await client.login()

        # Search with all query variants
        all_results = []
        for query in queries:
            request = await client.searches.search(query)
            await asyncio.sleep(cfg.soulseek.search_timeout_sec)
            all_results.extend(request.results)

        if not all_results:
            raise RuntimeError(f"No search results for: {search_string}")

        local_path = await _download_track(
            client, cfg, track, all_results, queries[0],
        )

        if not local_path:
            raise RuntimeError(f"No matching file found for: {search_string}")

        return {"local_path": local_path}


# ─── Fingerprint ─────────────────────────────────────────────────────────────

async def execute_fingerprint(
    payload: dict, cfg: Config, credentials: dict,
) -> dict[str, Any]:
    """Run fpcalc + optional AcoustID lookup on a local file.

    Returns {"fingerprint": str, "acoustid": str|None, "duration": float}.
    """
    from djtoolkit.fingerprint.chromaprint import calc, lookup_acoustid

    local_path = payload["local_path"]
    if not Path(local_path).is_file():
        raise FileNotFoundError(f"File not found: {local_path}")

    # Run fpcalc (CPU-bound, use thread pool)
    loop = asyncio.get_running_loop()
    fp_data = await loop.run_in_executor(None, calc, local_path, cfg)

    if fp_data is None:
        raise RuntimeError(f"fpcalc failed for: {local_path}")

    # Optional AcoustID lookup
    acoustid_key = credentials.get("acoustid_key") or ""
    acoustid = None
    if acoustid_key:
        acoustid = await loop.run_in_executor(
            None, lookup_acoustid,
            fp_data["fingerprint"], fp_data["duration"], acoustid_key,
        )

    return {
        "fingerprint": fp_data["fingerprint"],
        "acoustid": acoustid,
        "duration": fp_data["duration"],
    }


# ─── Cover Art ───────────────────────────────────────────────────────────────

async def execute_cover_art(
    payload: dict, cfg: Config, credentials: dict,
) -> dict[str, Any]:
    """Fetch and embed cover art for a track.

    Returns {"cover_art_written": bool}.
    """
    from djtoolkit.coverart.art import _fetch_art, _embed

    local_path = Path(payload["local_path"])
    if not local_path.is_file():
        raise FileNotFoundError(f"File not found: {local_path}")

    artist = payload.get("artist", "")
    album = payload.get("album", "")
    title = payload.get("title", "")

    ca = cfg.cover_art
    sources = [s.strip() for s in ca.sources.split() if s.strip()]

    loop = asyncio.get_running_loop()
    art_bytes = await loop.run_in_executor(
        None, _fetch_art,
        artist, album, title, sources,
    )

    if not art_bytes:
        return {"cover_art_written": False}

    await loop.run_in_executor(None, _embed, local_path, art_bytes)
    return {"cover_art_written": True}


# ─── Metadata ────────────────────────────────────────────────────────────────

async def execute_metadata(
    payload: dict, cfg: Config,
) -> dict[str, Any]:
    """Write metadata tags to a track file and normalize filename.

    Returns {"local_path": str, "metadata_written": bool}.
    """
    from djtoolkit.metadata.writer import _write_tags, _target_filename

    local_path = Path(payload["local_path"])
    if not local_path.is_file():
        raise FileNotFoundError(f"File not found: {local_path}")

    # Build track dict from payload for _write_tags
    track = {
        "title": payload.get("title", ""),
        "artist": payload.get("artist", ""),
        "artists": payload.get("artists", ""),
        "album": payload.get("album", ""),
        "year": payload.get("year"),
        "genres": payload.get("genres", ""),
        "tempo": payload.get("bpm"),
        "key": None,
        "mode": None,
    }

    # Parse musical_key back to key/mode if present
    musical_key = payload.get("musical_key", "")
    if musical_key:
        # _key_str produces e.g. "Am", "F#", "C" — reverse that
        # For now, just set the tag string directly; _write_tags handles int key/mode
        pass

    loop = asyncio.get_running_loop()
    success = await loop.run_in_executor(None, _write_tags, local_path, track)

    # Normalize filename
    new_path = local_path
    if success and track.get("artist") and track.get("title"):
        target_name = _target_filename(track["artist"], track["title"], local_path.suffix)
        target_path = local_path.parent / target_name
        if target_path != local_path and not target_path.exists():
            shutil.move(str(local_path), str(target_path))
            new_path = target_path

    return {
        "local_path": str(new_path),
        "metadata_written": success,
    }
