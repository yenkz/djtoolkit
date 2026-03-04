"""Tests for Exportify CSV importer."""

import pytest

from djtoolkit.db.database import setup, connect
from djtoolkit.importers.exportify import import_csv


SAMPLE_CSV = """\
Track URI,Track Name,Album Name,Artist Name(s),Release Date,Duration (ms),Popularity,Explicit,Added By,Added At,Genres,Record Label,Danceability,Energy,Key,Loudness,Mode,Speechiness,Acousticness,Instrumentalness,Liveness,Valence,Tempo,Time Signature
spotify:track:7c7ClnE57SwbizNe24XTXe,City of Sound,Superdream,Big Wild,2019-02-01,232000,49,false,yenkz,2021-04-29T02:33:20Z,,Counter Records,0.684,0.482,7,-5.339,1,0.0346,0.0128,0.742,0.17,0.724,120.008,4
spotify:track:0R3EcEKq6F1obFD7BB5YKr,It's A Memory - Oliver Remix,It's A Memory,"Fred Falke;Elohim;Oliver",2016-02-26,318786,29,false,yenkz,2021-04-29T02:33:35Z,house,Universal,0.658,0.707,5,-6.842,1,0.0538,0.013,0.359,0.329,0.123,114.984,4
"""


@pytest.fixture
def db(tmp_path):
    db_path = tmp_path / "test.db"
    setup(db_path)
    return db_path


@pytest.fixture
def csv_file(tmp_path):
    path = tmp_path / "export.csv"
    path.write_text(SAMPLE_CSV, encoding="utf-8")
    return path


def test_import_inserts_tracks(db, csv_file):
    result = import_csv(csv_file, db)
    assert result["inserted"] == 2
    assert result["skipped_duplicate"] == 0


def test_import_skips_duplicate(db, csv_file):
    import_csv(csv_file, db)
    result = import_csv(csv_file, db)
    assert result["inserted"] == 0
    assert result["skipped_duplicate"] == 2


def test_import_sets_status(db, csv_file):
    import_csv(csv_file, db)
    with connect(db) as conn:
        rows = conn.execute("SELECT acquisition_status FROM tracks").fetchall()
    assert all(r["acquisition_status"] == "candidate" for r in rows)


def test_import_primary_artist(db, csv_file):
    import_csv(csv_file, db)
    with connect(db) as conn:
        row = conn.execute(
            "SELECT artist FROM tracks WHERE spotify_uri = 'spotify:track:0R3EcEKq6F1obFD7BB5YKr'"
        ).fetchone()
    assert row["artist"] == "Fred Falke"


def test_import_search_string(db, csv_file):
    import_csv(csv_file, db)
    with connect(db) as conn:
        row = conn.execute(
            "SELECT search_string FROM tracks WHERE spotify_uri = 'spotify:track:7c7ClnE57SwbizNe24XTXe'"
        ).fetchone()
    assert row["search_string"] == "big wild city of sound"


def test_import_audio_features(db, csv_file):
    import_csv(csv_file, db)
    with connect(db) as conn:
        row = conn.execute(
            "SELECT tempo, danceability FROM tracks WHERE spotify_uri = 'spotify:track:7c7ClnE57SwbizNe24XTXe'"
        ).fetchone()
    assert abs(row["tempo"] - 120.008) < 0.001
    assert abs(row["danceability"] - 0.684) < 0.001


# ─── Additional coverage ──────────────────────────────────────────────────────

_HEADER = (
    "Track URI,Track Name,Album Name,Artist Name(s),Release Date,Duration (ms),"
    "Popularity,Explicit,Added By,Added At,Genres,Record Label,Danceability,Energy,"
    "Key,Loudness,Mode,Speechiness,Acousticness,Instrumentalness,Liveness,Valence,"
    "Tempo,Time Signature\n"
)


def _csv(rows: list) -> str:
    return _HEADER + "".join(r + "\n" for r in rows)


def test_import_sparse_row(db, tmp_path):
    """Row with only required fields and empty optionals inserts without crash."""
    # 8 explicit values, then 16 empty trailing columns
    row = "spotify:track:sparse001,Sparse Track,,Solo Artist,,,,false,,,,,,,,,,,,,,,,"
    path = tmp_path / "sparse.csv"
    path.write_text(_csv([row]), encoding="utf-8")
    result = import_csv(path, db)
    assert result["inserted"] == 1
    with connect(db) as conn:
        r = conn.execute(
            "SELECT title, album FROM tracks WHERE spotify_uri='spotify:track:sparse001'"
        ).fetchone()
    assert r["title"] == "Sparse Track"
    assert r["album"] is None


def test_import_explicit_true_false(db, tmp_path):
    """Explicit field: 'True' → 1, 'False' → 0."""
    rows = [
        "spotify:track:exp001,Explicit,,Artist,2020,200000,60,True,,,,,,,,,,,,,,,,",
        "spotify:track:exp002,Clean,,Artist,2020,200000,60,False,,,,,,,,,,,,,,,,",
    ]
    path = tmp_path / "explicit.csv"
    path.write_text(_csv(rows), encoding="utf-8")
    import_csv(path, db)
    with connect(db) as conn:
        e = conn.execute(
            "SELECT explicit FROM tracks WHERE spotify_uri='spotify:track:exp001'"
        ).fetchone()
        c = conn.execute(
            "SELECT explicit FROM tracks WHERE spotify_uri='spotify:track:exp002'"
        ).fetchone()
    assert e["explicit"] == 1
    assert c["explicit"] == 0


def test_import_trailing_semicolon_artist(db, tmp_path):
    """Artist field 'Artist;' → primary artist is 'Artist'."""
    row = "spotify:track:semi001,Title,,Artist;,2020,200000,,,,,,,,,,,,,,,,,,"
    path = tmp_path / "semi.csv"
    path.write_text(_csv([row]), encoding="utf-8")
    import_csv(path, db)
    with connect(db) as conn:
        r = conn.execute(
            "SELECT artist FROM tracks WHERE spotify_uri='spotify:track:semi001'"
        ).fetchone()
    assert r["artist"] == "Artist"


def test_import_idempotent(db, csv_file):
    """Re-importing the same CSV twice keeps same data with 0 new inserts."""
    r1 = import_csv(csv_file, db)
    r2 = import_csv(csv_file, db)
    assert r1["inserted"] == 2
    assert r2["inserted"] == 0
    assert r2["skipped_duplicate"] == 2
    with connect(db) as conn:
        count = conn.execute("SELECT COUNT(*) FROM tracks").fetchone()[0]
    assert count == 2


def test_import_bad_year_stores_none(db, tmp_path):
    """Malformed release_date → year is NULL, no crash."""
    row = "spotify:track:badyr001,Track,,Artist,not-a-date,200000,,,,,,,,,,,,,,,,,,"
    path = tmp_path / "bad.csv"
    path.write_text(_csv([row]), encoding="utf-8")
    import_csv(path, db)
    with connect(db) as conn:
        r = conn.execute(
            "SELECT year FROM tracks WHERE spotify_uri='spotify:track:badyr001'"
        ).fetchone()
    assert r["year"] is None
