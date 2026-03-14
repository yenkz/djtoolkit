"""aioslsk downloader — embedded Soulseek client.

Uses aioslsk (https://github.com/JurgenR/aioslsk) to search the Soulseek
network and download files directly within the djtoolkit process.
Credentials go in [soulseek] config section.

aioslsk data model quick-reference:
  SearchResultEvent.result  → SearchResult
  SearchResult.username     → str
  SearchResult.shared_items → list[FileData]
  FileData.filename         → str  (full remote path, Windows-style separators)
  FileData.filesize         → int  (bytes)
  FileData.extension        → str  (without leading dot, e.g. "flac")
  FileData.get_attribute_map() → dict[AttributeKey, int]
    AttributeKey.BITRATE = 0   (kbps)
    AttributeKey.DURATION = 1  (seconds)
  TransferProgressEvent.updates → list[tuple[Transfer, TransferProgressSnapshot, TransferProgressSnapshot]]
  TransferProgressSnapshot.state → TransferState.State
  Transfer.local_path       → str | None  (set after download completes)
"""

import asyncio
import logging
import re
from pathlib import Path

from thefuzz import fuzz

from djtoolkit.config import Config
from djtoolkit.db.database import connect

log = logging.getLogger(__name__)

AUDIO_EXTS = {".mp3", ".flac", ".aiff", ".aif", ".wav", ".ogg", ".m4a"}

# Max number of peers to try per track before giving up
_MAX_DOWNLOAD_RETRIES = 3

# TransferState.State values that indicate a finished transfer
_TERMINAL_FAILED = None  # populated lazily from aioslsk.transfer.state


def _terminal_failed_states():
    global _TERMINAL_FAILED
    if _TERMINAL_FAILED is None:
        from aioslsk.transfer.state import TransferState
        _TERMINAL_FAILED = frozenset({
            TransferState.State.FAILED,
            TransferState.State.ABORTED,
            TransferState.State.INCOMPLETE,
        })
    return _TERMINAL_FAILED


# ─── aioslsk Settings factory ─────────────────────────────────────────────────

def _make_settings(cfg: Config):
    from aioslsk.settings import (
        Settings, CredentialsSettings, SharesSettings,
        NetworkSettings, ListeningSettings, ServerSettings,
        ReconnectSettings,
    )
    from aioslsk.network.network import ListeningConnectionErrorMode
    return Settings(
        credentials=CredentialsSettings(
            username=cfg.soulseek.username,
            password=cfg.soulseek.password,
        ),
        shares=SharesSettings(
            download=str(cfg.downloads_dir),
        ),
        network=NetworkSettings(
            listening=ListeningSettings(
                error_mode=ListeningConnectionErrorMode.ALL,
            ),
            server=ServerSettings(
                reconnect=ReconnectSettings(auto=True),
            ),
        ),
    )


# ─── Path helpers ─────────────────────────────────────────────────────────────

def _basename(path: str) -> str:
    """Extract filename stem from a Windows or POSIX remote path."""
    name = path.replace("\\", "/").split("/")[-1]
    return name.rsplit(".", 1)[0] if "." in name else name


def _ext(path: str) -> str:
    name = path.replace("\\", "/").split("/")[-1]
    return ("." + name.rsplit(".", 1)[-1]).lower() if "." in name else ""


# ─── File scoring and selection ───────────────────────────────────────────────

def _quality_score(file) -> tuple[int, int]:
    """Score a FileData by format preference. Returns (quality, filesize)."""
    try:
        from aioslsk.protocol.primitives import AttributeKey
        attr_map = file.get_attribute_map()
        bitrate = attr_map.get(AttributeKey.BITRATE, 0) or 0
    except Exception:
        bitrate = 0

    ext = (file.extension or "").lower()
    score = 0
    if ext == "flac" or file.filename.lower().endswith(".flac"):
        score += 100
    elif ext == "mp3" or file.filename.lower().endswith(".mp3"):
        score += 5
    if "320" in file.filename:
        score += 10
    if bitrate >= 320:
        score += 10
    elif bitrate >= 256:
        score += 5

    return score, file.filesize


def _relevance(track: dict, filename: str, query: str = "") -> float:
    """
    Relevance of a remote filename against the track.
    Primary: word-overlap against search query (filters clearly wrong files).
    Secondary: fuzzy match against artist+title for ranking.

    Title matching uses the max of full-title and simplified-title scores so that
    files omitting version suffixes like "Original Mix" are not penalised.
    e.g. "Holding On - Original Mix" vs file "Holding On.flac" — simplified wins.

    Artist matching checks both the filename stem AND the full path, because
    Soulseek users commonly store files as "Hotlane/Whenever.flac" — the artist
    is in the directory name, not the filename itself.
    """
    stem = _basename(filename).lower()
    # Forward-slash normalised full path for directory-level artist matching
    full_path = filename.replace("\\", "/").lower()

    # Word-overlap pre-filter: if a query is provided, require ≥50% word match
    if query and _relevance_score(stem, query) == 0:
        return 0.0

    title = (track.get("title") or "").lower()
    artist = (track.get("artist") or "").lower()
    # Also score against the simplified title (version/remix suffix stripped)
    simplified = _simplify_for_search(title).lower()
    t = max(fuzz.partial_ratio(title, stem), fuzz.partial_ratio(simplified, stem)) / 100
    # Artist may live in the directory path (e.g. "Hotlane/Whenever.flac")
    a = max(fuzz.partial_ratio(artist, stem), fuzz.partial_ratio(artist, full_path)) / 100
    return t * 0.6 + a * 0.4


def _rank_candidates(track: dict, results: list, cfg: Config, query: str = "") -> list[tuple[str, str]]:
    """
    Return all valid (username, remote_filename) pairs sorted best-first.

    Filters: extension in AUDIO_EXTS, duration within tolerance, relevance >= min_score_title.
    Ranks: quality score (FLAC > MP3, bitrate) then relevance.
    """
    track_dur_ms = track.get("duration_ms") or 0
    candidates = []

    for result in results:
        username = result.username
        for file in result.shared_items:
            ext = ("." + file.extension.lower()) if file.extension else _ext(file.filename)
            if ext not in AUDIO_EXTS:
                continue

            # Duration gate
            if track_dur_ms:
                try:
                    from aioslsk.protocol.primitives import AttributeKey
                    dur_sec = file.get_attribute_map().get(AttributeKey.DURATION, 0) or 0
                except Exception:
                    dur_sec = 0
                if dur_sec and abs(track_dur_ms - dur_sec * 1000) > cfg.matching.duration_tolerance_ms:
                    continue

            rel = _relevance(track, file.filename, query)
            if rel < cfg.matching.min_score_title:
                continue

            candidates.append((_quality_score(file), rel, username, file.filename))

    candidates.sort(key=lambda x: (x[0], x[1]), reverse=True)
    total_files = sum(len(r.shared_items) for r in results)
    log.debug(
        "[%d] %d/%d files passed filter (from %d peers)",
        track["id"], len(candidates), total_files, len(results),
    )
    return [(user, fn) for _, _, user, fn in candidates]


def _pick_best(track: dict, results: list, cfg: Config, query: str = "") -> tuple[str | None, str | None]:
    ranked = _rank_candidates(track, results, cfg, query)
    return (ranked[0][0], ranked[0][1]) if ranked else (None, None)


# ─── Search query helpers ─────────────────────────────────────────────────────

def _simplify_for_search(title: str) -> str:
    """Strip remix/version/edit/feat suffixes to maximise Soulseek hit rate."""
    patterns = [
        r"\(feat\.?\s+[^)]*\)",
        r"\(ft\.?\s+[^)]*\)",
        r"feat\.?\s+.+",
        r"ft\.?\s+.+",
        r"-\s+.+\s+remix\b.*",
        r"-\s+.+\s+edit\b.*",
        r"-\s+.+\s+mix\b.*",
        r"-\s+.+\s+version\b.*",
        r"-\s+.+\s+dub\b.*",
        r"-\s+.+\s+rework\b.*",
        r"-\s+.+\s+bootleg\b.*",
        r"-\s+\w+\s+remix\b.*",
        r"-\s+\w+\s+version\b.*",
        r"\(.*remix.*\)",
        r"\(.*edit.*\)",
        r"\(.*version.*\)",
        r"\(.*mix\)",
        r"\(.*dub\)",
        r"\(.*rework.*\)",
        r"\(.*bootleg.*\)",
    ]
    cleaned = title
    for p in patterns:
        cleaned = re.sub(p, "", cleaned, flags=re.IGNORECASE)
    return re.sub(r"\s+", " ", cleaned).strip(" -–—")


def _relevance_score(filename: str, query: str) -> int:
    """Word-overlap relevance of filename vs query (0–100). Returns 0 if clearly irrelevant."""
    def _norm(text: str) -> str:
        return " ".join(re.sub(r"[^\w\s]", " ", text.lower()).split())

    fn, q = _norm(filename), _norm(query)
    words = q.split()
    if not words:
        return 0
    matched = sum(1 for w in words if w in fn)
    ratio = matched / len(words)
    return 0 if ratio < 0.5 else int(ratio * 100)


def _normalize_query(text: str) -> str:
    """Strip punctuation and collapse whitespace — produces a clean Soulseek query."""
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s]", " ", text)).strip().lower()


def _build_search_queries(track: dict) -> list[str]:
    """
    Return progressive fallback queries (deduplicated, in priority order):
      1. Original search_string (may contain hyphens / punctuation)
      2. Simplified title (remix/version/feat stripped) if different
      3. Punctuation-normalised version of the primary query
      4. Artist-only (last resort, only for multi-word artists)
    """
    base = track.get("search_string") or f"{track.get('artist', '')} {track.get('title', '')}"
    artist = (track.get("artist") or "").split(";")[0].strip()
    title = track.get("title") or ""

    seen: set[str] = set()
    queries: list[str] = []

    def _add(q: str) -> None:
        # Dedup by exact string — we intentionally keep "romare rainbow - club" and
        # "romare rainbow club" as distinct queries since some Soulseek peers treat
        # punctuation differently during local file matching.
        if q and q not in seen:
            seen.add(q)
            queries.append(q)

    _add(base)

    if title:
        simplified = f"{artist} {_simplify_for_search(title)}".strip()
        _add(simplified)

    # Normalised version strips hyphens/parentheses that confuse some peers
    _add(_normalize_query(base))

    # Artist-only as last resort for multi-word artists
    if len(artist.split()) >= 2:
        _add(artist)

    return queries


# ─── Search ───────────────────────────────────────────────────────────────────

async def _search_all(client, query_by_track_id: dict[int, str], timeout_sec: float) -> dict[int, list]:
    """
    Fire all searches simultaneously, wait once for timeout_sec, return results.
    Returns {track_id: [SearchResult, ...]} for all tracks.
    """
    from aioslsk.commands import GlobalSearchCommand
    from aioslsk.events import SearchResultEvent

    ticket_to_track: dict[int, int] = {}
    results_by_track: dict[int, list] = {tid: [] for tid in query_by_track_id}

    async def on_result(event: SearchResultEvent):
        ticket = getattr(event.result, "ticket", None)
        track_id = ticket_to_track.get(ticket)
        if track_id is not None:
            results_by_track[track_id].append(event.result)

    client.events.register(SearchResultEvent, on_result)
    try:
        for track_id, query in query_by_track_id.items():
            cmd = GlobalSearchCommand(query)
            await client.execute(cmd)
            ticket_to_track[cmd._ticket] = track_id
        await asyncio.sleep(timeout_sec)
    finally:
        client.events.unregister(SearchResultEvent, on_result)

    return results_by_track


# ─── Pipelined search + download ─────────────────────────────────────────────

async def _pipeline_download(
    client,
    cfg: Config,
    tracks_by_job: dict[str, dict],      # {job_id: track_dict}
    queries_by_id: dict[int, list[str]],  # {track_id: [query_variants]}
    report_fn,                            # async (job_id, success, result, error) -> None
    status_fn=None,                       # optional (phase: str) -> None
) -> None:
    """
    Pipelined search + download: each track starts downloading as soon as
    viable search results arrive, rather than waiting for all searches to finish.

    Each track dict in tracks_by_job MUST have an ``"id"`` key that
    corresponds to a key in queries_by_id.
    """
    from aioslsk.commands import GlobalSearchCommand
    from aioslsk.events import SearchResultEvent

    all_tracks = list(tracks_by_job.values())
    job_by_track_id: dict[int, str] = {t["id"]: job_id for job_id, t in tracks_by_job.items()}

    # Per-track result collectors and wake-up events
    results_by_track: dict[int, list] = {t["id"]: [] for t in all_tracks}
    track_events: dict[int, asyncio.Event] = {t["id"]: asyncio.Event() for t in all_tracks}

    # Maps search ticket → track_id so the result handler can route
    ticket_to_track: dict[int, int] = {}

    async def _on_result(event):
        ticket = getattr(event.result, "ticket", None)
        track_id = ticket_to_track.get(ticket)
        if track_id is not None:
            results_by_track[track_id].append(event.result)
            track_events[track_id].set()

    async def _worker(track: dict) -> None:
        """Per-track worker: wait for viable results, then download."""
        track_id = track["id"]
        job_id = job_by_track_id[track_id]
        query_variants = queries_by_id.get(track_id, [])
        primary_query = query_variants[0] if query_variants else ""
        timeout = cfg.soulseek.search_timeout_sec

        try:
            # Phase A: wait for viable results from primary search
            viable = await _wait_for_viable(
                track, track_id, results_by_track, track_events, cfg, primary_query, timeout,
            )

            # Phase B: fallback queries if primary yielded nothing viable
            if not viable:
                for variant in query_variants[1:]:
                    cmd = GlobalSearchCommand(variant)
                    await client.execute(cmd)
                    ticket_to_track[cmd._ticket] = track_id
                    log.info("[%d] Fallback query: «%s»", track_id, variant)

                    # Clear event and wait for new results
                    track_events[track_id].clear()
                    viable = await _wait_for_viable(
                        track, track_id, results_by_track, track_events, cfg, primary_query, timeout,
                    )
                    if viable:
                        break

            # Phase C: download
            if not viable:
                log.warning("[%d] No viable results after all queries", track_id)
                await report_fn(job_id, False, None, "No viable search results")
                return

            # Snapshot results to avoid data race
            snapshot = list(results_by_track[track_id])
            local_path = await _download_track(client, cfg, track, snapshot, primary_query)

            if local_path:
                log.info("[%d] ✓ downloaded via pipeline", track_id)
                await report_fn(job_id, True, {"local_path": local_path}, None)
            else:
                log.warning("[%d] No matching file (all peers exhausted)", track_id)
                await report_fn(job_id, False, None, f"No matching file for: {track.get('artist')} - {track.get('title')}")

        except Exception as exc:
            log.exception("[%d] Pipeline worker error", track_id)
            await report_fn(job_id, False, None, str(exc))

    client.events.register(SearchResultEvent, _on_result)
    try:
        if status_fn:
            status_fn("searching")

        # Fire all primary searches at once
        for track in all_tracks:
            track_id = track["id"]
            variants = queries_by_id.get(track_id, [])
            if variants:
                cmd = GlobalSearchCommand(variants[0])
                await client.execute(cmd)
                ticket_to_track[cmd._ticket] = track_id

        if status_fn:
            status_fn("downloading")

        # Run all workers concurrently
        await asyncio.gather(*[_worker(t) for t in all_tracks])
    finally:
        client.events.unregister(SearchResultEvent, _on_result)


async def _wait_for_viable(
    track: dict,
    track_id: int,
    results_by_track: dict[int, list],
    track_events: dict[int, asyncio.Event],
    cfg: Config,
    query: str,
    timeout: float,
) -> bool:
    """
    Wait up to *timeout* seconds for viable candidates to appear for a track.
    Checks _rank_candidates each time the per-track event fires.
    Returns True as soon as viable candidates exist, False on timeout.
    """
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while True:
        remaining = deadline - loop.time()
        if remaining <= 0:
            return False
        # Check if we already have viable results
        if results_by_track[track_id] and _rank_candidates(track, results_by_track[track_id], cfg, query):
            return True
        # Wait for more results (or poll interval, whichever comes first)
        track_events[track_id].clear()
        try:
            await asyncio.wait_for(track_events[track_id].wait(), timeout=min(remaining, 2.0))
        except asyncio.TimeoutError:
            # Poll interval expired — loop will re-check remaining time
            pass


# ─── Download ─────────────────────────────────────────────────────────────────

async def _wait_for_transfer(
    client, transfer, timeout_sec: float,
    track_id: int = 0, progress=None, task_id=None,
) -> bool:
    """
    Wait for a Transfer to reach a terminal state.
    Returns True on COMPLETE, False on failure/timeout.
    When progress+task_id are given, drives a rich progress bar every 2s.
    Otherwise logs every 30s so the terminal doesn't appear frozen.
    """
    from aioslsk.events import TransferProgressEvent
    from aioslsk.transfer.state import TransferState

    done = asyncio.Event()
    success = False

    async def on_progress(event: TransferProgressEvent):
        nonlocal success
        for xfer, *_, snapshot in event.updates:
            if xfer is not transfer:
                continue
            if snapshot.state == TransferState.State.COMPLETE:
                success = True
                done.set()
            elif snapshot.state in _terminal_failed_states():
                done.set()

    async def _ticker():
        elapsed = 0
        tick = 2 if progress else 30
        while True:
            await asyncio.sleep(tick)
            elapsed += tick
            snap = transfer.progress_snapshot
            total = transfer.filesize or 0
            if progress and task_id is not None:
                if snap.bytes_transfered > 0:
                    progress.update(task_id, completed=snap.bytes_transfered,
                                    total=total or None)
                elif transfer.place_in_queue is not None:
                    progress.update(task_id, completed=0, total=None)
            else:
                mb_done = snap.bytes_transfered / 1_048_576
                speed_kbps = (snap.speed or 0) / 1024
                if transfer.place_in_queue is not None and snap.bytes_transfered == 0:
                    log.info("[%d]   queued at position %d (%ds elapsed)",
                             track_id, transfer.place_in_queue, elapsed)
                elif total:
                    pct = snap.bytes_transfered / total * 100
                    log.info("[%d]   %.0f%% (%.1f / %.1f MB @ %.0f KB/s, %ds elapsed)",
                             track_id, pct, mb_done, total / 1_048_576, speed_kbps, elapsed)
                elif mb_done > 0:
                    log.info("[%d]   %.1f MB @ %.0f KB/s (%ds elapsed)",
                             track_id, mb_done, speed_kbps, elapsed)
                else:
                    log.info("[%d]   waiting for peer… (%ds elapsed)", track_id, elapsed)

    client.events.register(TransferProgressEvent, on_progress)
    ticker_task = asyncio.create_task(_ticker())
    try:
        await asyncio.wait_for(done.wait(), timeout=timeout_sec)
    except asyncio.TimeoutError:
        log.warning("[%d] Transfer timed out after %.0fs", track_id, timeout_sec)
    finally:
        ticker_task.cancel()
        try:
            await ticker_task
        except asyncio.CancelledError:
            pass
        client.events.unregister(TransferProgressEvent, on_progress)

    return success


async def _download_track(
    client, cfg: Config, track: dict, results: list,
    query: str = "", progress=None, task_id=None,
) -> str | None:
    """
    Download a single track given pre-fetched search results.
    Tries up to _MAX_DOWNLOAD_RETRIES peers (best-first) before giving up.
    Returns local_path on success, None on no match or all peers exhausted.
    """
    ranked = _rank_candidates(track, results, cfg, query)
    if not ranked:
        return None

    track_id = track["id"]
    label = f"{track.get('artist', '')} – {track.get('title', '')}"

    for attempt, (username, remote_filename) in enumerate(ranked[:_MAX_DOWNLOAD_RETRIES]):
        fname = remote_filename.split("\\")[-1]
        if attempt > 0:
            log.info("[%d] Retry %d/%d → %s: %s", track_id, attempt + 1, _MAX_DOWNLOAD_RETRIES, username, fname)
        else:
            log.info("[%d] → %s: %s", track_id, username, fname)

        transfer = await client.transfers.download(username, remote_filename)

        if progress and task_id is not None:
            retry_prefix = f"[yellow]↻{attempt+1}[/yellow] " if attempt > 0 else ""
            progress.update(
                task_id,
                description=f"{retry_prefix}[cyan]{label}[/cyan]  [dim]{fname}[/dim]",
                total=transfer.filesize or None,
                completed=0,
            )
        else:
            size_mb = f"{transfer.filesize / 1_048_576:.1f} MB" if transfer.filesize else "unknown size"
            log.info("[%d]   %s", track_id, size_mb)

        success = await _wait_for_transfer(
            client, transfer, cfg.soulseek.download_timeout_sec,
            track_id, progress=progress, task_id=task_id,
        )
        if success:
            local_path = getattr(transfer, "local_path", None)
            if local_path:
                return str(local_path)

    return None


# ─── DB helper ────────────────────────────────────────────────────────────────

def _set_status(db_path: Path, track_id: int, status: str, local_path: str | None = None) -> None:
    with connect(db_path) as conn:
        if local_path is not None:
            conn.execute(
                "UPDATE tracks SET acquisition_status = ?, local_path = ? WHERE id = ?",
                (status, local_path, track_id),
            )
        else:
            conn.execute(
                "UPDATE tracks SET acquisition_status = ? WHERE id = ?",
                (status, track_id),
            )
        conn.commit()


# ─── Main pipeline step ───────────────────────────────────────────────────────

async def _run_async(cfg: Config, progress=None) -> dict:
    from aioslsk.client import SoulSeekClient

    if not cfg.soulseek.username or not cfg.soulseek.password:
        raise RuntimeError(
            "Soulseek credentials not configured. "
            "Set [soulseek] username and SOULSEEK_PASSWORD in .env."
        )

    stats = {"attempted": 0, "downloaded": 0, "failed": 0, "no_match": 0}

    with connect(cfg.db_path) as conn:
        candidates = conn.execute(
            "SELECT * FROM tracks WHERE acquisition_status = 'candidate'"
        ).fetchall()

    if not candidates:
        log.info("No candidate tracks found")
        return stats

    log.info("Downloading %d candidates via aioslsk (Soulseek)", len(candidates))
    settings = _make_settings(cfg)

    # Suppress noisy internal aioslsk logs (P2P connection chatter, distributed network)
    # aioslsk.distributed is the correct module name (not aioslsk.network.distributed)
    for _noisy in (
        "aioslsk.network.network", "aioslsk.network.connection",
        "aioslsk.network.peer", "aioslsk.transfer",
        "aioslsk.network.distributed", "aioslsk.distributed",
    ):
        logging.getLogger(_noisy).setLevel(logging.CRITICAL)

    # Suppress asyncio "unhandled exception on loop" noise from aioslsk background tasks.
    # set_exception_handler only covers exceptions raised while the loop is running;
    # post-close GC-triggered exceptions go through call_exception_handler directly.
    # Patching the method on the loop instance covers both cases.
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
    # Also patch the instance method so GC-triggered post-close exceptions are suppressed
    loop.call_exception_handler = lambda ctx: _quiet_exception_handler(loop, ctx)

    async def _do_download(client, track: dict, results: list, query: str = "") -> None:
        track_id = track["id"]
        label = f"{track.get('artist')} – {track.get('title')}"
        task_id = None
        if progress:
            task_id = progress.add_task(
                f"[dim]{label}[/dim]",
                total=None,
            )
        try:
            if not results:
                log.warning("[%d] No results: %s", track_id, label)
                if progress and task_id is not None:
                    progress.update(task_id, description=f"[red]✗ no results[/red]  {label}",
                                    total=1, completed=1)
                _set_status(cfg.db_path, track_id, "failed")
                stats["no_match"] += 1
                stats["failed"] += 1
                return
            local_path = await _download_track(client, cfg, track, results, query,
                                               progress=progress, task_id=task_id)
            if local_path:
                _set_status(cfg.db_path, track_id, "available", local_path)
                log.info("[%d] ✓ %s", track_id, label)
                if progress and task_id is not None:
                    progress.update(task_id, description=f"[green]✓[/green]  {label}",
                                    completed=progress._tasks[task_id].total or 1,
                                    total=progress._tasks[task_id].total or 1)
                stats["downloaded"] += 1
            else:
                n_files = sum(len(sr.shared_items) for sr in results)
                log.warning("[%d] No match: %s  (%d files, all filtered/timed out)",
                            track_id, label, n_files)
                if progress and task_id is not None:
                    progress.update(task_id, description=f"[red]✗ no match[/red]  {label}",
                                    total=1, completed=1)
                _set_status(cfg.db_path, track_id, "failed")
                stats["no_match"] += 1
                stats["failed"] += 1
        except Exception:
            log.exception("[%d] Unexpected error: %s", track_id, label)
            if progress and task_id is not None:
                progress.update(task_id, description=f"[red]✗ error[/red]  {label}",
                                total=1, completed=1)
            _set_status(cfg.db_path, track_id, "failed")
            stats["failed"] += 1

    async with SoulSeekClient(settings) as client:
        await client.login()

        tracks = [dict(row) for row in candidates]
        stats["attempted"] = len(tracks)

        # Build per-track query variants (original + simplified + artist-only fallbacks)
        queries_by_track: dict[int, list[str]] = {t["id"]: _build_search_queries(t) for t in tracks}

        # ── Phase 1: search ────────────────────────────────────────────────────
        log.info("Searching %d tracks (%.0fs window)…", len(tracks), cfg.soulseek.search_timeout_sec)
        search_task = None
        if progress:
            search_task = progress.add_task(
                f"[bold cyan]Searching {len(tracks)} tracks"
                f"[/bold cyan]  [dim]{cfg.soulseek.search_timeout_sec:.0f}s window[/dim]",
                total=None,
            )

        primary_queries = {t["id"]: queries_by_track[t["id"]][0] for t in tracks}
        results_by_track = await _search_all(client, primary_queries, cfg.soulseek.search_timeout_sec)

        hits = sum(1 for r in results_by_track.values() if r)
        total_files = sum(sum(len(sr.shared_items) for sr in r) for r in results_by_track.values())
        log.info("Search done: %d/%d tracks got results (%d files total)", hits, len(tracks), total_files)
        if progress and search_task is not None:
            progress.update(search_task,
                            description=f"[bold cyan]Search[/bold cyan]  {hits}/{len(tracks)} tracks"
                                        f"  [dim]{total_files} files[/dim]",
                            total=1, completed=1)

        for t in tracks:
            res = results_by_track[t["id"]]
            n_files = sum(len(sr.shared_items) for sr in res)
            log.debug("[%d] %d peers / %d files — %s", t["id"], len(res), n_files, t.get("title"))

        # ── Phase 1b: fallback search ──────────────────────────────────────────
        # Trigger for tracks with zero results OR results that all failed scoring.
        # Tracks that still need a better query are tracked by next variant index.
        def _needs_better_results(t: dict) -> bool:
            res = results_by_track[t["id"]]
            return not res or not _rank_candidates(t, res, cfg, queries_by_track[t["id"]][0])

        # Try each remaining query variant in turn until all tracks are satisfied
        # or variants are exhausted.  Each round fires one window of searches.
        fallback_attempt: dict[int, int] = {t["id"]: 1 for t in tracks}  # next variant index

        for _round in range(3):  # at most 3 fallback rounds
            still_needing = [t for t in tracks if _needs_better_results(t) and fallback_attempt[t["id"]] < len(queries_by_track[t["id"]])]
            if not still_needing:
                break

            fallback_queries: dict[int, str] = {}
            for t in still_needing:
                idx = fallback_attempt[t["id"]]
                variant = queries_by_track[t["id"]][idx]
                fallback_queries[t["id"]] = variant
                log.info("[%d] Fallback #%d query: «%s»", t["id"], idx, variant)
                fallback_attempt[t["id"]] += 1

            fallback_task = None
            if progress:
                fallback_task = progress.add_task(
                    f"[bold cyan]Fallback search[/bold cyan]"
                    f"  [dim]round {_round+1}, {len(fallback_queries)} tracks[/dim]",
                    total=None,
                )
            else:
                log.info("── Phase 1b (round %d): fallback search for %d tracks (%.0fs window) ──",
                         _round + 1, len(fallback_queries), cfg.soulseek.search_timeout_sec)

            fallback_results = await _search_all(client, fallback_queries, cfg.soulseek.search_timeout_sec)
            improved = 0
            for tid, res in fallback_results.items():
                if res:
                    results_by_track[tid] = results_by_track[tid] + res
                    improved += 1

            log.info("Fallback round %d done: %d tracks gained new results", _round + 1, improved)
            if progress and fallback_task is not None:
                progress.update(fallback_task,
                                description=f"[bold cyan]Fallback {_round+1}[/bold cyan]"
                                            f"  [dim]{improved} tracks improved[/dim]",
                                total=1, completed=1)

        # ── Phase 2: download ──────────────────────────────────────────────────
        ready = sum(1 for t in tracks if results_by_track[t["id"]])
        log.info("── Phase 2: downloading %d/%d tracks concurrently ──", ready, len(tracks))
        for track in tracks:
            _set_status(cfg.db_path, track["id"], "downloading")

        await asyncio.gather(*[
            _do_download(client, track, results_by_track[track["id"]], queries_by_track[track["id"]][0])
            for track in tracks
        ])

    return stats


def run(cfg: Config, progress=None) -> dict:
    """
    Search and download all candidate tracks via embedded aioslsk Soulseek client.
    Returns {attempted, downloaded, failed, no_match}.
    Pass a rich.progress.Progress instance for live progress bars.
    """
    return asyncio.run(_run_async(cfg, progress=progress))


def reconcile_disk(cfg: Config) -> dict:
    """
    Scan downloads_dir and library_dir and promote any 'candidate' or 'downloading'
    tracks whose files are already on disk to 'available'.
    Returns {updated, skipped}.
    """
    from thefuzz import fuzz as _fuzz

    stats = {"updated": 0, "skipped": 0}

    with connect(cfg.db_path) as conn:
        rows = conn.execute(
            "SELECT id, download_job_id, artist, title FROM tracks"
            " WHERE acquisition_status IN ('candidate', 'downloading')"
        ).fetchall()

    if not rows:
        log.info("reconcile_disk: no candidate/downloading tracks")
        return stats

    audio_files: list[Path] = []
    for search_dir in (cfg.downloads_dir, cfg.library_dir):
        if search_dir.exists():
            audio_files.extend(
                p for p in search_dir.rglob("*")
                if p.suffix.lower() in AUDIO_EXTS and p.is_file()
            )

    if not audio_files:
        log.warning("reconcile_disk: no audio files found in downloads_dir or library_dir")
        stats["skipped"] = len(rows)
        return stats

    log.info("reconcile_disk: %d audio files, %d tracks to check", len(audio_files), len(rows))

    for row in rows:
        track_id = row["id"]
        job = row["download_job_id"] or ""
        matched_path: str | None = None

        if job:
            expected_bn = job.replace("\\", "/").split("/")[-1].lower()
            for p in audio_files:
                if p.name.lower() == expected_bn:
                    matched_path = str(p)
                    break
        else:
            target = f"{row['artist'] or ''} {row['title'] or ''}".lower()
            best_score, best_path = 0.0, None
            for p in audio_files:
                score = _fuzz.partial_ratio(target, p.stem.lower()) / 100
                if score > best_score:
                    best_score, best_path = score, p
            if best_score >= 0.75:
                matched_path = str(best_path)

        if matched_path:
            _set_status(cfg.db_path, track_id, "available", matched_path)
            log.info("[%d] Reconciled to available: %s", track_id, matched_path)
            stats["updated"] += 1
        else:
            log.debug("[%d] No disk match found", track_id)
            stats["skipped"] += 1

    log.info("reconcile_disk complete: %s", stats)
    return stats
