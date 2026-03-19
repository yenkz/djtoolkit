"""Chromaprint fingerprinting via fpcalc + optional AcoustID lookup."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import TYPE_CHECKING

from djtoolkit.config import Config

if TYPE_CHECKING:
    from djtoolkit.adapters.supabase import SupabaseAdapter


def _fpcalc_path(cfg: Config) -> str:
    return cfg.fingerprint.fpcalc_path or "fpcalc"


def is_available(cfg: Config) -> bool:
    """Return True if the fpcalc binary can be found."""
    import shutil
    path = _fpcalc_path(cfg)
    return bool(shutil.which(path) or Path(path).is_file())


def calc(file_path: str | Path, cfg: Config) -> dict | None:
    """
    Run fpcalc on a file and return {fingerprint, duration}.
    Returns None if fpcalc fails or is not installed.
    """
    try:
        result = subprocess.run(
            [_fpcalc_path(cfg), "-json", str(file_path)],
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode != 0:
            return None
        data = json.loads(result.stdout)
        return {"fingerprint": data["fingerprint"], "duration": data["duration"]}
    except (FileNotFoundError, subprocess.TimeoutExpired, json.JSONDecodeError, KeyError):
        return None


def lookup_acoustid(fingerprint: str, duration: float, api_key: str) -> str | None:
    """Query AcoustID with a Chromaprint fingerprint. Returns acoustid string or None."""
    if not api_key:
        return None
    try:
        import acoustid
        results = acoustid.lookup(api_key, fingerprint, int(duration))
        for score, recording_id, title, artist in acoustid.parse_lookup_result(results):
            return recording_id
    except Exception:
        pass
    return None


def is_duplicate(fp1: str, fp2: str) -> bool:
    """
    Simple duplicate check by exact fingerprint match.
    For production, a Hamming-distance approach is more robust.
    """
    return fp1 == fp2


def run(cfg: Config, adapter: "SupabaseAdapter", user_id: str) -> dict:
    """
    Run fingerprinting on all available tracks without a fingerprint yet.
    Marks duplicates via the adapter.

    Returns {fingerprinted, duplicates, skipped}.
    """
    if not cfg.fingerprint.enabled:
        return {"fingerprinted": 0, "duplicates": 0, "skipped": 0}

    stats = {"fingerprinted": 0, "duplicates": 0, "skipped": 0}
    tracks = adapter.query_available_unfingerprinted(user_id)

    for track in tracks:
        local_path = Path(track.file_path) if track.file_path else None
        if not local_path or not local_path.exists():
            stats["skipped"] += 1
            continue

        fp_data = calc(local_path, cfg)
        if not fp_data:
            stats["skipped"] += 1
            continue

        fingerprint = fp_data["fingerprint"]
        duration = fp_data["duration"]
        acoustid_id = lookup_acoustid(
            fingerprint, duration, cfg.fingerprint.acoustid_api_key
        )

        existing_track_id = adapter.find_fingerprint_match(fingerprint, user_id)
        if existing_track_id is not None:
            adapter.update_track(track._id, {
                "acquisition_status": "duplicate",
                "fingerprinted": True,
            })
            stats["duplicates"] += 1
            continue

        fp_id = adapter.insert_fingerprint(
            user_id=user_id,
            track_id=track._id,
            fingerprint=fingerprint,
            acoustid=acoustid_id,
            duration=duration,
        )
        adapter.mark_fingerprinted(track._id, {"fingerprint_id": fp_id})
        stats["fingerprinted"] += 1

    return stats
