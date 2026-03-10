"""Tests for aioslsk downloader helpers (pure-logic functions, no network)."""

from dataclasses import dataclass, field
from unittest.mock import MagicMock

import pytest

from djtoolkit.config import Config
from djtoolkit.downloader.aioslsk_client import (
    _basename,
    _ext,
    _pick_best,
    _quality_score,
    _relevance,
)


# ─── Minimal stubs mimicking aioslsk FileData / SearchResult ─────────────────

@dataclass
class _Attribute:
    key: int
    value: int


@dataclass
class _FileData:
    filename: str
    filesize: int = 5_000_000
    extension: str = ""
    attributes: list = field(default_factory=list)

    def get_attribute_map(self) -> dict:
        return {a.key: a.value for a in self.attributes}


@dataclass
class _SearchResult:
    username: str
    shared_items: list = field(default_factory=list)
    locked_results: list = field(default_factory=list)


from aioslsk.protocol.primitives import AttributeKey

_ATTR_BITRATE = AttributeKey.BITRATE
_ATTR_DURATION = AttributeKey.DURATION


def _make_result(username: str, filename: str, duration_sec: int = 232, filesize: int = 5_000_000):
    ext = filename.rsplit(".", 1)[-1] if "." in filename else ""
    f = _FileData(
        filename=filename,
        filesize=filesize,
        extension=ext,
        attributes=[_Attribute(_ATTR_DURATION, duration_sec)],
    )
    return _SearchResult(username=username, shared_items=[f])


@pytest.fixture
def cfg():
    c = Config()
    c.matching.min_score_title = 0.5
    c.matching.duration_tolerance_ms = 2000
    return c


# ─── _basename / _ext ─────────────────────────────────────────────────────────

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


# ─── _quality_score ───────────────────────────────────────────────────────────

def test_quality_score_flac_beats_mp3():
    flac = _FileData("track.flac", extension="flac", filesize=30_000_000)
    mp3 = _FileData("track.mp3", extension="mp3", filesize=10_000_000)
    assert _quality_score(flac) > _quality_score(mp3)


def test_quality_score_mp3_320_beats_plain_mp3():
    mp3_320 = _FileData("track 320.mp3", extension="mp3", filesize=10_000_000)
    mp3_plain = _FileData("track.mp3", extension="mp3", filesize=8_000_000)
    assert _quality_score(mp3_320) > _quality_score(mp3_plain)


def test_quality_score_high_bitrate_bonus():
    # High bitrate attr should bump score
    mp3_hi = _FileData(
        "track.mp3", extension="mp3",
        attributes=[_Attribute(_ATTR_BITRATE, 320)],
    )
    mp3_lo = _FileData("track.mp3", extension="mp3")
    assert _quality_score(mp3_hi) > _quality_score(mp3_lo)


# ─── _relevance ───────────────────────────────────────────────────────────────

def test_relevance_exact_match_is_high():
    track = {"title": "City of Sound", "artist": "Big Wild"}
    score = _relevance(track, "Big Wild - City of Sound.mp3")
    assert score > 0.7


def test_relevance_unrelated_is_low():
    track = {"title": "City of Sound", "artist": "Big Wild"}
    score = _relevance(track, "totally_unrelated_garbage_filename.mp3")
    assert score < 0.5


# ─── _pick_best ───────────────────────────────────────────────────────────────

def test_pick_best_returns_best_match(cfg):
    track = {"title": "City of Sound", "artist": "Big Wild", "duration_ms": 232_000}
    results = [_make_result("user1", "Big Wild - City of Sound.mp3")]
    user, filename = _pick_best(track, results, cfg)
    assert user == "user1"
    assert filename is not None


def test_pick_best_returns_none_when_no_match(cfg):
    track = {"title": "City of Sound", "artist": "Big Wild", "duration_ms": 232_000}
    results = [_make_result("user1", "totally_unrelated_song.mp3")]
    user, filename = _pick_best(track, results, cfg)
    assert user is None
    assert filename is None


def test_pick_best_filters_by_duration(cfg):
    track = {"title": "City of Sound", "artist": "Big Wild", "duration_ms": 232_000}
    # duration = 100s, far outside 2000ms tolerance from 232s
    results = [_make_result("user1", "Big Wild - City of Sound.mp3", duration_sec=100)]
    user, _ = _pick_best(track, results, cfg)
    assert user is None


def test_pick_best_prefers_flac_over_mp3(cfg):
    track = {"title": "City of Sound", "artist": "Big Wild", "duration_ms": 232_000}
    results = [
        _make_result("user1", "Big Wild - City of Sound.mp3"),
        _make_result("user2", "Big Wild - City of Sound.flac"),
    ]
    user, _ = _pick_best(track, results, cfg)
    assert user == "user2"


def test_pick_best_excludes_non_audio(cfg):
    track = {"title": "City of Sound", "artist": "Big Wild", "duration_ms": 232_000}
    f = _FileData("Big Wild - City of Sound.zip", extension="zip")
    results = [_SearchResult(username="user1", shared_items=[f])]
    user, _ = _pick_best(track, results, cfg)
    assert user is None


def test_pick_best_empty_results(cfg):
    track = {"title": "City of Sound", "artist": "Big Wild", "duration_ms": 232_000}
    user, filename = _pick_best(track, [], cfg)
    assert user is None
    assert filename is None
