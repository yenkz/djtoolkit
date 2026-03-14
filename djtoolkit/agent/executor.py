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


# ─── Persistent Soulseek client (shared within a batch) ──────────────────────

async def get_slsk_client(cfg: Config, credentials: dict):
    """Create, connect, and return a logged-in SoulSeekClient.

    The caller is responsible for closing the client when done.
    Credentials from the agent override the config-level values.
    """
    from djtoolkit.downloader.aioslsk_client import _make_settings

    cfg.soulseek.username = credentials["slsk_username"]
    cfg.soulseek.password = credentials["slsk_password"]

    # Suppress noisy aioslsk logs
    for _noisy in (
        "aioslsk.network.network", "aioslsk.network.connection",
        "aioslsk.network.peer", "aioslsk.transfer",
        "aioslsk.network.distributed", "aioslsk.distributed",
    ):
        logging.getLogger(_noisy).setLevel(logging.CRITICAL)

    from aioslsk.client import SoulSeekClient

    settings = _make_settings(cfg)
    client = SoulSeekClient(settings)
    await client.start()
    await client.login()
    return client


async def execute_download_batch(
    jobs: list[dict], cfg: Config, credentials: dict,
    report_fn=None,
) -> dict[str, dict]:
    """Batch search + parallel download for multiple tracks.

    Mirrors the CLI's run() from aioslsk_client.py:
    Phase 1: Batch search (_search_all for all tracks, one timeout window)
    Phase 2: Parallel download (asyncio.gather)
    Phase 3: Per-track local retry (next peer or fallback query)

    Args:
        jobs: List of claimed job dicts with payload.
        cfg: App config.
        credentials: Soulseek credentials.
        report_fn: async callback(job_id, success, result, error) to report
                   each job's result as it completes. If None, results are
                   returned in a dict.

    Returns:
        {job_id: {"success": bool, "result": dict|None, "error": str|None}}
    """
    from djtoolkit.downloader.aioslsk_client import (
        _build_search_queries,
        _search_all,
        _rank_candidates,
        _download_track,
    )

    client = await get_slsk_client(cfg, credentials)

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

    all_tracks = list(tracks_by_job.values())
    log.info("Batch download: %d tracks", len(all_tracks))

    # ── Phase 1: Batch search ────────────────────────────────────────────
    primary_queries = {t["id"]: queries_by_id[t["id"]][0] for t in all_tracks}
    results_by_track = await _search_all(client, primary_queries, cfg.soulseek.search_timeout_sec)

    hits = sum(1 for r in results_by_track.values() if r)
    log.info("Batch search: %d/%d tracks got results", hits, len(all_tracks))

    # Fallback rounds for tracks with no results
    def _needs_better(t):
        res = results_by_track.get(t["id"], [])
        return not res or not _rank_candidates(t, res, cfg, queries_by_id[t["id"]][0])

    fallback_idx: dict[int, int] = {t["id"]: 1 for t in all_tracks}
    for _round in range(3):
        needing = [t for t in all_tracks
                   if _needs_better(t) and fallback_idx[t["id"]] < len(queries_by_id[t["id"]])]
        if not needing:
            break

        fb_queries = {}
        for t in needing:
            idx = fallback_idx[t["id"]]
            fb_queries[t["id"]] = queries_by_id[t["id"]][idx]
            fallback_idx[t["id"]] += 1

        log.info("Fallback search round %d: %d tracks", _round + 1, len(fb_queries))
        fb_results = await _search_all(client, fb_queries, cfg.soulseek.search_timeout_sec)
        for tid, res in fb_results.items():
            if res:
                results_by_track.setdefault(tid, []).extend(res)

    # ── Phase 2: Parallel download with local retry ──────────────────────
    outcomes: dict[str, dict] = {}

    async def _download_one(job_id: str, track: dict):
        track_id = track["id"]
        results = results_by_track.get(track_id, [])
        label = f"{track.get('artist')} - {track.get('title')}"

        if not results:
            error = f"No search results for: {label}"
            log.warning("[batch] %s", error)
            outcomes[job_id] = {"success": False, "result": None, "error": error}
            if report_fn:
                await report_fn(job_id, False, None, error)
            return

        # Try download with local retry (up to 2 retries)
        last_error = None
        for attempt in range(3):
            try:
                local_path = await _download_track(
                    client, cfg, track, results, queries_by_id[track_id][0],
                )
                if local_path:
                    result = {"local_path": local_path}
                    log.info("[batch] OK: %s", label)
                    outcomes[job_id] = {"success": True, "result": result, "error": None}
                    if report_fn:
                        await report_fn(job_id, True, result, None)
                    return
                last_error = f"No matching file for: {label}"
            except Exception as exc:
                last_error = f"{type(exc).__name__}: {exc}"
                log.warning("[batch] attempt %d failed for %s: %s", attempt + 1, label, last_error)

        # All local retries exhausted
        log.error("[batch] FAIL after 3 attempts: %s", label)
        outcomes[job_id] = {"success": False, "result": None, "error": last_error}
        if report_fn:
            await report_fn(job_id, False, None, last_error)

    await asyncio.gather(*[
        _download_one(job_id, track)
        for job_id, track in tracks_by_job.items()
    ])

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
