"""Tests for SupabaseAdapter with mocked Supabase client."""

from unittest.mock import MagicMock, patch

import pytest

from djtoolkit.adapters.supabase import SupabaseAdapter
from djtoolkit.models.track import Track, CuePoint, CueType


@pytest.fixture
def mock_client():
    client = MagicMock()
    # Chain: client.table("tracks").upsert(...).execute()
    table = MagicMock()
    client.table.return_value = table
    return client


@pytest.fixture
def adapter(mock_client):
    return SupabaseAdapter(mock_client)


class TestSaveTracks:
    def test_upserts_tracks(self, adapter, mock_client):
        tracks = [
            Track(title="Test", artist="DJ", bpm=128.0, key="C minor", source="traktor"),
        ]
        adapter.save_tracks(tracks, user_id="user-123")

        mock_client.table.assert_called_with("tracks")
        table = mock_client.table.return_value
        table.upsert.assert_called_once()
        # Verify on_conflict for deduplication
        assert table.upsert.call_args[1]["on_conflict"] == "source_id,user_id"
        rows = table.upsert.call_args[0][0]
        assert len(rows) == 1
        assert rows[0]["title"] == "Test"
        assert rows[0]["user_id"] == "user-123"
        assert rows[0]["key_normalized"] == "C minor"
        assert rows[0]["camelot"] == "5A"

    def test_returns_stats(self, adapter, mock_client):
        tracks = [
            Track(title="A", artist="B", source="traktor"),
            Track(title="C", artist="D", source="traktor"),
        ]
        result = adapter.save_tracks(tracks, user_id="user-123")
        assert result == {"imported": 2}

    def test_empty_tracks_skips_upsert(self, adapter, mock_client):
        result = adapter.save_tracks([], user_id="user-123")
        mock_client.table.assert_not_called()
        assert result == {"imported": 0}


class TestLoadTracks:
    def test_deserializes_tracks(self, adapter, mock_client):
        table = mock_client.table.return_value
        select = table.select.return_value
        eq1 = select.eq.return_value
        eq1.execute.return_value.data = [
            {"title": "Test", "artist": "DJ", "bpm": 128.0,
             "key_normalized": "C minor", "camelot": "5A",
             "cue_points": [], "beatgrid": [], "artists": "DJ|MC"},
        ]

        tracks = adapter.load_tracks(user_id="user-123")
        assert len(tracks) == 1
        assert tracks[0].title == "Test"
        assert tracks[0].key == "C minor"
        assert tracks[0].artists == ["DJ", "MC"]

    def test_filters_applied(self, adapter, mock_client):
        table = mock_client.table.return_value
        select = table.select.return_value
        eq1 = select.eq.return_value
        eq2 = eq1.eq.return_value
        eq2.execute.return_value.data = []

        tracks = adapter.load_tracks(user_id="user-123", filters={"acquisition_status": "available"})
        assert tracks == []
        # Verify the filter eq was called
        eq1.eq.assert_called_with("acquisition_status", "available")


class TestMarkMethods:
    def test_mark_fingerprinted(self, adapter, mock_client):
        adapter.mark_fingerprinted(42, {"acoustid": "abc123", "fingerprint": "fp_data"})
        table = mock_client.table.return_value
        table.update.assert_called_once()
        update_data = table.update.call_args[0][0]
        assert update_data["fingerprinted"] == 1

    def test_mark_metadata_written(self, adapter, mock_client):
        adapter.mark_metadata_written(42, "spotify")
        table = mock_client.table.return_value
        update_data = table.update.call_args[0][0]
        assert update_data["metadata_written"] == 1
        assert update_data["metadata_source"] == "spotify"

    def test_mark_duplicate(self, adapter, mock_client):
        adapter.mark_duplicate(42)
        table = mock_client.table.return_value
        update_data = table.update.call_args[0][0]
        assert update_data["acquisition_status"] == "duplicate"

    def test_mark_cover_art_written(self, adapter, mock_client):
        adapter.mark_cover_art_written(42)
        table = mock_client.table.return_value
        update_data = table.update.call_args[0][0]
        assert update_data["cover_art_written"] == 1

    def test_mark_enriched_spotify(self, adapter, mock_client):
        adapter.mark_enriched_spotify(42)
        table = mock_client.table.return_value
        update_data = table.update.call_args[0][0]
        assert update_data["enriched_spotify"] == 1

    def test_mark_enriched_audio(self, adapter, mock_client):
        adapter.mark_enriched_audio(42, {"bpm": 128.0, "key_normalized": "C minor"})
        table = mock_client.table.return_value
        update_data = table.update.call_args[0][0]
        assert update_data["enriched_audio"] == 1
        assert update_data["bpm"] == 128.0

    def test_mark_in_library(self, adapter, mock_client):
        adapter.mark_in_library(42, "/music/library/track.mp3")
        table = mock_client.table.return_value
        update_data = table.update.call_args[0][0]
        assert update_data["in_library"] == 1
        assert update_data["local_path"] == "/music/library/track.mp3"

    def test_update_track_uses_eq_filter(self, adapter, mock_client):
        adapter.update_track(99, {"title": "New Title"})
        table = mock_client.table.return_value
        table.update.assert_called_once_with({"title": "New Title"})
        table.update.return_value.eq.assert_called_once_with("id", 99)


class TestQueryMethods:
    def _setup_query_result(self, mock_client, data):
        """Helper: configure the mock chain to return data at the end of any .eq() chain."""
        table = mock_client.table.return_value
        # All eq() calls return a mock that also has eq() and execute()
        chain = MagicMock()
        chain.eq.return_value = chain
        chain.execute.return_value.data = data
        table.select.return_value.eq.return_value = chain
        return chain

    def test_query_available_unfingerprinted(self, adapter, mock_client):
        self._setup_query_result(mock_client, [])
        result = adapter.query_available_unfingerprinted("user-1")
        assert result == []

    def test_query_available_unenriched_audio(self, adapter, mock_client):
        self._setup_query_result(mock_client, [])
        result = adapter.query_available_unenriched_audio("user-1")
        assert result == []

    def test_query_available_unenriched_spotify_no_force(self, adapter, mock_client):
        self._setup_query_result(mock_client, [])
        result = adapter.query_available_unenriched_spotify("user-1", force=False)
        assert result == []

    def test_query_available_unenriched_spotify_force_skips_enriched_filter(self, adapter, mock_client):
        # When force=True the enriched_spotify=0 filter is NOT applied
        table = mock_client.table.return_value
        chain = MagicMock()
        chain.eq.return_value = chain
        chain.execute.return_value.data = []
        table.select.return_value.eq.return_value = chain

        adapter.query_available_unenriched_spotify("user-1", force=True)

        # Count the total number of .eq() calls — with force=True there should be 2
        # (user_id + acquisition_status), NOT 3 (which would include enriched_spotify)
        # We verify by checking the chain.eq call count on the chain after select().eq()
        assert chain.eq.call_count == 1  # only acquisition_status after the first user_id eq

    def test_query_ready_for_library(self, adapter, mock_client):
        self._setup_query_result(mock_client, [])
        result = adapter.query_ready_for_library("user-1")
        assert result == []

    def test_query_missing_cover_art(self, adapter, mock_client):
        self._setup_query_result(mock_client, [])
        result = adapter.query_missing_cover_art("user-1")
        assert result == []
