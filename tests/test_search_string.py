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


def test_strips_vs():
    result = build("Artist vs. Another", "Title")
    assert "vs" not in result
    assert "another" not in result
    assert "artist" in result


def test_strips_x_feat():
    result = build("Artist x Featured", "Title")
    assert "featured" not in result
    assert "artist" in result


def test_unicode_survives():
    # Should not raise; result is lowercase
    result = build("Björk", "Jóga")
    assert result == result.lower()


def test_consecutive_spaces_collapsed():
    result = build("Big   Wild", "City   of   Sound")
    assert "  " not in result


def test_result_is_lowercase():
    result = build("ARTIST", "TITLE")
    assert result == result.lower()
