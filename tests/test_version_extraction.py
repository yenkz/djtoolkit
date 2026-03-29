# tests/test_version_extraction.py
"""Tests for version extraction and filename normalization."""

import pytest


@pytest.fixture(autouse=True)
def _import():
    """Pre-import to make test collection faster."""
    global _extract_version, _target_filename
    from djtoolkit.metadata.writer import _extract_version, _target_filename


def test_parenthetical_remix():
    from djtoolkit.metadata.writer import _extract_version
    base, version = _extract_version("Midnight City (Eric Prydz Remix)")
    assert base == "Midnight City"
    assert version == "Eric Prydz Remix"


def test_parenthetical_radio_edit():
    from djtoolkit.metadata.writer import _extract_version
    base, version = _extract_version("Latch (Radio Edit)")
    assert base == "Latch"
    assert version == "Radio Edit"


def test_bracketed_version():
    from djtoolkit.metadata.writer import _extract_version
    base, version = _extract_version("Song [Club Mix]")
    assert base == "Song"
    assert version == "Club Mix"


def test_dash_separated_remix():
    from djtoolkit.metadata.writer import _extract_version
    base, version = _extract_version("It's A Memory - Oliver Remix")
    assert base == "It's A Memory"
    assert version == "Oliver Remix"


def test_no_version():
    from djtoolkit.metadata.writer import _extract_version
    base, version = _extract_version("Blue Monday")
    assert base == "Blue Monday"
    assert version is None


def test_original_mix_stripped():
    from djtoolkit.metadata.writer import _extract_version
    base, version = _extract_version("Levels (Original Mix)")
    assert base == "Levels"
    assert version is None


def test_original_version_stripped():
    from djtoolkit.metadata.writer import _extract_version
    base, version = _extract_version("Track (Original Version)")
    assert base == "Track"
    assert version is None


def test_non_version_parenthetical_kept():
    from djtoolkit.metadata.writer import _extract_version
    base, version = _extract_version("Song (feat. Artist)")
    assert base == "Song (feat. Artist)"
    assert version is None


def test_extended_mix():
    from djtoolkit.metadata.writer import _extract_version
    base, version = _extract_version("Strobe (Extended Mix)")
    assert base == "Strobe"
    assert version == "Extended Mix"


def test_target_filename_with_version():
    from djtoolkit.metadata.writer import _target_filename
    result = _target_filename("Disclosure", "Latch (Radio Edit)", ".mp3")
    assert result == "Disclosure - Latch (Radio Edit).mp3"


def test_target_filename_without_version():
    from djtoolkit.metadata.writer import _target_filename
    result = _target_filename("New Order", "Blue Monday", ".flac")
    assert result == "New Order - Blue Monday.flac"


def test_target_filename_dash_remix_normalized():
    from djtoolkit.metadata.writer import _target_filename
    result = _target_filename("Fred Falke", "It's A Memory - Oliver Remix", ".mp3")
    assert result == "Fred Falke - It's A Memory (Oliver Remix).mp3"


def test_target_filename_original_mix_dropped():
    from djtoolkit.metadata.writer import _target_filename
    result = _target_filename("Avicii", "Levels (Original Mix)", ".mp3")
    assert result == "Avicii - Levels.mp3"
