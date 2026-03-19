"""SupabaseAdapter — sole data access layer for Track objects.

All Track DB operations go through this class. Handles serialization
between Track dataclasses and Supabase PostgREST format.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from supabase import Client

from djtoolkit.models.track import Track


class SupabaseAdapter:
    def __init__(self, client: "Client"):
        self._client = client

    # ── Import/Export service ──

    def save_tracks(self, tracks: list[Track], user_id: str) -> dict:
        """Upsert tracks to Supabase. Returns stats dict with track IDs."""
        rows = []
        for track in tracks:
            row = track.to_db_row()
            row["user_id"] = user_id
            rows.append(row)

        track_ids = []
        if rows:
            result = (
                self._client.table("tracks")
                .upsert(rows, on_conflict="source_id,user_id")
                .execute()
            )
            track_ids = [row["id"] for row in result.data]

        return {"imported": len(rows), "track_ids": track_ids}

    def load_tracks(self, user_id: str, filters: dict | None = None) -> list[Track]:
        """Query tracks for a user, optionally filtered."""
        query = self._client.table("tracks").select("*").eq("user_id", user_id)
        if filters:
            for col, val in filters.items():
                query = query.eq(col, val)
        result = query.execute()
        return [Track.from_db_row(row) for row in result.data]

    # ── Query methods for migrated CLI/agent modules ──

    def query_available_unfingerprinted(self, user_id: str) -> list[Track]:
        result = (self._client.table("tracks").select("*")
                  .eq("user_id", user_id)
                  .eq("acquisition_status", "available")
                  .eq("fingerprinted", False)
                  .execute())
        return [Track.from_db_row(row) for row in result.data]

    def query_available_unenriched_audio(self, user_id: str) -> list[Track]:
        result = (self._client.table("tracks").select("*")
                  .eq("user_id", user_id)
                  .eq("acquisition_status", "available")
                  .eq("enriched_audio", False)
                  .execute())
        return [Track.from_db_row(row) for row in result.data]

    def query_available_unenriched_spotify(self, user_id: str, force: bool = False) -> list[Track]:
        query = (self._client.table("tracks").select("*")
                 .eq("user_id", user_id)
                 .eq("acquisition_status", "available"))
        if not force:
            query = query.eq("enriched_spotify", False)
        result = query.execute()
        return [Track.from_db_row(row) for row in result.data]

    def query_ready_for_library(self, user_id: str) -> list[Track]:
        result = (self._client.table("tracks").select("*")
                  .eq("user_id", user_id)
                  .eq("acquisition_status", "available")
                  .eq("metadata_written", True)
                  .eq("in_library", False)
                  .execute())
        return [Track.from_db_row(row) for row in result.data]

    def query_missing_cover_art(self, user_id: str) -> list[Track]:
        result = (self._client.table("tracks").select("*")
                  .eq("user_id", user_id)
                  .eq("acquisition_status", "available")
                  .eq("cover_art_written", False)
                  .execute())
        return [Track.from_db_row(row) for row in result.data]

    # ── Update methods ──

    def update_track(self, track_id: int, updates: dict) -> None:
        self._client.table("tracks").update(updates).eq("id", track_id).execute()

    def mark_fingerprinted(self, track_id: int, fingerprint_data: dict) -> None:
        self.update_track(track_id, {"fingerprinted": True, **fingerprint_data})

    def mark_metadata_written(self, track_id: int, source: str) -> None:
        self.update_track(track_id, {"metadata_written": True, "metadata_source": source})

    def mark_cover_art_written(self, track_id: int) -> None:
        self.update_track(track_id, {"cover_art_written": True})

    def mark_enriched_spotify(self, track_id: int) -> None:
        self.update_track(track_id, {"enriched_spotify": True})

    def mark_enriched_audio(self, track_id: int, audio_features: dict) -> None:
        self.update_track(track_id, {"enriched_audio": True, **audio_features})

    def mark_in_library(self, track_id: int, new_path: str) -> None:
        self.update_track(track_id, {"in_library": True, "local_path": new_path})

    def mark_duplicate(self, track_id: int) -> None:
        self.update_track(track_id, {"acquisition_status": "duplicate"})

    # ── Fingerprint methods ──

    def insert_fingerprint(self, user_id: str, track_id: int, fingerprint: str,
                           acoustid: str | None, duration: float) -> int:
        """Insert a fingerprint record. Returns the new fingerprint ID."""
        result = (
            self._client.table("fingerprints")
            .insert({
                "user_id": user_id,
                "track_id": track_id,
                "fingerprint": fingerprint,
                "acoustid": acoustid,
                "duration": duration,
            })
            .execute()
        )
        return result.data[0]["id"]

    def find_fingerprint_match(self, fingerprint: str, user_id: str) -> int | None:
        """Find an existing track_id with this exact fingerprint (same user). Returns track_id or None."""
        result = (
            self._client.table("fingerprints")
            .select("track_id")
            .eq("fingerprint", fingerprint)
            .eq("user_id", user_id)
            .limit(1)
            .execute()
        )
        return result.data[0]["track_id"] if result.data else None

    def get_fingerprint_for_track(self, track_id: int) -> str | None:
        """Get the fingerprint string for a track. Returns None if not fingerprinted."""
        result = (
            self._client.table("fingerprints")
            .select("fingerprint")
            .eq("track_id", track_id)
            .limit(1)
            .execute()
        )
        return result.data[0]["fingerprint"] if result.data else None

    def find_library_duplicate(self, track_id: int, user_id: str) -> int | None:
        """Check if an in-library track has the same fingerprint. Returns matching track_id or None."""
        fp = self.get_fingerprint_for_track(track_id)
        if not fp:
            return None
        # Find other tracks with same fingerprint that are in the library
        matches = (
            self._client.table("fingerprints")
            .select("track_id")
            .eq("fingerprint", fp)
            .eq("user_id", user_id)
            .neq("track_id", track_id)
            .execute()
        )
        if not matches.data:
            return None
        # Check which of those tracks are in_library
        match_ids = [m["track_id"] for m in matches.data]
        for mid in match_ids:
            track_result = (
                self._client.table("tracks")
                .select("id, in_library")
                .eq("id", mid)
                .eq("in_library", True)
                .limit(1)
                .execute()
            )
            if track_result.data:
                return mid
        return None
