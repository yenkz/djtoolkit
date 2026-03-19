"""Import Exportify CSV into the tracks table."""

from __future__ import annotations

import csv
from pathlib import Path
from typing import TYPE_CHECKING

from djtoolkit.utils.search_string import build as build_search_string

if TYPE_CHECKING:
    from djtoolkit.adapters.supabase import SupabaseAdapter


# Map CSV header → DB column (only non-trivial mappings listed)
_CSV_TO_DB = {
    "Track URI":         "spotify_uri",
    "Track Name":        "title",
    "Album Name":        "album",
    "Artist Name(s)":    "artists",   # raw multi-artist field
    "Release Date":      "release_date",
    "Duration (ms)":     "duration_ms",
    "Popularity":        "popularity",
    "Explicit":          "explicit",
    "Added By":          "added_by",
    "Added At":          "added_at",
    "Genres":            "genres",
    "Record Label":      "record_label",
    "Danceability":      "danceability",
    "Energy":            "energy",
    "Key":               "key",
    "Loudness":          "loudness",
    "Mode":              "mode",
    "Speechiness":       "speechiness",
    "Acousticness":      "acousticness",
    "Instrumentalness":  "instrumentalness",
    "Liveness":          "liveness",
    "Valence":           "valence",
    "Tempo":             "tempo",
    "Time Signature":    "time_signature",
}


def _parse_year(release_date: str) -> int | None:
    if release_date:
        try:
            return int(release_date[:4])
        except (ValueError, IndexError):
            pass
    return None


def _primary_artist(artists_raw: str) -> str:
    """First artist before the semicolon separator."""
    return artists_raw.split(";")[0].strip()


def import_csv(csv_path: str | Path, adapter: "SupabaseAdapter", user_id: str) -> dict:
    """
    Parse an Exportify CSV and insert tracks via SupabaseAdapter.

    Returns a summary dict: {inserted, skipped_duplicate, total}.
    Tracks already in DB (matched by spotify_uri) are skipped.
    """
    csv_path = Path(csv_path)
    rows: list[dict] = []

    with open(csv_path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            row = {k.strip(): v.strip() for k, v in row.items()}
            record: dict = {
                "acquisition_status": "candidate",
                "source": "exportify",
                "user_id": user_id,
            }

            for csv_col, db_col in _CSV_TO_DB.items():
                record[db_col] = row.get(csv_col) or None

            # Derive artist (primary) and year
            artists_raw = record.get("artists") or ""
            record["artist"] = _primary_artist(artists_raw) if artists_raw else None
            record["year"] = _parse_year(record.get("release_date") or "")

            # Normalize explicit to boolean
            explicit_raw = (record.get("explicit") or "").lower()
            record["explicit"] = explicit_raw == "true"

            # Cast numeric fields
            for int_col in ("duration_ms", "popularity", "key", "mode", "time_signature"):
                val = record.get(int_col)
                try:
                    record[int_col] = int(val) if val not in (None, "") else None
                except (ValueError, TypeError):
                    record[int_col] = None
            for float_col in ("danceability", "energy", "loudness", "speechiness",
                              "acousticness", "instrumentalness", "liveness", "valence", "tempo"):
                val = record.get(float_col)
                try:
                    record[float_col] = float(val) if val not in (None, "") else None
                except (ValueError, TypeError):
                    record[float_col] = None

            # Build search_string
            artist = record.get("artist") or ""
            title = record.get("title") or ""
            record["search_string"] = build_search_string(artist, title) if (artist or title) else None

            if record.get("spotify_uri"):
                rows.append(record)

    # Upsert with ignore_duplicates — skips rows where (user_id, spotify_uri) already exists
    if rows:
        result = (
            adapter._client.table("tracks")
            .upsert(rows, on_conflict="user_id,spotify_uri", ignore_duplicates=True)
            .execute()
        )
        inserted = len(result.data)
    else:
        inserted = 0

    skipped = len(rows) - inserted
    return {"inserted": inserted, "skipped_duplicate": skipped, "total": len(rows)}


def parse_csv_rows(data: bytes) -> list[dict]:
    """Parse raw CSV bytes (Exportify format) into a list of track dicts.

    Used by the cloud API's CSV upload endpoint — no DB writes.
    Each dict matches the ``tracks`` table columns (minus user_id/status/source).
    """
    import io
    text = data.decode("utf-8-sig", errors="replace")
    reader = csv.DictReader(io.StringIO(text))
    tracks: list[dict] = []
    for row in reader:
        row = {k.strip(): (v.strip() if v else None) for k, v in row.items() if k is not None}
        record: dict = {}
        for csv_col, db_col in _CSV_TO_DB.items():
            record[db_col] = row.get(csv_col) or None
        artists_raw = record.get("artists") or ""
        record["artist"] = _primary_artist(artists_raw) if artists_raw else None
        record["year"] = _parse_year(record.get("release_date") or "")
        explicit_raw = (record.get("explicit") or "").lower()
        record["explicit"] = explicit_raw == "true"
        artist = record.get("artist") or ""
        title = record.get("title") or ""
        record["search_string"] = build_search_string(artist, title) if (artist or title) else None
        # Cast numeric fields so asyncpg/PostgreSQL gets the right types
        for int_col in ("duration_ms", "popularity", "key", "mode", "time_signature"):
            val = record.get(int_col)
            try:
                record[int_col] = int(val) if val not in (None, "") else None
            except (ValueError, TypeError):
                record[int_col] = None
        for float_col in ("danceability", "energy", "loudness", "speechiness",
                          "acousticness", "instrumentalness", "liveness", "valence", "tempo"):
            val = record.get(float_col)
            try:
                record[float_col] = float(val) if val not in (None, "") else None
            except (ValueError, TypeError):
                record[float_col] = None
        if record.get("spotify_uri"):
            tracks.append(record)
    return tracks
