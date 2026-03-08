"""Tests for slskd downloader helpers (pure-logic functions + mocked HTTP)."""

from unittest.mock import MagicMock, patch

import pytest

from djtoolkit.config import Config
from djtoolkit.db.database import connect, setup
from djtoolkit.downloader.slskd import (
    _basename,
    _ext,
    _iter_files,
    _normalize,
    _pick_best,
    _quality_score,
    _relevance,
    health_check,
    reconcile_disk,
)


@pytest.fixture
def cfg():
    c = Config()
    c.slskd.host = "http://localhost:5030"
    c.slskd.api_key = ""
    c.matching.min_score_title = 0.5
    c.matching.duration_tolerance_ms = 2000
    return c


@pytest.fixture
def reconcile_cfg(tmp_path):
    """Config wired to a fresh DB and controlled downloads_dir/library_dir."""
    db_path = tmp_path / "test.db"
    setup(db_path)
    downloads_dir = tmp_path / "downloads"
    downloads_dir.mkdir()
    c = Config()
    c.db.path = str(db_path)
    c.paths.downloads_dir = str(downloads_dir)
    c.paths.library_dir = str(tmp_path / "library")  # does not exist — won't be scanned
    return c


def _insert_track(db_path, *, status="candidate", artist="Test Artist", title="Test Track", slskd_job_id=None):
    with connect(db_path) as conn:
        cur = conn.execute(
            "INSERT INTO tracks (acquisition_status, source, title, artist, slskd_job_id)"
            " VALUES (?, 'exportify', ?, ?, ?)",
            (status, title, artist, slskd_job_id),
        )
        conn.commit()
        return cur.lastrowid


# ─── Pure helpers ─────────────────────────────────────────────────────────────


def test_basename_posix():
    assert _basename("/music/Artist/Track.mp3") == "Track"


def test_basename_windows():
    assert _basename("C:\\Users\\music\\Track.flac") == "Track"


def test_basename_no_extension():
    assert _basename("/music/Track") == "Track"


def test_ext_posix():
    assert _ext("/music/Track.mp3") == ".mp3"


def test_ext_windows():
    assert _ext("C:\\music\\Track.FLAC") == ".flac"


def test_ext_no_extension():
    assert _ext("/music/Track") == ""


def test_quality_score_flac_beats_mp3():
    flac = {"filename": "track.flac", "extension": "flac", "size": 30_000_000}
    mp3 = {"filename": "track.mp3", "extension": "mp3", "size": 10_000_000}
    assert _quality_score(flac) > _quality_score(mp3)


def test_quality_score_mp3_320_beats_plain_mp3():
    mp3_320 = {"filename": "track 320.mp3", "extension": "mp3", "size": 10_000_000}
    mp3_plain = {"filename": "track.mp3", "extension": "mp3", "size": 8_000_000}
    assert _quality_score(mp3_320) > _quality_score(mp3_plain)


def test_normalize_returns_list():
    assert _normalize([{"a": 1}]) == [{"a": 1}]


def test_normalize_extracts_responses_from_dict():
    raw = {"responses": [{"username": "user"}], "other": "data"}
    assert _normalize(raw) == [{"username": "user"}]


def test_normalize_returns_empty_for_unrecognised():
    assert _normalize("garbage") == []
    assert _normalize(None) == []


def test_iter_files_finds_files_key():
    resp = {"files": [{"filename": "a.mp3"}]}
    assert _iter_files(resp) == [{"filename": "a.mp3"}]


def test_iter_files_finds_file_results_key():
    resp = {"file_results": [{"filename": "b.flac"}]}
    assert _iter_files(resp) == [{"filename": "b.flac"}]


def test_iter_files_returns_empty_when_missing():
    assert _iter_files({}) == []


# ─── _pick_best ───────────────────────────────────────────────────────────────


def _make_response(username: str, filename: str, length_sec: int = 232) -> dict:
    return {
        "username": username,
        "files": [
            {
                "filename": filename,
                "extension": filename.rsplit(".", 1)[-1].lower(),
                "size": 5_000_000,
                "length": length_sec,
            }
        ],
    }


def test_pick_best_returns_best_match(cfg):
    track = {"title": "City of Sound", "artist": "Big Wild", "duration_ms": 232_000}
    responses = [_make_response("user1", "Big Wild - City of Sound.mp3")]
    user, f = _pick_best(track, responses, cfg)
    assert user == "user1"
    assert f is not None


def test_pick_best_returns_none_when_no_match(cfg):
    track = {"title": "City of Sound", "artist": "Big Wild", "duration_ms": 232_000}
    responses = [_make_response("user1", "totally_unrelated_song.mp3")]
    user, f = _pick_best(track, responses, cfg)
    assert user is None
    assert f is None


def test_pick_best_filters_by_duration(cfg):
    """File whose duration deviates beyond tolerance is excluded."""
    track = {"title": "City of Sound", "artist": "Big Wild", "duration_ms": 232_000}
    # length_sec = 100, far outside 2000ms tolerance
    responses = [_make_response("user1", "Big Wild - City of Sound.mp3", length_sec=100)]
    user, f = _pick_best(track, responses, cfg)
    assert user is None


def test_pick_best_prefers_flac_over_mp3(cfg):
    track = {"title": "City of Sound", "artist": "Big Wild", "duration_ms": 232_000}
    responses = [
        _make_response("user1", "Big Wild - City of Sound.mp3"),
        _make_response("user2", "Big Wild - City of Sound.flac"),
    ]
    user, f = _pick_best(track, responses, cfg)
    assert user == "user2"


# ─── health_check ─────────────────────────────────────────────────────────────


def test_health_check_returns_false_on_connection_error(cfg):
    import requests

    with patch("djtoolkit.downloader.slskd.requests.get", side_effect=requests.ConnectionError()):
        ok, msg = health_check(cfg)
    assert ok is False
    assert "Cannot connect" in msg


def test_health_check_returns_false_on_401(cfg):
    mock_resp = MagicMock()
    mock_resp.status_code = 401
    with patch("djtoolkit.downloader.slskd.requests.get", return_value=mock_resp):
        ok, msg = health_check(cfg)
    assert ok is False
    assert "401" in msg


def test_health_check_returns_false_when_not_connected(cfg):
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {"server": {"state": "Disconnected", "username": ""}}
    with patch("djtoolkit.downloader.slskd.requests.get", return_value=mock_resp):
        ok, msg = health_check(cfg)
    assert ok is False


def test_health_check_returns_true_when_connected(cfg):
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {
        "server": {"state": "Connected", "username": "testuser"}
    }
    with patch("djtoolkit.downloader.slskd.requests.get", return_value=mock_resp):
        ok, msg = health_check(cfg)
    assert ok is True
    assert "testuser" in msg


# ─── reconcile_disk ───────────────────────────────────────────────────────────


def test_reconcile_disk_candidate_matched(reconcile_cfg):
    """A candidate track whose file is found by fuzzy name is set to available."""
    track_id = _insert_track(reconcile_cfg.db_path, status="candidate", artist="Big Wild", title="City of Sound")
    audio_file = reconcile_cfg.downloads_dir / "Big Wild - City of Sound.mp3"
    audio_file.touch()

    stats = reconcile_disk(reconcile_cfg)

    assert stats["updated"] == 1
    assert stats["skipped"] == 0
    with connect(reconcile_cfg.db_path) as conn:
        row = conn.execute("SELECT acquisition_status, local_path FROM tracks WHERE id = ?", (track_id,)).fetchone()
    assert row["acquisition_status"] == "available"
    assert row["local_path"] == str(audio_file)


def test_reconcile_disk_downloading_exact_match(reconcile_cfg):
    """A downloading track matched by slskd_job_id basename is set to available."""
    job_id = "\\\\user\\music\\Big Wild - City of Sound.flac"
    track_id = _insert_track(
        reconcile_cfg.db_path, status="downloading", artist="Big Wild", title="City of Sound", slskd_job_id=job_id
    )
    audio_file = reconcile_cfg.downloads_dir / "Big Wild - City of Sound.flac"
    audio_file.touch()

    stats = reconcile_disk(reconcile_cfg)

    assert stats["updated"] == 1
    with connect(reconcile_cfg.db_path) as conn:
        row = conn.execute("SELECT acquisition_status FROM tracks WHERE id = ?", (track_id,)).fetchone()
    assert row["acquisition_status"] == "available"


def test_reconcile_disk_no_match(reconcile_cfg):
    """A candidate track with no matching file on disk stays candidate."""
    track_id = _insert_track(reconcile_cfg.db_path, status="candidate", artist="Big Wild", title="City of Sound")
    unrelated = reconcile_cfg.downloads_dir / "Some Other Artist - Unrelated Track.mp3"
    unrelated.touch()

    stats = reconcile_disk(reconcile_cfg)

    assert stats["updated"] == 0
    assert stats["skipped"] == 1
    with connect(reconcile_cfg.db_path) as conn:
        row = conn.execute("SELECT acquisition_status FROM tracks WHERE id = ?", (track_id,)).fetchone()
    assert row["acquisition_status"] == "candidate"


def test_reconcile_disk_missing_downloads_dir(reconcile_cfg):
    """If downloads_dir doesn't exist, no crash and updated=0."""
    import shutil
    shutil.rmtree(reconcile_cfg.downloads_dir)
    _insert_track(reconcile_cfg.db_path, status="candidate")

    stats = reconcile_disk(reconcile_cfg)

    assert stats["updated"] == 0
    assert stats["skipped"] == 1
