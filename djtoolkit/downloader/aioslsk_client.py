"""aioslsk downloader — embedded Soulseek client (no Docker/slskd required).

Replaces slskd.py. Uses aioslsk (https://github.com/JurgenR/aioslsk) to
search the Soulseek network and download files directly from within the
djtoolkit process. Credentials go in [soulseek] config section.

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
    from aioslsk.settings import Settings, CredentialsSettings, SharesSettings
    return Settings(
        credentials=CredentialsSettings(
            username=cfg.soulseek.username,
            password=cfg.soulseek.password,
        ),
        shares=SharesSettings(
            download=str(cfg.downloads_dir),
        ),
    )


# ─── Path helpers (same logic as slskd.py) ────────────────────────────────────

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
    """
    stem = _basename(filename).lower()

    # Word-overlap pre-filter: if a query is provided, require ≥50% word match
    if query and _relevance_score(stem, query) == 0:
        return 0.0

    title = (track.get("title") or "").lower()
    artist = (track.get("artist") or "").lower()
    t = fuzz.partial_ratio(title, stem) / 100
    a = fuzz.partial_ratio(artist, stem) / 100
    return t * 0.6 + a * 0.4


def _pick_best(track: dict, results: list, cfg: Config, query: str = "") -> tuple[str | None, str | None]:
    """
    Pick best file from a list of SearchResult objects.
    Returns (username, remote_filename) or (None, None).

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

    if not candidates:
        return None, None

    candidates.sort(key=lambda x: (x[0], x[1]), reverse=True)
    _, _, best_user, best_filename = candidates[0]
    return best_user, best_filename


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


def _build_search_queries(track: dict) -> list[str]:
    """Return progressive fallback queries: original → simplified → artist-only."""
    base = track.get("search_string") or f"{track.get('artist', '')} {track.get('title', '')}"
    queries = [base]
    artist = (track.get("artist") or "").split(";")[0].strip()
    title = track.get("title") or ""
    if title:
        simplified = f"{artist} {_simplify_for_search(title)}".strip()
        if simplified.lower() != base.lower():
            queries.append(simplified)
        if len(artist.split()) >= 2:
            queries.append(artist)
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


# ─── Download ─────────────────────────────────────────────────────────────────

async def _wait_for_transfer(client, transfer, timeout_sec: float) -> bool:
    """
    Wait for a Transfer to reach a terminal state.
    Returns True on COMPLETE, False on failure/timeout.
    Uses TransferProgressEvent which carries (Transfer, TransferProgressSnapshot) tuples.
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

    client.events.register(TransferProgressEvent, on_progress)
    try:
        await asyncio.wait_for(done.wait(), timeout=timeout_sec)
    except asyncio.TimeoutError:
        log.warning("Transfer timed out after %.0fs: %s", timeout_sec, transfer.remote_path)
    finally:
        client.events.unregister(TransferProgressEvent, on_progress)

    return success


async def _download_track(client, cfg: Config, track: dict, results: list, query: str = "") -> str | None:
    """
    Download a single track given pre-fetched search results.
    Returns local_path on success, None on no match or failure.
    """
    username, remote_filename = _pick_best(track, results, cfg, query)
    if not username or not remote_filename:
        return None

    log.info("[%d] Downloading from %s: %s", track["id"], username, remote_filename.split("\\")[-1])
    transfer = await client.transfers.download(username, remote_filename)

    success = await _wait_for_transfer(client, transfer, cfg.soulseek.download_timeout_sec)
    if not success:
        return None

    local_path = getattr(transfer, "local_path", None)
    return str(local_path) if local_path else None


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

async def _run_async(cfg: Config) -> dict:
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
    for _noisy in ("aioslsk.network.network", "aioslsk.network.connection",
                   "aioslsk.network.peer", "aioslsk.transfer"):
        logging.getLogger(_noisy).setLevel(logging.CRITICAL)

    # Suppress asyncio "unhandled exception on loop" noise from aioslsk P2P connection failures
    loop = asyncio.get_running_loop()
    _orig_handler = loop.get_exception_handler()

    def _quiet_exception_handler(loop, context):
        exc = context.get("exception")
        if exc and type(exc).__module__.startswith("aioslsk"):
            return
        if _orig_handler:
            _orig_handler(loop, context)
        else:
            loop.default_exception_handler(context)

    loop.set_exception_handler(_quiet_exception_handler)

    async def _do_download(client, track: dict, results: list, query: str = "") -> None:
        track_id = track["id"]
        label = f"{track.get('artist')} – {track.get('title')}"
        try:
            local_path = await _download_track(client, cfg, track, results, query)
            if local_path:
                _set_status(cfg.db_path, track_id, "available", local_path)
                log.info("[%d] OK: %s", track_id, local_path)
                stats["downloaded"] += 1
            else:
                log.warning("[%d] No match: %s", track_id, label)
                _set_status(cfg.db_path, track_id, "failed")
                stats["no_match"] += 1
                stats["failed"] += 1
        except Exception:
            log.exception("[%d] Unexpected error: %s", track_id, label)
            _set_status(cfg.db_path, track_id, "failed")
            stats["failed"] += 1

    async with SoulSeekClient(settings) as client:
        await client.login()

        tracks = [dict(row) for row in candidates]
        stats["attempted"] = len(tracks)

        # Build per-track query variants (original + simplified + artist-only fallbacks)
        queries_by_track: dict[int, list[str]] = {t["id"]: _build_search_queries(t) for t in tracks}

        # Phase 1: fire all primary queries simultaneously, wait once
        log.info("Searching for %d tracks (%.0fs window)…", len(tracks), cfg.soulseek.search_timeout_sec)
        primary_queries = {t["id"]: queries_by_track[t["id"]][0] for t in tracks}
        results_by_track = await _search_all(client, primary_queries, cfg.soulseek.search_timeout_sec)

        # Phase 1b: fallback searches for tracks that got zero results
        no_results = [t for t in tracks if not results_by_track[t["id"]]]
        if no_results:
            fallback_queries: dict[int, str] = {}
            for t in no_results:
                variants = queries_by_track[t["id"]]
                if len(variants) > 1:
                    fallback_queries[t["id"]] = variants[1]
                    log.info("[%d] No results for primary query, trying: %s", t["id"], variants[1])
            if fallback_queries:
                fallback_results = await _search_all(client, fallback_queries, cfg.soulseek.search_timeout_sec)
                for track_id, res in fallback_results.items():
                    if res:
                        results_by_track[track_id] = res

        # Phase 2: mark all as downloading, then download all concurrently
        for track in tracks:
            _set_status(cfg.db_path, track["id"], "downloading")

        await asyncio.gather(*[
            _do_download(client, track, results_by_track[track["id"]], queries_by_track[track["id"]][0])
            for track in tracks
        ])

    return stats


def run(cfg: Config) -> dict:
    """
    Search and download all candidate tracks via embedded aioslsk Soulseek client.
    Returns {attempted, downloaded, failed, no_match}.
    """
    return asyncio.run(_run_async(cfg))


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
            "SELECT id, slskd_job_id, artist, title FROM tracks"
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
        job = row["slskd_job_id"] or ""
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
