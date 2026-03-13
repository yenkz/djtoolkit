"""Flow 3 — identify tracks in a YouTube DJ mix via TrackID.dev API."""

import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from djtoolkit.config import Config


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
