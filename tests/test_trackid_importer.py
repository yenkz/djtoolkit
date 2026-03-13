"""Tests for TrackID.dev importer."""

import json
import urllib.error
import pytest
from unittest.mock import patch, MagicMock
from djtoolkit.importers.trackid import validate_url, submit_job, poll_job, PollTimeoutError
from djtoolkit.config import Config


# ─── validate_url ─────────────────────────────────────────────────────────────

@pytest.mark.parametrize("url,expected", [
    # Standard watch URL
    ("https://www.youtube.com/watch?v=dQw4w9WgXcQ",
     "https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    # Without www
    ("https://youtube.com/watch?v=dQw4w9WgXcQ",
     "https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    # Short URL
    ("https://youtu.be/dQw4w9WgXcQ",
     "https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    # Embed URL
    ("https://www.youtube.com/embed/dQw4w9WgXcQ",
     "https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    # Strips tracking params
    ("https://youtu.be/dQw4w9WgXcQ?si=abc123",
     "https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    # Strips extra params, keeps video ID
    ("https://www.youtube.com/watch?v=dQw4w9WgXcQ&feature=share&t=42",
     "https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
])
def test_validate_url_normalizes(url, expected):
    assert validate_url(url) == expected


@pytest.mark.parametrize("bad_url", [
    "https://vimeo.com/123456",
    "https://soundcloud.com/artist/track",
    "not-a-url",
    "",
    "https://youtube.com/",           # no video ID
    "https://youtube.com/watch",      # no v= param
])
def test_validate_url_rejects_invalid(bad_url):
    with pytest.raises(ValueError):
        validate_url(bad_url)


def _cfg(**kwargs) -> Config:
    cfg = Config()
    for k, v in kwargs.items():
        setattr(cfg.trackid, k, v)
    return cfg


def _mock_response(body: dict, status: int = 200):
    """Build a mock urllib response."""
    mock = MagicMock()
    mock.status = status
    mock.read.return_value = json.dumps(body).encode()
    mock.__enter__ = lambda s: s
    mock.__exit__ = MagicMock(return_value=False)
    return mock


# ─── submit_job ───────────────────────────────────────────────────────────────

def test_submit_job_returns_job_id():
    cfg = _cfg()
    mock_resp = _mock_response({"jobId": "job_123", "status": "queued"})
    with patch("urllib.request.urlopen", return_value=mock_resp):
        job_id = submit_job("https://www.youtube.com/watch?v=abc", cfg)
    assert job_id == "job_123"


def test_submit_job_retries_on_429():
    cfg = _cfg()
    ok_resp = _mock_response({"jobId": "job_456", "status": "queued"})
    err_429 = urllib.error.HTTPError(
        url=None, code=429, msg="Too Many Requests", hdrs=None, fp=None
    )
    with patch("urllib.request.urlopen", side_effect=[err_429, ok_resp]), \
         patch("time.sleep"):
        job_id = submit_job("https://www.youtube.com/watch?v=abc", cfg)
    assert job_id == "job_456"


def test_submit_job_raises_after_max_retries():
    cfg = _cfg()
    err_429 = urllib.error.HTTPError(
        url=None, code=429, msg="Too Many Requests", hdrs=None, fp=None
    )
    with patch("urllib.request.urlopen", side_effect=[err_429, err_429, err_429, err_429]), \
         patch("time.sleep"):
        with pytest.raises(RuntimeError, match="Rate limited"):
            submit_job("https://www.youtube.com/watch?v=abc", cfg)


# ─── poll_job ─────────────────────────────────────────────────────────────────

def test_poll_job_returns_on_completed():
    cfg = _cfg(poll_interval_sec=1, poll_timeout_sec=60)  # 1 is clamped to 3 internally; sleep is mocked
    completed = {
        "id": "job_123",
        "status": "completed",
        "tracks": [
            {"id": "t1", "timestamp": 0, "duration": 180,
             "artist": "Bonobo", "title": "Kong",
             "confidence": 0.95, "acoustidId": "aid1",
             "youtubeUrl": "", "isUnknown": False}
        ]
    }
    mock_resp = _mock_response(completed)
    with patch("urllib.request.urlopen", return_value=mock_resp), \
         patch("time.sleep"):
        result = poll_job("job_123", cfg)
    assert result["status"] == "completed"
    assert len(result["tracks"]) == 1


def test_poll_job_raises_on_api_failed():
    cfg = _cfg(poll_interval_sec=1, poll_timeout_sec=60)  # 1 is clamped to 3 internally; sleep is mocked
    failed = {"id": "job_123", "status": "failed"}
    mock_resp = _mock_response(failed)
    with patch("urllib.request.urlopen", return_value=mock_resp), \
         patch("time.sleep"):
        with pytest.raises(RuntimeError, match="failed"):
            poll_job("job_123", cfg)


def test_poll_job_raises_on_timeout():
    cfg = _cfg(poll_interval_sec=3, poll_timeout_sec=1)
    in_progress = {"id": "job_123", "status": "fingerprinting", "progress": 50}
    mock_resp = _mock_response(in_progress)
    with patch("urllib.request.urlopen", return_value=mock_resp), \
         patch("time.sleep"), \
         patch("time.monotonic", side_effect=[0.0, 0.0, 2.0]):  # start, check, elapsed > timeout
        with pytest.raises(PollTimeoutError):
            poll_job("job_123", cfg)
