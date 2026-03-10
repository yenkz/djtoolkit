"""slskd downloader — uses slskd_api package, follows intelliDj reference pattern."""

import logging
import time
import uuid
from pathlib import Path

import requests
from thefuzz import fuzz

from djtoolkit.config import Config
from djtoolkit.db.database import connect

log = logging.getLogger(__name__)

AUDIO_EXTS = {".mp3", ".flac", ".aiff", ".aif", ".wav", ".ogg", ".m4a"}


# ─── Client factory ───────────────────────────────────────────────────────────

def _make_client(cfg: Config):
    """
    slskd_api already prefixes /api/v0 internally.
    Strip url_base if it equals /api/v0 to avoid double-prefix.
    """
    import slskd_api  # lazy — only needed for actual downloads
    url_base = cfg.slskd.url_base.strip()
    if url_base == "/api/v0":
        url_base = ""
    return slskd_api.SlskdClient(cfg.slskd.host, cfg.slskd.api_key, url_base)


# ─── Health check ─────────────────────────────────────────────────────────────

def health_check(cfg: Config) -> tuple[bool, str]:
    """
    Check API reachability AND Soulseek network connection state.
    slskd must be logged into the Soulseek network for searches to return results.
    """
    base = cfg.slskd.host.rstrip("/")
    headers = {"X-API-KEY": cfg.slskd.api_key} if cfg.slskd.api_key else {}
    try:
        r = requests.get(f"{base}/api/v0/application", headers=headers, timeout=10)
        if r.status_code == 401:
            return False, "401 Unauthorized — check api_key in config"
        if r.status_code != 200:
            return False, f"HTTP {r.status_code}"
        data = r.json()
        server = data.get("server", {})
        state = server.get("state", "unknown")
        username = server.get("username", "")
        if "Connected" not in state:
            return False, (
                f"slskd is running but NOT connected to Soulseek "
                f"(state: {state}) — open {cfg.slskd.host} and log in"
            )
        return True, f"Connected to Soulseek as '{username}'"
    except requests.ConnectionError:
        return False, f"Cannot connect to slskd at {cfg.slskd.host} — is it running?"
    except Exception as e:
        return False, f"Unexpected error: {e}"


# ─── Search + response collection ─────────────────────────────────────────────

def _fetch_responses_direct(cfg: Config, search_id: str) -> list[dict]:
    """Call /searches/{id}/responses — the most reliable responses endpoint."""
    base = cfg.slskd.host.rstrip("/")
    headers = {"X-API-KEY": cfg.slskd.api_key} if cfg.slskd.api_key else {}
    try:
        r = requests.get(f"{base}/api/v0/searches/{search_id}/responses", headers=headers, timeout=10)
        if r.status_code == 404:
            return []
        r.raise_for_status()
        data = r.json()
        return data if isinstance(data, list) else []
    except Exception:
        return []


def _normalize(raw) -> list[dict]:
    if isinstance(raw, list):
        return raw
    if isinstance(raw, dict):
        if "responses" in raw and isinstance(raw["responses"], list):
            return raw["responses"]
    return []


def _search_and_collect(client, cfg: Config, query: str) -> list[dict]:
    """
    Submit search and collect responses using the multi-fallback strategy
    from the intelliDj reference implementation.

    Key insight: responses live at /searches/{id}/responses (separate endpoint),
    not always inline in the state object.
    """
    search_id = str(uuid.uuid4())
    search_resp = client.searches.search_text(
        searchText=query,
        id=search_id,
        fileLimit=cfg.slskd.file_limit,
        responseLimit=cfg.slskd.response_limit,
        searchTimeout=cfg.slskd.search_timeout_ms,
    )
    # slskd may return its own id
    if isinstance(search_resp, dict):
        search_id = search_resp.get("id") or search_id

    time.sleep(3)  # brief pause for initial results to populate

    responses: list[dict] = []
    deadline = time.time() + cfg.slskd.search_timeout_ms / 1000.0
    stop_issued = False

    while time.time() < deadline:
        # 1. Try dedicated /responses endpoint (most reliable)
        responses = _fetch_responses_direct(cfg, search_id)
        if responses:
            break

        # 2. Try state with inline responses
        try:
            state = client.searches.state(search_id, includeResponses=True)
            if isinstance(state, dict):
                # Stop the search once we have response counts — finalises inline responses
                if (not stop_issued) and state.get("responseCount", 0) and not state.get("isComplete"):
                    try:
                        client.searches.stop(search_id)
                        stop_issued = True
                    except Exception:
                        pass

                responses = _normalize(state.get("responses"))
                if responses:
                    break

                # Counts exist but no inline responses — try search_responses method
                if state.get("responseCount", 0):
                    try:
                        responses = _normalize(client.searches.search_responses(search_id))
                    except Exception:
                        pass
                    if responses:
                        break

                if state.get("isComplete"):
                    break
        except Exception:
            pass

        time.sleep(2)

    # Final fallback
    if not responses:
        try:
            responses = _normalize(client.searches.search_responses(search_id))
        except Exception:
            pass

    # Clean up search in slskd UI
    if not stop_issued:
        try:
            client.searches.stop(search_id)
        except Exception:
            pass

    return responses


# ─── File selection ───────────────────────────────────────────────────────────

def _basename(path: str) -> str:
    """Extract filename stem from a Windows or POSIX path."""
    name = path.replace("\\", "/").split("/")[-1]
    return name.rsplit(".", 1)[0] if "." in name else name


def _ext(path: str) -> str:
    name = path.replace("\\", "/").split("/")[-1]
    return ("." + name.rsplit(".", 1)[-1]).lower() if "." in name else ""


def _quality_score(file_info: dict) -> tuple[int, int]:
    """Score file by format preference. Returns (quality, size) for sorting."""
    name = str(file_info.get("filename", "")).lower()
    ext_field = str(file_info.get("extension", "")).lower()
    size = int(file_info.get("size") or 0)
    score = 0
    if ext_field == "flac" or name.endswith(".flac"):
        score += 100
    if "flac" in name:
        score += 20
    if ext_field == "mp3" or name.endswith(".mp3"):
        score += 5
    if "320" in name:
        score += 10
    return score, size


def _relevance(track: dict, file_info: dict) -> float:
    """Fuzzy relevance 0–1 of file against track title + artist."""
    stem = _basename(file_info.get("filename", "")).lower()
    title = (track.get("title") or "").lower()
    artist = (track.get("artist") or "").lower()
    t = fuzz.partial_ratio(title, stem) / 100
    a = fuzz.partial_ratio(artist, stem) / 100
    return t * 0.6 + a * 0.4


def _iter_files(response: dict) -> list[dict]:
    for key in ("files", "fileInfos", "results", "file_results"):
        files = response.get(key)
        if isinstance(files, list):
            return files
    return []


def _pick_best(track: dict, responses: list[dict], cfg: Config) -> tuple[str | None, dict | None]:
    """
    Pick best file from search responses.
    Filter: relevance >= min_score_title AND duration within tolerance.
    Rank: quality (FLAC > MP3, bitrate) then relevance.
    """
    track_dur_ms = track.get("duration_ms") or 0
    candidates = []

    for resp in responses:
        username = resp.get("username")
        for f in _iter_files(resp):
            if _ext(f.get("filename", "")) not in AUDIO_EXTS:
                continue
            # Duration gate
            if track_dur_ms:
                file_dur_ms = (f.get("length") or 0) * 1000
                if file_dur_ms and abs(track_dur_ms - file_dur_ms) > cfg.matching.duration_tolerance_ms:
                    continue
            # Relevance gate
            rel = _relevance(track, f)
            if rel < cfg.matching.min_score_title:
                continue
            candidates.append((_quality_score(f), rel, username, f))

    if not candidates:
        return None, None

    candidates.sort(key=lambda x: (x[0], x[1]), reverse=True)
    _, _, best_user, best_file = candidates[0]
    return best_user, best_file


# ─── Main pipeline step ───────────────────────────────────────────────────────

def run(cfg: Config) -> dict:
    """
    Read download_candidate tracks, search slskd, enqueue best match.
    Marks tracks as 'downloading' after successful enqueue.
    Use poll_downloads() separately to update to 'downloaded'.

    Returns {attempted, queued, failed, no_match}.
    """
    ok, msg = health_check(cfg)
    if not ok:
        log.error("slskd health check failed: %s", msg)
        raise RuntimeError(f"slskd not reachable: {msg}")

    client = _make_client(cfg)
    stats = {"attempted": 0, "queued": 0, "failed": 0, "no_match": 0}

    with connect(cfg.db_path) as conn:
        candidates = conn.execute(
            "SELECT * FROM tracks WHERE acquisition_status = 'candidate'"
        ).fetchall()

    if not candidates:
        log.info("No candidate tracks found in DB")
        return stats

    log.info("Starting download pipeline — %d candidates", len(candidates))

    for track in candidates:
        track = dict(track)
        stats["attempted"] += 1
        track_id = track["id"]
        query = track.get("search_string") or f"{track.get('artist', '')} {track.get('title', '')}"
        label = f"{track.get('artist')} – {track.get('title')}"

        _set_acquisition_status(cfg.db_path, track_id, "downloading")
        log.info("[%d] Searching: %s", track_id, query)

        try:
            responses = _search_and_collect(client, cfg, query)
            log.info("[%d] %d responses received", track_id, len(responses))

            username, file_info = _pick_best(track, responses, cfg)

            if not username or not file_info:
                log.warning("[%d] No match for: %s", track_id, label)
                _set_acquisition_status(cfg.db_path, track_id, "failed")
                stats["no_match"] += 1
                stats["failed"] += 1
                continue

            filename = file_info.get("filename")
            size = file_info.get("size", 0)
            log.info("[%d] Enqueueing from %s: %s", track_id, username, filename)

            enqueued = client.transfers.enqueue(username, [{"filename": filename, "size": size}])
            if enqueued is not False:
                log.info("[%d] Queued successfully", track_id)
                # Store remote filename so poll_downloads() can match this transfer
                with connect(cfg.db_path) as conn:
                    conn.execute(
                        "UPDATE tracks SET slskd_job_id = ? WHERE id = ?",
                        (filename, track_id),
                    )
                    conn.commit()
                stats["queued"] += 1
            else:
                log.error("[%d] Enqueue returned failure for: %s", track_id, label)
                _set_acquisition_status(cfg.db_path, track_id, "failed")
                stats["failed"] += 1

        except Exception:
            log.exception("[%d] Unexpected error for: %s", track_id, label)
            _set_acquisition_status(cfg.db_path, track_id, "failed")
            stats["failed"] += 1

    log.info("Pipeline complete: %s", stats)
    return stats


# ─── DB helper ────────────────────────────────────────────────────────────────

def _set_acquisition_status(db_path: Path, track_id: int, status: str, local_path: str | None = None) -> None:
    with connect(db_path) as conn:
        if local_path is not None:
            conn.execute(
                "UPDATE tracks SET acquisition_status = ?, local_path = ? WHERE id = ?",
                (status, local_path, track_id),
            )
        else:
            conn.execute("UPDATE tracks SET acquisition_status = ? WHERE id = ?", (status, track_id))
        conn.commit()


# ─── Poll completed downloads ──────────────────────────────────────────────────

def poll_downloads(cfg: Config) -> dict:
    """
    Two-step reconciliation:
      1. Match via slskd transfers API (catches in-progress/failed transfers).
      2. Disk scan fallback for tracks without slskd_job_id or already-cleared transfers.
    Updates 'downloading' tracks → 'downloaded' (with local_path) or 'download_fail'.
    Returns {updated, failed, still_downloading}.
    """
    stats = {"updated": 0, "failed": 0, "still_downloading": 0}

    with connect(cfg.db_path) as conn:
        rows = conn.execute(
            "SELECT id, slskd_job_id, artist, title FROM tracks WHERE acquisition_status = 'downloading'"
        ).fetchall()

    if not rows:
        log.info("poll_downloads: no tracks in 'downloading' state")
        return stats

    pending = [dict(r) for r in rows]
    resolved: set[int] = set()

    # ── Step 1: slskd transfers API ──────────────────────────────────────────
    by_basename: dict[str, dict] = {}
    for t in pending:
        job = t.get("slskd_job_id") or ""
        if job:
            bn = job.replace("\\", "/").split("/")[-1].lower()
            by_basename[bn] = t

    if by_basename:
        base = cfg.slskd.host.rstrip("/")
        headers = {"X-API-KEY": cfg.slskd.api_key} if cfg.slskd.api_key else {}
        try:
            r = requests.get(f"{base}/api/v0/transfers/downloads", headers=headers, timeout=10)
            r.raise_for_status()
            for user_entry in (r.json() if isinstance(r.json(), list) else []):
                for directory in user_entry.get("directories", []):
                    for f in directory.get("files", []):
                        remote_filename = f.get("filename", "")
                        bn = remote_filename.replace("\\", "/").split("/")[-1].lower()
                        state = str(f.get("state", ""))
                        track = by_basename.get(bn)
                        if track is None:
                            continue
                        track_id = track["id"]
                        if "Completed" in state:
                            local_path = _find_on_disk(cfg.downloads_dir, bn)
                            _set_acquisition_status(cfg.db_path, track_id, "available", local_path=local_path)
                            log.info("[%d] Downloaded (API): %s", track_id, local_path or bn)
                            stats["updated"] += 1
                            resolved.add(track_id)
                        elif any(s in state for s in ("Errored", "Rejected", "TimedOut", "Cancelled")):
                            _set_acquisition_status(cfg.db_path, track_id, "failed")
                            log.warning("[%d] Transfer failed (state: %s)", track_id, state)
                            stats["failed"] += 1
                            resolved.add(track_id)
                        else:
                            stats["still_downloading"] += 1
                            resolved.add(track_id)
        except Exception as e:
            log.warning("poll_downloads: transfers API error: %s", e)

    # ── Step 2: disk scan for unresolved tracks ──────────────────────────────
    unresolved = [t for t in pending if t["id"] not in resolved]
    if not unresolved:
        log.info("poll_downloads complete: %s", stats)
        return stats

    downloads_dir = cfg.downloads_dir
    if not downloads_dir.exists():
        log.warning("poll_downloads: downloads_dir does not exist: %s", downloads_dir)
        stats["still_downloading"] += len(unresolved)
        log.info("poll_downloads complete: %s", stats)
        return stats

    audio_files = [p for p in downloads_dir.rglob("*") if p.suffix.lower() in AUDIO_EXTS and p.is_file()]
    log.info("poll_downloads: scanning %d files on disk for %d unresolved tracks", len(audio_files), len(unresolved))

    for track in unresolved:
        track_id = track["id"]
        job = track.get("slskd_job_id") or ""
        matched_path: str | None = None

        if job:
            # Exact filename match against stored remote path
            expected_bn = job.replace("\\", "/").split("/")[-1].lower()
            for p in audio_files:
                if p.name.lower() == expected_bn:
                    matched_path = str(p)
                    break
        else:
            # Fuzzy match: file stem vs "artist title"
            target = f"{track.get('artist', '')} {track.get('title', '')}".lower()
            best_score, best_path = 0.0, None
            for p in audio_files:
                score = fuzz.partial_ratio(target, p.stem.lower()) / 100
                if score > best_score:
                    best_score, best_path = score, p
            if best_score >= 0.75:
                matched_path = str(best_path)

        if matched_path:
            _set_acquisition_status(cfg.db_path, track_id, "available", local_path=matched_path)
            log.info("[%d] Downloaded (disk scan): %s", track_id, matched_path)
            stats["updated"] += 1
        else:
            log.debug("[%d] Not yet found on disk", track_id)
            stats["still_downloading"] += 1

    log.info("poll_downloads complete: %s", stats)
    return stats


def reconcile_disk(cfg: Config) -> dict:
    """
    Scan downloads_dir and library_dir and update any 'candidate' or 'downloading'
    tracks whose files are already on disk to 'available'.
    Returns {updated, skipped}.
    """
    stats = {"updated": 0, "skipped": 0}

    with connect(cfg.db_path) as conn:
        rows = conn.execute(
            "SELECT id, slskd_job_id, artist, title FROM tracks"
            " WHERE acquisition_status IN ('candidate', 'downloading')"
        ).fetchall()

    if not rows:
        log.info("reconcile_disk: no candidate/downloading tracks")
        return stats

    # Collect audio files from both downloads_dir and library_dir
    audio_files: list[Path] = []
    for search_dir in (cfg.downloads_dir, cfg.library_dir):
        if search_dir.exists():
            audio_files.extend(p for p in search_dir.rglob("*") if p.suffix.lower() in AUDIO_EXTS and p.is_file())

    if not audio_files:
        log.warning("reconcile_disk: no audio files found in downloads_dir or library_dir")
        stats["skipped"] = len(rows)
        return stats

    log.info("reconcile_disk: %d audio files on disk, %d tracks to check", len(audio_files), len(rows))

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
                score = fuzz.partial_ratio(target, p.stem.lower()) / 100
                if score > best_score:
                    best_score, best_path = score, p
            if best_score >= 0.75:
                matched_path = str(best_path)

        if matched_path:
            _set_acquisition_status(cfg.db_path, track_id, "available", local_path=matched_path)
            log.info("[%d] Reconciled to available: %s", track_id, matched_path)
            stats["updated"] += 1
        else:
            log.debug("[%d] No disk match found", track_id)
            stats["skipped"] += 1

    log.info("reconcile_disk complete: %s", stats)
    return stats


def _find_on_disk(downloads_dir: Path, basename: str) -> str | None:
    """Recursively search downloads_dir for an exact filename match."""
    try:
        for p in downloads_dir.rglob(basename):
            return str(p)
    except Exception:
        pass
    return None
