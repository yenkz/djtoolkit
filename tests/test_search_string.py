"""Tests for search_string utility."""

from djtoolkit.utils.search_string import build


def test_single_artist():
    assert build("Big Wild", "City of Sound") == "big wild city of sound"


def test_multi_artist_uses_first():
    result = build("Fred Falke;Elohim;Oliver", "It's A Memory - Oliver Remix")
    assert result.startswith("fred falke")
    assert "oliver remix" in result


def test_strips_feat():
    result = build("Tensnake feat. Nile Rodgers", "Love Sublime")
    assert "feat" not in result
    assert "tensnake" in result


def test_strips_special_chars():
    result = build("Artist", "Track (Original Mix)")
    # parenthetical should be stripped
    assert "(" not in result
    assert ")" not in result


def test_empty_inputs():
    assert build("", "") == ""
    assert build("Artist", "") == "artist"
    assert build("", "Title") == "title"
