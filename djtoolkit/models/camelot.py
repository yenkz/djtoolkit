"""Camelot Wheel key mappings and harmonic compatibility.

Handles key normalization from Traktor (int 0-23), Rekordbox (string "Cm"),
and Spotify (int key + int mode) into canonical "Note scale" format.
"""

PITCH_NAMES = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]

# Traktor MUSICAL_KEY integer → normalized key
TRAKTOR_KEY_MAP: dict[int, str] = {
    **{i: f"{PITCH_NAMES[i]} major" for i in range(12)},
    **{i + 12: f"{PITCH_NAMES[i]} minor" for i in range(12)},
}

# Spotify key (0-11 pitch class) + mode (1=major, 0=minor) → normalized key
SPOTIFY_KEY_MAP: dict[tuple[int, int], str] = {
    (k, m): f"{PITCH_NAMES[k]} {'major' if m == 1 else 'minor'}"
    for k in range(12)
    for m in (0, 1)
}

# Camelot Wheel: normalized key → Camelot code
KEY_TO_CAMELOT: dict[str, str] = {
    "Ab minor": "1A",  "Eb minor": "2A",  "Bb minor": "3A",
    "F minor":  "4A",  "C minor":  "5A",  "G minor":  "6A",
    "D minor":  "7A",  "A minor":  "8A",  "E minor":  "9A",
    "B minor":  "10A", "F# minor": "11A", "Db minor": "12A",
    "B major":  "1B",  "F# major": "2B",  "Db major": "3B",
    "Ab major": "4B",  "Eb major": "5B",  "Bb major": "6B",
    "F major":  "7B",  "C major":  "8B",  "G major":  "9B",
    "D major":  "10B", "A major":  "11B", "E major":  "12B",
}

CAMELOT_TO_KEY: dict[str, str] = {v: k for k, v in KEY_TO_CAMELOT.items()}


def normalize_key(raw: str, source: str) -> str:
    """Convert any key format to normalized 'Note scale' string.

    Args:
        raw: Key value in source-specific format.
        source: One of 'traktor', 'rekordbox', 'spotify', or 'any'.
    """
    if not raw:
        return ""

    # Already normalized
    if raw in KEY_TO_CAMELOT:
        return raw

    if source == "traktor":
        return TRAKTOR_KEY_MAP.get(int(raw), "")

    if source == "rekordbox":
        raw = raw.strip()
        if raw.endswith("m"):
            return f"{raw[:-1]} minor"
        return f"{raw} major"

    if source == "spotify":
        parts = raw.split(",")
        key_int, mode_int = int(parts[0]), int(parts[1])
        return SPOTIFY_KEY_MAP.get((key_int, mode_int), "")

    # Fallback: return as-is if already in "Note scale" format
    return raw


def key_to_camelot(key: str) -> str:
    """Convert normalized key to Camelot code. Returns '' if key is empty/unknown."""
    if not key:
        return ""
    return KEY_TO_CAMELOT.get(key, "")


def get_compatible_keys(camelot: str) -> dict[str, list[str]]:
    """Return harmonically compatible Camelot codes grouped by compatibility level.

    Returns dict with keys: 'perfect', 'harmonic', 'energy_boost'.
    """
    number = int(camelot[:-1])
    letter = camelot[-1]
    other_letter = "B" if letter == "A" else "A"

    def wrap(n: int) -> int:
        return ((n - 1) % 12) + 1

    return {
        "perfect": [camelot],
        "harmonic": [
            f"{number}{other_letter}",
            f"{wrap(number + 1)}{letter}",
            f"{wrap(number - 1)}{letter}",
        ],
        "energy_boost": [
            f"{wrap(number + 2)}{letter}",
            f"{wrap(number - 2)}{letter}",
            f"{wrap(number + 7)}{letter}",
            f"{wrap(number - 7)}{letter}",
        ],
    }
