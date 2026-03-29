# tests/test_browse_folder.py
"""Tests for browse_folder agent command."""

import pytest
from pathlib import Path


@pytest.fixture
def audio_folder(tmp_path: Path) -> Path:
    """Create a temp folder with audio files and subdirectories."""
    sub = tmp_path / "Techno"
    sub.mkdir()
    (tmp_path / "track1.mp3").write_bytes(b"\x00" * 1024)
    (tmp_path / "track2.flac").write_bytes(b"\x00" * 2048)
    (tmp_path / "readme.txt").write_bytes(b"not audio")
    (tmp_path / ".hidden.mp3").write_bytes(b"\x00" * 512)
    (sub / "deep.wav").write_bytes(b"\x00" * 4096)
    return tmp_path


def test_browse_lists_audio_and_dirs(audio_folder: Path):
    from djtoolkit.agent.commands.browse_folder import browse_folder

    result = browse_folder({"path": str(audio_folder)})

    assert result["path"] == str(audio_folder)
    assert result["parent"] == str(audio_folder.parent)

    names = [e["name"] for e in result["entries"]]
    # Dirs first, then audio files. No hidden files, no .txt
    assert "Techno" in names
    assert "track1.mp3" in names
    assert "track2.flac" in names
    assert "readme.txt" not in names
    assert ".hidden.mp3" not in names

    # Dirs listed before files
    types = [e["type"] for e in result["entries"]]
    dir_idx = types.index("dir")
    file_indices = [i for i, t in enumerate(types) if t == "file"]
    assert all(dir_idx < fi for fi in file_indices)


def test_browse_empty_dir(tmp_path: Path):
    from djtoolkit.agent.commands.browse_folder import browse_folder

    result = browse_folder({"path": str(tmp_path)})
    assert result["entries"] == []


def test_browse_default_path():
    from djtoolkit.agent.commands.browse_folder import browse_folder

    result = browse_folder({})
    assert result["path"] == str(Path.home())


def test_browse_nonexistent_path():
    from djtoolkit.agent.commands.browse_folder import browse_folder

    with pytest.raises(ValueError, match="Not a directory"):
        browse_folder({"path": "/nonexistent/path/xyz"})


def test_browse_file_entry_has_size(audio_folder: Path):
    from djtoolkit.agent.commands.browse_folder import browse_folder

    result = browse_folder({"path": str(audio_folder)})
    file_entries = [e for e in result["entries"] if e["type"] == "file"]
    for entry in file_entries:
        assert isinstance(entry["size_bytes"], int)
        assert entry["size_bytes"] > 0
        assert entry["extension"] in {".mp3", ".flac"}
