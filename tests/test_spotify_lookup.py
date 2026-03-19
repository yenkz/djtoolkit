"""Tests for enrichment/spotify_lookup.py — Spotify API search + metadata."""

from unittest.mock import MagicMock, patch

import pytest

from djtoolkit.enrichment.spotify_lookup import lookup_track


class TestLookupTrack:
    """Tests for lookup_track()."""

    def test_returns_none_when_no_credentials(self):
        result = lookup_track("Artist", "Title", client_id="", client_secret="")
        assert result is None

    def test_returns_none_when_no_search_results(self):
        with patch("djtoolkit.enrichment.spotify_lookup.spotipy") as mock_sp_mod:
            mock_sp = MagicMock()
            mock_sp_mod.Spotify.return_value = mock_sp
            mock_sp.search.return_value = {"tracks": {"items": []}}
            result = lookup_track("Artist", "Title",
                                  client_id="cid", client_secret="csec")
        assert result is None

    def test_returns_metadata_on_good_match(self):
        mock_track = {
            "uri": "spotify:track:abc123",
            "name": "My Title",
            "artists": [{"name": "My Artist", "id": "artist1"}],
            "album": {
                "name": "My Album",
                "id": "album1",
                "release_date": "2023-06-15",
                "images": [{"url": "http://img", "width": 640}],
            },
            "popularity": 72,
            "explicit": False,
            "external_ids": {"isrc": "USRC1234"},
            "duration_ms": 240000,
        }
        mock_album = {"label": "My Label"}
        mock_artist = {"genres": ["house", "deep house"]}

        with patch("djtoolkit.enrichment.spotify_lookup.spotipy") as mock_sp_mod:
            mock_sp = MagicMock()
            mock_sp_mod.Spotify.return_value = mock_sp
            mock_sp.search.return_value = {"tracks": {"items": [mock_track]}}
            mock_sp.album.return_value = mock_album
            mock_sp.artist.return_value = mock_artist

            result = lookup_track("My Artist", "My Title",
                                  client_id="cid", client_secret="csec")

        assert result is not None
        assert result["spotify_uri"] == "spotify:track:abc123"
        assert result["album"] == "My Album"
        assert result["record_label"] == "My Label"
        assert result["genres"] == "house, deep house"
        assert result["year"] == 2023
        assert result["release_date"] == "2023-06-15"
        assert result["popularity"] == 72
        assert result["explicit"] is False
        assert result["isrc"] == "USRC1234"
        assert result["duration_ms"] == 240000

    def test_filters_by_duration_tolerance(self):
        mock_track = {
            "uri": "spotify:track:abc123",
            "name": "Title",
            "artists": [{"name": "Artist", "id": "a1"}],
            "album": {"name": "Alb", "id": "al1", "release_date": "2023",
                       "images": []},
            "popularity": 50,
            "explicit": False,
            "external_ids": {},
            "duration_ms": 300000,  # 5 min — way off from 240000
        }
        with patch("djtoolkit.enrichment.spotify_lookup.spotipy") as mock_sp_mod:
            mock_sp = MagicMock()
            mock_sp_mod.Spotify.return_value = mock_sp
            mock_sp.search.return_value = {"tracks": {"items": [mock_track]}}

            # duration_ms=240000, tolerance default 30000 → 300000 is 60000 off
            result = lookup_track("Artist", "Title", duration_ms=240000,
                                  client_id="cid", client_secret="csec")

        assert result is None

    def test_spotify_uri_skips_search_and_calls_track_directly(self):
        mock_track = {
            "uri": "spotify:track:direct123",
            "name": "Direct Title",
            "artists": [{"name": "Direct Artist", "id": "artist_direct"}],
            "album": {
                "name": "Direct Album",
                "id": "album_direct",
                "release_date": "2024-01-01",
                "images": [],
            },
            "popularity": 80,
            "explicit": True,
            "external_ids": {"isrc": "USRC9999"},
            "duration_ms": 200000,
        }
        mock_album = {"label": "Direct Label"}
        mock_artist = {"genres": ["techno"]}

        with patch("djtoolkit.enrichment.spotify_lookup.spotipy") as mock_sp_mod:
            mock_sp = MagicMock()
            mock_sp_mod.Spotify.return_value = mock_sp
            mock_sp.track.return_value = mock_track
            mock_sp.album.return_value = mock_album
            mock_sp.artist.return_value = mock_artist

            result = lookup_track(
                "Direct Artist",
                "Direct Title",
                spotify_uri="spotify:track:direct123",
                client_id="cid",
                client_secret="csec",
            )

        mock_sp.search.assert_not_called()
        mock_sp.track.assert_called_once_with("spotify:track:direct123")
        assert result is not None
        assert result["spotify_uri"] == "spotify:track:direct123"
        assert result["album"] == "Direct Album"
        assert result["record_label"] == "Direct Label"
        assert result["genres"] == "techno"
        assert result["year"] == 2024
        assert result["isrc"] == "USRC9999"
        assert result["duration_ms"] == 200000
        assert result["explicit"] is True

    def test_returns_none_on_auth_exception(self):
        with patch("djtoolkit.enrichment.spotify_lookup.spotipy") as mock_sp_mod:
            mock_sp_mod.Spotify.side_effect = Exception("auth failure")
            result = lookup_track("Artist", "Title",
                                  client_id="bad_id", client_secret="bad_secret")
        assert result is None

    def test_fuzzy_match_rejects_low_score(self):
        mock_track = {
            "uri": "spotify:track:abc123",
            "name": "Completely Different Song",
            "artists": [{"name": "Other Artist", "id": "a1"}],
            "album": {"name": "Alb", "id": "al1", "release_date": "2023",
                       "images": []},
            "popularity": 50,
            "explicit": False,
            "external_ids": {},
            "duration_ms": 240000,
        }
        with patch("djtoolkit.enrichment.spotify_lookup.spotipy") as mock_sp_mod:
            mock_sp = MagicMock()
            mock_sp_mod.Spotify.return_value = mock_sp
            mock_sp.search.return_value = {"tracks": {"items": [mock_track]}}

            result = lookup_track("My Artist", "My Title",
                                  client_id="cid", client_secret="csec")

        assert result is None
