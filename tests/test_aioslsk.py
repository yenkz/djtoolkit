"""Tests for aioslsk downloader helpers (pure-logic functions, no network)."""

import asyncio
from dataclasses import dataclass, field
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from djtoolkit.config import Config
from djtoolkit.downloader.aioslsk_client import (
    _basename,
    _ext,
    _pick_best,
    _pipeline_download,
    _quality_score,
    _rank_candidates,
    _relevance,
    _set_status,
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
    track = {"id": 1, "title": "City of Sound", "artist": "Big Wild", "duration_ms": 232_000}
    results = [_make_result("user1", "Big Wild - City of Sound.mp3")]
    user, filename = _pick_best(track, results, cfg)
    assert user == "user1"
    assert filename is not None


def test_pick_best_returns_none_when_no_match(cfg):
    track = {"id": 2, "title": "City of Sound", "artist": "Big Wild", "duration_ms": 232_000}
    results = [_make_result("user1", "totally_unrelated_song.mp3")]
    user, filename = _pick_best(track, results, cfg)
    assert user is None
    assert filename is None


def test_pick_best_filters_by_duration(cfg):
    track = {"id": 3, "title": "City of Sound", "artist": "Big Wild", "duration_ms": 232_000}
    # duration = 100s, far outside 2000ms tolerance from 232s
    results = [_make_result("user1", "Big Wild - City of Sound.mp3", duration_sec=100)]
    user, _ = _pick_best(track, results, cfg)
    assert user is None


def test_pick_best_prefers_flac_over_mp3(cfg):
    track = {"id": 4, "title": "City of Sound", "artist": "Big Wild", "duration_ms": 232_000}
    results = [
        _make_result("user1", "Big Wild - City of Sound.mp3"),
        _make_result("user2", "Big Wild - City of Sound.flac"),
    ]
    user, _ = _pick_best(track, results, cfg)
    assert user == "user2"


def test_pick_best_excludes_non_audio(cfg):
    track = {"id": 5, "title": "City of Sound", "artist": "Big Wild", "duration_ms": 232_000}
    f = _FileData("Big Wild - City of Sound.zip", extension="zip")
    results = [_SearchResult(username="user1", shared_items=[f])]
    user, _ = _pick_best(track, results, cfg)
    assert user is None


def test_pick_best_empty_results(cfg):
    track = {"id": 6, "title": "City of Sound", "artist": "Big Wild", "duration_ms": 232_000}
    user, filename = _pick_best(track, [], cfg)
    assert user is None
    assert filename is None


# ─── Mock client for _pipeline_download tests ────────────────────────────────

@dataclass
class _MockSearchRequest:
    """Mimics aioslsk SearchRequest — accumulates results on .results list."""
    query: str
    results: list = field(default_factory=list)


class _MockSearchManager:
    """Mimics client.searches with a search() method."""

    def __init__(self):
        self._requests: list[_MockSearchRequest] = []

    async def search(self, query: str) -> _MockSearchRequest:
        req = _MockSearchRequest(query=query)
        self._requests.append(req)
        return req


class _MockClient:
    """Fake aioslsk client with searches manager."""

    def __init__(self):
        self.searches = _MockSearchManager()


# ─── _pipeline_download tests ────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_pipeline_download_starts_download_on_first_viable_result(cfg):
    """Deliver results shortly after search fires. Verify download is called and success reported."""
    cfg.soulseek.search_timeout_sec = 2.0

    client = _MockClient()
    track = {"id": 1, "title": "City of Sound", "artist": "Big Wild", "duration_ms": 232_000}
    tracks_by_job = {"job-1": track}
    queries_by_id = {1: ["big wild city of sound"]}

    reports = []

    async def report_fn(job_id, success, result, error):
        reports.append({"job_id": job_id, "success": success, "result": result, "error": error})

    async def deliver_results():
        """Wait briefly, then inject results into the SearchRequest."""
        await asyncio.sleep(0.1)
        # The first search request is for our track
        req = client.searches._requests[0]
        req.results.append(_SearchResult(
            username="user1",
            shared_items=[_FileData(
                "Big Wild - City of Sound.flac", extension="flac", filesize=30_000_000,
                attributes=[_Attribute(_ATTR_DURATION, 232)],
            )],
        ))

    with patch("djtoolkit.downloader.aioslsk_client._download_track", new_callable=AsyncMock) as mock_dl:
        mock_dl.return_value = "/tmp/Big Wild - City of Sound.flac"

        # Run delivery and pipeline concurrently
        asyncio.create_task(deliver_results())
        await _pipeline_download(client, cfg, tracks_by_job, queries_by_id, report_fn)

    assert len(reports) == 1
    assert reports[0]["success"] is True
    assert reports[0]["result"] == {"local_path": "/tmp/Big Wild - City of Sound.flac"}
    mock_dl.assert_called_once()


@pytest.mark.asyncio
async def test_pipeline_download_reports_failure_when_no_results(cfg):
    """No results delivered, short timeout. Verify failure reported."""
    cfg.soulseek.search_timeout_sec = 0.3

    client = _MockClient()
    track = {"id": 10, "title": "Nonexistent Song", "artist": "Nobody", "duration_ms": 200_000}
    tracks_by_job = {"job-10": track}
    queries_by_id = {10: ["nobody nonexistent song"]}

    reports = []

    async def report_fn(job_id, success, result, error):
        reports.append({"job_id": job_id, "success": success, "result": result, "error": error})

    await _pipeline_download(client, cfg, tracks_by_job, queries_by_id, report_fn)

    assert len(reports) == 1
    assert reports[0]["success"] is False
    assert reports[0]["job_id"] == "job-10"


@pytest.mark.asyncio
async def test_pipeline_download_independent_tracks(cfg):
    """Two tracks: one gets results (success), one does not (failure). Both report independently."""
    cfg.soulseek.search_timeout_sec = 0.5

    client = _MockClient()
    track_a = {"id": 20, "title": "City of Sound", "artist": "Big Wild", "duration_ms": 232_000}
    track_b = {"id": 21, "title": "Ghost Song", "artist": "Nobody", "duration_ms": 180_000}
    tracks_by_job = {"job-20": track_a, "job-21": track_b}
    queries_by_id = {
        20: ["big wild city of sound"],
        21: ["nobody ghost song"],
    }

    reports = []

    async def report_fn(job_id, success, result, error):
        reports.append({"job_id": job_id, "success": success, "result": result, "error": error})

    async def deliver_results_for_track_a():
        await asyncio.sleep(0.1)
        # With MAX_CONCURRENT=3, both tracks search immediately.
        # Find the request for track A's query.
        for req in client.searches._requests:
            if req.query == "big wild city of sound":
                req.results.append(_SearchResult(
                    username="user1",
                    shared_items=[_FileData(
                        "Big Wild - City of Sound.flac", extension="flac", filesize=30_000_000,
                        attributes=[_Attribute(_ATTR_DURATION, 232)],
                    )],
                ))
                break

    with patch("djtoolkit.downloader.aioslsk_client._download_track", new_callable=AsyncMock) as mock_dl:
        mock_dl.return_value = "/tmp/Big Wild - City of Sound.flac"

        asyncio.create_task(deliver_results_for_track_a())
        await _pipeline_download(client, cfg, tracks_by_job, queries_by_id, report_fn)

    assert len(reports) == 2
    by_job = {r["job_id"]: r for r in reports}
    assert by_job["job-20"]["success"] is True
    assert by_job["job-21"]["success"] is False


# ─── TestStatusTransitions ────────────────────────────────────────────────────

class _MockAdapter:
    """Fake SupabaseAdapter that records update_track calls."""

    def __init__(self):
        self.calls: list[tuple[int, dict]] = []

    def update_track(self, track_id: int, updates: dict) -> None:
        self.calls[len(self.calls):] = [(track_id, dict(updates))]


class TestStatusTransitions:
    """Tests for granular acquisition_status transitions."""

    def test_set_status_basic(self):
        adapter = _MockAdapter()
        _set_status(adapter, 42, "searching")
        assert len(adapter.calls) == 1
        assert adapter.calls[0] == (42, {"acquisition_status": "searching"})

    def test_set_status_with_local_path(self):
        adapter = _MockAdapter()
        _set_status(adapter, 7, "available", local_path="/tmp/track.flac")
        assert adapter.calls[0] == (
            7, {"acquisition_status": "available", "local_path": "/tmp/track.flac"}
        )

    def test_set_status_with_search_results_count(self):
        adapter = _MockAdapter()
        _set_status(adapter, 10, "found", search_results_count=5)
        assert adapter.calls[0] == (
            10, {"acquisition_status": "found", "search_results_count": 5}
        )

    def test_set_status_search_results_count_zero(self):
        adapter = _MockAdapter()
        _set_status(adapter, 10, "not_found", search_results_count=0)
        assert adapter.calls[0] == (
            10, {"acquisition_status": "not_found", "search_results_count": 0}
        )

    def test_set_status_with_all_params(self):
        adapter = _MockAdapter()
        _set_status(adapter, 99, "available", local_path="/music/song.mp3", search_results_count=3)
        assert adapter.calls[0] == (
            99, {
                "acquisition_status": "available",
                "local_path": "/music/song.mp3",
                "search_results_count": 3,
            }
        )

    def test_set_status_omitted_optional_params_not_in_updates(self):
        """When local_path and search_results_count are None, they must not appear in the dict."""
        adapter = _MockAdapter()
        _set_status(adapter, 1, "downloading")
        updates = adapter.calls[0][1]
        assert "local_path" not in updates
        assert "search_results_count" not in updates

    def test_searching_to_found_flow(self):
        """Simulate the searching -> found transition sequence."""
        adapter = _MockAdapter()
        _set_status(adapter, 50, "searching")
        _set_status(adapter, 50, "found", search_results_count=12)
        assert len(adapter.calls) == 2
        assert adapter.calls[0][1]["acquisition_status"] == "searching"
        assert adapter.calls[1][1]["acquisition_status"] == "found"
        assert adapter.calls[1][1]["search_results_count"] == 12

    def test_searching_to_not_found_flow(self):
        """Simulate the searching -> not_found transition sequence."""
        adapter = _MockAdapter()
        _set_status(adapter, 51, "searching")
        _set_status(adapter, 51, "not_found", search_results_count=0)
        assert len(adapter.calls) == 2
        assert adapter.calls[0][1]["acquisition_status"] == "searching"
        assert adapter.calls[1][1]["acquisition_status"] == "not_found"
        assert adapter.calls[1][1]["search_results_count"] == 0

    def test_full_happy_path_transitions(self):
        """Simulate the full happy path: searching -> found -> queued -> downloading -> available."""
        adapter = _MockAdapter()
        tid = 100
        _set_status(adapter, tid, "searching")
        _set_status(adapter, tid, "found", search_results_count=8)
        _set_status(adapter, tid, "queued")
        _set_status(adapter, tid, "downloading")
        _set_status(adapter, tid, "available", local_path="/tmp/song.flac")

        statuses = [c[1]["acquisition_status"] for c in adapter.calls]
        assert statuses == ["searching", "found", "queued", "downloading", "available"]

    def test_rank_candidates_returns_viable_for_good_match(self, cfg):
        """_rank_candidates returns non-empty list for a good match."""
        track = {"id": 1, "title": "City of Sound", "artist": "Big Wild", "duration_ms": 232_000}
        results = [_make_result("user1", "Big Wild - City of Sound.flac", duration_sec=232)]
        ranked = _rank_candidates(track, results, cfg, "big wild city of sound")
        assert len(ranked) > 0

    def test_rank_candidates_returns_empty_for_bad_match(self, cfg):
        """_rank_candidates returns empty list for an irrelevant file."""
        track = {"id": 2, "title": "City of Sound", "artist": "Big Wild", "duration_ms": 232_000}
        results = [_make_result("user1", "totally_unrelated_garbage.mp3", duration_sec=232)]
        ranked = _rank_candidates(track, results, cfg, "big wild city of sound")
        assert len(ranked) == 0
