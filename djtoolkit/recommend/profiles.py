"""Profile merging and lineup modifiers for the recommendation engine."""

from __future__ import annotations

LINEUP_MODIFIERS: dict[str, dict] = {
    "warmup": {"energy_multiplier": 0.6, "bpm_shift": -5},
    "middle": {"energy_multiplier": 0.85, "bpm_shift": 0},
    "headliner": {"energy_multiplier": 1.1, "bpm_shift": 5},
}

_RANGE_FEATURES = {"bpm", "energy", "danceability", "loudness"}


def merge_profiles(
    venue_profile: dict | None,
    mood_profile: dict | None,
) -> dict:
    """Merge venue and mood target profiles.

    Numeric ranges are intersected if overlapping, otherwise midpoint ±5.
    List fields (genres, mood_tags) are unioned.
    """
    if venue_profile is None and mood_profile is None:
        raise ValueError("At least one profile (venue or mood) is required")

    if venue_profile is None:
        return dict(mood_profile)
    if mood_profile is None:
        return dict(venue_profile)

    merged: dict = {}
    all_keys = set(venue_profile) | set(mood_profile)

    for key in all_keys:
        v = venue_profile.get(key)
        m = mood_profile.get(key)

        if v is None:
            merged[key] = m
        elif m is None:
            merged[key] = v
        elif key in _RANGE_FEATURES and isinstance(v, list) and isinstance(m, list):
            merged[key] = _merge_ranges(v, m)
        elif isinstance(v, list) and isinstance(m, list):
            # List fields like genres — union
            merged[key] = list(set(v) | set(m))
        else:
            merged[key] = v  # venue takes precedence for non-range scalars

    return merged


def _merge_ranges(a: list[float], b: list[float]) -> list[float]:
    """Intersect two [min, max] ranges. If non-overlapping, use midpoint ±5."""
    lo = max(a[0], b[0])
    hi = min(a[1], b[1])
    if lo <= hi:
        return [lo, hi]
    # Non-overlapping: midpoint between the gap
    midpoint = (min(a[1], b[1]) + max(a[0], b[0])) / 2
    return [midpoint - 5, midpoint + 5]


def apply_lineup_modifier(profile: dict, lineup_position: str) -> dict:
    """Apply lineup position modifier to a target profile."""
    mod = LINEUP_MODIFIERS[lineup_position]
    result = dict(profile)

    if "energy" in result:
        lo, hi = result["energy"]
        mult = mod["energy_multiplier"]
        result["energy"] = [
            min(max(lo * mult, 0.0), 1.0),
            min(max(hi * mult, 0.0), 1.0),
        ]

    if "bpm" in result:
        shift = mod["bpm_shift"]
        lo, hi = result["bpm"]
        result["bpm"] = [lo + shift, hi + shift]

    if "danceability" in result:
        lo, hi = result["danceability"]
        mult = mod["energy_multiplier"]
        result["danceability"] = [
            min(max(lo * mult, 0.0), 1.0),
            min(max(hi * mult, 0.0), 1.0),
        ]

    return result


def build_context_profile(
    venue_profile: dict | None,
    mood_profile: dict | None,
    lineup_position: str,
) -> dict:
    """Merge profiles and apply lineup modifier. Returns the final context profile."""
    merged = merge_profiles(venue_profile, mood_profile)
    return apply_lineup_modifier(merged, lineup_position)
