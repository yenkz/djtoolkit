"""Tests for library/mover.py."""

import pytest

from djtoolkit.config import Config
from djtoolkit.db.database import connect, setup
from djtoolkit.library.mover import run


@pytest.fixture
def cfg(tmp_path):
    c = Config()
    c.db.path = str(tmp_path / "test.db")
    c.paths.library_dir = str(tmp_path / "library")
    setup(c.db_path)
    return c


def _insert_track(db_path, *, local_path, metadata_written=1, in_library=0, fingerprint=None):
    """Insert a minimal available track and optional fingerprint into the DB."""
    with connect(db_path) as conn:
        cursor = conn.execute(
            """INSERT INTO tracks
               (acquisition_status, source, title, artist, local_path, metadata_written, in_library)
               VALUES ('available', 'folder', 'Track', 'Artist', ?, ?, ?)""",
            (str(local_path), metadata_written, in_library),
        )
        track_id = cursor.lastrowid
        if fingerprint:
            fp_cursor = conn.execute(
                "INSERT INTO fingerprints (track_id, fingerprint, duration) VALUES (?, ?, 240.0)",
                (track_id, fingerprint),
            )
            conn.execute(
                "UPDATE tracks SET fingerprint_id = ?, fingerprinted = 1 WHERE id = ?",
                (fp_cursor.lastrowid, track_id),
            )
        conn.commit()
    return track_id


def test_moves_file_to_library(cfg, tmp_path):
    src = tmp_path / "track.flac"
    src.write_bytes(b"\x00" * 100)
    _insert_track(cfg.db_path, local_path=src)

    stats = run(cfg)

    assert stats["moved"] == 1
    assert stats["failed"] == 0
    assert not src.exists()
    library_dir = cfg.library_dir
    assert any(library_dir.iterdir())


def test_updates_local_path_and_in_library(cfg, tmp_path):
    src = tmp_path / "track.flac"
    src.write_bytes(b"\x00" * 100)
    track_id = _insert_track(cfg.db_path, local_path=src)

    run(cfg)

    with connect(cfg.db_path) as conn:
        row = conn.execute(
            "SELECT local_path, in_library FROM tracks WHERE id = ?", (track_id,)
        ).fetchone()
    assert row["in_library"] == 1
    assert row["local_path"] != str(src)  # path updated to library location


def test_mode_metadata_applied_skips_unwritten(cfg, tmp_path):
    """Default mode skips tracks without metadata_written=1."""
    src = tmp_path / "track.flac"
    src.write_bytes(b"\x00" * 100)
    _insert_track(cfg.db_path, local_path=src, metadata_written=0)

    stats = run(cfg, mode="metadata_applied")

    assert stats["moved"] == 0
    assert src.exists()  # file not moved


def test_mode_imported_moves_regardless_of_metadata(cfg, tmp_path):
    """'imported' mode moves tracks even without metadata_written=1."""
    src = tmp_path / "track.flac"
    src.write_bytes(b"\x00" * 100)
    _insert_track(cfg.db_path, local_path=src, metadata_written=0)

    stats = run(cfg, mode="imported")

    assert stats["moved"] == 1


def test_missing_source_file_skipped(cfg, tmp_path):
    _insert_track(cfg.db_path, local_path=tmp_path / "ghost.flac")

    stats = run(cfg)

    assert stats["skipped"] == 1
    assert stats["moved"] == 0


def test_library_duplicate_not_moved(cfg, tmp_path):
    """Track whose fingerprint already exists in library is marked duplicate."""
    # First: an in-library track with a fingerprint
    existing_src = tmp_path / "existing.flac"
    existing_src.write_bytes(b"\x00" * 100)
    existing_id = _insert_track(
        cfg.db_path, local_path=existing_src, fingerprint="SAME_FP"
    )
    with connect(cfg.db_path) as conn:
        conn.execute(
            "UPDATE tracks SET in_library = 1 WHERE id = ?", (existing_id,)
        )
        conn.commit()

    # Second: a new track with the same fingerprint
    new_src = tmp_path / "duplicate.flac"
    new_src.write_bytes(b"\x00" * 100)
    _insert_track(cfg.db_path, local_path=new_src, fingerprint="SAME_FP")

    stats = run(cfg, mode="imported")

    assert stats["duplicates"] == 1
    assert stats["moved"] == 0


def test_invalid_mode_raises():
    cfg = Config()
    with pytest.raises(ValueError, match="mode must be"):
        run(cfg, mode="invalid_mode")


def test_library_dir_created_if_missing(cfg, tmp_path):
    src = tmp_path / "track.mp3"
    src.write_bytes(b"\x00" * 100)
    _insert_track(cfg.db_path, local_path=src)

    assert not cfg.library_dir.exists()
    run(cfg)
    assert cfg.library_dir.exists()
