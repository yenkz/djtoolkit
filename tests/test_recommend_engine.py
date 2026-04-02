import pytest
import numpy as np
from djtoolkit.recommend.engine import RecommendationEngine


def _make_track(id: int, tempo: float, energy: float, dance: float,
                loudness: float, camelot: str, genres: str, enriched: bool = True) -> dict:
    return {
        "id": id, "tempo": tempo, "energy": energy, "danceability": dance,
        "loudness": loudness, "camelot": camelot, "genres": genres,
        "enriched_audio": enriched, "title": f"Track {id}", "artist": f"Artist {id}",
    }


@pytest.fixture
def library():
    return [
        _make_track(1, 128.0, 0.75, 0.80, -8.0, "8B", "techno, minimal"),
        _make_track(2, 130.0, 0.82, 0.78, -7.0, "9A", "techno"),
        _make_track(3, 124.0, 0.60, 0.85, -10.0, "7B", "house, deep house"),
        _make_track(4, 132.0, 0.90, 0.70, -6.0, "8A", "techno, industrial"),
        _make_track(5, 126.0, 0.55, 0.82, -12.0, "6B", "house"),
        _make_track(6, 140.0, 0.95, 0.65, -5.0, "10A", "hard techno"),
        _make_track(7, 120.0, 0.40, 0.90, -14.0, "5A", "deep house"),
        _make_track(8, 135.0, 0.88, 0.72, -6.5, "9B", "techno"),
        _make_track(9, 122.0, 0.50, 0.88, -11.0, "6A", "house, disco"),
        _make_track(10, 128.0, 0.70, 0.80, -9.0, "8B", "minimal"),
        _make_track(11, 130.0, 0.65, 0.75, -10.0, "7A", "progressive"),
        _make_track(12, 125.0, 0.45, 0.85, -13.0, "5B", "deep house"),
        # Unanalyzed track
        _make_track(99, 0.0, 0.0, 0.0, 0.0, "", "", enriched=False),
    ]


@pytest.fixture
def engine():
    return RecommendationEngine()


class TestGenerateSeeds:
    def test_returns_up_to_10_seeds(self, engine, library):
        profile = {"bpm": [125, 135], "energy": [0.6, 0.9], "genres": ["techno"]}
        seeds = engine.generate_seeds(library, profile)
        assert len(seeds) <= 10

    def test_excludes_unanalyzed(self, engine, library):
        profile = {"bpm": [125, 135], "energy": [0.6, 0.9]}
        seeds = engine.generate_seeds(library, profile)
        seed_ids = [s["id"] for s in seeds]
        assert 99 not in seed_ids

    def test_returns_unanalyzed_count(self, engine, library):
        profile = {"bpm": [125, 135], "energy": [0.6, 0.9]}
        seeds, unanalyzed = engine.generate_seeds(library, profile, return_unanalyzed_count=True)
        assert unanalyzed == 1

    def test_best_matches_score_highest(self, engine, library):
        profile = {"bpm": [127, 132], "energy": [0.7, 0.85], "genres": ["techno"]}
        seeds = engine.generate_seeds(library, profile)
        # Track 1 (128 bpm, 0.75 energy, techno) should be top
        assert seeds[0]["id"] == 1


class TestExpand:
    def test_returns_up_to_100_tracks(self, engine, library):
        profile = {"bpm": [125, 135], "energy": [0.6, 0.9]}
        feedback = [
            {"track_id": 1, "liked": True, "position": 1},
            {"track_id": 2, "liked": True, "position": 2},
            {"track_id": 3, "liked": False, "position": 3},
        ]
        result = engine.expand(library, profile, feedback)
        assert len(result["tracks"]) <= 100

    def test_excludes_disliked_seeds(self, engine, library):
        profile = {"bpm": [125, 135], "energy": [0.6, 0.9]}
        feedback = [
            {"track_id": 1, "liked": True, "position": 1},
            {"track_id": 3, "liked": False, "position": 2},
        ]
        result = engine.expand(library, profile, feedback)
        track_ids = [t["id"] for t in result["tracks"]]
        assert 3 not in track_ids

    def test_returns_similarity_edges(self, engine, library):
        profile = {"bpm": [125, 135], "energy": [0.6, 0.9]}
        feedback = [{"track_id": 1, "liked": True, "position": 1}]
        result = engine.expand(library, profile, feedback)
        assert "similarity_edges" in result
        for edge in result["similarity_edges"]:
            assert "source" in edge
            assert "target" in edge
            assert "weight" in edge


class TestEnergyArcOrdering:
    def test_warmup_ascending(self, engine):
        tracks = [
            {"id": 1, "energy": 0.8},
            {"id": 2, "energy": 0.3},
            {"id": 3, "energy": 0.5},
        ]
        ordered = engine.order_by_energy_arc(tracks, "warmup")
        energies = [t["energy"] for t in ordered]
        assert energies == sorted(energies)

    def test_headliner_peaks_in_middle(self, engine):
        tracks = [
            {"id": i, "energy": e}
            for i, e in enumerate([0.3, 0.5, 0.7, 0.9, 0.8, 0.6, 0.4])
        ]
        ordered = engine.order_by_energy_arc(tracks, "headliner")
        energies = [t["energy"] for t in ordered]
        peak_idx = energies.index(max(energies))
        # Peak should be roughly in the middle-to-upper portion
        assert len(energies) // 3 <= peak_idx <= 2 * len(energies) // 3 + 1
