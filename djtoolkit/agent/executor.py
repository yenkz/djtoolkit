"""Job executor — routes job_type to the appropriate module.

Each executor function takes a job payload dict and returns a result dict.
No database writes — the daemon reports results back to the cloud.
"""

from __future__ import annotations

import asyncio
import logging
import shutil
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from djtoolkit.config import Config

log = logging.getLogger(__name__)


# ─── Payload settings helpers ────────────────────────────────────────────────

_COVER_ART_SOURCE_MAP = {"coverartarchive": "coverart"}


def _apply_download_settings(cfg: Config, settings: dict) -> None:
    """Override cfg matching/soulseek fields from payload settings."""
    if "min_score" in settings:
        cfg.matching.min_score = settings["min_score"]
        cfg.matching.min_score_title = settings["min_score"]
    if "duration_tolerance_ms" in settings:
        cfg.matching.duration_tolerance_ms = settings["duration_tolerance_ms"]
    if "search_timeout_sec" in settings:
        cfg.soulseek.search_timeout_sec = settings["search_timeout_sec"]


def _resolve_cover_art_sources(cfg: Config, settings: dict) -> list[str]:
    """Return cover art sources from payload settings or config fallback."""
    if "coverart_sources" in settings:
        return [_COVER_ART_SOURCE_MAP.get(s, s) for s in settings["coverart_sources"]]
    return [s.strip() for s in cfg.cover_art.sources.split() if s.strip()]


# ─── Soulseek client factory ─────────────────────────────────────────────────

_noisy_loggers_suppressed = False


@asynccontextmanager
async def _slsk_session(cfg: Config, credentials: dict):
    """Create a fresh SoulSeekClient for the duration of a batch.

    Mirrors the CLI's ``async with SoulSeekClient(settings) as client:``
    pattern — a clean connection per batch avoids stale-session issues.
    """
    global _noisy_loggers_suppressed

    from djtoolkit.downloader.aioslsk_client import _make_settings
    from aioslsk.client import SoulSeekClient

    cfg.soulseek.username = credentials["slsk_username"]
    cfg.soulseek.password = credentials["slsk_password"]
    settings = _make_settings(cfg)

    if not _noisy_loggers_suppressed:
        for _noisy in (
            "aioslsk.network.network", "aioslsk.network.connection",
            "aioslsk.network.peer", "aioslsk.transfer",
            "aioslsk.network.distributed", "aioslsk.distributed",
        ):
            logging.getLogger(_noisy).setLevel(logging.CRITICAL)
        _noisy_loggers_suppressed = True

    # Suppress noisy aioslsk peer connection errors that bubble through the
    # event loop exception handler (same pattern as _run_async in the CLI).
    loop = asyncio.get_running_loop()
    _orig_handler = loop.get_exception_handler()

    def _quiet_exception_handler(loop, context):
        exc = context.get("exception")
        if exc and (
            type(exc).__module__.startswith("aioslsk")
            or isinstance(exc, (ConnectionError, TimeoutError, OSError))
        ):
            return
        if _orig_handler:
            _orig_handler(loop, context)
        else:
            loop.default_exception_handler(context)

    loop.set_exception_handler(_quiet_exception_handler)
    loop.call_exception_handler = lambda ctx: _quiet_exception_handler(loop, ctx)

    async with SoulSeekClient(settings) as client:
        # Retry login with exponential backoff — Soulseek server sometimes
        # rejects rapid reconnections after a per-batch disconnect.
        last_exc = None
        for attempt in range(4):
            try:
                await client.login()
                log.info("Soulseek client connected")
                break
            except Exception as exc:
                last_exc = exc
                delay = 5 * (2 ** attempt)  # 5s, 10s, 20s, 40s
                log.warning(
                    "Soulseek login attempt %d failed: %s — retrying in %ds",
                    attempt + 1, exc, delay,
                )
                await asyncio.sleep(delay)
        else:
            raise last_exc  # type: ignore[misc]

        yield client

    log.info("Soulseek client disconnected")


async def shutdown_slsk_client():
    """No-op — kept for daemon compatibility. Clients are now per-batch."""
    pass


# ─── Job dispatch ────────────────────────────────────────────────────────────

async def execute_job(
    job_type: str, payload: dict, cfg: Config, credentials: dict,
) -> dict[str, Any]:
    """Dispatch a job to the appropriate executor. Returns result dict."""
    match job_type:
        case "download":
            return await execute_download(payload, cfg, credentials)
        case "fingerprint":
            return await execute_fingerprint(payload, cfg, credentials)
        case "spotify_lookup":
            return await execute_spotify_lookup(payload, cfg)
        case "cover_art":
            return await execute_cover_art(payload, cfg, credentials)
        case "audio_analysis":
            return await execute_audio_analysis(payload, cfg)
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
    # Apply user settings from payload (overrides local config)
    _apply_download_settings(cfg, payload.get("settings", {}))

    from djtoolkit.downloader.aioslsk_client import (
        _build_search_queries,
        _download_track,
    )

    search_string = payload.get("search_string", "")
    artist = payload.get("artist", "")
    title = payload.get("title", "")
    duration_ms = payload.get("duration_ms")

    track = {
        "id": payload.get("track_id", 0),
        "artist": artist,
        "title": title,
        "duration_ms": duration_ms,
        "search_string": search_string,
    }

    queries = _build_search_queries(track)

    async with _slsk_session(cfg, credentials) as client:
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


async def execute_download_batch(
    jobs: list[dict], cfg: Config, credentials: dict,
    report_fn=None, status_fn=None,
) -> dict[str, dict]:
    """Pipelined search + download for a batch of tracks.

    Fires all searches at once, then each track starts downloading as soon
    as viable results arrive. No track blocks another.

    Args:
        jobs: List of claimed job dicts with payload.
        cfg: App config.
        credentials: Soulseek credentials.
        report_fn: async callback(job_id, success, result, error) to report
                   each job's result as it completes.
        status_fn: optional callback(phase: str) to report batch phase changes.

    Returns:
        {job_id: {"success": bool, "result": dict|None, "error": str|None}}
    """
    # Apply user settings from first job's payload (single-user batches)
    first_payload = (jobs[0].get("payload") or {}) if jobs else {}
    _apply_download_settings(cfg, first_payload.get("settings", {}))

    from djtoolkit.downloader.aioslsk_client import (
        _build_search_queries,
        _pipeline_download,
    )

    # Build track dicts and query variants
    tracks_by_job: dict[str, dict] = {}
    queries_by_id: dict[int, list[str]] = {}

    for job in jobs:
        payload = job.get("payload") or {}
        job_id = job["id"]
        track_id = payload.get("track_id", 0)
        track = {
            "id": track_id,
            "artist": payload.get("artist", ""),
            "title": payload.get("title", ""),
            "duration_ms": payload.get("duration_ms"),
            "search_string": payload.get("search_string", ""),
        }
        tracks_by_job[job_id] = track
        queries_by_id[track_id] = _build_search_queries(track)

    log.info("Batch download: %d tracks", len(tracks_by_job))

    outcomes: dict[str, dict] = {}

    async def _outcome_report(job_id, success, result, error):
        outcomes[job_id] = {"success": success, "result": result, "error": error}
        if report_fn:
            await report_fn(job_id, success, result, error)

    async with _slsk_session(cfg, credentials) as client:
        await _pipeline_download(
            client, cfg, tracks_by_job, queries_by_id,
            report_fn=_outcome_report,
            status_fn=status_fn,
        )

    log.info(
        "Batch complete: %d ok, %d failed",
        sum(1 for o in outcomes.values() if o["success"]),
        sum(1 for o in outcomes.values() if not o["success"]),
    )
    return outcomes


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


# ─── Spotify Lookup ─────────────────────────────────────────────────────

async def execute_spotify_lookup(
    payload: dict, cfg: Config,
) -> dict[str, Any]:
    """Search Spotify for track metadata.

    Returns metadata dict on match, or {"matched": False} on no match.
    """
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


# ─── Audio Analysis ─────────────────────────────────────────────────────

async def execute_audio_analysis(
    payload: dict, cfg: Config,
) -> dict[str, Any]:
    """Run BPM/key/energy/danceability/loudness analysis on a local file.

    Returns feature dict.
    """
    from djtoolkit.enrichment.audio_analysis import analyze_single

    local_path = Path(payload["local_path"])
    if not local_path.is_file():
        raise FileNotFoundError(f"File not found: {local_path}")

    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, analyze_single, local_path)


# ─── Cover Art ───────────────────────────────────────────────────────────────

async def execute_cover_art(
    payload: dict, cfg: Config, credentials: dict,
) -> dict[str, Any]:
    """Fetch and embed cover art for a track.

    Returns {"cover_art_written": bool}.
    """
    from functools import partial
    from djtoolkit.coverart.art import _fetch_art, _embed

    local_path = Path(payload["local_path"])
    if not local_path.is_file():
        raise FileNotFoundError(f"File not found: {local_path}")

    artist = payload.get("artist", "")
    album = payload.get("album", "")
    title = payload.get("title", "")
    spotify_uri = payload.get("spotify_uri")

    ca = cfg.cover_art
    sources = _resolve_cover_art_sources(cfg, payload.get("settings", {}))

    fetch_fn = partial(
        _fetch_art, artist, album, title, sources,
        spotify_uri=spotify_uri,
        spotify_client_id=ca.spotify_client_id,
        spotify_client_secret=ca.spotify_client_secret,
        lastfm_api_key=ca.lastfm_api_key,
    )

    loop = asyncio.get_running_loop()
    art_bytes = await loop.run_in_executor(None, fetch_fn)

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
