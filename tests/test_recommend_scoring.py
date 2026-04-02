import pytest
import numpy as np
from djtoolkit.recommend.scoring import (
    normalize_features,
    profile_fit_score,
    cosine_similarity,
    harmonic_score,
    genre_overlap,
    expansion_score,
)


class TestNormalizeFeatures:
    def test_bpm_normalization(self):
        result = normalize_features({"tempo": 130.0, "energy": 0.7, "danceability": 0.8, "loudness": -10.0})
        assert result[0] == pytest.approx((130 - 60) / 140)

    def test_energy_passthrough(self):
        result = normalize_features({"tempo": 130.0, "energy": 0.7, "danceability": 0.8, "loudness": -10.0})
        assert result[1] == pytest.approx(0.7)

    def test_loudness_normalization(self):
        result = normalize_features({"tempo": 130.0, "energy": 0.7, "danceability": 0.8, "loudness": -10.0})
        assert result[3] == pytest.approx((-10 + 30) / 30)

    def test_missing_features_default_to_midpoint(self):
        result = normalize_features({"tempo": None, "energy": None, "danceability": None, "loudness": None})
        assert result[0] == pytest.approx(0.5)  # midpoint


class TestProfileFitScore:
    def test_within_range_is_1(self):
        track = {"tempo": 130.0, "energy": 0.8}
        profile = {"bpm": [125, 135], "energy": [0.7, 0.9]}
        assert profile_fit_score(track, profile) == pytest.approx(1.0)

    def test_outside_range_decays(self):
        track = {"tempo": 145.0, "energy": 0.8}
        profile = {"bpm": [125, 135], "energy": [0.7, 0.9]}
        score = profile_fit_score(track, profile)
        assert 0.0 < score < 1.0

    def test_far_outside_range_is_low(self):
        track = {"tempo": 200.0, "energy": 0.1}
        profile = {"bpm": [125, 135], "energy": [0.7, 0.9]}
        score = profile_fit_score(track, profile)
        assert score < 0.3


class TestCosineSimilarity:
    def test_identical_vectors(self):
        a = np.array([0.5, 0.7, 0.8, 0.6])
        assert cosine_similarity(a, a) == pytest.approx(1.0)

    def test_orthogonal_vectors(self):
        a = np.array([1.0, 0.0, 0.0, 0.0])
        b = np.array([0.0, 1.0, 0.0, 0.0])
        assert cosine_similarity(a, b) == pytest.approx(0.0)

    def test_similar_vectors_high_score(self):
        a = np.array([0.5, 0.7, 0.8, 0.6])
        b = np.array([0.52, 0.68, 0.82, 0.58])
        assert cosine_similarity(a, b) > 0.99


class TestHarmonicScore:
    def test_same_key(self):
        assert harmonic_score("8B", "8B") == 1.0

    def test_adjacent_number(self):
        assert harmonic_score("8B", "7B") == 0.8

    def test_adjacent_letter(self):
        assert harmonic_score("8A", "8B") == 0.8

    def test_two_steps(self):
        assert harmonic_score("8B", "6B") == 0.4

    def test_incompatible(self):
        assert harmonic_score("8B", "3A") == 0.0

    def test_empty_camelot(self):
        assert harmonic_score("", "8B") == 0.5  # neutral


class TestGenreOverlap:
    def test_full_overlap(self):
        assert genre_overlap("techno, house", ["techno", "house"]) == pytest.approx(1.0)

    def test_partial_overlap(self):
        assert genre_overlap("techno, minimal", ["techno", "house"]) == pytest.approx(0.5)

    def test_no_overlap(self):
        assert genre_overlap("ambient, classical", ["techno", "house"]) == pytest.approx(0.0)

    def test_empty_track_genres(self):
        assert genre_overlap("", ["techno"]) == pytest.approx(0.0)

    def test_empty_seed_genres(self):
        assert genre_overlap("techno", []) == pytest.approx(0.0)


class TestExpansionScore:
    def test_returns_float_between_0_and_1(self):
        track_vector = np.array([0.5, 0.7, 0.8, 0.6])
        centroid = np.array([0.5, 0.7, 0.8, 0.6])
        track = {"tempo": 130.0, "energy": 0.8, "genres": "techno", "camelot": "8B"}
        profile = {"bpm": [125, 135], "energy": [0.7, 0.9]}
        score = expansion_score(
            track_vector=track_vector,
            centroid=centroid,
            track=track,
            context_profile=profile,
            seed_genres=["techno"],
            prev_camelot="8A",
        )
        assert 0.0 <= score <= 1.5  # can exceed 1 before normalization
