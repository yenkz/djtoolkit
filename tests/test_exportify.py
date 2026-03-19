"""Tests for Exportify CSV importer (SupabaseAdapter)."""

import pytest
from unittest.mock import MagicMock

from djtoolkit.importers.exportify import import_csv


SAMPLE_CSV = """\
Track URI,Track Name,Album Name,Artist Name(s),Release Date,Duration (ms),Popularity,Explicit,Added By,Added At,Genres,Record Label,Danceability,Energy,Key,Loudness,Mode,Speechiness,Acousticness,Instrumentalness,Liveness,Valence,Tempo,Time Signature
spotify:track:7c7ClnE57SwbizNe24XTXe,City of Sound,Superdream,Big Wild,2019-02-01,232000,49,false,yenkz,2021-04-29T02:33:20Z,,Counter Records,0.684,0.482,7,-5.339,1,0.0346,0.0128,0.742,0.17,0.724,120.008,4
spotify:track:0R3EcEKq6F1obFD7BB5YKr,It's A Memory - Oliver Remix,It's A Memory,"Fred Falke;Elohim;Oliver",2016-02-26,318786,29,false,yenkz,2021-04-29T02:33:35Z,house,Universal,0.658,0.707,5,-6.842,1,0.0538,0.013,0.359,0.329,0.123,114.984,4
"""

USER_ID = "test-user-id"

_HEADER = (
    "Track URI,Track Name,Album Name,Artist Name(s),Release Date,Duration (ms),"
    "Popularity,Explicit,Added By,Added At,Genres,Record Label,Danceability,Energy,"
    "Key,Loudness,Mode,Speechiness,Acousticness,Instrumentalness,Liveness,Valence,"
    "Tempo,Time Signature\n"
)


def _csv(rows: list) -> str:
    return _HEADER + "".join(r + "\n" for r in rows)


def _mock_adapter(inserted_data=None):
    """Build a mock adapter. upsert returns inserted_data or echoes input."""
    adapter = MagicMock()
    execute_mock = MagicMock()
    if inserted_data is not None:
        execute_mock.data = inserted_data
    else:
        # Default: echo back all rows (all inserted, none skipped)
        execute_mock.data = None  # will be set per test
    upsert_mock = MagicMock(return_value=MagicMock(execute=MagicMock(return_value=execute_mock)))
    adapter._client.table.return_value.upsert.return_value = upsert_mock
    # Capture the upserted rows
    adapter._upserted_rows = []

    def capture_upsert(rows, **kwargs):
        adapter._upserted_rows = rows
        if inserted_data is None:
            execute_mock.data = rows  # all inserted
        result_mock = MagicMock()
        result_mock.execute.return_value = execute_mock
        return result_mock

    adapter._client.table.return_value.upsert = capture_upsert
    return adapter


@pytest.fixture
def csv_file(tmp_path):
    path = tmp_path / "export.csv"
    path.write_text(SAMPLE_CSV, encoding="utf-8")
    return path


def test_import_inserts_tracks(csv_file):
    adapter = _mock_adapter()
    result = import_csv(csv_file, adapter, USER_ID)
    assert result["inserted"] == 2
    assert result["skipped_duplicate"] == 0


def test_import_skips_duplicate(csv_file):
    """When upsert returns fewer rows, the rest are duplicates."""
    adapter = _mock_adapter(inserted_data=[{"id": 1}])  # only 1 inserted
    result = import_csv(csv_file, adapter, USER_ID)
    assert result["inserted"] == 1
    assert result["skipped_duplicate"] == 1


def test_import_sets_candidate_status(csv_file):
    adapter = _mock_adapter()
    import_csv(csv_file, adapter, USER_ID)
    for row in adapter._upserted_rows:
        assert row["acquisition_status"] == "candidate"


def test_import_sets_user_id(csv_file):
    adapter = _mock_adapter()
    import_csv(csv_file, adapter, USER_ID)
    for row in adapter._upserted_rows:
        assert row["user_id"] == USER_ID


def test_import_primary_artist(csv_file):
    adapter = _mock_adapter()
    import_csv(csv_file, adapter, USER_ID)
    fred_row = next(r for r in adapter._upserted_rows if r["spotify_uri"] == "spotify:track:0R3EcEKq6F1obFD7BB5YKr")
    assert fred_row["artist"] == "Fred Falke"


def test_import_search_string(csv_file):
    adapter = _mock_adapter()
    import_csv(csv_file, adapter, USER_ID)
    bw_row = next(r for r in adapter._upserted_rows if r["spotify_uri"] == "spotify:track:7c7ClnE57SwbizNe24XTXe")
    assert bw_row["search_string"] == "big wild city of sound"


def test_import_audio_features(csv_file):
    adapter = _mock_adapter()
    import_csv(csv_file, adapter, USER_ID)
    bw_row = next(r for r in adapter._upserted_rows if r["spotify_uri"] == "spotify:track:7c7ClnE57SwbizNe24XTXe")
    assert abs(bw_row["tempo"] - 120.008) < 0.001
    assert abs(bw_row["danceability"] - 0.684) < 0.001


def test_import_sparse_row(tmp_path):
    row = "spotify:track:sparse001,Sparse Track,,Solo Artist,,,,false,,,,,,,,,,,,,,,,"
    path = tmp_path / "sparse.csv"
    path.write_text(_csv([row]), encoding="utf-8")
    adapter = _mock_adapter()
    result = import_csv(path, adapter, USER_ID)
    assert result["inserted"] == 1
    r = adapter._upserted_rows[0]
    assert r["title"] == "Sparse Track"
    assert r["album"] is None


def test_import_explicit_true_false(tmp_path):
    rows = [
        "spotify:track:exp001,Explicit,,Artist,2020,200000,60,True,,,,,,,,,,,,,,,,",
        "spotify:track:exp002,Clean,,Artist,2020,200000,60,False,,,,,,,,,,,,,,,,",
    ]
    path = tmp_path / "explicit.csv"
    path.write_text(_csv(rows), encoding="utf-8")
    adapter = _mock_adapter()
    import_csv(path, adapter, USER_ID)
    exp = next(r for r in adapter._upserted_rows if r["spotify_uri"] == "spotify:track:exp001")
    clean = next(r for r in adapter._upserted_rows if r["spotify_uri"] == "spotify:track:exp002")
    assert exp["explicit"] is True
    assert clean["explicit"] is False


def test_import_trailing_semicolon_artist(tmp_path):
    row = "spotify:track:semi001,Title,,Artist;,2020,200000,,,,,,,,,,,,,,,,,,"
    path = tmp_path / "semi.csv"
    path.write_text(_csv([row]), encoding="utf-8")
    adapter = _mock_adapter()
    import_csv(path, adapter, USER_ID)
    assert adapter._upserted_rows[0]["artist"] == "Artist"


def test_import_bad_year_stores_none(tmp_path):
    row = "spotify:track:badyr001,Track,,Artist,not-a-date,200000,,,,,,,,,,,,,,,,,,"
    path = tmp_path / "bad.csv"
    path.write_text(_csv([row]), encoding="utf-8")
    adapter = _mock_adapter()
    import_csv(path, adapter, USER_ID)
    assert adapter._upserted_rows[0]["year"] is None
