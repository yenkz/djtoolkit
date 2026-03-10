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
  TransferProgressEvent.updates → list[tuple[Transfer, TransferProgressSnapshot]]
  TransferProgressSnapshot.state → TransferState.State
  Transfer.local_path       → str | None  (set after download completes)
"""

import asyncio
import logging
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


def _relevance(track: dict, filename: str) -> float:
    """Fuzzy relevance 0–1 of a remote filename against track title + artist."""
    stem = _basename(filename).lower()
    title = (track.get("title") or "").lower()
    artist = (track.get("artist") or "").lower()
    t = fuzz.partial_ratio(title, stem) / 100
    a = fuzz.partial_ratio(artist, stem) / 100
    return t * 0.6 + a * 0.4


def _pick_best(track: dict, results: list, cfg: Config) -> tuple[str | None, str | None]:
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

            rel = _relevance(track, file.filename)
            if rel < cfg.matching.min_score_title:
                continue

            candidates.append((_quality_score(file), rel, username, file.filename))

    if not candidates:
        return None, None

    candidates.sort(key=lambda x: (x[0], x[1]), reverse=True)
    _, _, best_user, best_filename = candidates[0]
    return best_user, best_filename


# ─── Search ───────────────────────────────────────────────────────────────────

async def _search(client, query: str, timeout_sec: float) -> list:
    """
    Submit a global search and collect SearchResult objects for timeout_sec.
    Returns a flat list of SearchResult (one per responding peer).
    """
    from aioslsk.commands import GlobalSearchCommand
    from aioslsk.events import SearchResultEvent

    results: list = []

    async def on_result(event: SearchResultEvent):
        results.append(event.result)

    client.events.register(SearchResultEvent, on_result)
    try:
        await client.execute(GlobalSearchCommand(query))
        await asyncio.sleep(timeout_sec)
    finally:
        client.events.unregister(SearchResultEvent, on_result)

    return results


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
        for xfer, snapshot in event.updates:
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


async def _download_track(client, cfg: Config, track: dict) -> str | None:
    """
    Search and download a single track. Returns local_path on success, None on failure.
    Sets acquisition_status = 'downloading' before waiting, caller updates to 'available'/'failed'.
    """
    query = track.get("search_string") or f"{track.get('artist', '')} {track.get('title', '')}"

    results = await _search(client, query, cfg.soulseek.search_timeout_sec)
    log.info("[%d] %d peers responded for: %s", track["id"], len(results), query)

    username, remote_filename = _pick_best(track, results, cfg)
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

    async with SoulSeekClient(settings) as client:
        await client.login()

        for row in candidates:
            track = dict(row)
            track_id = track["id"]
            stats["attempted"] += 1
            label = f"{track.get('artist')} – {track.get('title')}"

            _set_status(cfg.db_path, track_id, "downloading")

            try:
                local_path = await _download_track(client, cfg, track)
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
