"""Pydantic request/response models for the recommendation API."""

from __future__ import annotations

from pydantic import BaseModel


class SeedRequest(BaseModel):
    venue_id: str | None = None
    mood_preset_id: str | None = None
    lineup_position: str  # warmup | middle | headliner


class SeedFeedbackItem(BaseModel):
    track_id: int
    liked: bool
    position: int


class ExpandRequest(BaseModel):
    session_id: str
    seed_feedback: list[SeedFeedbackItem]


class FeedbackItem(BaseModel):
    track_id: int
    liked: bool


class RefineRequest(BaseModel):
    session_id: str
    feedback: list[FeedbackItem]


class ExportRequest(BaseModel):
    session_id: str
    format: str  # m3u | traktor | rekordbox | csv
    playlist_name: str | None = None


class SimilarityEdge(BaseModel):
    source: int
    target: int
    weight: float
    harmonic: float = 0.0
    genre: float = 0.0
    feature: float = 0.0


class SeedResponse(BaseModel):
    session_id: str
    context_profile: dict
    seeds: list[dict]
    unanalyzed_count: int


class ExpandResponse(BaseModel):
    tracks: list[dict]
    energy_arc: str
    similarity_edges: list[SimilarityEdge]
