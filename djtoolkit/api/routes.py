"""REST API routes for the djtoolkit UI."""

import logging
import collections
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, BackgroundTasks
from pydantic import BaseModel

from djtoolkit.config import load as load_config
from djtoolkit.db.database import connect

router = APIRouter()
_CONFIG_PATH = "djtoolkit.toml"

# ─── In-memory log buffer (last 200 lines) ────────────────────────────────────

_log_buffer: collections.deque = collections.deque(maxlen=200)


class _UILogHandler(logging.Handler):
    """Capture log records from djtoolkit modules into the UI buffer."""
    def emit(self, record: logging.LogRecord):
        level = record.levelname
        msg = self.format(record)
        _log_buffer.append({"level": level, "msg": msg})


def _setup_log_handler():
    handler = _UILogHandler()
    handler.setFormatter(logging.Formatter("%(name)s — %(message)s"))
    logger = logging.getLogger("djtoolkit")
    logger.setLevel(logging.DEBUG)
    if not any(isinstance(h, _UILogHandler) for h in logger.handlers):
        logger.addHandler(handler)


_setup_log_handler()


def _cfg():
    return load_config(_CONFIG_PATH)


# ─── Tracks ───────────────────────────────────────────────────────────────────

@router.get("/tracks")
def list_tracks(
    acquisition_status: Optional[str] = None,
    limit: int = 100,
    offset: int = 0,
):
    cfg = _cfg()
    with connect(cfg.db_path) as conn:
        if acquisition_status:
            rows = conn.execute(
                "SELECT * FROM tracks WHERE acquisition_status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?",
                (acquisition_status, limit, offset),
            ).fetchall()
            total = conn.execute(
                "SELECT COUNT(*) FROM tracks WHERE acquisition_status = ?", (acquisition_status,)
            ).fetchone()[0]
        else:
            rows = conn.execute(
                "SELECT * FROM tracks ORDER BY created_at DESC LIMIT ? OFFSET ?",
                (limit, offset),
            ).fetchall()
            total = conn.execute("SELECT COUNT(*) FROM tracks").fetchone()[0]

    return {"total": total, "offset": offset, "limit": limit, "items": [dict(r) for r in rows]}


@router.get("/tracks/stats")
def track_stats():
    cfg = _cfg()
    with connect(cfg.db_path) as conn:
        acq_rows = conn.execute(
            "SELECT acquisition_status, COUNT(*) as n FROM tracks GROUP BY acquisition_status ORDER BY n DESC"
        ).fetchall()
        flag_row = conn.execute("""
            SELECT
                SUM(fingerprinted)    AS fingerprinted,
                SUM(enriched_spotify) AS enriched_spotify,
                SUM(enriched_audio)   AS enriched_audio,
                SUM(metadata_written) AS metadata_written,
                SUM(normalized)       AS normalized,
                COUNT(*)              AS total
            FROM tracks
        """).fetchone()
    return {
        "by_acquisition_status": [dict(r) for r in acq_rows],
        "processing_flags": dict(flag_row) if flag_row else {},
    }


@router.get("/tracks/{track_id}")
def get_track(track_id: int):
    cfg = _cfg()
    with connect(cfg.db_path) as conn:
        row = conn.execute("SELECT * FROM tracks WHERE id = ?", (track_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Track not found")
    return dict(row)


# ─── Pipeline actions ─────────────────────────────────────────────────────────

class ActionResponse(BaseModel):
    message: str
    stats: dict = {}


@router.post("/pipeline/download", response_model=ActionResponse)
def pipeline_download(background_tasks: BackgroundTasks):
    """Trigger the Soulseek download pipeline in background."""
    from djtoolkit.downloader.aioslsk_client import run
    cfg = _cfg()
    background_tasks.add_task(_run_safe, run, cfg, "download")
    return ActionResponse(message="Download pipeline started — watch the log")


@router.post("/pipeline/fingerprint", response_model=ActionResponse)
def pipeline_fingerprint(background_tasks: BackgroundTasks):
    from djtoolkit.fingerprint.chromaprint import run
    cfg = _cfg()
    background_tasks.add_task(_run_safe, run, cfg, "fingerprint")
    return ActionResponse(message="Fingerprinting started — watch the log")


@router.post("/pipeline/metadata", response_model=ActionResponse)
def pipeline_metadata(background_tasks: BackgroundTasks):
    from djtoolkit.metadata.writer import run
    cfg = _cfg()
    background_tasks.add_task(_run_safe, run, cfg, "metadata")
    return ActionResponse(message="Metadata application started — watch the log")


@router.post("/tracks/reset-failed", response_model=ActionResponse)
def reset_failed():
    """Reset all failed tracks back to candidate."""
    cfg = _cfg()
    with connect(cfg.db_path) as conn:
        result = conn.execute(
            "UPDATE tracks SET acquisition_status = 'candidate' WHERE acquisition_status = 'failed'"
        )
        count = result.rowcount
        conn.commit()
    return ActionResponse(message=f"Reset {count} failed tracks to candidate", stats={"reset": count})


@router.post("/tracks/reset-downloading", response_model=ActionResponse)
def reset_downloading():
    """Reset stuck 'downloading' tracks back to candidate."""
    cfg = _cfg()
    with connect(cfg.db_path) as conn:
        result = conn.execute(
            "UPDATE tracks SET acquisition_status = 'candidate' WHERE acquisition_status = 'downloading'"
        )
        count = result.rowcount
        conn.commit()
    return ActionResponse(message=f"Reset {count} stuck downloads to candidate", stats={"reset": count})


@router.delete("/tracks/failed", response_model=ActionResponse)
def delete_failed():
    """Permanently delete all tracks with acquisition_status = 'failed'."""
    cfg = _cfg()
    with connect(cfg.db_path) as conn:
        result = conn.execute(
            "DELETE FROM tracks WHERE acquisition_status = 'failed'"
        )
        count = result.rowcount
        conn.commit()
    return ActionResponse(message=f"Deleted {count} failed tracks", stats={"deleted": count})


def _run_safe(fn, cfg, name: str):
    """Wrapper that ensures exceptions from background tasks appear in the log."""
    log = logging.getLogger("djtoolkit.api")
    try:
        result = fn(cfg)
        log.info("%s pipeline finished: %s", name, result)
    except Exception as e:
        log.error("%s pipeline error: %s", name, e, exc_info=True)


# ─── Logs ─────────────────────────────────────────────────────────────────────

@router.get("/logs")
def get_logs(since: int = 0):
    """Return log lines from the in-memory buffer. `since` skips the first N entries."""
    lines = list(_log_buffer)
    return {"lines": lines[since:], "total": len(lines)}


# ─── Soulseek health ──────────────────────────────────────────────────────────

@router.get("/soulseek/health")
def soulseek_health():
    """Check if Soulseek credentials are configured."""
    try:
        cfg = _cfg()
        ok = bool(cfg.soulseek.username and cfg.soulseek.password)
        msg = "Credentials configured" if ok else "Missing username or password in [soulseek] config"
        return {"ok": ok, "message": msg}
    except Exception as e:
        return {"ok": False, "message": f"Config error: {e}"}


# ─── DB ───────────────────────────────────────────────────────────────────────

@router.get("/db/check")
def db_check():
    from djtoolkit.db.database import check
    cfg = _cfg()
    issues = check(cfg.db_path)
    return {"ok": len(issues) == 0, "issues": issues}
