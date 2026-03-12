"""Local SQLite mirror for agent job idempotency.

Tracks which jobs have been claimed/completed so the agent can safely restart
without re-claiming already-running or finished jobs.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path


_SCHEMA = """
CREATE TABLE IF NOT EXISTS claimed_jobs (
    job_id      TEXT PRIMARY KEY,
    claimed_at  TEXT NOT NULL DEFAULT (datetime('now')),
    status      TEXT NOT NULL DEFAULT 'claimed'
);
"""


def init(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute(_SCHEMA)
    conn.commit()
    return conn


def is_claimed(conn: sqlite3.Connection, job_id: str) -> bool:
    row = conn.execute("SELECT 1 FROM claimed_jobs WHERE job_id = ?", (job_id,)).fetchone()
    return row is not None


def mark_claimed(conn: sqlite3.Connection, job_id: str) -> None:
    conn.execute(
        "INSERT OR IGNORE INTO claimed_jobs (job_id, status) VALUES (?, 'claimed')",
        (job_id,),
    )
    conn.commit()


def mark_done(conn: sqlite3.Connection, job_id: str) -> None:
    conn.execute("UPDATE claimed_jobs SET status = 'done' WHERE job_id = ?", (job_id,))
    conn.commit()


def mark_failed(conn: sqlite3.Connection, job_id: str) -> None:
    conn.execute("UPDATE claimed_jobs SET status = 'failed' WHERE job_id = ?", (job_id,))
    conn.commit()
