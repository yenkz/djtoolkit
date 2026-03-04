"""Enrich imported tracks using an Exportify CSV as the metadata source."""

import csv
import re
from pathlib import Path

from thefuzz import fuzz

from djtoolkit.config import Config
from djtoolkit.db.database import connect

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


def run(csv_path: Path, cfg: Config, force: bool = False) -> dict:
    """
    Match imported tracks against an Exportify CSV and fill in metadata.

    When force=True, overwrites existing DB values for all matched fields
    (used by `metadata apply --source spotify` to make Spotify the authoritative source).

    Returns {"matched": N, "unmatched": N, "matched_ids": [...]}.
    """
    stats: dict = {"matched": 0, "unmatched": 0, "matched_ids": []}

    # Load CSV
    with open(csv_path, newline="", encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))

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

    # When forcing, re-process already-enriched tracks too
    with connect(cfg.db_path) as conn:
        query = "SELECT * FROM tracks WHERE acquisition_status = 'available'"
        if not force:
            query += " AND enriched_spotify = 0"
        tracks = conn.execute(query).fetchall()

    for track in tracks:
        track = dict(track)
        matched_row = None

        # Try URI match first
        if track.get("spotify_uri"):
            matched_row = uri_map.get(track["spotify_uri"])

        # Fuzzy fallback
        if matched_row is None:
            track_artist = _normalize(track.get("artist") or "")
            track_title = _normalize(track.get("title") or "")
            best_score = 0
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

        if matched_row is None:
            stats["unmatched"] += 1
            continue

        # Build UPDATE — fill NULL columns (or all columns when forcing).
        # spotify_uri is an identity field with a UNIQUE constraint:
        #   - normal mode: set only when NULL
        #   - force mode: skip entirely (fuzzy-matched tracks could steal a URI already owned by
        #     another row, causing a UNIQUE constraint violation)
        updates: dict[str, object] = {}
        for csv_col, db_col in _CSV_TO_DB.items():
            if db_col == "spotify_uri":
                if track.get(db_col) is not None or force:
                    continue
            elif not force and track.get(db_col) is not None:
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
        if (force or track.get("year") is None) and "release_date" in updates:
            yr = _year_from_release_date(str(updates["release_date"]))
            if yr:
                updates["year"] = yr

        updates["enriched_spotify"] = 1
        set_clause = ", ".join(f"{col} = ?" for col in updates)
        values = list(updates.values()) + [track["id"]]

        with connect(cfg.db_path) as conn:
            conn.execute(
                f"UPDATE tracks SET {set_clause} WHERE id = ?", values
            )
            conn.commit()

        stats["matched"] += 1
        stats["matched_ids"].append(track["id"])

    return stats
