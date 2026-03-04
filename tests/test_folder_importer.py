"""Tests for the folder importer."""

from pathlib import Path
from unittest.mock import patch

import pytest

from djtoolkit.config import Config
from djtoolkit.db.database import connect, setup
from djtoolkit.importers.folder import import_folder

_FAKE_FP = {"fingerprint": "AAABBBCCC111", "duration": 240.0}
_DIFF_FP = {"fingerprint": "XXXYYYZZZXXX", "duration": 180.0}


@pytest.fixture
def cfg(tmp_path):
    c = Config()
    c.db.path = str(tmp_path / "test.db")
    c.paths.library_dir = str(tmp_path / "library")
    c.fingerprint.enabled = False  # skip fpcalc availability check
    setup(c.db_path)
    return c


def _fake_audio(directory: Path, name: str = "track.mp3") -> Path:
    """Create a minimal fake audio file (enough bytes to not be empty)."""
    path = directory / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"\xff\xfb\x90\x00" + b"\x00" * 512)
    return path


def test_empty_folder(cfg, tmp_path):
    folder = tmp_path / "music"
    folder.mkdir()
    with patch("djtoolkit.importers.folder.calc_fingerprint", return_value=None):
        stats = import_folder(folder, cfg)
    assert stats == {"inserted": 0, "skipped_duplicate": 0, "skipped_no_audio": 0}


def test_non_audio_extensions_skipped(cfg, tmp_path):
    folder = tmp_path / "music"
    folder.mkdir()
    (folder / "cover.jpg").write_bytes(b"\xff\xd8\xff")
    (folder / "readme.txt").write_text("text")
    with patch("djtoolkit.importers.folder.calc_fingerprint", return_value=None):
        stats = import_folder(folder, cfg)
    assert stats["inserted"] == 0


def test_audio_files_inserted(cfg, tmp_path):
    folder = tmp_path / "music"
    folder.mkdir()
    _fake_audio(folder, "a.mp3")
    _fake_audio(folder, "b.flac")
    with patch("djtoolkit.importers.folder.calc_fingerprint", return_value=None):
        stats = import_folder(folder, cfg)
    assert stats["inserted"] == 2
    assert stats["skipped_duplicate"] == 0


def test_nested_subdirectories_scanned(cfg, tmp_path):
    folder = tmp_path / "music"
    sub = folder / "Artist" / "Album"
    sub.mkdir(parents=True)
    _fake_audio(sub, "track.flac")
    with patch("djtoolkit.importers.folder.calc_fingerprint", return_value=None):
        stats = import_folder(folder, cfg)
    assert stats["inserted"] == 1


def test_duplicate_fingerprint_skipped(cfg, tmp_path):
    """Two files with the same fingerprint: first inserted, second skipped."""
    folder = tmp_path / "music"
    folder.mkdir()
    _fake_audio(folder, "track1.mp3")
    _fake_audio(folder, "track2.mp3")
    with patch("djtoolkit.importers.folder.calc_fingerprint", return_value=_FAKE_FP):
        stats = import_folder(folder, cfg)
    assert stats["inserted"] == 1
    assert stats["skipped_duplicate"] == 1


def test_distinct_fingerprints_both_inserted(cfg, tmp_path):
    folder = tmp_path / "music"
    folder.mkdir()
    _fake_audio(folder, "track1.mp3")
    _fake_audio(folder, "track2.mp3")
    fp_values = iter([_FAKE_FP, _DIFF_FP])
    with patch(
        "djtoolkit.importers.folder.calc_fingerprint", side_effect=fp_values
    ):
        stats = import_folder(folder, cfg)
    assert stats["inserted"] == 2
    assert stats["skipped_duplicate"] == 0


def test_filename_fallback_when_no_tags(cfg, tmp_path):
    """Files without readable tags use parent dir as artist and stem as title."""
    folder = tmp_path / "music" / "FallbackArtist"
    folder.mkdir(parents=True)
    _fake_audio(folder, "FallbackTitle.mp3")
    with patch("djtoolkit.importers.folder.calc_fingerprint", return_value=None):
        import_folder(folder, cfg)
    with connect(cfg.db_path) as conn:
        row = conn.execute("SELECT title, artist FROM tracks").fetchone()
    assert row["artist"] == "FallbackArtist"
    assert row["title"] == "FallbackTitle"


def test_tags_stored_in_db(cfg, tmp_path):
    """Tags returned by _read_tags are written into the DB."""
    folder = tmp_path / "music"
    folder.mkdir()
    _fake_audio(folder, "track.mp3")

    fake_tags = {
        "title": "My Track",
        "artist": "My Artist",
        "album": "My Album",
        "year": 2020,
        "genres": "Electronic",
    }
    with patch("djtoolkit.importers.folder._read_tags", return_value=fake_tags):
        with patch("djtoolkit.importers.folder.calc_fingerprint", return_value=None):
            stats = import_folder(folder, cfg)
    assert stats["inserted"] == 1
    with connect(cfg.db_path) as conn:
        row = conn.execute("SELECT title, artist, album, year FROM tracks").fetchone()
    assert row["title"] == "My Track"
    assert row["artist"] == "My Artist"
    assert row["album"] == "My Album"
    assert row["year"] == 2020


def test_inserted_track_has_available_status(cfg, tmp_path):
    folder = tmp_path / "music"
    folder.mkdir()
    _fake_audio(folder, "track.mp3")
    with patch("djtoolkit.importers.folder.calc_fingerprint", return_value=None):
        import_folder(folder, cfg)
    with connect(cfg.db_path) as conn:
        row = conn.execute("SELECT acquisition_status, source FROM tracks").fetchone()
    assert row["acquisition_status"] == "available"
    assert row["source"] == "folder"
