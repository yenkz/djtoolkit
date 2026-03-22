"""Enrich imported tracks from Spotify — via Exportify CSV or the Spotify Web API."""

from __future__ import annotations

import csv
import logging
import re
from pathlib import Path
from typing import TYPE_CHECKING

from thefuzz import fuzz

from djtoolkit.config import Config

log = logging.getLogger("djtoolkit.enrichment.spotify")

if TYPE_CHECKING:
    from djtoolkit.adapters.supabase import SupabaseAdapter

# Exportify CSV column → DB column
_CSV_TO_DB = {
    "Track URI":          "spotify_uri",
    "Album Name":         "album",
    "Release Date":       "release_date",
    "Genres":             "genres",
    "Record Label":       "record_label",
    "Popularity":         "popularity",
    "Danceability":       "danceability",
    "Energy":             "energy",
    "Key":                "key",
    "Loudness":           "loudness",
    "Mode":               "mode",
    "Speechiness":        "speechiness",
    "Acousticness":       "acousticness",
    "Instrumentalness":   "instrumentalness",
    "Liveness":           "liveness",
    "Valence":            "valence",
    "Tempo":              "tempo",
    "Time Signature":     "time_signature",
}

# DB column → Track attribute for "skip if already set" check.
# Columns not listed here (key, mode, popularity, time_signature, release_date)
# are always written when available in the CSV.
_DB_COL_TO_ATTR = {
    "spotify_uri": "spotify_uri",
    "album": "album",
    "genres": "genres",
    "record_label": "label",
    "danceability": "danceability",
    "energy": "energy",
    "loudness": "loudness",
    "speechiness": "speechiness",
    "acousticness": "acousticness",
    "instrumentalness": "instrumentalness",
    "liveness": "liveness",
    "valence": "valence",
    "tempo": "tempo",
}

_CLEANUP_RE = re.compile(r"[^\w\s]")


def _normalize(text: str) -> str:
    return _CLEANUP_RE.sub("", (text or "").lower()).strip()


def _year_from_release_date(release_date: str) -> int | None:
    if release_date and len(release_date) >= 4:
        try:
            return int(release_date[:4])
        except ValueError:
            pass
    return None


def run(csv_path: Path, cfg: Config, adapter: "SupabaseAdapter", user_id: str, force: bool = False) -> dict:
    """
    Match imported tracks against an Exportify CSV and fill in metadata.

    When force=True, overwrites existing DB values for all matched fields
    (used by `metadata apply --source spotify` to make Spotify the authoritative source).

    Returns {"matched": N, "unmatched": N, "matched_ids": [...]}.
    """
    stats: dict = {"matched": 0, "unmatched": 0, "matched_ids": []}

    # Load CSV
    from djtoolkit.importers.exportify import _normalize_headers

    with open(csv_path, newline="", encoding="utf-8-sig") as f:
        rows = [_normalize_headers(r) for r in csv.DictReader(f)]

    if not rows:
        return stats

    # Build lookup structures
    uri_map: dict[str, dict] = {}
    fuzzy_list: list[tuple[str, str, dict]] = []

    for row in rows:
        uri = (row.get("Track URI") or "").strip()
        if uri:
            uri_map[uri] = row
        artist_norm = _normalize(row.get("Artist Name(s)") or "")
        title_norm = _normalize(row.get("Track Name") or "")
        fuzzy_list.append((artist_norm, title_norm, row))

    tracks = adapter.query_available_unenriched_spotify(user_id, force=force)

    log.debug("Loaded %d CSV rows (%d with URI), %d DB tracks to enrich",
              len(rows), len(uri_map), len(tracks))

    for track in tracks:
        matched_row = None
        match_method = ""

        # Try URI match first
        if track.spotify_uri:
            matched_row = uri_map.get(track.spotify_uri)
            if matched_row:
                match_method = "uri"

        # Fuzzy fallback
        if matched_row is None:
            track_artist = _normalize(track.artist or "")
            track_title = _normalize(track.title or "")
            best_score = 0
            best_row = None
            for csv_artist, csv_title, row in fuzzy_list:
                score = (
                    fuzz.token_sort_ratio(track_artist, csv_artist)
                    + fuzz.token_sort_ratio(track_title, csv_title)
                ) / 2
                if score > best_score:
                    best_score = score
                    best_row = row
            if best_score >= cfg.matching.min_score * 100:
                matched_row = best_row
                match_method = f"fuzzy ({best_score:.0f}%)"
            else:
                log.debug("no match: %s – %s (best fuzzy: %.0f%%)",
                          track.artist, track.title, best_score)

        if matched_row is None:
            stats["unmatched"] += 1
            continue

        # Build updates — fill NULL columns (or all columns when forcing).
        # spotify_uri is an identity field with a UNIQUE constraint:
        #   - normal mode: set only when NULL
        #   - force mode: skip entirely (fuzzy-matched tracks could steal a URI already owned by
        #     another row, causing a UNIQUE constraint violation)
        updates: dict[str, object] = {}
        for csv_col, db_col in _CSV_TO_DB.items():
            if db_col == "spotify_uri":
                if track.spotify_uri is not None or force:
                    continue
            else:
                attr = _DB_COL_TO_ATTR.get(db_col)
                if attr and not force:
                    val = getattr(track, attr, None)
                    # Track uses "" and 0.0 as defaults for unset fields;
                    # treat any falsy value as "not yet set".
                    if val:
                        continue  # already set — don't overwrite
            raw = (matched_row.get(csv_col) or "").strip()
            if not raw:
                continue
            # Type coercion
            if db_col in ("popularity", "key", "mode", "time_signature"):
                try:
                    updates[db_col] = int(float(raw))
                except ValueError:
                    pass
            elif db_col in (
                "danceability", "energy", "loudness", "speechiness",
                "acousticness", "instrumentalness", "liveness", "valence",
                "tempo",
            ):
                try:
                    updates[db_col] = float(raw)
                except ValueError:
                    pass
            else:
                updates[db_col] = raw

        # Derive year from release_date if year is NULL (or forcing)
        if (force or track.year is None) and "release_date" in updates:
            yr = _year_from_release_date(str(updates["release_date"]))
            if yr:
                updates["year"] = yr

        updates["enriched_spotify"] = True
        filled = [k for k in updates if k != "enriched_spotify"]
        log.debug("matched [%s]: %s – %s → filled %s",
                  match_method, track.artist, track.title, ", ".join(filled) if filled else "(no new fields)")
        adapter.update_track(track._id, updates)

        stats["matched"] += 1
        stats["matched_ids"].append(track._id)

    return stats


# ---------------------------------------------------------------------------
# Spotify Web API enrichment (no CSV required)
# ---------------------------------------------------------------------------

_RATE_LIMIT_WAIT_MAX = 60  # seconds — abort if Spotify asks for longer


def run_api(
    adapter: "SupabaseAdapter",
    user_id: str,
    *,
    client_id: str,
    client_secret: str,
    force: bool = False,
) -> dict:
    """
    Enrich tracks by calling the Spotify Web API directly.

    Uses singular endpoints (sp.track, sp.artist) which work under basic
    Client Credentials — batch endpoints and audio-features require Extended
    Quota Mode.  Fills: album, release_date, record_label, popularity, genres,
    year.  For audio features (BPM, key, danceability, …) use --audio-analysis.

    Respects Spotify rate limits: pauses up to 60 s on 429; aborts if the
    required wait is longer (re-run later to resume where you left off since
    each track is committed individually).

    Returns {"enriched": N, "failed": N, "skipped": N}.
    """
    import time

    import spotipy
    from spotipy.oauth2 import SpotifyClientCredentials

    sp = spotipy.Spotify(
        auth_manager=SpotifyClientCredentials(
            client_id=client_id,
            client_secret=client_secret,
        ),
        retries=0,  # we handle retries ourselves
    )

    tracks = adapter.query_available_unenriched_spotify(user_id, force=force)
    # Only tracks that already have a URI
    tracks = [t for t in tracks if t.spotify_uri]
    log.debug("Spotify API enrichment: %d tracks with URIs to process", len(tracks))

    stats: dict = {"enriched": 0, "failed": 0, "skipped": 0}
    if not tracks:
        return stats

    # Cache artist genres to avoid redundant calls
    artist_genres: dict[str, str | None] = {}

    def _api_call(fn, *args, **kwargs):
        """Call a spotipy method, handling 429 rate limits."""
        try:
            return fn(*args, **kwargs)
        except spotipy.SpotifyException as exc:
            if exc.http_status == 429:
                retry_after = int(exc.headers.get("Retry-After", 0)) if exc.headers else 0
                if retry_after <= _RATE_LIMIT_WAIT_MAX:
                    log.warning("Rate limited — waiting %d s", retry_after)
                    time.sleep(retry_after)
                    return fn(*args, **kwargs)
                else:
                    log.warning("Rate limited for %d s — aborting (re-run later to resume)", retry_after)
                    raise _RateLimitAbort(retry_after) from exc
            raise

    class _RateLimitAbort(Exception):
        def __init__(self, wait: int):
            self.wait = wait

    try:
        for track in tracks:
            try:
                api_track = _api_call(sp.track, track.spotify_uri)
            except _RateLimitAbort:
                raise
            except Exception as exc:
                log.debug("sp.track failed: %s – %s (%s): %s",
                          track.artist, track.title, track.spotify_uri, exc)
                stats["failed"] += 1
                continue

            if not api_track:
                stats["failed"] += 1
                continue

            updates: dict[str, object] = {}
            album_obj = api_track.get("album") or {}

            _set_if_empty(updates, track, force, "album", album_obj.get("name"))
            _set_if_empty(updates, track, force, "record_label", album_obj.get("label"))
            release_date = album_obj.get("release_date") or ""
            if release_date:
                updates["release_date"] = release_date
            pop = api_track.get("popularity")
            if pop is not None:
                updates["popularity"] = pop

            # Genres — from first artist (cached)
            first_artist_id = None
            for art in api_track.get("artists") or []:
                if art.get("id"):
                    first_artist_id = art["id"]
                    break
            if first_artist_id:
                if first_artist_id not in artist_genres:
                    try:
                        a = _api_call(sp.artist, first_artist_id)
                        g = a.get("genres")
                        artist_genres[first_artist_id] = ", ".join(g) if g else None
                    except _RateLimitAbort:
                        raise
                    except Exception:
                        artist_genres[first_artist_id] = None
                _set_if_empty(updates, track, force, "genres", artist_genres[first_artist_id])

            # Derive year
            if (force or track.year is None) and release_date:
                yr = _year_from_release_date(release_date)
                if yr:
                    updates["year"] = yr

            # Remove None values
            updates = {k: v for k, v in updates.items() if v is not None}

            updates["enriched_spotify"] = True
            filled = [k for k in updates if k != "enriched_spotify"]
            log.debug("enriched [api]: %s – %s → filled %s",
                      track.artist, track.title, ", ".join(filled) if filled else "(no new fields)")
            adapter.update_track(track._id, updates)
            stats["enriched"] += 1

    except _RateLimitAbort as e:
        log.warning("Stopped after %d enriched — rate limited for %d s. "
                    "Re-run later to continue.", stats["enriched"], e.wait)

    return stats


def _set_if_empty(
    updates: dict, track, force: bool, db_col: str, value: object
) -> None:
    """Add *value* to *updates* if the track field is unset (or force=True)."""
    if value is None:
        return
    attr = _DB_COL_TO_ATTR.get(db_col, db_col)
    if not force:
        existing = getattr(track, attr, None)
        if existing:
            return
    updates[db_col] = value
