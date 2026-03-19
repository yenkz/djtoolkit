"""Tests for TrackID.dev importer."""

import json
import uuid
import urllib.error
import pytest
from unittest.mock import patch, MagicMock, call
from djtoolkit.importers.trackid import validate_url, submit_job, poll_job, PollTimeoutError
from djtoolkit.importers.trackid import import_trackid
from djtoolkit.config import Config
from typer.testing import CliRunner
from djtoolkit.__main__ import app


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
    cfg = _cfg(poll_interval_sec=1, poll_timeout_sec=60)
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
    cfg = _cfg(poll_interval_sec=1, poll_timeout_sec=60)
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
         patch("time.monotonic", side_effect=[0.0, 0.0, 2.0]):
        with pytest.raises(PollTimeoutError):
            poll_job("job_123", cfg)


# ─── import_trackid (adapter-based) ──────────────────────────────────────────

USER_ID = "test-user-uuid"


def _mock_adapter():
    """Build a mock adapter with chained Supabase client methods."""
    adapter = MagicMock()
    # Default: no cached job
    adapter._client.table.return_value.select.return_value.eq.return_value.eq.return_value.maybeSingle.return_value.execute.return_value.data = None
    # Track insert returns the rows
    adapter._inserted_tracks = []

    def capture_insert(rows):
        adapter._inserted_tracks = rows
        result = MagicMock()
        result.execute.return_value.data = rows
        return result

    # We need to handle multiple table() calls differently
    original_table = MagicMock()

    def table_router(name):
        mock_table = MagicMock()
        if name == "trackid_jobs":
            # Cache queries
            select_chain = MagicMock()
            select_chain.eq.return_value.eq.return_value.maybeSingle.return_value.execute.return_value.data = adapter._cached_job
            mock_table.select.return_value = select_chain
            mock_table.insert.return_value.execute.return_value = MagicMock()
            mock_table.update.return_value.eq.return_value.eq.return_value.execute.return_value = MagicMock()
        elif name == "tracks":
            mock_table.insert = capture_insert
        return mock_table

    adapter._client.table = table_router
    adapter._cached_job = None
    return adapter


def _job_completed(tracks: list) -> dict:
    return {"id": "job_abc", "status": "completed", "tracks": tracks}


def _make_track(artist="Bonobo", title="Kong", confidence=0.95,
                duration=180, is_unknown=False):
    uid = uuid.uuid4().hex[:8]
    return {
        "id": uid, "timestamp": 0, "duration": duration,
        "artist": artist, "title": title, "confidence": confidence,
        "acoustidId": uid, "youtubeUrl": "", "isUnknown": is_unknown,
    }


def test_import_trackid_inserts_tracks():
    cfg = _cfg()
    adapter = _mock_adapter()
    url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    completed = _job_completed([_make_track(), _make_track("Aphex Twin", "Windowlicker", 0.88)])

    with patch("djtoolkit.importers.trackid.submit_job", return_value="job_abc"), \
         patch("djtoolkit.importers.trackid.poll_job", return_value=completed):
        stats = import_trackid(url, cfg, adapter, USER_ID)

    assert stats["imported"] == 2
    assert stats["skipped_low_confidence"] == 0
    assert stats["skipped_unknown"] == 0
    assert len(adapter._inserted_tracks) == 2
    assert adapter._inserted_tracks[0]["source"] == "trackid"
    assert adapter._inserted_tracks[0]["acquisition_status"] == "candidate"
    assert adapter._inserted_tracks[0]["duration_ms"] == 180 * 1000


def test_import_trackid_filters_low_confidence():
    cfg = _cfg()
    cfg.trackid.confidence_threshold = 0.8
    adapter = _mock_adapter()
    url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    completed = _job_completed([
        _make_track(confidence=0.9),
        _make_track("Low", "Score", confidence=0.5),
    ])

    with patch("djtoolkit.importers.trackid.submit_job", return_value="job_abc"), \
         patch("djtoolkit.importers.trackid.poll_job", return_value=completed):
        stats = import_trackid(url, cfg, adapter, USER_ID)

    assert stats["imported"] == 1
    assert stats["skipped_low_confidence"] == 1


def test_import_trackid_filters_unknown():
    cfg = _cfg()
    adapter = _mock_adapter()
    url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    completed = _job_completed([
        _make_track(),
        _make_track(is_unknown=True),
    ])

    with patch("djtoolkit.importers.trackid.submit_job", return_value="job_abc"), \
         patch("djtoolkit.importers.trackid.poll_job", return_value=completed):
        stats = import_trackid(url, cfg, adapter, USER_ID)

    assert stats["imported"] == 1
    assert stats["skipped_unknown"] == 1


def test_import_trackid_cache_skips_duplicate_url():
    cfg = _cfg()
    adapter = _mock_adapter()
    adapter._cached_job = {"job_id": "old_job", "status": "completed"}
    url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"

    stats = import_trackid(url, cfg, adapter, USER_ID)
    assert stats.get("skipped_cached") == 1


def test_import_trackid_force_bypasses_cache():
    cfg = _cfg()
    url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    completed = _job_completed([_make_track()])

    # First call: no cache
    adapter1 = _mock_adapter()
    with patch("djtoolkit.importers.trackid.submit_job", return_value="job_abc") as mock_submit, \
         patch("djtoolkit.importers.trackid.poll_job", return_value=completed):
        import_trackid(url, cfg, adapter1, USER_ID)

    # Second call: cached but force=True
    adapter2 = _mock_adapter()
    adapter2._cached_job = {"job_id": "job_abc", "status": "completed"}
    with patch("djtoolkit.importers.trackid.submit_job", return_value="job_def") as mock_submit, \
         patch("djtoolkit.importers.trackid.poll_job", return_value=completed):
        stats = import_trackid(url, cfg, adapter2, USER_ID, force=True)

    assert stats["imported"] == 1
    mock_submit.assert_called_once()


def test_import_trackid_empty_tracks():
    cfg = _cfg()
    adapter = _mock_adapter()
    url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    completed = _job_completed([])

    with patch("djtoolkit.importers.trackid.submit_job", return_value="job_abc"), \
         patch("djtoolkit.importers.trackid.poll_job", return_value=completed):
        stats = import_trackid(url, cfg, adapter, USER_ID)

    assert stats["identified"] == 0
    assert stats["imported"] == 0


# ─── CLI smoke tests ──────────────────────────────────────────────────────────

def test_cli_import_trackid_invalid_url():
    """CLI exits non-zero and prints error on invalid URL."""
    result = CliRunner().invoke(app, ["import", "trackid", "--url", "https://vimeo.com/123"])
    assert result.exit_code != 0
    assert "YouTube" in result.output or "valid" in result.output.lower()


def test_cli_import_trackid_missing_url():
    """CLI exits non-zero when --url is not provided."""
    result = CliRunner().invoke(app, ["import", "trackid"])
    assert result.exit_code != 0
