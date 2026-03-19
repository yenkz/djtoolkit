"""Single-track Spotify metadata lookup via API search.

Uses spotipy (Client Credentials flow) to search by artist+title,
fuzzy-match the best result, and extract metadata for DB storage.

Requires SPOTIFY_CLIENT_ID + SPOTIFY_CLIENT_SECRET in .env.
"""

from __future__ import annotations

import logging
import re

import spotipy
from spotipy.oauth2 import SpotifyClientCredentials
from thefuzz import fuzz

log = logging.getLogger(__name__)

_CLEANUP_RE = re.compile(r"[^\w\s]")
_MIN_FUZZY_SCORE = 70
_DURATION_TOLERANCE_MS = 30_000


def _normalize(text: str) -> str:
    return _CLEANUP_RE.sub("", (text or "").lower()).strip()


def _year_from_release_date(release_date: str) -> int | None:
    if release_date and len(release_date) >= 4:
        try:
            return int(release_date[:4])
        except ValueError:
            pass
    return None


def lookup_track(
    artist: str,
    title: str,
    *,
    duration_ms: int | None = None,
    client_id: str = "",
    client_secret: str = "",
    spotify_uri: str | None = None,
) -> dict | None:
    """Look up a track on Spotify and return metadata dict, or None.

    If spotify_uri is provided, does a direct lookup instead of searching.
    Otherwise searches by artist+title and fuzzy-matches.

    Returns dict with keys: spotify_uri, album, release_date, year, genres,
    record_label, popularity, explicit, isrc, duration_ms.
    """
    if not client_id or not client_secret:
        log.debug("Spotify lookup skipped — no credentials")
        return None

    try:
        sp = spotipy.Spotify(
            auth_manager=SpotifyClientCredentials(
                client_id=client_id,
                client_secret=client_secret,
            )
        )
    except Exception as exc:
        log.warning("Spotify auth failed: %s", exc)
        return None

    # Direct lookup if URI provided
    if spotify_uri:
        try:
            track = sp.track(spotify_uri)
            return _extract_metadata(sp, track)
        except Exception as exc:
            log.warning("Spotify track lookup failed for %s: %s", spotify_uri, exc)
            return None

    # Search by artist + title
    query = f'artist:"{artist}" track:"{title}"'
    try:
        results = sp.search(q=query, type="track", limit=5)
    except Exception as exc:
        log.warning("Spotify search failed: %s", exc)
        return None

    items = results.get("tracks", {}).get("items", [])
    if not items:
        log.debug("No Spotify results for: %s", query)
        return None

    # Score and filter
    artist_norm = _normalize(artist)
    title_norm = _normalize(title)
    best_track = None
    best_score = 0

    for item in items:
        # Duration filter
        if duration_ms is not None:
            item_dur = item.get("duration_ms", 0)
            if abs(item_dur - duration_ms) > _DURATION_TOLERANCE_MS:
                continue

        item_artist = _normalize(
            item.get("artists", [{}])[0].get("name", "")
        )
        item_title = _normalize(item.get("name", ""))

        score = (
            fuzz.token_sort_ratio(artist_norm, item_artist)
            + fuzz.token_sort_ratio(title_norm, item_title)
        ) / 2

        if score > best_score:
            best_score = score
            best_track = item

    if best_score < _MIN_FUZZY_SCORE or best_track is None:
        log.debug("No match above threshold (best=%.0f) for: %s - %s",
                   best_score, artist, title)
        return None

    return _extract_metadata(sp, best_track)


def _extract_metadata(sp: spotipy.Spotify, track: dict) -> dict:
    """Extract metadata from a Spotify track object + album/artist lookups."""
    album_obj = track.get("album", {})
    artists = track.get("artists", [])
    release_date = album_obj.get("release_date", "")

    result = {
        "spotify_uri": track.get("uri"),
        "album": album_obj.get("name"),
        "release_date": release_date,
        "year": _year_from_release_date(release_date),
        "popularity": track.get("popularity"),
        "explicit": track.get("explicit", False),
        "isrc": track.get("external_ids", {}).get("isrc"),
        "duration_ms": track.get("duration_ms"),
        "record_label": None,
        "genres": None,
    }

    # Fetch record_label from album
    album_id = album_obj.get("id")
    if album_id:
        try:
            full_album = sp.album(album_id)
            result["record_label"] = full_album.get("label")
        except Exception as exc:
            log.debug("Album lookup failed: %s", exc)

    # Fetch genres from primary artist
    if artists and artists[0].get("id"):
        try:
            full_artist = sp.artist(artists[0]["id"])
            genres = full_artist.get("genres", [])
            if genres:
                result["genres"] = ", ".join(genres)
        except Exception as exc:
            log.debug("Artist lookup failed: %s", exc)

    return result
