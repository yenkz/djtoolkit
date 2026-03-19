"""Tests for the folder importer -- SupabaseAdapter-backed."""

from pathlib import Path
from unittest.mock import MagicMock, patch, call

import pytest

from djtoolkit.config import Config
from djtoolkit.importers.folder import import_folder

_FAKE_FP = {"fingerprint": "AAABBBCCC111", "duration": 240.0}
_DIFF_FP = {"fingerprint": "XXXYYYZZZXXX", "duration": 180.0}

USER_ID = "test-user-456"


@pytest.fixture
def cfg(tmp_path):
    c = Config()
    c.paths.library_dir = str(tmp_path / "library")
    c.fingerprint.enabled = False  # skip fpcalc availability check
    return c


def _fake_audio(directory: Path, name: str = "track.mp3") -> Path:
    """Create a minimal fake audio file (enough bytes to not be empty)."""
    path = directory / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"\xff\xfb\x90\x00" + b"\x00" * 512)
    return path


def _mock_adapter(*, fp_match=None, save_ids_gen=None):
    """Build a mock SupabaseAdapter.

    fp_match: either None (no match) or a track_id to return for all fingerprint lookups.
    save_ids_gen: an iterator yielding track_id lists for each save_tracks call.
                  If None, auto-generates sequential IDs starting at 1.
    """
    adapter = MagicMock()
    adapter.find_fingerprint_match.return_value = fp_match

    if save_ids_gen is not None:
        adapter.save_tracks.side_effect = lambda tracks, uid: {"imported": len(tracks), "track_ids": next(save_ids_gen)}
    else:
        _counter = iter(range(1, 1000))
        def _save(tracks, uid):
            ids = [next(_counter) for _ in tracks]
            return {"imported": len(tracks), "track_ids": ids}
        adapter.save_tracks.side_effect = _save

    adapter.update_track.return_value = None
    adapter.insert_fingerprint.return_value = 100  # default fingerprint ID
    adapter.mark_fingerprinted.return_value = None
    return adapter


def test_empty_folder(cfg, tmp_path):
    folder = tmp_path / "music"
    folder.mkdir()
    adapter = _mock_adapter()
    with patch("djtoolkit.importers.folder.calc_fingerprint", return_value=None):
        stats = import_folder(folder, cfg, adapter, USER_ID)
    assert stats == {"inserted": 0, "skipped_duplicate": 0, "skipped_no_audio": 0}


def test_non_audio_extensions_skipped(cfg, tmp_path):
    folder = tmp_path / "music"
    folder.mkdir()
    (folder / "cover.jpg").write_bytes(b"\xff\xd8\xff")
    (folder / "readme.txt").write_text("text")
    adapter = _mock_adapter()
    with patch("djtoolkit.importers.folder.calc_fingerprint", return_value=None):
        stats = import_folder(folder, cfg, adapter, USER_ID)
    assert stats["inserted"] == 0


def test_audio_files_inserted(cfg, tmp_path):
    folder = tmp_path / "music"
    folder.mkdir()
    _fake_audio(folder, "a.mp3")
    _fake_audio(folder, "b.flac")
    adapter = _mock_adapter()
    with patch("djtoolkit.importers.folder.calc_fingerprint", return_value=None):
        stats = import_folder(folder, cfg, adapter, USER_ID)
    assert stats["inserted"] == 2
    assert stats["skipped_duplicate"] == 0
    assert adapter.save_tracks.call_count == 2


def test_nested_subdirectories_scanned(cfg, tmp_path):
    folder = tmp_path / "music"
    sub = folder / "Artist" / "Album"
    sub.mkdir(parents=True)
    _fake_audio(sub, "track.flac")
    adapter = _mock_adapter()
    with patch("djtoolkit.importers.folder.calc_fingerprint", return_value=None):
        stats = import_folder(folder, cfg, adapter, USER_ID)
    assert stats["inserted"] == 1


def test_duplicate_fingerprint_skipped(cfg, tmp_path):
    """Two files with the same fingerprint: first inserted, second skipped via adapter."""
    folder = tmp_path / "music"
    folder.mkdir()
    _fake_audio(folder, "track1.mp3")
    _fake_audio(folder, "track2.mp3")

    adapter = _mock_adapter()
    # First call: no match. Second call: match found (first track was inserted).
    adapter.find_fingerprint_match.side_effect = [None, 1]

    with patch("djtoolkit.importers.folder.calc_fingerprint", return_value=_FAKE_FP):
        stats = import_folder(folder, cfg, adapter, USER_ID)
    assert stats["inserted"] == 1
    assert stats["skipped_duplicate"] == 1


def test_distinct_fingerprints_both_inserted(cfg, tmp_path):
    folder = tmp_path / "music"
    folder.mkdir()
    _fake_audio(folder, "track1.mp3")
    _fake_audio(folder, "track2.mp3")
    fp_values = iter([_FAKE_FP, _DIFF_FP])

    adapter = _mock_adapter()
    adapter.find_fingerprint_match.return_value = None  # no matches

    with patch("djtoolkit.importers.folder.calc_fingerprint", side_effect=fp_values):
        stats = import_folder(folder, cfg, adapter, USER_ID)
    assert stats["inserted"] == 2
    assert stats["skipped_duplicate"] == 0


def test_filename_fallback_when_no_tags(cfg, tmp_path):
    """Files without readable tags use parent dir as artist and stem as title."""
    folder = tmp_path / "music" / "FallbackArtist"
    folder.mkdir(parents=True)
    _fake_audio(folder, "FallbackTitle.mp3")

    adapter = _mock_adapter()
    with patch("djtoolkit.importers.folder.calc_fingerprint", return_value=None):
        import_folder(folder, cfg, adapter, USER_ID)

    # Check that save_tracks was called with a Track having correct artist/title
    assert adapter.save_tracks.call_count == 1
    saved_tracks = adapter.save_tracks.call_args[0][0]
    assert saved_tracks[0].artist == "FallbackArtist"
    assert saved_tracks[0].title == "FallbackTitle"


def test_tags_passed_to_track(cfg, tmp_path):
    """Tags returned by _read_tags are set on the Track object."""
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
    adapter = _mock_adapter()
    with patch("djtoolkit.importers.folder._read_tags", return_value=fake_tags):
        with patch("djtoolkit.importers.folder.calc_fingerprint", return_value=None):
            stats = import_folder(folder, cfg, adapter, USER_ID)
    assert stats["inserted"] == 1
    saved_tracks = adapter.save_tracks.call_args[0][0]
    track = saved_tracks[0]
    assert track.title == "My Track"
    assert track.artist == "My Artist"
    assert track.album == "My Album"
    assert track.year == 2020


def test_inserted_track_set_to_available(cfg, tmp_path):
    """After save_tracks, acquisition_status is set to 'available'."""
    folder = tmp_path / "music"
    folder.mkdir()
    _fake_audio(folder, "track.mp3")

    adapter = _mock_adapter()
    with patch("djtoolkit.importers.folder.calc_fingerprint", return_value=None):
        import_folder(folder, cfg, adapter, USER_ID)

    # update_track should have been called with acquisition_status='available'
    adapter.update_track.assert_called_once()
    update_args = adapter.update_track.call_args[0]
    assert update_args[1]["acquisition_status"] == "available"


def test_fingerprint_stored_via_adapter(cfg, tmp_path):
    """When fingerprint data is available, insert_fingerprint and mark_fingerprinted are called."""
    folder = tmp_path / "music"
    folder.mkdir()
    _fake_audio(folder, "track.mp3")

    adapter = _mock_adapter()
    adapter.find_fingerprint_match.return_value = None
    adapter.insert_fingerprint.return_value = 42

    with patch("djtoolkit.importers.folder.calc_fingerprint", return_value=_FAKE_FP):
        stats = import_folder(folder, cfg, adapter, USER_ID)

    assert stats["inserted"] == 1
    adapter.insert_fingerprint.assert_called_once_with(
        user_id=USER_ID,
        track_id=1,  # first auto-generated ID
        fingerprint="AAABBBCCC111",
        acoustid=None,
        duration=240.0,
    )
    adapter.mark_fingerprinted.assert_called_once_with(1, {"fingerprint_id": 42})


def test_source_id_set_to_file_path(cfg, tmp_path):
    """Track.source_id is set to the file path to prevent duplicate imports."""
    folder = tmp_path / "music"
    folder.mkdir()
    audio_path = _fake_audio(folder, "track.mp3")

    adapter = _mock_adapter()
    with patch("djtoolkit.importers.folder.calc_fingerprint", return_value=None):
        import_folder(folder, cfg, adapter, USER_ID)

    saved_tracks = adapter.save_tracks.call_args[0][0]
    assert saved_tracks[0].source_id == str(audio_path)
    assert saved_tracks[0].source == "folder"


def test_save_tracks_empty_ids_counts_as_duplicate(cfg, tmp_path):
    """When save_tracks returns empty track_ids (upsert conflict), count as duplicate."""
    folder = tmp_path / "music"
    folder.mkdir()
    _fake_audio(folder, "track.mp3")

    adapter = _mock_adapter(save_ids_gen=iter([[]]))
    with patch("djtoolkit.importers.folder.calc_fingerprint", return_value=None):
        stats = import_folder(folder, cfg, adapter, USER_ID)

    assert stats["inserted"] == 0
    assert stats["skipped_duplicate"] == 1
