"""Tests for library/mover.py — SupabaseAdapter-backed."""

from pathlib import Path
from unittest.mock import MagicMock

import pytest

from djtoolkit.config import Config
from djtoolkit.library.mover import run
from djtoolkit.models.track import Track

USER_ID = "test-user-123"


@pytest.fixture
def cfg(tmp_path):
    c = Config()
    c.paths.library_dir = str(tmp_path / "library")
    return c


def _make_track(tmp_path, name="track.flac", *, track_id=1, file_exists=True):
    """Create a Track object and optionally a matching file on disk."""
    src = tmp_path / name
    if file_exists:
        src.write_bytes(b"\x00" * 100)
    track = Track(title="Track", artist="Artist", file_path=str(src), source="folder")
    track._id = track_id
    return track


def _mock_adapter(tracks=None, dupe_map=None):
    """Build a mock SupabaseAdapter with configurable return values."""
    adapter = MagicMock()
    adapter.query_ready_for_library.return_value = tracks or []
    adapter.load_tracks.return_value = tracks or []
    adapter.find_library_duplicate.side_effect = lambda tid, uid: (dupe_map or {}).get(tid)
    adapter.mark_duplicate.return_value = None
    adapter.mark_in_library.return_value = None
    return adapter


def test_moves_file_to_library(cfg, tmp_path):
    track = _make_track(tmp_path, track_id=1)
    src = Path(track.file_path)
    adapter = _mock_adapter(tracks=[track])

    stats = run(cfg, adapter, USER_ID)

    assert stats["moved"] == 1
    assert stats["failed"] == 0
    assert not src.exists()
    library_dir = Path(cfg.library_dir).expanduser().resolve()
    assert any(library_dir.iterdir())


def test_updates_local_path_via_adapter(cfg, tmp_path):
    track = _make_track(tmp_path, track_id=42)
    adapter = _mock_adapter(tracks=[track])

    run(cfg, adapter, USER_ID)

    adapter.mark_in_library.assert_called_once()
    call_args = adapter.mark_in_library.call_args
    assert call_args[0][0] == 42  # track_id
    new_path = call_args[0][1]
    library_dir = Path(cfg.library_dir).expanduser().resolve()
    assert new_path.startswith(str(library_dir))


def test_mode_metadata_applied_uses_query_ready(cfg, tmp_path):
    track = _make_track(tmp_path, track_id=1)
    adapter = _mock_adapter(tracks=[track])

    run(cfg, adapter, USER_ID, mode="metadata_applied")

    adapter.query_ready_for_library.assert_called_once_with(USER_ID)
    adapter.load_tracks.assert_not_called()


def test_mode_imported_uses_load_tracks(cfg, tmp_path):
    track = _make_track(tmp_path, track_id=1)
    adapter = _mock_adapter(tracks=[track])

    run(cfg, adapter, USER_ID, mode="imported")

    adapter.load_tracks.assert_called_once_with(
        USER_ID, {"acquisition_status": "available", "in_library": False}
    )
    adapter.query_ready_for_library.assert_not_called()


def test_missing_source_file_skipped(cfg, tmp_path):
    track = _make_track(tmp_path, "ghost.flac", track_id=1, file_exists=False)
    adapter = _mock_adapter(tracks=[track])

    stats = run(cfg, adapter, USER_ID)

    assert stats["skipped"] == 1
    assert stats["moved"] == 0
    adapter.mark_in_library.assert_not_called()


def test_library_duplicate_not_moved(cfg, tmp_path):
    track = _make_track(tmp_path, "duplicate.flac", track_id=10)
    adapter = _mock_adapter(tracks=[track], dupe_map={10: 99})

    stats = run(cfg, adapter, USER_ID)

    assert stats["duplicates"] == 1
    assert stats["moved"] == 0
    adapter.mark_duplicate.assert_called_once_with(10)
    adapter.mark_in_library.assert_not_called()
    # Source file should still exist (not moved)
    assert Path(track.file_path).exists()


def test_invalid_mode_raises(cfg):
    adapter = _mock_adapter()
    with pytest.raises(ValueError, match="mode must be"):
        run(cfg, adapter, USER_ID, mode="invalid_mode")


def test_library_dir_created_if_missing(cfg, tmp_path):
    track = _make_track(tmp_path, track_id=1)
    adapter = _mock_adapter(tracks=[track])
    library_dir = Path(cfg.library_dir).expanduser().resolve()

    assert not library_dir.exists()
    run(cfg, adapter, USER_ID)
    assert library_dir.exists()


def test_none_file_path_skipped(cfg, tmp_path):
    """Track with file_path=None is skipped."""
    track = Track(title="Track", artist="Artist", file_path=None, source="folder")
    track._id = 1
    adapter = _mock_adapter(tracks=[track])

    stats = run(cfg, adapter, USER_ID)

    assert stats["skipped"] == 1
    assert stats["moved"] == 0


def test_collision_appends_track_id(cfg, tmp_path):
    """When dest already exists, file is saved with track_id appended."""
    track = _make_track(tmp_path, "track.flac", track_id=7)
    library_dir = Path(cfg.library_dir).expanduser().resolve()
    library_dir.mkdir(parents=True, exist_ok=True)
    # Pre-create a file in library with the same name
    (library_dir / "track.flac").write_bytes(b"\xff" * 50)

    adapter = _mock_adapter(tracks=[track])

    stats = run(cfg, adapter, USER_ID)

    assert stats["moved"] == 1
    expected_dest = library_dir / "track_7.flac"
    assert expected_dest.exists()
