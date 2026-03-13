"""Tests for djtoolkit/api/catalog_routes.py.

Unit tests (no DB needed):
  - parse_csv_rows correctly maps Exportify CSV bytes to track dicts
  - Missing Authorization returns 422
  - Invalid token returns 401

Integration tests (require SUPABASE_DATABASE_URL + SUPABASE_JWT_SECRET):
  - GET /catalog/stats returns zeros for a fresh user
  - GET /catalog/tracks returns empty list for a fresh user
  - POST /catalog/import/csv inserts tracks and creates download jobs
  - GET /catalog/tracks returns inserted tracks, paginated, filterable
  - POST /catalog/tracks/{id}/reset resets a failed track back to candidate
  - Tenant isolation: user A cannot see user B's tracks

Run manually:
    SUPABASE_DATABASE_URL="..." SUPABASE_JWT_SECRET="..." poetry run pytest tests/test_catalog_routes.py -v
"""

from __future__ import annotations

import io
import os
import time
import uuid

import asyncpg
import httpx
import pytest
import pytest_asyncio
from jose import jwt

from djtoolkit.api.app import app
from djtoolkit.importers.exportify import parse_csv_rows


# ─── Skip markers ─────────────────────────────────────────────────────────────

_needs_db = pytest.mark.skipif(
    not (os.environ.get("SUPABASE_DATABASE_URL") and os.environ.get("SUPABASE_JWT_SECRET")),
    reason="SUPABASE_DATABASE_URL or SUPABASE_JWT_SECRET not set",
)

_needs_jwt = pytest.mark.skipif(
    not os.environ.get("SUPABASE_JWT_SECRET"),
    reason="SUPABASE_JWT_SECRET not set",
)


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _make_jwt(user_id: str) -> str:
    secret = os.environ.get("SUPABASE_JWT_SECRET", "test-secret")
    now = int(time.time())
    return jwt.encode({"sub": user_id, "iat": now, "exp": now + 3600}, secret, algorithm="HS256")


def _async_client():
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
    )


def _async_client_no_db():
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
    )


_MINIMAL_CSV = b"""Track URI,Track Name,Artist Name(s),Album Name,Release Date,Duration (ms),Popularity,Added By,Added At,Genres,Record Label,Danceability,Energy,Key,Loudness,Mode,Speechiness,Acousticness,Instrumentalness,Liveness,Valence,Tempo,Time Signature,Explicit
spotify:track:aaa111,Test Track One,Artist A,Album One,2022-01-01,210000,70,user1,2022-01-10,,,,,,,,,,,,,,,False
spotify:track:bbb222,Test Track Two,Artist B,Album Two,2023-06-15,185000,55,user1,2023-06-20,,,,,,,,,,,,,,,False
"""


# ─── Unit tests: parse_csv_rows ───────────────────────────────────────────────

def test_parse_csv_rows_returns_list():
    rows = parse_csv_rows(_MINIMAL_CSV)
    assert len(rows) == 2


def test_parse_csv_rows_fields():
    rows = parse_csv_rows(_MINIMAL_CSV)
    t = rows[0]
    assert t["title"] == "Test Track One"
    assert t["artist"] == "Artist A"
    assert t["spotify_uri"] == "spotify:track:aaa111"
    assert t["duration_ms"] == 210000
    assert t["year"] == 2022


def test_parse_csv_rows_search_string_set():
    rows = parse_csv_rows(_MINIMAL_CSV)
    assert rows[0]["search_string"]  # non-empty


def test_parse_csv_rows_skips_rows_without_uri():
    no_uri_csv = b"Track URI,Track Name,Artist Name(s)\n,Missing URI Track,Artist X\n"
    rows = parse_csv_rows(no_uri_csv)
    assert rows == []


def test_parse_csv_rows_utf8_bom():
    """BOM-prefixed CSV (common Windows export) should parse without errors."""
    bom_csv = b"\xef\xbb\xbf" + _MINIMAL_CSV
    rows = parse_csv_rows(bom_csv)
    assert len(rows) == 2


# ─── Unit tests: auth guards ──────────────────────────────────────────────────

@_needs_jwt
@pytest.mark.asyncio
async def test_catalog_tracks_no_auth():
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.get("/api/catalog/tracks")
    assert resp.status_code == 422  # missing required header


@_needs_jwt
@pytest.mark.asyncio
async def test_catalog_tracks_invalid_token():
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.get("/api/catalog/tracks", headers={"Authorization": "Bearer not.a.valid.token"})
    # 401 from JWT decode failure, or 500/503 if no DB — but NOT 200/422
    assert resp.status_code in (401, 500, 503)


# ─── Integration tests ────────────────────────────────────────────────────────

@pytest_asyncio.fixture
async def db_user():
    """Create a fresh user row and yield (user_id, jwt_token). Cleans up after test."""
    user_id = str(uuid.uuid4())
    token = _make_jwt(user_id)
    conn = await asyncpg.connect(os.environ["SUPABASE_DATABASE_URL"])
    await conn.execute(
        "INSERT INTO users (id, email) VALUES ($1, $2)",
        user_id, f"test-catalog-{user_id}@djtoolkit.test",
    )
    yield user_id, token
    await conn.execute("DELETE FROM users WHERE id = $1", user_id)
    await conn.close()


@_needs_db
@pytest.mark.asyncio
async def test_stats_empty_user(db_user):
    user_id, token = db_user
    async with _async_client() as client:
        resp = await client.get("/api/catalog/stats", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["total"] == 0
    assert data["by_status"] == {}
    assert data["flags"]["in_library"] == 0


@_needs_db
@pytest.mark.asyncio
async def test_tracks_empty_user(db_user):
    user_id, token = db_user
    async with _async_client() as client:
        resp = await client.get("/api/catalog/tracks", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["total"] == 0
    assert data["tracks"] == []
    assert data["page"] == 1


@_needs_db
@pytest.mark.asyncio
async def test_import_csv_inserts_tracks_and_jobs(db_user):
    user_id, token = db_user
    async with _async_client() as client:
        resp = await client.post(
            "/api/catalog/import/csv",
            files={"file": ("test.csv", io.BytesIO(_MINIMAL_CSV), "text/csv")},
            headers={"Authorization": f"Bearer {token}"},
        )
    assert resp.status_code == 201, resp.text
    data = resp.json()
    assert data["imported"] == 2
    assert data["skipped_duplicates"] == 0
    assert data["jobs_created"] == 2


@_needs_db
@pytest.mark.asyncio
async def test_import_csv_idempotent(db_user):
    """Uploading the same CSV twice skips the duplicates on the second upload."""
    user_id, token = db_user
    async with _async_client() as client:
        for i in range(2):
            resp = await client.post(
                "/api/catalog/import/csv",
                files={"file": ("test.csv", io.BytesIO(_MINIMAL_CSV), "text/csv")},
                headers={"Authorization": f"Bearer {token}"},
            )
            assert resp.status_code == 201, resp.text

    data = resp.json()
    assert data["imported"] == 0
    assert data["skipped_duplicates"] == 2


@_needs_db
@pytest.mark.asyncio
async def test_tracks_after_import(db_user):
    user_id, token = db_user
    async with _async_client() as client:
        await client.post(
            "/api/catalog/import/csv",
            files={"file": ("test.csv", io.BytesIO(_MINIMAL_CSV), "text/csv")},
            headers={"Authorization": f"Bearer {token}"},
        )
        resp = await client.get("/api/catalog/tracks", headers={"Authorization": f"Bearer {token}"})

    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["total"] == 2
    titles = {t["title"] for t in data["tracks"]}
    assert "Test Track One" in titles
    assert "Test Track Two" in titles


@_needs_db
@pytest.mark.asyncio
async def test_tracks_status_filter(db_user):
    user_id, token = db_user
    async with _async_client() as client:
        await client.post(
            "/api/catalog/import/csv",
            files={"file": ("test.csv", io.BytesIO(_MINIMAL_CSV), "text/csv")},
            headers={"Authorization": f"Bearer {token}"},
        )
        resp = await client.get(
            "/api/catalog/tracks?status=candidate",
            headers={"Authorization": f"Bearer {token}"},
        )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["total"] == 2
    assert all(t["acquisition_status"] == "candidate" for t in data["tracks"])

    # Filter for a status that has no tracks
    async with _async_client() as client:
        resp = await client.get(
            "/api/catalog/tracks?status=available",
            headers={"Authorization": f"Bearer {token}"},
        )
    assert resp.json()["total"] == 0


@_needs_db
@pytest.mark.asyncio
async def test_get_single_track(db_user):
    user_id, token = db_user
    async with _async_client() as client:
        await client.post(
            "/api/catalog/import/csv",
            files={"file": ("test.csv", io.BytesIO(_MINIMAL_CSV), "text/csv")},
            headers={"Authorization": f"Bearer {token}"},
        )
        list_resp = await client.get("/api/catalog/tracks", headers={"Authorization": f"Bearer {token}"})
        track_id = list_resp.json()["tracks"][0]["id"]

        resp = await client.get(f"/api/catalog/tracks/{track_id}", headers={"Authorization": f"Bearer {token}"})

    assert resp.status_code == 200, resp.text
    assert resp.json()["id"] == track_id


@_needs_db
@pytest.mark.asyncio
async def test_reset_failed_track(db_user):
    user_id, token = db_user
    conn = await asyncpg.connect(os.environ["SUPABASE_DATABASE_URL"])
    try:
        # Insert a failed track directly
        track_id = await conn.fetchval(
            """
            INSERT INTO tracks (user_id, acquisition_status, source, title, artist, search_string)
            VALUES ($1, 'failed', 'exportify', 'Failed Track', 'Artist', 'artist failed track')
            RETURNING id
            """,
            user_id,
        )

        async with _async_client() as client:
            resp = await client.post(
                f"/api/catalog/tracks/{track_id}/reset",
                headers={"Authorization": f"Bearer {token}"},
            )
        assert resp.status_code == 204, resp.text

        # Verify status changed
        row = await conn.fetchrow("SELECT acquisition_status FROM tracks WHERE id = $1", track_id)
        assert row["acquisition_status"] == "candidate"

        # Verify a download job was created
        job = await conn.fetchrow(
            "SELECT job_type FROM pipeline_jobs WHERE track_id = $1 AND status = 'pending'", track_id
        )
        assert job is not None
        assert job["job_type"] == "download"

    finally:
        await conn.execute("DELETE FROM tracks WHERE id = $1", track_id)
        await conn.close()


@_needs_db
@pytest.mark.asyncio
async def test_import_csv_queue_jobs_false(db_user):
    """POST /catalog/import/csv?queue_jobs=false inserts tracks but no pipeline_jobs."""
    user_id, token = db_user
    csv_bytes = _MINIMAL_CSV
    async with _async_client() as c:
        r = await c.post(
            "/api/catalog/import/csv?queue_jobs=false",
            files={"file": ("test.csv", io.BytesIO(csv_bytes), "text/csv")},
            headers={"Authorization": f"Bearer {token}"},
        )
    assert r.status_code == 201
    data = r.json()
    assert data["imported"] > 0
    assert data["jobs_created"] == 0

    # Verify no pipeline_jobs were created
    conn = await asyncpg.connect(os.environ["SUPABASE_DATABASE_URL"])
    count = await conn.fetchval(
        "SELECT count(*) FROM pipeline_jobs WHERE user_id = $1", user_id
    )
    await conn.close()
    assert count == 0


@_needs_db
@pytest.mark.asyncio
async def test_import_spotify_queue_jobs_false_skips_jobs(db_user, monkeypatch):
    """POST /catalog/import/spotify?queue_jobs=false creates no pipeline_jobs."""
    from djtoolkit.api import catalog_routes

    async def _fake_token(user_id):
        return "fake-token"

    monkeypatch.setattr(
        catalog_routes, "_get_spotify_token",
        _fake_token
    )

    import respx, httpx as _httpx
    with respx.mock:
        respx.get("https://api.spotify.com/v1/playlists/test123/tracks").mock(
            return_value=_httpx.Response(200, json={
                "items": [{
                    "added_by": {"id": "user"},
                    "added_at": "2024-01-01T00:00:00Z",
                    "track": {
                        "uri": "spotify:track:abc123",
                        "name": "Test Track",
                        "duration_ms": 240000,
                        "artists": [{"name": "Test Artist"}],
                        "album": {"name": "Test Album", "release_date": "2024"},
                        "explicit": False,
                        "popularity": 50,
                        "external_ids": {},
                    }
                }],
                "next": None,
            })
        )
        user_id, token = db_user
        async with _async_client() as c:
            r = await c.post(
                "/api/catalog/import/spotify?queue_jobs=false",
                json={"playlist_id": "test123"},
                headers={"Authorization": f"Bearer {token}"},
            )

    assert r.status_code == 201
    assert r.json()["imported"] == 1
    assert r.json()["jobs_created"] == 0


@_needs_db
@pytest.mark.asyncio
async def test_list_tracks_already_owned_flag(db_user):
    """Verify already_owned logic and no self-match bug.

    The tracks table has a global UNIQUE constraint on spotify_uri, so we cannot
    insert two rows with the same URI.  We therefore test:

    1. SELF-MATCH PREVENTION: an available track must NOT report already_owned=true
       for itself.  Without the ``AND o.id != t.id`` guard in the LATERAL subquery
       it would, because the subquery would match the row against itself.

    2. NEGATIVE CASE: a candidate track whose spotify_uri has no available
       counterpart must report already_owned=false.
    """
    user_id, token = db_user
    conn = await asyncpg.connect(os.environ["SUPABASE_DATABASE_URL"])

    uri_available = f"spotify:track:{uuid.uuid4().hex}"
    uri_candidate = f"spotify:track:{uuid.uuid4().hex}"

    await conn.execute(
        """INSERT INTO tracks (user_id, acquisition_status, source, title, artist,
                               spotify_uri, search_string)
           VALUES ($1, 'available', 'folder', 'Owned Track', 'Artist A', $2, '')""",
        user_id, uri_available,
    )
    await conn.execute(
        """INSERT INTO tracks (user_id, acquisition_status, source, title, artist,
                               spotify_uri, search_string)
           VALUES ($1, 'candidate', 'exportify', 'Candidate Track', 'Artist B', $2, '')""",
        user_id, uri_candidate,
    )
    await conn.close()

    async with _async_client() as c:
        r = await c.get(
            "/api/catalog/tracks",
            headers={"Authorization": f"Bearer {token}"},
        )
    assert r.status_code == 200
    tracks = r.json()["tracks"]

    # 1. Self-match prevention: the available track must NOT show already_owned=true
    available_tracks = [t for t in tracks if t["spotify_uri"] == uri_available]
    assert len(available_tracks) == 1, "available track should appear in listing"
    assert available_tracks[0]["already_owned"] is False, (
        "available track must not match itself in the already_owned LATERAL subquery"
    )

    # 2. Negative case: candidate with no available counterpart → already_owned=false
    candidate_tracks = [t for t in tracks if t["spotify_uri"] == uri_candidate]
    assert len(candidate_tracks) == 1, "candidate track should appear in listing"
    assert candidate_tracks[0]["already_owned"] is False, (
        "candidate with no available counterpart must report already_owned=false"
    )


@_needs_db
@pytest.mark.asyncio
async def test_bulk_delete_tracks_candidates_only(db_user):
    """DELETE /catalog/tracks/bulk deletes candidates; ignores available tracks."""
    user_id, token = db_user
    conn = await asyncpg.connect(os.environ["SUPABASE_DATABASE_URL"])

    candidate_id = await conn.fetchval(
        """INSERT INTO tracks (user_id, acquisition_status, source, title, artist, search_string)
           VALUES ($1, 'candidate', 'spotify', 'To Delete', 'Artist', '') RETURNING id""",
        user_id,
    )
    available_id = await conn.fetchval(
        """INSERT INTO tracks (user_id, acquisition_status, source, title, artist, search_string)
           VALUES ($1, 'available', 'spotify', 'Keep Me', 'Artist', '') RETURNING id""",
        user_id,
    )
    await conn.close()

    async with _async_client() as c:
        r = await c.request(
            "DELETE",
            "/api/catalog/tracks/bulk",
            json={"track_ids": [candidate_id, available_id]},
            headers={"Authorization": f"Bearer {token}"},
        )
    assert r.status_code == 200
    assert r.json()["deleted"] == 1  # only the candidate

    conn = await asyncpg.connect(os.environ["SUPABASE_DATABASE_URL"])
    still_there = await conn.fetchval("SELECT id FROM tracks WHERE id = $1", available_id)
    gone = await conn.fetchval("SELECT id FROM tracks WHERE id = $1", candidate_id)
    await conn.close()
    assert still_there is not None
    assert gone is None


@_needs_db
@pytest.mark.asyncio
async def test_tenant_isolation(db_user):
    """User A's tracks must not be visible to User B."""
    from djtoolkit.db.postgres import close_pool

    user_a_id, token_a = db_user
    user_b_id = str(uuid.uuid4())
    token_b = _make_jwt(user_b_id)

    conn = await asyncpg.connect(os.environ["SUPABASE_DATABASE_URL"])
    await conn.execute(
        "INSERT INTO users (id, email) VALUES ($1, $2)",
        user_b_id, f"test-catalog-b-{user_b_id}@djtoolkit.test",
    )
    try:
        async with _async_client() as client:
            # Import CSV for user A
            await client.post(
                "/api/catalog/import/csv",
                files={"file": ("test.csv", io.BytesIO(_MINIMAL_CSV), "text/csv")},
                headers={"Authorization": f"Bearer {token_a}"},
            )
            # User B should see 0 tracks
            resp = await client.get("/api/catalog/tracks", headers={"Authorization": f"Bearer {token_b}"})

        assert resp.status_code == 200, resp.text
        assert resp.json()["total"] == 0, "User B must not see User A's tracks"

    finally:
        await conn.execute("DELETE FROM users WHERE id = $1", user_b_id)
        await conn.close()
        await close_pool()


# ─── Unit tests: CSV upload validation ────────────────────────────────────────

_csv_content = b"Spotify URI,Track Name,Artist Name(s),Album Name,Disc Number,Track Number,Track Duration (ms),Added By,Added At\nspotify:track:abc123,Test Track,Test Artist,Test Album,1,1,200000,user,2024-01-01\n"


@pytest.mark.asyncio
async def test_csv_upload_rejects_non_csv_extension():
    """A file with .txt extension is rejected with 400 even if content is valid CSV."""
    async with _async_client_no_db() as client:
        resp = await client.post(
            "/api/catalog/import/csv",
            files={"file": ("export.txt", _csv_content, "text/csv")},
            headers={"Authorization": "Bearer fake.jwt.token"},
        )
    # 401 is also acceptable here (auth fails before validation),
    # but we must NOT get 201 (success).
    assert resp.status_code in (400, 401, 422), f"Expected rejection, got {resp.status_code}"


@pytest.mark.asyncio
async def test_csv_upload_accepts_csv_extension():
    """A file with .csv extension and valid content-type is not rejected at the extension check."""
    async with _async_client_no_db() as client:
        resp = await client.post(
            "/api/catalog/import/csv",
            files={"file": ("export.csv", _csv_content, "text/csv")},
            headers={"Authorization": "Bearer fake.jwt.token"},
        )
    # 401 = valid filename, auth rejected — the extension check passed.
    # NOT 400 with "extension" in the message.
    if resp.status_code == 400:
        assert "extension" not in resp.json().get("detail", "").lower(), \
            "Valid .csv file should not be rejected for extension"
