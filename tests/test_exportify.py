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
