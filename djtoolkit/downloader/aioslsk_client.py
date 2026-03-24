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

from typing import TYPE_CHECKING

from djtoolkit.config import Config

if TYPE_CHECKING:
    from djtoolkit.adapters.supabase import SupabaseAdapter

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
    rejected_duration = 0
    rejected_score = 0

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
                    rejected_duration += 1
                    continue

            rel = _relevance(track, file.filename, query)
            if rel < cfg.matching.min_score_title:
                rejected_score += 1
                continue

            candidates.append((_quality_score(file), rel, username, file.filename))

    candidates.sort(key=lambda x: (x[0], x[1]), reverse=True)
    total_files = sum(len(r.shared_items) for r in results)
    log.info(
        "[%d] %d/%d files passed filters (from %d peers) — rejected: %d duration, %d score<%s",
        track["id"], len(candidates), total_files, len(results),
        rejected_duration, rejected_score, f"{cfg.matching.min_score_title:.2f}",
    )

    # Log the best match details when we have candidates
    if candidates:
        best_quality, best_rel, best_user, best_fn = candidates[0]
        log.info(
            "[%d] Best match: score=%.2f peer=%s file=%s",
            track["id"], best_rel, best_user, best_fn.split("\\")[-1],
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
    Fire all searches via the SearchManager, wait once for timeout_sec,
    return results.  Returns {track_id: [SearchResult, ...]}.
    """
    requests: dict[int, object] = {}
    for track_id, query in query_by_track_id.items():
        requests[track_id] = await client.searches.search(query)

    log.info("Broadcast %d searches, waiting %.0fs for results...", len(requests), timeout_sec)
    await asyncio.sleep(timeout_sec)

    results = {tid: list(req.results) for tid, req in requests.items()}
    for tid, res in results.items():
        n_files = sum(len(r.shared_items) for r in res)
        log.info("[%d] Search returned %d peers, %d files", tid, len(res), n_files)
    return results


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
    Semaphore-bounded pipeline: each worker manages its own search+download
    cycle, but at most ``MAX_CONCURRENT`` workers run at a time.  This keeps
    the Soulseek server happy (no flood of simultaneous searches) while still
    overlapping search-for-track-N+1 with download-of-track-N.

    Uses the aioslsk SearchManager (``client.searches.search()``) which
    accumulates results internally on the ``SearchRequest.results`` list —
    no manual event routing required.

    Each track dict in tracks_by_job MUST have an ``"id"`` key that
    corresponds to a key in queries_by_id.
    """
    MAX_CONCURRENT = 3  # max workers active at once

    all_tracks = list(tracks_by_job.values())
    job_by_track_id: dict[int, str] = {t["id"]: job_id for job_id, t in tracks_by_job.items()}

    # Session-loss flag — when set, workers abort early instead of
    # each independently hitting InvalidSessionError.
    session_lost = asyncio.Event()

    # Semaphore gates how many workers can be active (searching or downloading)
    sem = asyncio.Semaphore(MAX_CONCURRENT)

    async def _worker(track: dict) -> None:
        """Per-track worker: acquire semaphore, search, download, release."""
        track_id = track["id"]
        job_id = job_by_track_id[track_id]
        query_variants = queries_by_id.get(track_id, [])
        primary_query = query_variants[0] if query_variants else ""
        timeout = cfg.soulseek.search_timeout_sec

        # Bail early if session already lost (before waiting for semaphore)
        if session_lost.is_set():
            await report_fn(job_id, False, None, "Soulseek session lost")
            return

        async with sem:
            try:
                # Re-check after acquiring semaphore
                if session_lost.is_set():
                    await report_fn(job_id, False, None, "Soulseek session lost")
                    return

                # Phase A: search with primary query
                log.info("[%d] Search: «%s»", track_id, primary_query)
                request = await client.searches.search(primary_query)
                results = await _collect_viable(
                    track, request, cfg, primary_query, timeout,
                )

                # Phase B: fallback queries if primary yielded nothing viable
                if not results:
                    for variant in query_variants[1:]:
                        if session_lost.is_set():
                            break
                        log.info("[%d] Fallback query: «%s»", track_id, variant)
                        request = await client.searches.search(variant)
                        results = await _collect_viable(
                            track, request, cfg, primary_query, timeout,
                        )
                        if results:
                            break

                # Phase C: download
                if session_lost.is_set():
                    await report_fn(job_id, False, None, "Soulseek session lost")
                    return

                if not results:
                    log.warning("[%d] No viable results after all queries", track_id)
                    await report_fn(job_id, False, None, "No viable search results")
                    return

                local_path = await _download_track(client, cfg, track, results, primary_query)

                if local_path:
                    log.info("[%d] ✓ downloaded via pipeline", track_id)
                    await report_fn(job_id, True, {"local_path": local_path}, None)
                else:
                    log.warning("[%d] No matching file (all peers exhausted)", track_id)
                    await report_fn(job_id, False, None, f"No matching file for: {track.get('artist')} - {track.get('title')}")

            except Exception as exc:
                if "not logged in" in str(exc).lower():
                    session_lost.set()
                    log.error("[%d] Session lost — flagging batch abort", track_id)
                    await report_fn(job_id, False, None, "Soulseek session lost")
                else:
                    log.exception("[%d] Pipeline worker error", track_id)
                    await report_fn(job_id, False, None, str(exc))

    if status_fn:
        status_fn("downloading")

    # All workers start immediately but only MAX_CONCURRENT proceed past
    # the semaphore at a time — the rest queue up transparently.
    await asyncio.gather(*[_worker(t) for t in all_tracks])


async def _collect_viable(
    track: dict,
    request,
    cfg: Config,
    query: str,
    timeout: float,
) -> list:
    """
    Wait up to *timeout* seconds for viable candidates from a SearchRequest.
    Polls ``request.results`` periodically and runs ``_rank_candidates`` to
    check viability.  Returns the full result list on success, empty on timeout.
    """
    POLL_INTERVAL = 2.0
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout

    while True:
        remaining = deadline - loop.time()
        if remaining <= 0:
            break
        if request.results and _rank_candidates(track, request.results, cfg, query):
            elapsed = timeout - remaining
            log.info(
                "[%d] Viable results found after %.1fs (%d peers so far)",
                track["id"], elapsed, len(request.results),
            )
            return list(request.results)
        await asyncio.sleep(min(remaining, POLL_INTERVAL))

    # Final check after timeout
    if request.results and _rank_candidates(track, request.results, cfg, query):
        log.info(
            "[%d] Viable results found at timeout (%d peers)",
            track["id"], len(request.results),
        )
        return list(request.results)
    total_files = sum(len(r.shared_items) for r in request.results) if request.results else 0
    log.info(
        "[%d] No viable results after %.0fs timeout (%d peers, %d files, all filtered)",
        track["id"], timeout, len(request.results) if request.results else 0, total_files,
    )
    return []


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
                size_mb = f"{transfer.filesize / 1_048_576:.1f} MB" if transfer.filesize else "unknown size"
                log.info("[%d] Download complete: %s (%s) from %s", track_id, fname, size_mb, username)
                return str(local_path)
            log.info("[%d] Transfer completed but no local_path returned", track_id)
        else:
            log.info("[%d] Download failed from peer %s (attempt %d/%d)", track_id, username, attempt + 1, _MAX_DOWNLOAD_RETRIES)

    log.info("[%d] All %d download attempts exhausted", track_id, min(len(ranked), _MAX_DOWNLOAD_RETRIES))
    return None


# ─── DB helper ────────────────────────────────────────────────────────────────

def _set_status(
    adapter: "SupabaseAdapter",
    track_id: int,
    status: str,
    local_path: str | None = None,
    search_results_count: int | None = None,
) -> None:
    updates: dict = {"acquisition_status": status}
    if local_path is not None:
        updates["local_path"] = local_path
    if search_results_count is not None:
        updates["search_results_count"] = search_results_count
    adapter.update_track(track_id, updates)


# ─── Main pipeline step ───────────────────────────────────────────────────────

async def _run_async(cfg: Config, adapter: "SupabaseAdapter", user_id: str, progress=None) -> dict:
    from aioslsk.client import SoulSeekClient

    if not cfg.soulseek.username or not cfg.soulseek.password:
        raise RuntimeError(
            "Soulseek credentials not configured. "
            "Set [soulseek] username and SOULSEEK_PASSWORD in .env."
        )

    stats = {"attempted": 0, "downloaded": 0, "failed": 0, "no_match": 0}

    candidate_tracks = adapter.query_by_acquisition_status(user_id, "candidate")

    if not candidate_tracks:
        log.info("No candidate tracks found")
        return stats

    log.info("Downloading %d candidates via aioslsk (Soulseek)", len(candidate_tracks))
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
                _set_status(adapter, track_id, "failed")
                stats["no_match"] += 1
                stats["failed"] += 1
                return
            _set_status(adapter, track_id, "queued")
            _set_status(adapter, track_id, "downloading")
            local_path = await _download_track(client, cfg, track, results, query,
                                               progress=progress, task_id=task_id)
            if local_path:
                _set_status(adapter, track_id, "available", local_path)
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
                _set_status(adapter, track_id, "failed")
                stats["no_match"] += 1
                stats["failed"] += 1
        except Exception:
            log.exception("[%d] Unexpected error: %s", track_id, label)
            if progress and task_id is not None:
                progress.update(task_id, description=f"[red]✗ error[/red]  {label}",
                                total=1, completed=1)
            _set_status(adapter, track_id, "failed")
            stats["failed"] += 1

    async with SoulSeekClient(settings) as client:
        await client.login()

        tracks = [{"id": t._id, **t.to_db_row()} for t in candidate_tracks]
        stats["attempted"] = len(tracks)

        # Build per-track query variants (original + simplified + artist-only fallbacks)
        queries_by_track: dict[int, list[str]] = {t["id"]: _build_search_queries(t) for t in tracks}

        # Set all tracks to 'searching' before broadcast
        for track in tracks:
            _set_status(adapter, track["id"], "searching")

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

        # ── Classify found / not_found ────────────────────────────────────────
        viable_counts: dict[int, int] = {}
        for track in tracks:
            tid = track["id"]
            res = results_by_track[tid]
            ranked = _rank_candidates(track, res, cfg, queries_by_track[tid][0]) if res else []
            viable_counts[tid] = len(ranked)
            if ranked:
                _set_status(adapter, tid, "found", search_results_count=len(ranked))
            else:
                _set_status(adapter, tid, "not_found", search_results_count=0)

        # ── Phase 2: download (only tracks that were found) ───────────────────
        found_tracks = [t for t in tracks if viable_counts.get(t["id"], 0) > 0]
        not_found_count = len(tracks) - len(found_tracks)
        stats["no_match"] += not_found_count
        ready = len(found_tracks)
        log.info("── Phase 2: downloading %d/%d tracks concurrently ──", ready, len(tracks))

        await asyncio.gather(*[
            _do_download(client, track, results_by_track[track["id"]], queries_by_track[track["id"]][0])
            for track in found_tracks
        ])

    return stats


def run(cfg: Config, adapter: "SupabaseAdapter", user_id: str, progress=None) -> dict:
    """
    Search and download all candidate tracks via embedded aioslsk Soulseek client.
    Returns {attempted, downloaded, failed, no_match}.
    Pass a rich.progress.Progress instance for live progress bars.
    """
    return asyncio.run(_run_async(cfg, adapter, user_id, progress=progress))


def reconcile_disk(cfg: Config, adapter: "SupabaseAdapter", user_id: str) -> dict:
    """
    Scan downloads_dir and library_dir and promote any 'candidate' or 'downloading'
    tracks whose files are already on disk to 'available'.
    Returns {updated, skipped}.
    """
    from thefuzz import fuzz as _fuzz

    stats = {"updated": 0, "skipped": 0}

    candidates = adapter.query_by_acquisition_status(user_id, "candidate")
    downloading = adapter.query_by_acquisition_status(user_id, "downloading")
    all_tracks = candidates + downloading
    rows = [{"id": t._id, "download_job_id": None, "artist": t.artist, "title": t.title} for t in all_tracks]

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
            _set_status(adapter, track_id, "available", matched_path)
            log.info("[%d] Reconciled to available: %s", track_id, matched_path)
            stats["updated"] += 1
        else:
            log.debug("[%d] No disk match found", track_id)
            stats["skipped"] += 1

    log.info("reconcile_disk complete: %s", stats)
    return stats
