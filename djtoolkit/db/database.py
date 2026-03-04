"""SQLite connection and helpers."""

import sqlite3
from pathlib import Path

_SCHEMA = Path(__file__).parent / "schema.sql"


def connect(db_path: str | Path) -> sqlite3.Connection:
    """Return a sqlite3 connection with row_factory and FK enforcement."""
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def setup(db_path: str | Path) -> None:
    """Create tables from schema.sql if they don't exist."""
    sql = _SCHEMA.read_text()
    with connect(db_path) as conn:
        conn.executescript(sql)


def check(db_path: str | Path) -> list[str]:
    """Run PRAGMA integrity_check and return any issues."""
    with connect(db_path) as conn:
        rows = conn.execute("PRAGMA integrity_check").fetchall()
    results = [row[0] for row in rows]
    return results if results != ["ok"] else []


def migrate(db_path: str | Path) -> None:
    """Migrate existing DB from single status column to acquisition_status + flags."""
    new_cols = [
        ("acquisition_status", "TEXT"),
        ("fingerprinted",      "INTEGER NOT NULL DEFAULT 0"),
        ("enriched_spotify",   "INTEGER NOT NULL DEFAULT 0"),
        ("enriched_audio",     "INTEGER NOT NULL DEFAULT 0"),
        ("metadata_written",   "INTEGER NOT NULL DEFAULT 0"),
        ("normalized",         "INTEGER NOT NULL DEFAULT 0"),
        ("in_library",         "INTEGER NOT NULL DEFAULT 0"),
        ("metadata_source",    "TEXT"),
        ("cover_art_written",     "INTEGER NOT NULL DEFAULT 0"),
        ("cover_art_embedded_at", "DATETIME"),
    ]
    with connect(db_path) as conn:
        existing = {row[1] for row in conn.execute("PRAGMA table_info(tracks)").fetchall()}
        for col, defn in new_cols:
            if col not in existing:
                conn.execute(f"ALTER TABLE tracks ADD COLUMN {col} {defn}")

        if "status" in existing:
            conn.execute("""
                UPDATE tracks SET acquisition_status = CASE
                    WHEN status = 'download_candidate' THEN 'candidate'
                    WHEN status = 'downloading'        THEN 'downloading'
                    WHEN status IN ('downloaded', 'imported', 'metadata_applied') THEN 'available'
                    WHEN status = 'download_fail'      THEN 'failed'
                    WHEN status = 'duplicated'         THEN 'duplicate'
                    ELSE 'candidate'
                END
                WHERE acquisition_status IS NULL
            """)
            conn.execute("UPDATE tracks SET fingerprinted    = 1 WHERE status IN ('duplicated', 'metadata_applied')")
            conn.execute("UPDATE tracks SET metadata_written = 1 WHERE status = 'metadata_applied'")

        conn.commit()


def wipe(db_path: str | Path) -> None:
    """Drop all tables and recreate schema."""
    with connect(db_path) as conn:
        conn.executescript("""
            DROP TABLE IF EXISTS track_embeddings;
            DROP TABLE IF EXISTS fingerprints;
            DROP TABLE IF EXISTS tracks;
        """)
    setup(db_path)
