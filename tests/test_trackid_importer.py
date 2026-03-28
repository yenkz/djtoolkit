"""Tests for track identification importer (YouTube + SoundCloud)."""

import json
import uuid
import pytest
from unittest.mock import patch, MagicMock
from djtoolkit.importers.trackid import validate_url, PollTimeoutError
from djtoolkit.importers.trackid import import_trackid
from djtoolkit.config import Config
from typer.testing import CliRunner
from djtoolkit.__main__ import app


# ─── validate_url (YouTube) ──────────────────────────────────────────────────

@pytest.mark.parametrize("url,expected", [
    ("https://www.youtube.com/watch?v=dQw4w9WgXcQ",
     "https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    ("https://youtube.com/watch?v=dQw4w9WgXcQ",
     "https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    ("https://youtu.be/dQw4w9WgXcQ",
     "https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    ("https://www.youtube.com/embed/dQw4w9WgXcQ",
     "https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    ("https://youtu.be/dQw4w9WgXcQ?si=abc123",
     "https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    ("https://www.youtube.com/watch?v=dQw4w9WgXcQ&feature=share&t=42",
     "https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
])
def test_validate_url_normalizes_youtube(url, expected):
    assert validate_url(url) == expected


# ─── validate_url (SoundCloud) ───────────────────────────────────────────────

@pytest.mark.parametrize("url,expected", [
    ("https://soundcloud.com/boilerroom/solomun-tulum",
     "https://soundcloud.com/boilerroom/solomun-tulum"),
    ("https://www.soundcloud.com/boilerroom/solomun-tulum",
     "https://soundcloud.com/boilerroom/solomun-tulum"),
    ("https://m.soundcloud.com/boilerroom/solomun-tulum",
     "https://soundcloud.com/boilerroom/solomun-tulum"),
])
def test_validate_url_normalizes_soundcloud(url, expected):
    assert validate_url(url) == expected


# ─── validate_url rejects invalid ────────────────────────────────────────────

@pytest.mark.parametrize("bad_url", [
    "https://vimeo.com/123456",
    "not-a-url",
    "",
    "https://youtube.com/",
    "https://youtube.com/watch",
    "https://soundcloud.com/",        # no path after artist
    "https://soundcloud.com/artist",  # needs artist/track
])
def test_validate_url_rejects_invalid(bad_url):
    with pytest.raises(ValueError):
        validate_url(bad_url)


# ─── Helpers ─────────────────────────────────────────────────────────────────

def _cfg(**kwargs) -> Config:
    cfg = Config()
    for k, v in kwargs.items():
        setattr(cfg.trackid, k, v)
    return cfg


USER_ID = "test-user-uuid"


def _mock_adapter():
    """Build a mock adapter with chained Supabase client methods."""
    adapter = MagicMock()
    adapter._inserted_tracks = []

    def capture_insert(row):
        adapter._inserted_tracks.append(row)
        result = MagicMock()
        result.execute.return_value.data = [row]
        return result

    def table_router(name):
        mock_table = MagicMock()
        if name == "trackid_jobs":
            select_chain = MagicMock()
            select_chain.eq.return_value.eq.return_value.maybeSingle.return_value.execute.return_value.data = adapter._cached_job
            mock_table.select.return_value = select_chain
            mock_table.insert.return_value.execute.return_value = MagicMock()
            mock_table.update.return_value.eq.return_value.eq.return_value.execute.return_value = MagicMock()
        elif name == "trackid_import_jobs":
            # poll_analysis reads from this table
            select_chain = MagicMock()
            select_chain.eq.return_value.maybeSingle.return_value.execute.return_value.data = adapter._poll_result
            mock_table.select.return_value = select_chain
        elif name == "tracks":
            mock_table.insert = capture_insert
        return mock_table

    adapter._client.table = table_router
    adapter._cached_job = None
    adapter._poll_result = None
    return adapter


def _make_preview_track(artist="Bonobo", title="Kong", confidence=0.95, duration_ms=180000):
    return {
        "_key": f"{title.lower()}|{artist.lower()}",
        "source": "trackid",
        "artist": artist,
        "title": title,
        "artists": artist,
        "duration_ms": duration_ms,
        "confidence": confidence,
        "search_string": f"{artist.lower()} {title.lower()}",
        "already_owned": False,
    }


# ─── import_trackid ─────────────────────────────────────────────────────────

def test_import_trackid_inserts_tracks():
    cfg = _cfg()
    adapter = _mock_adapter()
    url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"

    completed_result = {
        "tracks": [
            _make_preview_track(),
            _make_preview_track("Aphex Twin", "Windowlicker", 0.88),
        ],
        "total": 2,
    }

    with patch("djtoolkit.importers.trackid.submit_analysis", return_value="job_abc"), \
         patch("djtoolkit.importers.trackid.poll_analysis", return_value=completed_result):
        stats = import_trackid(url, cfg, adapter, USER_ID)

    assert stats["imported"] == 2
    assert stats["skipped_low_confidence"] == 0
    assert len(adapter._inserted_tracks) == 2
    assert adapter._inserted_tracks[0]["source"] == "trackid"
    assert adapter._inserted_tracks[0]["acquisition_status"] == "candidate"
    assert adapter._inserted_tracks[0]["duration_ms"] == 180000


def test_import_trackid_filters_low_confidence():
    cfg = _cfg()
    cfg.trackid.confidence_threshold = 0.8
    adapter = _mock_adapter()
    url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"

    completed_result = {
        "tracks": [
            _make_preview_track(confidence=0.9),
            _make_preview_track("Low", "Score", confidence=0.5),
        ],
        "total": 2,
    }

    with patch("djtoolkit.importers.trackid.submit_analysis", return_value="job_abc"), \
         patch("djtoolkit.importers.trackid.poll_analysis", return_value=completed_result):
        stats = import_trackid(url, cfg, adapter, USER_ID)

    assert stats["imported"] == 1
    assert stats["skipped_low_confidence"] == 1


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

    completed_result = {"tracks": [_make_preview_track()], "total": 1}

    adapter = _mock_adapter()
    adapter._cached_job = {"job_id": "job_abc", "status": "completed"}
    with patch("djtoolkit.importers.trackid.submit_analysis", return_value="job_def") as mock_submit, \
         patch("djtoolkit.importers.trackid.poll_analysis", return_value=completed_result):
        stats = import_trackid(url, cfg, adapter, USER_ID, force=True)

    assert stats["imported"] == 1
    mock_submit.assert_called_once()


def test_import_trackid_empty_tracks():
    cfg = _cfg()
    adapter = _mock_adapter()
    url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"

    completed_result = {"tracks": [], "total": 0}

    with patch("djtoolkit.importers.trackid.submit_analysis", return_value="job_abc"), \
         patch("djtoolkit.importers.trackid.poll_analysis", return_value=completed_result):
        stats = import_trackid(url, cfg, adapter, USER_ID)

    assert stats["identified"] == 0
    assert stats["imported"] == 0


def test_import_trackid_deduplicates_within_result():
    cfg = _cfg()
    adapter = _mock_adapter()
    url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"

    completed_result = {
        "tracks": [
            _make_preview_track("Bonobo", "Kong", 0.95),
            _make_preview_track("Bonobo", "Kong", 0.85),  # duplicate
        ],
        "total": 2,
    }

    with patch("djtoolkit.importers.trackid.submit_analysis", return_value="job_abc"), \
         patch("djtoolkit.importers.trackid.poll_analysis", return_value=completed_result):
        stats = import_trackid(url, cfg, adapter, USER_ID)

    assert stats["imported"] == 1
    assert stats["skipped_duplicate"] == 1


def test_import_trackid_soundcloud_url():
    cfg = _cfg()
    adapter = _mock_adapter()
    url = "https://soundcloud.com/boilerroom/solomun-tulum"

    completed_result = {"tracks": [_make_preview_track()], "total": 1}

    with patch("djtoolkit.importers.trackid.submit_analysis", return_value="job_abc"), \
         patch("djtoolkit.importers.trackid.poll_analysis", return_value=completed_result):
        stats = import_trackid(url, cfg, adapter, USER_ID)

    assert stats["imported"] == 1


# ─── CLI smoke tests ──────────────────────────────────────────────────────────

def test_cli_import_trackid_invalid_url():
    """CLI exits non-zero and prints error on invalid URL."""
    result = CliRunner().invoke(app, ["import", "trackid", "--url", "https://vimeo.com/123"])
    assert result.exit_code != 0


def test_cli_import_trackid_missing_url():
    """CLI exits non-zero when --url is not provided."""
    result = CliRunner().invoke(app, ["import", "trackid"])
    assert result.exit_code != 0
