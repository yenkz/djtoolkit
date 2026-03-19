"""Move tagged tracks to the library directory."""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import TYPE_CHECKING

from djtoolkit.config import Config

if TYPE_CHECKING:
    from djtoolkit.adapters.supabase import SupabaseAdapter


def run(cfg: Config, adapter: "SupabaseAdapter", user_id: str, mode: str = "metadata_applied") -> dict:
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

    if mode == "metadata_applied":
        tracks = adapter.query_ready_for_library(user_id)
    else:
        tracks = adapter.load_tracks(user_id, {"acquisition_status": "available", "in_library": False})

    for track in tracks:
        src = Path(track.file_path) if track.file_path else None
        if not src or not src.exists():
            stats["skipped"] += 1
            continue

        # Fingerprint dedup check against in-library tracks
        dupe_id = adapter.find_library_duplicate(track._id, user_id)
        if dupe_id is not None:
            adapter.mark_duplicate(track._id)
            stats["duplicates"] += 1
            continue

        dest = library_dir / src.name
        if dest.exists() and dest != src:
            dest = library_dir / (src.stem + f"_{track._id}" + src.suffix)

        try:
            if src.resolve() != dest.resolve():
                shutil.move(str(src), str(dest))
        except OSError:
            stats["failed"] += 1
            continue

        adapter.mark_in_library(track._id, str(dest))
        stats["moved"] += 1

    return stats
