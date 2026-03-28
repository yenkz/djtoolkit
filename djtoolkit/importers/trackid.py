"""Flow 3 — identify tracks in a YouTube/SoundCloud DJ mix.

Submits the URL to the Hetzner analysis service (api.djtoolkit.net),
which runs Shazam-based identification via spectral boundary detection.
Falls back to direct local analysis if the service is unreachable.
"""

from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import TYPE_CHECKING

from djtoolkit.config import Config
from djtoolkit.utils.search_string import build as build_search_string

if TYPE_CHECKING:
    from djtoolkit.adapters.supabase import SupabaseAdapter


# ─── Exceptions ───────────────────────────────────────────────────────────────

class PollTimeoutError(Exception):
    """Raised when poll_timeout_sec is exceeded."""


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


def _is_soundcloud_url(url: str) -> bool:
    """Check if URL is a valid SoundCloud link."""
    try:
        parsed = urllib.parse.urlparse(url)
        host = parsed.netloc.lower().removeprefix("www.")
        if host in ("soundcloud.com", "m.soundcloud.com"):
            path = parsed.path.strip("/")
            return "/" in path
    except Exception:
        pass
    return False


def _normalize_soundcloud_url(url: str) -> str:
    """Normalize a SoundCloud URL to canonical form."""
    parsed = urllib.parse.urlparse(url)
    path = parsed.path.strip("/")
    return f"https://soundcloud.com/{path}"


def validate_url(url: str) -> str:
    """Normalize and validate a YouTube or SoundCloud URL.

    Accepts:
      - youtube.com/watch?v=ID, youtu.be/ID, youtube.com/embed/ID
      - soundcloud.com/artist/set-name

    Raises ValueError for unsupported URLs.
    """
    if not url:
        raise ValueError("URL must not be empty — expected a YouTube or SoundCloud URL")

    # Try YouTube first
    vid = _extract_video_id(url)
    if vid:
        return f"https://www.youtube.com/watch?v={vid}"

    # Try SoundCloud
    if _is_soundcloud_url(url):
        return _normalize_soundcloud_url(url)

    raise ValueError(
        f"Not a valid YouTube or SoundCloud URL: {url!r}\n"
        "Expected: youtube.com/watch?v=ID, youtu.be/ID, or soundcloud.com/artist/set"
    )


# ─── HTTP helpers ─────────────────────────────────────────────────────────────

_USER_AGENT = "djtoolkit/1.0"


def _http_get(url: str, headers: dict | None = None) -> dict:
    hdrs = {"User-Agent": _USER_AGENT}
    if headers:
        hdrs.update(headers)
    req = urllib.request.Request(url, headers=hdrs)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def _http_post(url: str, body: dict, headers: dict | None = None) -> dict:
    data = json.dumps(body).encode()
    hdrs = {"User-Agent": _USER_AGENT, "Content-Type": "application/json"}
    if headers:
        hdrs.update(headers)
    req = urllib.request.Request(url, data=data, headers=hdrs, method="POST")
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read())


# ─── Hetzner service interaction ──────────────────────────────────────────────

def submit_analysis(url: str, cfg: Config, auth_token: str | None = None) -> str:
    """Submit a mix URL to the Hetzner analysis service.

    Returns the job_id for polling.
    """
    endpoint = f"{cfg.trackid.api_url}/trackid/analyze"
    job_id = str(uuid.uuid4())
    headers = {}
    if auth_token:
        headers["Authorization"] = f"Bearer {auth_token}"

    result = _http_post(endpoint, {
        "url": url,
        "job_id": job_id,
        "confidence_threshold": cfg.trackid.confidence_threshold,
    }, headers)
    return result.get("job_id", job_id)


def poll_analysis(job_id: str, cfg: Config, adapter: "SupabaseAdapter") -> dict:
    """Poll trackid_import_jobs in Supabase until completed.

    The Hetzner service updates the job directly in Supabase,
    so we just read the DB row.

    Returns the completed job dict with result containing tracks.
    """
    from rich.progress import Progress, SpinnerColumn, TextColumn, BarColumn

    interval = max(3, min(10, cfg.trackid.poll_interval_sec))
    timeout = cfg.trackid.poll_timeout_sec
    client = adapter._client
    start = time.monotonic()

    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TextColumn("{task.percentage:>3.0f}%"),
        transient=True,
    ) as progress:
        task = progress.add_task("Analyzing mix…", total=100)

        while True:
            if timeout and (time.monotonic() - start) >= timeout:
                raise PollTimeoutError(
                    f"Analysis job {job_id!r} timed out after {timeout}s"
                )

            data = (
                client.table("trackid_import_jobs")
                .select("status, progress, step, error, result")
                .eq("id", job_id)
                .maybeSingle()
                .execute()
            ).data

            if not data:
                raise RuntimeError(f"Job {job_id!r} not found in database")

            status = data.get("status", "")
            step = data.get("step", status)
            pct = data.get("progress", 0)

            progress.update(task, description=step, completed=pct)

            if status == "completed":
                result = data.get("result")
                if isinstance(result, str):
                    result = json.loads(result)
                return result or {}
            if status == "failed":
                error = data.get("error", "Unknown error")
                raise RuntimeError(f"Analysis failed: {error}")

            time.sleep(interval)


# ─── Main entry point ─────────────────────────────────────────────────────────

def import_trackid(
    url: str, cfg: Config,
    adapter: "SupabaseAdapter | None" = None,
    user_id: str | None = None,
    force: bool = False,
) -> dict:
    """Full Flow 3 orchestration.

    Validates URL (YouTube or SoundCloud), submits to the Hetzner analysis
    service, polls for results, filters by confidence, inserts candidates
    into DB.

    Returns stats dict with keys:
        identified, imported, skipped_low_confidence, skipped_duplicate,
        failed, skipped_cached.
    """
    stats = {
        "identified": 0,
        "imported": 0,
        "skipped_low_confidence": 0,
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

    # 3. Submit to Hetzner analysis service
    try:
        job_id = submit_analysis(normalized_url, cfg)
    except Exception:
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
        result = poll_analysis(job_id, cfg, adapter)
    except (PollTimeoutError, RuntimeError):
        (client.table("trackid_jobs")
         .update({"status": "failed"})
         .eq("user_id", user_id)
         .eq("youtube_url", normalized_url)
         .execute())
        stats["failed"] = 1
        return stats

    # 6. Extract tracks from result and insert into DB
    all_tracks = result.get("tracks", [])
    threshold = cfg.trackid.confidence_threshold
    seen_keys: set[str] = set()

    for track in all_tracks:
        confidence = track.get("confidence", 0)
        if confidence < threshold:
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

        duration_ms = track.get("duration_ms")

        row = {
            "user_id": user_id,
            "acquisition_status": "candidate",
            "source": "trackid",
            "artist": artist or None,
            "artists": artist or None,
            "title": title or None,
            "duration_ms": duration_ms,
            "search_string": build_search_string(artist, title) if (artist or title) else None,
        }

        try:
            result_row = client.table("tracks").insert(row).execute()
            if result_row.data:
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
