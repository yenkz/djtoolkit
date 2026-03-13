"""Flow 3 — identify tracks in a YouTube DJ mix via TrackID.dev API."""

import re
import sqlite3
import time
import urllib.error
import urllib.parse
import urllib.request
import json
from datetime import datetime, timezone

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
    host = parsed.netloc.lower().lstrip("www.")

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
