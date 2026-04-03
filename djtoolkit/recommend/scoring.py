"""Scoring functions for the recommendation engine."""

from __future__ import annotations

import numpy as np

# Feature order for vectors: [bpm_norm, energy, danceability, loudness_norm]
FEATURE_KEYS = ["tempo", "energy", "danceability", "loudness"]
_BPM_MIN, _BPM_RANGE = 60.0, 140.0
_LUFS_MIN, _LUFS_RANGE = -30.0, 30.0


def normalize_features(track: dict) -> np.ndarray:
    """Convert track features to a normalized [0,1] vector.

    Feature order: [bpm_norm, energy, danceability, loudness_norm].
    Missing/None values default to 0.5 (midpoint).
    """
    bpm = track.get("tempo")
    energy = track.get("energy")
    dance = track.get("danceability")
    loud = track.get("loudness")

    return np.array([
        np.clip((bpm - _BPM_MIN) / _BPM_RANGE, 0, 1) if bpm is not None else 0.5,
        energy if energy is not None else 0.5,
        dance if dance is not None else 0.5,
        np.clip((loud - _LUFS_MIN) / _LUFS_RANGE, 0, 1) if loud is not None else 0.5,
    ], dtype=np.float64)


def profile_fit_score(track: dict, profile: dict) -> float:
    """Score how well a track's features fit within a target profile's ranges.

    Returns 1.0 if all features are within range, decays linearly outside.
    """
    feature_map = {"bpm": "tempo", "energy": "energy", "danceability": "danceability", "loudness": "loudness"}
    scores = []

    for profile_key, track_key in feature_map.items():
        if profile_key not in profile:
            continue
        lo, hi = profile[profile_key]
        val = track.get(track_key)
        if val is None:
            scores.append(0.5)
            continue
        if lo <= val <= hi:
            scores.append(1.0)
        else:
            rng = hi - lo
            if rng == 0:
                rng = 1.0
            dist = min(abs(val - lo), abs(val - hi)) / rng
            scores.append(max(0.0, 1.0 - dist))

    return float(np.mean(scores)) if scores else 0.5


def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    """Cosine similarity between two vectors. Returns 0 if either is zero."""
    norm_a = np.linalg.norm(a)
    norm_b = np.linalg.norm(b)
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return float(np.dot(a, b) / (norm_a * norm_b))


def track_similarity(track_a: dict, track_b: dict) -> dict:
    """Compute multi-dimensional similarity between two tracks.

    Returns a dict with component scores and a combined weight.
    Components: feature (cosine on BPM/energy/dance/loud), harmonic, genre.
    Combined: 0.40 * feature + 0.35 * harmonic + 0.25 * genre
    """
    vec_a = normalize_features(track_a)
    vec_b = normalize_features(track_b)
    feat_sim = cosine_similarity(vec_a, vec_b)

    harm = harmonic_score(
        track_a.get("camelot", ""),
        track_b.get("camelot", ""),
    )

    # Genre overlap (symmetric Jaccard)
    genres_a = {g.strip().lower() for g in (track_a.get("genres") or "").split(",") if g.strip()}
    genres_b = {g.strip().lower() for g in (track_b.get("genres") or "").split(",") if g.strip()}
    union = genres_a | genres_b
    genre_sim = len(genres_a & genres_b) / len(union) if union else 0.0

    combined = 0.40 * feat_sim + 0.35 * harm + 0.25 * genre_sim

    return {
        "feature": round(feat_sim, 3),
        "harmonic": round(harm, 3),
        "genre": round(genre_sim, 3),
        "weight": round(combined, 3),
    }


def harmonic_score(camelot_a: str, camelot_b: str) -> float:
    """Score harmonic compatibility between two Camelot keys.

    1.0 = same key, 0.8 = adjacent, 0.4 = two steps, 0.0 = incompatible.
    """
    if not camelot_a or not camelot_b:
        return 0.5  # neutral if key unknown

    if camelot_a == camelot_b:
        return 1.0

    num_a, letter_a = _parse_camelot(camelot_a)
    num_b, letter_b = _parse_camelot(camelot_b)

    if num_a is None or num_b is None:
        return 0.5

    # Adjacent: same number different letter, or +/-1 same letter
    same_num_diff_letter = num_a == num_b and letter_a != letter_b
    adjacent_num_same_letter = letter_a == letter_b and _camelot_distance(num_a, num_b) == 1

    if same_num_diff_letter or adjacent_num_same_letter:
        return 0.8

    # Two steps away
    if letter_a == letter_b and _camelot_distance(num_a, num_b) == 2:
        return 0.4

    return 0.0


def genre_overlap(track_genres: str, seed_genres: list[str]) -> float:
    """Score genre overlap between a track and seed genre list."""
    if not track_genres or not seed_genres:
        return 0.0
    track_set = {g.strip().lower() for g in track_genres.split(",") if g.strip()}
    seed_set = {g.lower() for g in seed_genres}
    if not seed_set:
        return 0.0
    return len(track_set & seed_set) / len(seed_set)


def expansion_score(
    track_vector: np.ndarray,
    centroid: np.ndarray,
    track: dict,
    context_profile: dict,
    seed_genres: list[str],
    prev_camelot: str,
) -> float:
    """Compute the full expansion score for a candidate track.

    score = 0.40 * cosine_sim + 0.25 * profile_fit + 0.20 * harmonic + 0.15 * genre
    """
    cos_sim = cosine_similarity(track_vector, centroid)
    pfit = profile_fit_score(track, context_profile)
    harm = harmonic_score(track.get("camelot", ""), prev_camelot)
    genre = genre_overlap(track.get("genres", ""), seed_genres)

    return 0.40 * cos_sim + 0.25 * pfit + 0.20 * harm + 0.15 * genre


def _parse_camelot(code: str) -> tuple[int | None, str]:
    """Parse '8B' into (8, 'B')."""
    if not code:
        return None, ""
    letter = code[-1].upper()
    try:
        num = int(code[:-1])
        return num, letter
    except ValueError:
        return None, ""


def _camelot_distance(a: int, b: int) -> int:
    """Circular distance on the Camelot wheel (1-12)."""
    diff = abs(a - b)
    return min(diff, 12 - diff)
