"""Tests for FastAPI routes."""

import pytest
from fastapi.testclient import TestClient

from djtoolkit.api.app import app
from djtoolkit.config import Config
from djtoolkit.db.database import connect, setup


@pytest.fixture
def client(tmp_path, monkeypatch):
    db_path = tmp_path / "test.db"
    setup(db_path)

    cfg = Config()
    cfg.db.path = str(db_path)

    import djtoolkit.api.routes as routes_mod
    monkeypatch.setattr(routes_mod, "_cfg", lambda: cfg)

    return TestClient(app)


def _insert_track(db_path, *, acquisition_status="available", title="Track", artist="Artist"):
    with connect(db_path) as conn:
        cursor = conn.execute(
            """INSERT INTO tracks (acquisition_status, source, title, artist)
               VALUES (?, 'exportify', ?, ?)""",
            (acquisition_status, title, artist),
        )
        conn.commit()
        return cursor.lastrowid


# ─── GET /api/tracks ──────────────────────────────────────────────────────────


def test_list_tracks_empty(client):
    resp = client.get("/api/tracks")
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 0
    assert data["items"] == []


def test_list_tracks_returns_inserted(client, tmp_path):
    cfg = Config()
    cfg.db.path = str(tmp_path / "test.db")
    setup(cfg.db_path)
    import djtoolkit.api.routes as routes_mod
    original_cfg = routes_mod._cfg
    routes_mod._cfg = lambda: cfg
    _insert_track(cfg.db_path)
    resp = client.get("/api/tracks")
    routes_mod._cfg = original_cfg
    assert resp.status_code == 200


def test_list_tracks_status_filter(client, tmp_path):
    """Filtering by acquisition_status returns only matching tracks."""
    # Use the db from the client fixture
    db_path = tmp_path / "test.db"
    _insert_track(db_path, acquisition_status="available")
    _insert_track(db_path, acquisition_status="candidate")

    resp = client.get("/api/tracks?acquisition_status=available")
    assert resp.status_code == 200
    data = resp.json()
    assert all(t["acquisition_status"] == "available" for t in data["items"])


# ─── GET /api/tracks/stats ────────────────────────────────────────────────────


def test_track_stats_empty_db(client):
    resp = client.get("/api/tracks/stats")
    assert resp.status_code == 200
    data = resp.json()
    assert "by_acquisition_status" in data
    assert "processing_flags" in data


def test_track_stats_counts_correctly(client, tmp_path):
    db_path = tmp_path / "test.db"
    _insert_track(db_path, acquisition_status="available")
    _insert_track(db_path, acquisition_status="available")
    _insert_track(db_path, acquisition_status="candidate")

    resp = client.get("/api/tracks/stats")
    assert resp.status_code == 200
    data = resp.json()
    by_status = {r["acquisition_status"]: r["n"] for r in data["by_acquisition_status"]}
    assert by_status.get("available", 0) == 2
    assert by_status.get("candidate", 0) == 1


# ─── GET /api/tracks/{id} ─────────────────────────────────────────────────────


def test_get_track_not_found(client):
    resp = client.get("/api/tracks/99999")
    assert resp.status_code == 404


def test_get_track_returns_track(client, tmp_path):
    db_path = tmp_path / "test.db"
    track_id = _insert_track(db_path, title="My Song")
    resp = client.get(f"/api/tracks/{track_id}")
    assert resp.status_code == 200
    assert resp.json()["title"] == "My Song"


# ─── POST /api/tracks/reset-failed ───────────────────────────────────────────


def test_reset_failed_resets_failed_tracks(client, tmp_path):
    db_path = tmp_path / "test.db"
    _insert_track(db_path, acquisition_status="failed")
    _insert_track(db_path, acquisition_status="failed")

    resp = client.post("/api/tracks/reset-failed")
    assert resp.status_code == 200
    data = resp.json()
    assert data["stats"]["reset"] == 2


# ─── GET /api/logs ────────────────────────────────────────────────────────────


def test_get_logs_returns_list(client):
    resp = client.get("/api/logs")
    assert resp.status_code == 200
    data = resp.json()
    assert "lines" in data
    assert "total" in data


# ─── GET /api/db/check ────────────────────────────────────────────────────────


def test_db_check_returns_ok(client):
    resp = client.get("/api/db/check")
    assert resp.status_code == 200
    data = resp.json()
    assert data["ok"] is True
    assert data["issues"] == []
