"""Core recommendation engine — seed generation, expansion, refinement."""

from __future__ import annotations

import numpy as np
from djtoolkit.recommend.scoring import (
    normalize_features,
    profile_fit_score,
    cosine_similarity,
    expansion_score,
    genre_overlap,
)


class RecommendationEngine:
    """Two-phase recommendation engine: profile matching → seed similarity."""

    def __init__(self, similarity_threshold: float = 0.5):
        self._similarity_threshold = similarity_threshold

    def generate_seeds(
        self,
        library: list[dict],
        context_profile: dict,
        max_seeds: int = 10,
        return_unanalyzed_count: bool = False,
    ) -> list[dict] | tuple[list[dict], int]:
        """Phase 1: Score all tracks against context profile, return top N as seeds."""
        analyzed = [t for t in library if t.get("enriched_audio", False)]
        unanalyzed_count = len(library) - len(analyzed)

        profile_genres = context_profile.get("genres", [])

        scored: list[tuple[float, dict]] = []
        for track in analyzed:
            fit = profile_fit_score(track, context_profile)
            genre = genre_overlap(track.get("genres", ""), profile_genres) if profile_genres else 0.0
            score = 0.6 * fit + 0.4 * genre
            scored.append((score, track))

        scored.sort(key=lambda x: x[0], reverse=True)
        seeds = [t for _, t in scored[:max_seeds]]

        if return_unanalyzed_count:
            return seeds, unanalyzed_count
        return seeds

    def expand(
        self,
        library: list[dict],
        context_profile: dict,
        seed_feedback: list[dict],
        max_results: int = 100,
    ) -> dict:
        """Phase 2: Expand from liked seeds using similarity + context scoring."""
        liked = [f for f in seed_feedback if f.get("liked", False)]
        disliked_ids = {f["track_id"] for f in seed_feedback if not f.get("liked", True)}
        seed_ids = {f["track_id"] for f in seed_feedback}

        if not liked:
            return {"tracks": [], "similarity_edges": [], "energy_arc": "build"}

        # Build weighted centroid from liked seeds
        analyzed = [t for t in library if t.get("enriched_audio", False)]
        track_map = {t["id"]: t for t in analyzed}

        centroid, seed_genres = self._build_centroid(liked, track_map)

        # Score all candidates
        candidates = [
            t for t in analyzed
            if t["id"] not in disliked_ids and t["id"] not in seed_ids
        ]

        # Get first liked seed's camelot for harmonic scoring
        first_liked_track = track_map.get(liked[0]["track_id"], {})
        first_camelot = first_liked_track.get("camelot", "")

        scored: list[tuple[float, dict]] = []
        for track in candidates:
            vec = normalize_features(track)
            score = expansion_score(
                track_vector=vec,
                centroid=centroid,
                track=track,
                context_profile=context_profile,
                seed_genres=seed_genres,
                prev_camelot=first_camelot,
            )
            scored.append((score, track))

        scored.sort(key=lambda x: x[0], reverse=True)
        result_tracks = [t for _, t in scored[:max_results]]

        # Compute similarity edges
        edges = self._compute_similarity_edges(result_tracks)

        return {
            "tracks": result_tracks,
            "similarity_edges": edges,
            "energy_arc": "build",
        }

    def refine(
        self,
        library: list[dict],
        context_profile: dict,
        original_feedback: list[dict],
        new_feedback: list[dict],
    ) -> dict:
        """Iterative refinement: merge new feedback with original, re-expand."""
        merged = list(original_feedback)
        for fb in new_feedback:
            fb_copy = dict(fb)
            fb_copy["position"] = len(merged) + 1
            merged.append(fb_copy)
        return self.expand(library, context_profile, merged)

    def order_by_energy_arc(self, tracks: list[dict], lineup_position: str) -> list[dict]:
        """Reorder tracks to create a natural energy progression."""
        if not tracks:
            return tracks

        sorted_by_energy = sorted(tracks, key=lambda t: t.get("energy", 0.5))

        if lineup_position == "warmup":
            return sorted_by_energy

        if lineup_position == "middle":
            return sorted_by_energy

        # Headliner: build → peak → cool down
        n = len(sorted_by_energy)
        peak_point = int(n * 0.6)
        build = sorted_by_energy[:peak_point]
        cooldown = list(reversed(sorted_by_energy[peak_point:]))
        return build + cooldown

    def _build_centroid(
        self, liked: list[dict], track_map: dict[int, dict]
    ) -> tuple[np.ndarray, list[str]]:
        """Build weighted centroid from liked seed tracks."""
        vectors: list[np.ndarray] = []
        weights: list[float] = []
        all_genres: list[str] = []
        num_liked = len(liked)

        for fb in liked:
            track = track_map.get(fb["track_id"])
            if track is None:
                continue
            vec = normalize_features(track)
            weight = num_liked - fb.get("position", num_liked) + 1
            vectors.append(vec)
            weights.append(max(weight, 0.5))

            if track.get("genres"):
                for g in track["genres"].split(","):
                    g = g.strip().lower()
                    if g and g not in all_genres:
                        all_genres.append(g)

        if not vectors:
            return np.array([0.5, 0.5, 0.5, 0.5]), []

        weights_arr = np.array(weights)
        weights_arr = weights_arr / weights_arr.sum()
        centroid = np.average(vectors, axis=0, weights=weights_arr)

        return centroid, all_genres

    def _compute_similarity_edges(self, tracks: list[dict]) -> list[dict]:
        """Compute pairwise similarity edges above threshold."""
        if len(tracks) < 2:
            return []

        vectors = [normalize_features(t) for t in tracks]
        edges = []

        for i in range(len(tracks)):
            for j in range(i + 1, len(tracks)):
                sim = cosine_similarity(vectors[i], vectors[j])
                if sim >= self._similarity_threshold:
                    edges.append({
                        "source": tracks[i]["id"],
                        "target": tracks[j]["id"],
                        "weight": round(sim, 3),
                    })

        return edges
