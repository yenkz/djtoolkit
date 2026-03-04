"""Chromaprint fingerprinting via fpcalc + optional AcoustID lookup."""

import json
import subprocess
import sqlite3
from pathlib import Path

from djtoolkit.config import Config
from djtoolkit.db.database import connect


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


def run(cfg: Config) -> dict:
    """
    Run fingerprinting on all downloaded tracks without a fingerprint yet.
    Marks duplicates in the DB.

    Returns {fingerprinted, duplicates, skipped}.
    """
    if not cfg.fingerprint.enabled:
        return {"fingerprinted": 0, "duplicates": 0, "skipped": 0}

    stats = {"fingerprinted": 0, "duplicates": 0, "skipped": 0}

    with connect(cfg.db_path) as conn:
        tracks = conn.execute("""
            SELECT id, local_path, title, artist
            FROM tracks
            WHERE acquisition_status = 'available'
              AND fingerprinted = 0
              AND local_path IS NOT NULL
        """).fetchall()

    for track in tracks:
        track = dict(track)
        local_path = Path(track["local_path"])
        if not local_path.exists():
            stats["skipped"] += 1
            continue

        fp_data = calc(local_path, cfg)
        if not fp_data:
            stats["skipped"] += 1
            continue

        fingerprint = fp_data["fingerprint"]
        duration = fp_data["duration"]
        acoustid = lookup_acoustid(fingerprint, duration, cfg.fingerprint.acoustid_api_key)

        with connect(cfg.db_path) as conn:
            # Check for existing identical fingerprint
            existing = conn.execute(
                "SELECT track_id FROM fingerprints WHERE fingerprint = ?",
                (fingerprint,),
            ).fetchone()

            if existing:
                # Mark as duplicate — keep original, flag new one
                conn.execute(
                    "UPDATE tracks SET acquisition_status = 'duplicate', fingerprinted = 1 WHERE id = ?",
                    (track["id"],),
                )
                conn.commit()
                stats["duplicates"] += 1
                continue

            # Insert fingerprint record
            cursor = conn.execute(
                "INSERT INTO fingerprints (track_id, fingerprint, acoustid, duration) VALUES (?, ?, ?, ?)",
                (track["id"], fingerprint, acoustid, duration),
            )
            fp_id = cursor.lastrowid
            conn.execute(
                "UPDATE tracks SET fingerprint_id = ?, fingerprinted = 1 WHERE id = ?",
                (fp_id, track["id"]),
            )
            conn.commit()
            stats["fingerprinted"] += 1

    return stats
