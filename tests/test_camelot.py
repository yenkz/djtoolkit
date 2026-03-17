"""Tests for Camelot key module."""

from djtoolkit.models.camelot import (
    KEY_TO_CAMELOT,
    CAMELOT_TO_KEY,
    TRAKTOR_KEY_MAP,
    SPOTIFY_KEY_MAP,
    normalize_key,
    key_to_camelot,
    get_compatible_keys,
)


class TestTraktorKeyMap:
    def test_major_keys(self):
        assert TRAKTOR_KEY_MAP[0] == "C major"
        assert TRAKTOR_KEY_MAP[5] == "F major"
        assert TRAKTOR_KEY_MAP[11] == "B major"

    def test_minor_keys(self):
        assert TRAKTOR_KEY_MAP[12] == "C minor"
        assert TRAKTOR_KEY_MAP[17] == "F minor"
        assert TRAKTOR_KEY_MAP[23] == "B minor"

    def test_all_24_keys_present(self):
        assert len(TRAKTOR_KEY_MAP) == 24


class TestNormalizeKey:
    def test_traktor_integer(self):
        assert normalize_key("0", "traktor") == "C major"
        assert normalize_key("17", "traktor") == "F minor"

    def test_rekordbox_tonality(self):
        assert normalize_key("Cm", "rekordbox") == "C minor"
        assert normalize_key("Ab", "rekordbox") == "Ab major"
        assert normalize_key("F#m", "rekordbox") == "F# minor"
        assert normalize_key("Bbm", "rekordbox") == "Bb minor"

    def test_spotify_key_mode(self):
        # Spotify passes "key,mode" as two ints
        assert normalize_key("0,1", "spotify") == "C major"
        assert normalize_key("0,0", "spotify") == "C minor"
        assert normalize_key("9,1", "spotify") == "A major"

    def test_already_normalized(self):
        assert normalize_key("C minor", "any") == "C minor"
        assert normalize_key("Ab major", "any") == "Ab major"

    def test_empty_returns_empty(self):
        assert normalize_key("", "traktor") == ""
        assert normalize_key("", "rekordbox") == ""


class TestKeyToCamelot:
    def test_minor_keys(self):
        assert key_to_camelot("Ab minor") == "1A"
        assert key_to_camelot("C minor") == "5A"
        assert key_to_camelot("A minor") == "8A"

    def test_major_keys(self):
        assert key_to_camelot("B major") == "1B"
        assert key_to_camelot("C major") == "8B"
        assert key_to_camelot("A major") == "11B"

    def test_empty_returns_empty(self):
        assert key_to_camelot("") == ""

    def test_reverse_mapping(self):
        for key, camelot in KEY_TO_CAMELOT.items():
            assert CAMELOT_TO_KEY[camelot] == key


class TestGetCompatibleKeys:
    def test_same_key(self):
        result = get_compatible_keys("8A")
        assert "8A" in result["perfect"]

    def test_relative_major_minor(self):
        result = get_compatible_keys("8A")
        assert "8B" in result["harmonic"]

    def test_adjacent_keys(self):
        result = get_compatible_keys("8A")
        assert "9A" in result["harmonic"]
        assert "7A" in result["harmonic"]

    def test_wrapping_at_12(self):
        result = get_compatible_keys("12A")
        assert "1A" in result["harmonic"]  # 12 + 1 wraps to 1

    def test_wrapping_at_1(self):
        result = get_compatible_keys("1A")
        assert "12A" in result["harmonic"]  # 1 - 1 wraps to 12

    def test_energy_boost(self):
        result = get_compatible_keys("8A")
        assert "10A" in result["energy_boost"]  # +2
        assert "6A" in result["energy_boost"]   # -2
