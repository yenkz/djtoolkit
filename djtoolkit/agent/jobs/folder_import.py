# djtoolkit/agent/jobs/folder_import.py
"""Agent job: import tracks from a local folder with live progress reporting."""

from __future__ import annotations

import asyncio
import logging
import time
from pathlib import Path

from supabase import create_client

from djtoolkit.config import Config
from djtoolkit.fingerprint.chromaprint import calc as calc_fingerprint, is_available as fpcalc_available
from djtoolkit.importers.folder import AUDIO_EXTENSIONS, _read_tags
from djtoolkit.utils.search_string import build as build_search_string

log = logging.getLogger(__name__)

MAX_LOG_ENTRIES = 200
FLUSH_INTERVAL_SEC = 2.0


class _ProgressTracker:
    """Accumulates progress and flushes to pipeline_jobs.result periodically."""

    def __init__(self, sb, job_id: str | None):
        self._sb = sb
        self._job_id = job_id
        self._last_flush = 0.0
        self.stage = "importing"
        self.done = 0
        self.total = 0
        self.current_track = ""
        self.inserted = 0
        self.duplicates = 0
        self.errors = 0
        self._log: list[dict] = []

    def add_log(self, entry: dict) -> None:
        self._log.append(entry)
        if len(self._log) > MAX_LOG_ENTRIES:
            self._log = self._log[-MAX_LOG_ENTRIES:]

    def to_dict(self) -> dict:
        return {
            "stage": self.stage,
            "progress": {"done": self.done, "total": self.total},
            "current_track": self.current_track,
            "inserted": self.inserted,
            "duplicates": self.duplicates,
            "errors": self.errors,
            "log": list(self._log),
        }

    def flush(self, *, force: bool = False) -> None:
        if not self._job_id:
            return
        now = time.monotonic()
        if not force and (now - self._last_flush) < FLUSH_INTERVAL_SEC:
            return
        try:
            self._sb.table("pipeline_jobs").update(
                {"result": self.to_dict()}
            ).eq("id", self._job_id).execute()
            self._last_flush = now
        except Exception as exc:
            log.debug("Progress flush failed: %s", exc)


async def run(
    cfg: Config, payload: dict, credentials: dict,
    *, job_id: str | None = None,
) -> dict:
    """Scan a folder for audio files, insert tracks, and monitor fingerprinting.

    Returns: {inserted, skipped_existing, skipped_duplicate, errors, track_ids, path}
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
    audio_files = sorted(
        (p for p in pattern if p.is_file() and p.suffix.lower() in AUDIO_EXTENSIONS),
        key=lambda p: p.name.lower(),
    )

    if not audio_files:
        return {"inserted": 0, "skipped_existing": 0, "skipped_duplicate": 0,
                "errors": 0, "track_ids": [], "path": str(folder)}

    log.info("Found %d audio files in %s", len(audio_files), folder)

    can_fingerprint = fpcalc_available(cfg)
    if not can_fingerprint:
        log.warning("fpcalc not found — fingerprint dedup disabled for this import")

    library_dir = Path(cfg.paths.library_dir).expanduser().resolve()

    # Connect to Supabase
    sb = create_client(credentials["supabase_url"], credentials["supabase_anon_key"])
    sb.auth.sign_in_with_password({
        "email": credentials["agent_email"],
        "password": credentials["agent_password"],
    })

    loop = asyncio.get_running_loop()
    progress = _ProgressTracker(sb, job_id)
    progress.total = len(audio_files)
    progress.flush(force=True)

    track_ids: list[int] = []
    fingerprint_job_ids: list[str] = []

    # ── Stage 1: Import files ────────────────────────────────────────────
    for audio_path in audio_files:
        track_label = audio_path.stem
        progress.current_track = track_label
        progress.done += 1

        try:
            source_id = str(audio_path)

            existing = sb.table("tracks").select("id").eq(
                "source_id", source_id,
            ).eq("user_id", user_id).execute()

            if existing.data:
                progress.add_log({"type": "skip", "track": track_label})
                progress.flush()
                continue

            # Fingerprint-based dedup
            fp_data = None
            if can_fingerprint:
                fp_data = await loop.run_in_executor(None, calc_fingerprint, audio_path, cfg)
                if fp_data:
                    match = sb.table("fingerprints").select("track_id").eq(
                        "fingerprint", fp_data["fingerprint"],
                    ).eq("user_id", user_id).limit(1).execute()
                    if match.data:
                        progress.duplicates += 1
                        progress.add_log({"type": "fingerprint", "track": track_label, "duplicate": True})
                        progress.flush()
                        log.info("Skipped duplicate: %s", audio_path.name)
                        continue

            tags = await loop.run_in_executor(None, _read_tags, audio_path)
            artist = tags.get("artist") or audio_path.parent.name
            title = tags.get("title") or audio_path.stem
            track_label = f"{artist} - {title}"
            progress.current_track = track_label

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
            progress.inserted += 1
            progress.add_log({"type": "insert", "track": track_label})

            # Store fingerprint or queue fingerprint job
            if fp_data:
                sb.table("fingerprints").insert({
                    "user_id": user_id,
                    "track_id": track_id,
                    "fingerprint": fp_data["fingerprint"],
                    "duration": fp_data["duration"],
                }).execute()
                sb.table("tracks").update({"fingerprinted": True}).eq("id", track_id).execute()
            else:
                fp_job = sb.table("pipeline_jobs").insert({
                    "user_id": user_id,
                    "track_id": track_id,
                    "job_type": "fingerprint",
                    "payload": {"track_id": track_id, "local_path": str(audio_path)},
                }).select("id").single().execute()
                if fp_job.data:
                    fingerprint_job_ids.append(fp_job.data["id"])

            progress.flush()
            log.info("Imported: %s (%s)", track_label, audio_path.name)

        except Exception as exc:
            progress.errors += 1
            progress.add_log({"type": "error", "track": track_label, "message": str(exc)})
            progress.flush()
            log.warning("Failed to import %s: %s", audio_path.name, exc)

    # ── Stage 2: Monitor fingerprint jobs (if any were queued) ───────────
    if fingerprint_job_ids:
        progress.stage = "fingerprinting"
        progress.done = 0
        progress.total = len(fingerprint_job_ids)
        progress.flush(force=True)

        pending = set(fingerprint_job_ids)
        while pending:
            await asyncio.sleep(FLUSH_INTERVAL_SEC)

            fp_jobs = sb.table("pipeline_jobs").select(
                "id, status, result"
            ).in_("id", list(pending)).execute()

            for fj in (fp_jobs.data or []):
                if fj["status"] in ("completed", "failed"):
                    pending.discard(fj["id"])
                    progress.done += 1

                    fj_result = fj.get("result") or {}
                    track_name = fj_result.get("title", fj_result.get("track", "unknown"))
                    is_dupe = fj_result.get("is_duplicate", False)

                    if is_dupe:
                        progress.duplicates += 1
                        progress.add_log({"type": "fingerprint", "track": track_name, "duplicate": True})
                    elif fj["status"] == "completed":
                        progress.add_log({"type": "fingerprint", "track": track_name, "duplicate": False})
                    else:
                        progress.errors += 1
                        progress.add_log({"type": "error", "track": track_name,
                                          "message": fj_result.get("error", "fingerprint failed")})

            progress.flush(force=True)

    # ── Done ─────────────────────────────────────────────────────────────
    progress.stage = "complete"
    progress.flush(force=True)

    sb.auth.sign_out()

    return {
        "inserted": progress.inserted,
        "skipped_existing": progress.total - progress.inserted - progress.duplicates - progress.errors,
        "skipped_duplicate": progress.duplicates,
        "errors": progress.errors,
        "track_ids": track_ids,
        "path": str(folder),
    }
