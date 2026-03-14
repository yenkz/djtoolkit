"""Local state recovery — JSON files for in-flight job tracking.

Writes one JSON file per active job to ~/.djtoolkit/jobs/{job_id}.json.
On startup, orphaned files are detected and results re-reported to the cloud.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

DEFAULT_JOBS_DIR = Path.home() / ".djtoolkit" / "jobs"


def _jobs_dir(base: Path | None = None) -> Path:
    d = base or DEFAULT_JOBS_DIR
    d.mkdir(parents=True, exist_ok=True)
    return d


def save_job_state(
    job_id: str,
    status: str,
    payload: dict,
    result: dict | None = None,
    *,
    jobs_dir: Path | None = None,
) -> None:
    """Write or update a job state file."""
    path = _jobs_dir(jobs_dir) / f"{job_id}.json"
    data: dict[str, Any] = {
        "job_id": job_id,
        "status": status,
        "payload": payload,
    }
    if result is not None:
        data["result"] = result
    path.write_text(json.dumps(data, indent=2))


def load_orphaned_jobs(*, jobs_dir: Path | None = None) -> list[dict]:
    """Load all job state files that have results to re-report.

    Returns list of dicts with keys: job_id, status, payload, result.
    Only returns jobs with status "completed" or "failed" (have results).
    Jobs with status "claimed" (interrupted mid-execution) are left for
    the stale job sweeper on the cloud side.
    """
    d = _jobs_dir(jobs_dir)
    orphans = []
    for path in d.glob("*.json"):
        try:
            data = json.loads(path.read_text())
            if data.get("status") in ("completed", "failed"):
                orphans.append(data)
        except (json.JSONDecodeError, KeyError):
            log.warning("Corrupt job state file: %s", path)
    return orphans


def cleanup_job(job_id: str, *, jobs_dir: Path | None = None) -> None:
    """Delete a job state file after successful result reporting."""
    path = _jobs_dir(jobs_dir) / f"{job_id}.json"
    path.unlink(missing_ok=True)


def cleanup_all(*, jobs_dir: Path | None = None) -> int:
    """Remove all job state files. Returns count deleted."""
    d = _jobs_dir(jobs_dir)
    count = 0
    for path in d.glob("*.json"):
        path.unlink()
        count += 1
    return count


# ─── Daemon activity status ──────────────────────────────────────────────────

STATUS_FILE = Path.home() / ".djtoolkit" / "agent-status.json"


def save_daemon_status(status: dict) -> None:
    """Write daemon activity status to a JSON file for CLI querying."""
    import time
    STATUS_FILE.parent.mkdir(parents=True, exist_ok=True)
    status["updated_at"] = time.time()
    STATUS_FILE.write_text(json.dumps(status, indent=2))


def load_daemon_status() -> dict | None:
    """Read daemon activity status. Returns None if not available."""
    if not STATUS_FILE.exists():
        return None
    try:
        return json.loads(STATUS_FILE.read_text())
    except (json.JSONDecodeError, OSError):
        return None


def clear_daemon_status() -> None:
    """Remove daemon status file on shutdown."""
    STATUS_FILE.unlink(missing_ok=True)
