"""Flow 3 — identify tracks in a YouTube DJ mix via TrackID.dev API."""

import json
import re
import sqlite3
import time
import urllib.error
import urllib.parse
import urllib.request
from djtoolkit.config import Config
from djtoolkit.db.database import connect
from djtoolkit.utils.search_string import build as build_search_string


# ─── Exceptions ───────────────────────────────────────────────────────────────

class PollTimeoutError(Exception):
    """Raised by poll_job() when poll_timeout_sec is exceeded."""


# ─── URL Validation ───────────────────────────────────────────────────────────

_YOUTUBE_ID_RE = re.compile(r'^[A-Za-z0-9_-]{11}$')


def _extract_video_id(url: str) -> str | None:
    """Return the 11-char YouTube video ID from a URL, or None if not found."""
    parsed = urllib.parse.urlparse(url)
    host = parsed.netloc.lower()
    if host.startswith("www."):
        host = host.removeprefix("www.")

    if host == "youtu.be":
        vid = parsed.path.lstrip("/").split("/")[0]
        if _YOUTUBE_ID_RE.match(vid):
            return vid

    if host in ("youtube.com", "m.youtube.com"):
        if parsed.path.startswith("/embed/"):
            vid = parsed.path[len("/embed/"):].split("/")[0]
            if _YOUTUBE_ID_RE.match(vid):
                return vid
        qs = urllib.parse.parse_qs(parsed.query)
        vid = qs.get("v", [None])[0]
        if vid and _YOUTUBE_ID_RE.match(vid):
            return vid

    return None


def validate_url(url: str) -> str:
    """Normalize and validate a YouTube URL.

    Accepts youtube.com/watch?v=ID, youtu.be/ID, youtube.com/embed/ID.
    Strips tracking params. Returns canonical https://www.youtube.com/watch?v=ID.
    Raises ValueError if no valid YouTube video ID is found.
    """
    if not url:
        raise ValueError("URL must not be empty — expected a YouTube URL")
    vid = _extract_video_id(url)
    if not vid:
        raise ValueError(f"Not a valid YouTube URL (expected youtube.com/watch?v=ID, youtu.be/ID, or youtube.com/embed/ID): {url!r}")
    return f"https://www.youtube.com/watch?v={vid}"


# ─── HTTP helpers ─────────────────────────────────────────────────────────────

_USER_AGENT = "djtoolkit/1.0"
_MAX_RETRIES = 3
_BACKOFF_START = 15  # seconds


def _http_get(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": _USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def _http_post(url: str, body: dict) -> dict:
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        url,
        data=data,
        headers={"User-Agent": _USER_AGENT, "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def _with_backoff(fn, *args, **kwargs):
    """Call fn(*args, **kwargs), retrying up to _MAX_RETRIES on HTTP 429."""
    delay = _BACKOFF_START
    for attempt in range(_MAX_RETRIES + 1):
        try:
            return fn(*args, **kwargs)
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < _MAX_RETRIES:
                time.sleep(delay)
                delay *= 2
                continue
            if e.code == 429:
                raise RuntimeError(
                    f"Rate limited by TrackID.dev after {_MAX_RETRIES} retries"
                ) from e
            raise


# ─── API calls ────────────────────────────────────────────────────────────────

def submit_job(url: str, cfg: Config) -> str:
    """POST to /api/analyze and return the jobId string."""
    endpoint = f"{cfg.trackid.base_url}/api/analyze"
    result = _with_backoff(_http_post, endpoint, {"url": url})
    return result["jobId"]


def poll_job(job_id: str, cfg: Config) -> dict:
    """Poll /api/job/{jobId} until completed; return the job dict.

    Raises:
        PollTimeoutError: if poll_timeout_sec is exceeded (0 = unlimited).
        RuntimeError: if the API reports status 'failed'.
    """
    from rich.progress import Progress, SpinnerColumn, TextColumn, BarColumn

    interval = max(3, min(10, cfg.trackid.poll_interval_sec))
    timeout = cfg.trackid.poll_timeout_sec  # 0 = unlimited
    endpoint = f"{cfg.trackid.base_url}/api/job/{job_id}"
    start = time.monotonic()

    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TextColumn("{task.percentage:>3.0f}%"),
        transient=True,
    ) as progress:
        task = progress.add_task("Waiting for TrackID.dev…", total=100)

        while True:
            if timeout and (time.monotonic() - start) >= timeout:
                raise PollTimeoutError(
                    f"TrackID.dev job {job_id!r} timed out after {timeout}s"
                )

            try:
                data = _with_backoff(_http_get, endpoint)
            except urllib.error.URLError:
                # Network error — retry up to 3 times with 10s wait
                for _ in range(3):
                    time.sleep(10)
                    try:
                        data = _with_backoff(_http_get, endpoint)
                        break
                    except urllib.error.URLError:
                        pass
                else:
                    raise RuntimeError(
                        f"Network error polling TrackID.dev job {job_id!r}"
                    )

            status = data.get("status", "")
            step = data.get("currentStep", status)
            pct = data.get("progress", 0)

            progress.update(task, description=step, completed=pct)

            if status == "completed":
                return data
            if status == "failed":
                raise RuntimeError(
                    f"TrackID.dev job {job_id!r} failed on the server"
                )

            time.sleep(interval)


# ─── Main entry point ─────────────────────────────────────────────────────────

def import_trackid(url: str, cfg: Config, force: bool = False) -> dict:
    """Full Flow 3 orchestration.

    Validates URL, checks cache, submits to TrackID.dev, polls for results,
    filters by confidence, inserts candidates into DB, and records job in cache.

    Returns stats dict with keys:
        identified, imported, skipped_low_confidence, skipped_unknown,
        failed, skipped_cached.
    """
    stats = {
        "identified": 0,
        "imported": 0,
        "skipped_low_confidence": 0,
        "skipped_unknown": 0,
        "failed": 0,
        "skipped_cached": 0,
    }

    # 1. Validate + normalize URL
    normalized_url = validate_url(url)

    # 2. Check cache + submit job (short-lived connection)
    with connect(cfg.db_path) as conn:
        cached = conn.execute(
            "SELECT job_id, status FROM trackid_jobs WHERE youtube_url = ?",
            (normalized_url,),
        ).fetchone()

        if cached and not force:
            stats["skipped_cached"] = 1
            return stats

        try:
            job_id = submit_job(normalized_url, cfg)
        except RuntimeError:
            stats["failed"] = 1
            return stats

        if cached:
            conn.execute(
                "UPDATE trackid_jobs SET job_id=?, status='queued', "
                "tracks_found=NULL, tracks_imported=NULL WHERE youtube_url=?",
                (job_id, normalized_url),
            )
        else:
            conn.execute(
                "INSERT INTO trackid_jobs (youtube_url, job_id, status) VALUES (?, ?, 'queued')",
                (normalized_url, job_id),
            )
        conn.commit()

    # 3. Poll for results (outside DB connection — can block for minutes)
    try:
        job = poll_job(job_id, cfg)
    except PollTimeoutError:
        with connect(cfg.db_path) as conn:
            conn.execute(
                "UPDATE trackid_jobs SET status='failed' WHERE youtube_url=?",
                (normalized_url,),
            )
            conn.commit()
        stats["failed"] = 1
        return stats
    except RuntimeError:
        with connect(cfg.db_path) as conn:
            conn.execute(
                "UPDATE trackid_jobs SET status='failed' WHERE youtube_url=?",
                (normalized_url,),
            )
            conn.commit()
        stats["failed"] = 1
        return stats

    # 4. Filter and insert tracks (second short-lived connection)
    with connect(cfg.db_path) as conn:
        all_tracks = job.get("tracks", [])
        threshold = cfg.trackid.confidence_threshold

        for track in all_tracks:
            if track.get("isUnknown"):
                stats["skipped_unknown"] += 1
                continue
            if track.get("confidence", 0) < threshold:
                stats["skipped_low_confidence"] += 1
                continue

            stats["identified"] += 1

            artist = track.get("artist") or ""
            title = track.get("title") or ""
            duration_sec = track.get("duration")
            duration_ms = int(duration_sec * 1000) if duration_sec is not None else None

            record = {
                "acquisition_status": "candidate",
                "source": "trackid",
                "artist": artist or None,
                "artists": artist or None,
                "title": title or None,
                "duration_ms": duration_ms,
                "search_string": build_search_string(artist, title) if (artist or title) else None,
            }

            columns = ", ".join(record.keys())
            placeholders = ", ".join("?" for _ in record)
            try:
                conn.execute(
                    f"INSERT INTO tracks ({columns}) VALUES ({placeholders})",
                    list(record.values()),
                )
                stats["imported"] += 1
            except sqlite3.IntegrityError:
                pass

        conn.commit()

        # 5. Update cache
        conn.execute(
            "UPDATE trackid_jobs SET status='completed', tracks_found=?, tracks_imported=? "
            "WHERE youtube_url=?",
            (len(all_tracks), stats["imported"], normalized_url),
        )
        conn.commit()

    return stats
