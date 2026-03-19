"""Tests for enrichment/spotify.py — adapter-based."""

from unittest.mock import MagicMock

import pytest

from djtoolkit.config import Config
from djtoolkit.enrichment.spotify import _normalize, run
from djtoolkit.models.track import Track

_CSV_HEADER = (
    "Track URI,Track Name,Album Name,Artist Name(s),Release Date,Duration (ms),"
    "Popularity,Explicit,Added By,Added At,Genres,Record Label,Danceability,Energy,"
    "Key,Loudness,Mode,Speechiness,Acousticness,Instrumentalness,Liveness,Valence,"
    "Tempo,Time Signature\n"
)

_CSV_ROW_A = (
    "spotify:track:abc123,My Track,My Album,My Artist,2020-01-01,240000,"
    "70,false,,,electronic,Label,0.8,0.9,5,-5.0,1,0.05,0.01,0.6,0.1,0.7,128.0,4\n"
)

_CSV_ROW_B = (
    "spotify:track:xyz999,Other Track,Other Album,Other Artist,2021-06-15,180000,"
    "60,false,,,house,Label2,0.75,0.85,2,-4.5,1,0.04,0.02,0.5,0.2,0.8,130.0,4\n"
)

USER_ID = "test-user-123"


def _make_track(*, _id=1, spotify_uri=None, artist="Unknown", title="Unknown",
                album=None, genres=None, label=None, danceability=None,
                energy=None, loudness=None, speechiness=None, acousticness=None,
                instrumentalness=None, liveness=None, valence=None, tempo=None,
                year=None):
    """Create a Track object with specified attributes for testing."""
    t = Track(
        title=title,
        artist=artist,
        spotify_uri=spotify_uri,
        album=album or "",
        genres=genres or "",
        label=label or "",
        year=year,
    )
    # Set numeric fields only if provided (otherwise leave as default)
    if danceability is not None:
        t.danceability = danceability
    if energy is not None:
        t.energy = energy
    if loudness is not None:
        t.loudness = loudness
    if speechiness is not None:
        t.speechiness = speechiness
    if acousticness is not None:
        t.acousticness = acousticness
    if instrumentalness is not None:
        t.instrumentalness = instrumentalness
    if liveness is not None:
        t.liveness = liveness
    if valence is not None:
        t.valence = valence
    if tempo is not None:
        t.tempo = tempo
    t._id = _id
    return t


@pytest.fixture
def cfg():
    c = Config()
    c.matching.min_score = 0.7
    return c


@pytest.fixture
def adapter():
    mock = MagicMock()
    mock.query_available_unenriched_spotify = MagicMock(return_value=[])
    mock.update_track = MagicMock()
    return mock


def _write_csv(path, rows: list[str]):
    path.write_text(_CSV_HEADER + "".join(rows), encoding="utf-8")


def test_uri_match_enriches_track(cfg, adapter, tmp_path):
    """Track matched by spotify_uri gets its metadata filled in."""
    csv_path = tmp_path / "export.csv"
    _write_csv(csv_path, [_CSV_ROW_A])
    track = _make_track(_id=10, spotify_uri="spotify:track:abc123")
    adapter.query_available_unenriched_spotify.return_value = [track]

    result = run(csv_path, cfg, adapter, USER_ID)

    assert result["matched"] == 1
    assert 10 in result["matched_ids"]
    adapter.update_track.assert_called_once()
    call_args = adapter.update_track.call_args
    assert call_args[0][0] == 10  # track_id
    updates = call_args[0][1]
    assert updates["enriched_spotify"] is True
    assert updates["album"] == "My Album"
    assert updates["genres"] == "electronic"
    assert abs(updates["tempo"] - 128.0) < 0.001


def test_fuzzy_match_enriches_track(cfg, adapter, tmp_path):
    """Track matched by fuzzy artist+title when URI doesn't match."""
    csv_path = tmp_path / "export.csv"
    _write_csv(csv_path, [_CSV_ROW_A])
    track = _make_track(_id=20, spotify_uri=None, artist="My Artist", title="My Track")
    adapter.query_available_unenriched_spotify.return_value = [track]

    result = run(csv_path, cfg, adapter, USER_ID)

    assert result["matched"] == 1
    assert 20 in result["matched_ids"]
    adapter.update_track.assert_called_once()


def test_unmatched_track_stays_unenriched(cfg, adapter, tmp_path):
    """Track not in CSV stays unenriched — update_track is not called."""
    csv_path = tmp_path / "export.csv"
    _write_csv(csv_path, [_CSV_ROW_A])
    track = _make_track(_id=30, artist="Completely Different Artist", title="No Match Title")
    adapter.query_available_unenriched_spotify.return_value = [track]

    result = run(csv_path, cfg, adapter, USER_ID)

    assert result["unmatched"] >= 1
    adapter.update_track.assert_not_called()


def test_force_false_skips_already_enriched(cfg, adapter, tmp_path):
    """Already-enriched tracks are not returned by adapter when force=False."""
    csv_path = tmp_path / "export.csv"
    _write_csv(csv_path, [_CSV_ROW_A])
    # Adapter returns empty list (filters enriched_spotify=True when force=False)
    adapter.query_available_unenriched_spotify.return_value = []

    result = run(csv_path, cfg, adapter, USER_ID, force=False)

    assert result["matched"] == 0
    adapter.query_available_unenriched_spotify.assert_called_once_with(USER_ID, force=False)


def test_force_true_overwrites_enriched(cfg, adapter, tmp_path):
    """force=True re-processes already-enriched tracks."""
    csv_path = tmp_path / "export.csv"
    _write_csv(csv_path, [_CSV_ROW_A])
    track = _make_track(_id=40, spotify_uri="spotify:track:abc123")
    adapter.query_available_unenriched_spotify.return_value = [track]

    result = run(csv_path, cfg, adapter, USER_ID, force=True)

    assert result["matched"] == 1
    assert 40 in result["matched_ids"]
    adapter.query_available_unenriched_spotify.assert_called_once_with(USER_ID, force=True)


def test_empty_csv_returns_zero_stats(cfg, adapter, tmp_path):
    csv_path = tmp_path / "empty.csv"
    csv_path.write_text(_CSV_HEADER, encoding="utf-8")
    # Even with tracks available, empty CSV means no matches
    track = _make_track(_id=50, spotify_uri="spotify:track:abc123")
    adapter.query_available_unenriched_spotify.return_value = [track]

    result = run(csv_path, cfg, adapter, USER_ID)

    assert result["matched"] == 0
    assert result["unmatched"] == 0


def test_multiple_tracks_partially_matched(cfg, adapter, tmp_path):
    csv_path = tmp_path / "export.csv"
    _write_csv(csv_path, [_CSV_ROW_A, _CSV_ROW_B])

    track1 = _make_track(_id=60, spotify_uri="spotify:track:abc123")
    track2 = _make_track(_id=61, artist="No Match", title="Ghost Track")
    adapter.query_available_unenriched_spotify.return_value = [track1, track2]

    result = run(csv_path, cfg, adapter, USER_ID)

    assert result["matched"] == 1
    assert result["unmatched"] == 1


def test_force_true_skips_spotify_uri_update(cfg, adapter, tmp_path):
    """In force mode, spotify_uri should NOT be overwritten (avoids UNIQUE violations)."""
    csv_path = tmp_path / "export.csv"
    _write_csv(csv_path, [_CSV_ROW_A])
    track = _make_track(_id=70, spotify_uri="spotify:track:abc123")
    adapter.query_available_unenriched_spotify.return_value = [track]

    result = run(csv_path, cfg, adapter, USER_ID, force=True)

    assert result["matched"] == 1
    updates = adapter.update_track.call_args[0][1]
    assert "spotify_uri" not in updates  # should NOT overwrite URI in force mode


def test_null_fields_get_written(cfg, adapter, tmp_path):
    """Track with no existing data gets all CSV fields written."""
    csv_path = tmp_path / "export.csv"
    _write_csv(csv_path, [_CSV_ROW_A])
    track = _make_track(_id=80, spotify_uri="spotify:track:abc123")
    adapter.query_available_unenriched_spotify.return_value = [track]

    run(csv_path, cfg, adapter, USER_ID)

    updates = adapter.update_track.call_args[0][1]
    assert updates["album"] == "My Album"
    assert updates["record_label"] == "Label"
    assert updates["genres"] == "electronic"
    assert updates["danceability"] == 0.8
    assert updates["energy"] == 0.9
    assert updates["key"] == 5
    assert updates["loudness"] == -5.0
    assert updates["mode"] == 1
    assert updates["year"] == 2020
    assert updates["enriched_spotify"] is True


def test_year_derived_from_release_date(cfg, adapter, tmp_path):
    """Year is derived from release_date when track.year is None."""
    csv_path = tmp_path / "export.csv"
    _write_csv(csv_path, [_CSV_ROW_A])
    track = _make_track(_id=90, spotify_uri="spotify:track:abc123", year=None)
    adapter.query_available_unenriched_spotify.return_value = [track]

    run(csv_path, cfg, adapter, USER_ID)

    updates = adapter.update_track.call_args[0][1]
    assert updates["year"] == 2020


# ─── _normalize ───────────────────────────────────────────────────────────────


def test_normalize_lowercases():
    assert _normalize("ARTIST NAME") == "artist name"


def test_normalize_strips_punctuation():
    assert _normalize("It's A Memory!") == "its a memory"


def test_normalize_handles_none_like():
    assert _normalize("") == ""
    assert _normalize(None) == ""
