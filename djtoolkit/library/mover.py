"""Move tagged tracks to the library directory."""

import shutil
from pathlib import Path

from djtoolkit.config import Config
from djtoolkit.db.database import connect


def _library_duplicate(conn, track_id: int) -> int | None:
    """
    Return the track id of an in-library track with the same fingerprint, or None.
    Returns None if the current track has no fingerprint (can't check).
    """
    row = conn.execute(
        "SELECT fingerprint FROM fingerprints WHERE track_id = ?", (track_id,)
    ).fetchone()
    if not row or not row["fingerprint"]:
        return None

    match = conn.execute(
        """
        SELECT t.id FROM tracks t
        JOIN fingerprints f ON f.track_id = t.id
        WHERE t.in_library = 1
          AND f.fingerprint = ?
          AND t.id != ?
        LIMIT 1
        """,
        (row["fingerprint"], track_id),
    ).fetchone()
    return match["id"] if match else None


def run(cfg: Config, mode: str = "metadata_applied") -> dict:
    """
    Move tracks into library_dir.

    mode='metadata_applied' (default): only tracks where metadata_written=1.
    mode='imported': all available tracks regardless of metadata_written.

    Before moving, checks fingerprint against existing in-library tracks.
    Tracks that match an existing library fingerprint are marked duplicate and skipped.

    Returns {moved, failed, skipped, duplicates}.
    """
    if mode not in ("metadata_applied", "imported"):
        raise ValueError(f"mode must be 'metadata_applied' or 'imported', got {mode!r}")

    stats = {"moved": 0, "failed": 0, "skipped": 0, "duplicates": 0}

    library_dir = Path(cfg.library_dir).expanduser().resolve()
    library_dir.mkdir(parents=True, exist_ok=True)

    metadata_filter = "AND metadata_written = 1" if mode == "metadata_applied" else ""

    with connect(cfg.db_path) as conn:
        tracks = conn.execute(f"""
            SELECT id, local_path
            FROM tracks
            WHERE acquisition_status = 'available'
              {metadata_filter}
              AND in_library = 0
              AND local_path IS NOT NULL
        """).fetchall()

    for track in tracks:
        track = dict(track)
        src = Path(track["local_path"])

        if not src.exists():
            stats["skipped"] += 1
            continue

        # Fingerprint dedup check against in-library tracks
        with connect(cfg.db_path) as conn:
            dupe_id = _library_duplicate(conn, track["id"])
        if dupe_id is not None:
            with connect(cfg.db_path) as conn:
                conn.execute(
                    "UPDATE tracks SET acquisition_status = 'duplicate' WHERE id = ?",
                    (track["id"],),
                )
                conn.commit()
            stats["duplicates"] += 1
            continue

        dest = library_dir / src.name
        if dest.exists() and dest != src:
            # Avoid collision by appending the track id
            dest = library_dir / (src.stem + f"_{track['id']}" + src.suffix)

        try:
            if src.resolve() != dest.resolve():
                shutil.move(str(src), str(dest))
        except OSError:
            stats["failed"] += 1
            continue

        with connect(cfg.db_path) as conn:
            conn.execute(
                "UPDATE tracks SET local_path = ?, in_library = 1 WHERE id = ?",
                (str(dest), track["id"]),
            )
            conn.commit()

        stats["moved"] += 1

    return stats
