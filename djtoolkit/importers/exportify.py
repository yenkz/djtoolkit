"""Import Exportify CSV into the tracks table."""

import csv
import sqlite3
from pathlib import Path

from djtoolkit.db.database import connect
from djtoolkit.utils.search_string import build as build_search_string


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


def import_csv(csv_path: str | Path, db_path: str | Path) -> dict:
    """
    Parse an Exportify CSV and insert tracks into the DB.

    Returns a summary dict: {inserted, skipped_duplicate, total}.
    Tracks already in DB (matched by spotify_uri) are skipped.
    """
    csv_path = Path(csv_path)
    inserted = 0
    skipped = 0

    with connect(db_path) as conn, open(csv_path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            row = {k.strip(): v.strip() for k, v in row.items()}

            # Build the DB row
            record: dict = {"acquisition_status": "candidate", "source": "exportify"}

            for csv_col, db_col in _CSV_TO_DB.items():
                record[db_col] = row.get(csv_col) or None

            # Derive artist (primary) and year
            artists_raw = record.get("artists") or ""
            record["artist"] = _primary_artist(artists_raw) if artists_raw else None
            record["year"] = _parse_year(record.get("release_date") or "")

            # Normalize explicit to int
            explicit_raw = (record.get("explicit") or "").lower()
            record["explicit"] = 1 if explicit_raw == "true" else 0

            # Build search_string
            artist = record.get("artist") or ""
            title = record.get("title") or ""
            record["search_string"] = build_search_string(artist, title) if (artist or title) else None

            # Insert, skip on duplicate spotify_uri
            try:
                _insert(conn, record)
                inserted += 1
            except sqlite3.IntegrityError:
                skipped += 1

        conn.commit()

    return {"inserted": inserted, "skipped_duplicate": skipped, "total": inserted + skipped}


def _insert(conn: sqlite3.Connection, record: dict) -> None:
    columns = ", ".join(record.keys())
    placeholders = ", ".join("?" for _ in record)
    sql = f"INSERT INTO tracks ({columns}) VALUES ({placeholders})"
    conn.execute(sql, list(record.values()))
