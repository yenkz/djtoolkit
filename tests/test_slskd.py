"""Tests for slskd downloader helpers (pure-logic functions + mocked HTTP)."""

from unittest.mock import MagicMock, patch

import pytest

from djtoolkit.config import Config
from djtoolkit.downloader.slskd import (
    _basename,
    _ext,
    _iter_files,
    _normalize,
    _pick_best,
    _quality_score,
    _relevance,
    health_check,
)


@pytest.fixture
def cfg():
    c = Config()
    c.slskd.host = "http://localhost:5030"
    c.slskd.api_key = ""
    c.matching.min_score_title = 0.5
    c.matching.duration_tolerance_ms = 2000
    return c


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
