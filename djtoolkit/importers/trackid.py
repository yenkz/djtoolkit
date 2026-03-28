"""Flow 3 — identify tracks in a YouTube DJ mix via TrackID.dev API."""

from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import TYPE_CHECKING

from djtoolkit.config import Config
from djtoolkit.utils.search_string import build as build_search_string

if TYPE_CHECKING:
    from djtoolkit.adapters.supabase import SupabaseAdapter


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

def import_trackid(
    url: str, cfg: Config,
    adapter: "SupabaseAdapter | None" = None,
    user_id: str | None = None,
    force: bool = False,
) -> dict:
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
        "skipped_duplicate": 0,
        "failed": 0,
        "skipped_cached": 0,
    }

    if adapter is None or user_id is None:
        raise RuntimeError("adapter and user_id are required")

    client = adapter._client

    # 1. Validate + normalize URL
    normalized_url = validate_url(url)

    # 2. Check cache
    cached = (
        client.table("trackid_jobs")
        .select("job_id, status")
        .eq("user_id", user_id)
        .eq("youtube_url", normalized_url)
        .maybeSingle()
        .execute()
    ).data

    if cached and not force:
        stats["skipped_cached"] = 1
        return stats

    # 3. Submit job
    try:
        job_id = submit_job(normalized_url, cfg)
    except RuntimeError:
        stats["failed"] = 1
        return stats

    # 4. Update or insert cache entry
    if cached:
        (client.table("trackid_jobs")
         .update({"job_id": job_id, "status": "queued", "tracks_found": None, "tracks_imported": None})
         .eq("user_id", user_id)
         .eq("youtube_url", normalized_url)
         .execute())
    else:
        (client.table("trackid_jobs")
         .insert({"user_id": user_id, "youtube_url": normalized_url, "job_id": job_id, "status": "queued"})
         .execute())

    # 5. Poll for results (can block for minutes)
    try:
        job = poll_job(job_id, cfg)
    except (PollTimeoutError, RuntimeError):
        (client.table("trackid_jobs")
         .update({"status": "failed"})
         .eq("user_id", user_id)
         .eq("youtube_url", normalized_url)
         .execute())
        stats["failed"] = 1
        return stats

    # 5b. Verify TrackID.dev analyzed the correct video
    returned_url = job.get("youtubeUrl", "")
    if returned_url:
        returned_id = _extract_video_id(returned_url)
        submitted_id = _extract_video_id(normalized_url)
        if returned_id and submitted_id and returned_id != submitted_id:
            (client.table("trackid_jobs")
             .update({"status": "failed"})
             .eq("user_id", user_id)
             .eq("youtube_url", normalized_url)
             .execute())
            raise RuntimeError(
                f"TrackID.dev analyzed a different video ({returned_id}) "
                f"than submitted ({submitted_id}). Please retry."
            )

    # 6. Filter, deduplicate, and insert tracks
    all_tracks = job.get("tracks", [])
    all_tracks.sort(key=lambda t: t.get("confidence", 0), reverse=True)
    threshold = cfg.trackid.confidence_threshold
    rows: list[dict] = []
    seen_keys: set[str] = set()

    for track in all_tracks:
        if track.get("isUnknown") or track.get("unknown"):
            stats["skipped_unknown"] += 1
            continue
        if track.get("confidence", 0) < threshold:
            stats["skipped_low_confidence"] += 1
            continue

        artist = track.get("artist") or ""
        title = track.get("title") or ""
        key = f"{title.lower().strip()}|{artist.lower().strip()}"

        if key in seen_keys:
            stats["skipped_duplicate"] += 1
            continue
        seen_keys.add(key)

        stats["identified"] += 1

        duration_sec = track.get("duration")
        duration_ms = int(duration_sec * 1000) if duration_sec is not None else None

        rows.append({
            "user_id": user_id,
            "acquisition_status": "candidate",
            "source": "trackid",
            "artist": artist or None,
            "artists": artist or None,
            "title": title or None,
            "duration_ms": duration_ms,
            "search_string": build_search_string(artist, title) if (artist or title) else None,
        })

    for row in rows:
        try:
            result = client.table("tracks").insert(row).execute()
            if result.data:
                stats["imported"] += 1
        except Exception:
            stats["skipped_duplicate"] += 1

    # 7. Update cache
    (client.table("trackid_jobs")
     .update({
         "status": "completed",
         "tracks_found": len(all_tracks),
         "tracks_imported": stats["imported"],
     })
     .eq("user_id", user_id)
     .eq("youtube_url", normalized_url)
     .execute())

    return stats
