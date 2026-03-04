"""Tests for database helpers."""

import sqlite3

import pytest

from djtoolkit.db.database import check, connect, migrate, setup, wipe


@pytest.fixture
def db(tmp_path):
    db_path = tmp_path / "test.db"
    setup(db_path)
    return db_path


def test_setup_creates_tables(db):
    with connect(db) as conn:
        tables = {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
    assert "tracks" in tables
    assert "fingerprints" in tables
    assert "track_embeddings" in tables


def test_connect_returns_row_factory(db):
    with connect(db) as conn:
        row = conn.execute("SELECT COUNT(*) as n FROM tracks").fetchone()
    assert row["n"] == 0  # dict-style access works → row_factory is set


def test_connect_enforces_foreign_keys(db):
    with connect(db) as conn:
        result = conn.execute("PRAGMA foreign_keys").fetchone()
    assert result[0] == 1


def test_check_returns_empty_for_fresh_db(db):
    issues = check(db)
    assert issues == []


def test_migrate_is_idempotent(db):
    migrate(db)
    migrate(db)  # second call must not raise or duplicate columns
    with connect(db) as conn:
        cols = [row[1] for row in conn.execute("PRAGMA table_info(tracks)").fetchall()]
    assert cols.count("acquisition_status") == 1
    assert cols.count("cover_art_written") == 1


def test_migrate_adds_columns_to_old_schema(tmp_path):
    """Simulate an old-schema DB (missing new columns) and verify migration adds them."""
    db_path = tmp_path / "old.db"
    with sqlite3.connect(db_path) as conn:
        conn.execute("""
            CREATE TABLE tracks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source TEXT,
                title TEXT,
                artist TEXT
            )
        """)
    migrate(db_path)
    with connect(db_path) as conn:
        cols = {row[1] for row in conn.execute("PRAGMA table_info(tracks)").fetchall()}
    assert "acquisition_status" in cols
    assert "fingerprinted" in cols
    assert "cover_art_written" in cols
    assert "metadata_source" in cols


def test_wipe_drops_and_recreates(db):
    # Insert a row
    with connect(db) as conn:
        conn.execute(
            "INSERT INTO tracks (source, acquisition_status) VALUES ('exportify', 'candidate')"
        )
        conn.commit()

    wipe(db)

    with connect(db) as conn:
        tables = {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
        count = conn.execute("SELECT COUNT(*) FROM tracks").fetchone()[0]

    assert "tracks" in tables
    assert count == 0
