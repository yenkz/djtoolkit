"""Move tagged tracks to the library directory."""

import shutil
from pathlib import Path

from djtoolkit.config import Config
from djtoolkit.db.database import connect


def run(cfg: Config) -> dict:
    """
    Move all metadata-written tracks into library_dir.

    Selects tracks where metadata_written=1 and in_library=0, then moves each
    file to cfg.library_dir, updating local_path and setting in_library=1.

    Returns {moved, failed, skipped}.
    """
    stats = {"moved": 0, "failed": 0, "skipped": 0}

    library_dir = Path(cfg.library_dir).expanduser().resolve()
    library_dir.mkdir(parents=True, exist_ok=True)

    with connect(cfg.db_path) as conn:
        tracks = conn.execute("""
            SELECT id, local_path
            FROM tracks
            WHERE acquisition_status = 'available'
              AND metadata_written = 1
              AND in_library = 0
              AND local_path IS NOT NULL
        """).fetchall()

    for track in tracks:
        track = dict(track)
        src = Path(track["local_path"])

        if not src.exists():
            stats["skipped"] += 1
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
