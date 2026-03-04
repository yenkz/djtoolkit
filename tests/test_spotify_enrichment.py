"""Tests for enrichment/spotify.py."""

import pytest

from djtoolkit.config import Config
from djtoolkit.db.database import connect, setup
from djtoolkit.enrichment.spotify import _normalize, run

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


@pytest.fixture
def cfg(tmp_path):
    c = Config()
    c.db.path = str(tmp_path / "test.db")
    c.matching.min_score = 0.7
    setup(c.db_path)
    return c


def _insert_track(db_path, *, spotify_uri=None, artist="Unknown", title="Unknown",
                   enriched_spotify=0):
    with connect(db_path) as conn:
        cursor = conn.execute(
            """INSERT INTO tracks
               (acquisition_status, source, title, artist, spotify_uri, enriched_spotify)
               VALUES ('available', 'folder', ?, ?, ?, ?)""",
            (title, artist, spotify_uri, enriched_spotify),
        )
        conn.commit()
        return cursor.lastrowid


def _write_csv(path, rows: list[str]):
    path.write_text(_CSV_HEADER + "".join(rows), encoding="utf-8")


def test_uri_match_enriches_track(cfg, tmp_path):
    """Track matched by spotify_uri gets its metadata filled in."""
    csv_path = tmp_path / "export.csv"
    _write_csv(csv_path, [_CSV_ROW_A])
    track_id = _insert_track(cfg.db_path, spotify_uri="spotify:track:abc123")

    result = run(csv_path, cfg)

    assert result["matched"] == 1
    assert track_id in result["matched_ids"]
    with connect(cfg.db_path) as conn:
        row = conn.execute(
            "SELECT enriched_spotify, album, genres, tempo FROM tracks WHERE id = ?",
            (track_id,),
        ).fetchone()
    assert row["enriched_spotify"] == 1
    assert row["album"] == "My Album"
    assert row["genres"] == "electronic"
    assert abs(row["tempo"] - 128.0) < 0.001


def test_fuzzy_match_enriches_track(cfg, tmp_path):
    """Track matched by fuzzy artist+title when URI doesn't match."""
    csv_path = tmp_path / "export.csv"
    _write_csv(csv_path, [_CSV_ROW_A])
    # Insert track without spotify_uri but with matching artist+title
    track_id = _insert_track(
        cfg.db_path, spotify_uri=None, artist="My Artist", title="My Track"
    )

    result = run(csv_path, cfg)

    assert result["matched"] == 1
    assert track_id in result["matched_ids"]


def test_unmatched_track_stays_unenriched(cfg, tmp_path):
    """Track not in CSV stays with enriched_spotify=0."""
    csv_path = tmp_path / "export.csv"
    _write_csv(csv_path, [_CSV_ROW_A])
    track_id = _insert_track(
        cfg.db_path, artist="Completely Different Artist", title="No Match Title"
    )

    result = run(csv_path, cfg)

    assert result["unmatched"] >= 1
    with connect(cfg.db_path) as conn:
        row = conn.execute(
            "SELECT enriched_spotify FROM tracks WHERE id = ?", (track_id,)
        ).fetchone()
    assert row["enriched_spotify"] == 0


def test_force_false_skips_already_enriched(cfg, tmp_path):
    """Already-enriched tracks are skipped when force=False."""
    csv_path = tmp_path / "export.csv"
    _write_csv(csv_path, [_CSV_ROW_A])
    _insert_track(
        cfg.db_path, spotify_uri="spotify:track:abc123", enriched_spotify=1
    )

    result = run(csv_path, cfg, force=False)

    assert result["matched"] == 0


def test_force_true_overwrites_enriched(cfg, tmp_path):
    """force=True re-processes already-enriched tracks."""
    csv_path = tmp_path / "export.csv"
    _write_csv(csv_path, [_CSV_ROW_A])
    track_id = _insert_track(
        cfg.db_path, spotify_uri="spotify:track:abc123", enriched_spotify=1
    )

    result = run(csv_path, cfg, force=True)

    assert result["matched"] == 1
    assert track_id in result["matched_ids"]


def test_empty_csv_returns_zero_stats(cfg, tmp_path):
    csv_path = tmp_path / "empty.csv"
    csv_path.write_text(_CSV_HEADER, encoding="utf-8")
    _insert_track(cfg.db_path, spotify_uri="spotify:track:abc123")

    result = run(csv_path, cfg)

    assert result["matched"] == 0
    assert result["unmatched"] == 0


def test_multiple_tracks_partially_matched(cfg, tmp_path):
    csv_path = tmp_path / "export.csv"
    _write_csv(csv_path, [_CSV_ROW_A, _CSV_ROW_B])

    _insert_track(cfg.db_path, spotify_uri="spotify:track:abc123")
    _insert_track(cfg.db_path, artist="No Match", title="Ghost Track")

    result = run(csv_path, cfg)

    assert result["matched"] == 1
    assert result["unmatched"] == 1


# ─── _normalize ───────────────────────────────────────────────────────────────


def test_normalize_lowercases():
    assert _normalize("ARTIST NAME") == "artist name"


def test_normalize_strips_punctuation():
    assert _normalize("It's A Memory!") == "its a memory"


def test_normalize_handles_none_like():
    assert _normalize("") == ""
    assert _normalize(None) == ""
