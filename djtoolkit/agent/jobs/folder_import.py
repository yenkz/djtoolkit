# djtoolkit/agent/jobs/folder_import.py
"""Agent job: import tracks from a local folder into the catalogue."""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path

from supabase import create_client

from djtoolkit.config import Config
from djtoolkit.fingerprint.chromaprint import calc as calc_fingerprint, is_available as fpcalc_available
from djtoolkit.importers.folder import AUDIO_EXTENSIONS, _read_tags
from djtoolkit.utils.search_string import build as build_search_string

log = logging.getLogger(__name__)


async def run(cfg: Config, payload: dict, credentials: dict) -> dict:
    """Scan a folder for audio files, insert tracks, and queue fingerprint jobs.

    Returns: {inserted, skipped_existing, track_ids, path}
    """
    folder = Path(payload["path"]).expanduser().resolve()
    recursive = payload.get("recursive", True)
    user_id = payload.get("user_id")

    if not user_id:
        raise ValueError("user_id required in folder_import payload")
    if not folder.is_dir():
        raise FileNotFoundError(f"Folder not found: {folder}")

    # Scan for audio files
    pattern = folder.rglob("*") if recursive else folder.iterdir()
    audio_files = [
        p for p in pattern
        if p.is_file() and p.suffix.lower() in AUDIO_EXTENSIONS
    ]

    if not audio_files:
        return {"inserted": 0, "skipped_existing": 0, "track_ids": [], "path": str(folder)}

    log.info("Found %d audio files in %s", len(audio_files), folder)

    # Check if fpcalc is available for fingerprint-based dedup
    can_fingerprint = fpcalc_available(cfg)
    if not can_fingerprint:
        log.warning("fpcalc not found — fingerprint dedup disabled for this import")

    # Resolve library_dir for in_library check
    library_dir = Path(cfg.paths.library_dir).expanduser().resolve()

    # Connect to Supabase
    sb = create_client(credentials["supabase_url"], credentials["supabase_anon_key"])
    sb.auth.sign_in_with_password({
        "email": credentials["agent_email"],
        "password": credentials["agent_password"],
    })

    loop = asyncio.get_running_loop()
    stats = {"inserted": 0, "skipped_existing": 0, "skipped_duplicate": 0, "errors": 0}
    track_ids: list[int] = []

    for audio_path in audio_files:
        try:
            source_id = str(audio_path)

            # Check if already imported (by file path)
            existing = sb.table("tracks").select("id").eq(
                "source_id", source_id,
            ).eq("user_id", user_id).execute()

            if existing.data:
                stats["skipped_existing"] += 1
                continue

            # Fingerprint-based dedup (matches CLI behavior)
            fp_data = None
            if can_fingerprint:
                fp_data = await loop.run_in_executor(None, calc_fingerprint, audio_path, cfg)
                if fp_data:
                    match = sb.table("fingerprints").select("track_id").eq(
                        "fingerprint", fp_data["fingerprint"],
                    ).eq("user_id", user_id).limit(1).execute()
                    if match.data:
                        stats["skipped_duplicate"] += 1
                        log.info("Skipped duplicate: %s (matches track %d)", audio_path.name, match.data[0]["track_id"])
                        continue

            # Read tags (CPU-bound)
            tags = await loop.run_in_executor(None, _read_tags, audio_path)
            artist = tags.get("artist") or audio_path.parent.name
            title = tags.get("title") or audio_path.stem

            # Check if file is under library_dir
            try:
                in_library = audio_path.resolve().is_relative_to(library_dir)
            except (ValueError, OSError):
                in_library = False

            row = {
                "user_id": user_id,
                "title": title,
                "artist": artist,
                "artists": artist,
                "album": tags.get("album") or "",
                "year": tags.get("year"),
                "genres": tags.get("genres") or "",
                "local_path": str(audio_path),
                "source": "folder",
                "source_id": source_id,
                "acquisition_status": "available",
                "search_string": build_search_string(artist, title),
                "in_library": in_library,
            }

            result = sb.table("tracks").insert(row).select("id").single().execute()
            if not result.data:
                continue

            track_id = result.data["id"]
            track_ids.append(track_id)
            stats["inserted"] += 1

            # Store fingerprint if we have it
            if fp_data:
                sb.table("fingerprints").insert({
                    "user_id": user_id,
                    "track_id": track_id,
                    "fingerprint": fp_data["fingerprint"],
                    "duration": fp_data["duration"],
                }).execute()
                sb.table("tracks").update({
                    "fingerprinted": True,
                }).eq("id", track_id).execute()
            else:
                # No fingerprint data — queue a fingerprint job
                sb.table("pipeline_jobs").insert({
                    "user_id": user_id,
                    "track_id": track_id,
                    "job_type": "fingerprint",
                    "payload": {
                        "track_id": track_id,
                        "local_path": str(audio_path),
                    },
                }).execute()

            log.info("Imported: %s - %s (%s)", artist, title, audio_path.name)

        except Exception as exc:
            log.warning("Failed to import %s: %s", audio_path.name, exc)
            stats["errors"] += 1

    sb.auth.sign_out()

    return {
        "inserted": stats["inserted"],
        "skipped_existing": stats["skipped_existing"],
        "skipped_duplicate": stats["skipped_duplicate"],
        "errors": stats["errors"],
        "track_ids": track_ids,
        "path": str(folder),
    }
