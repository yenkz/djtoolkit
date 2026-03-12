"""Tests for djtoolkit/api/pipeline_routes.py.

Unit tests (no DB needed):
  - recover_stale_jobs is importable
  - broadcast does not crash when no listeners are subscribed

Integration tests (require SUPABASE_DATABASE_URL + SUPABASE_JWT_SECRET):
  - GET /pipeline/status returns pending=0, running=0 for fresh user
  - GET /pipeline/jobs returns empty list for fresh user
  - Full job lifecycle: pending → claim → report done → track flags updated
  - Claim race: second claim of same job returns 409
  - report_result 'failed' on download job marks track as failed
  - Auto-queue: completing a download job creates a fingerprint job
  - recover_stale_jobs resets claimed jobs older than 5 minutes

Run manually:
    SUPABASE_DATABASE_URL="..." SUPABASE_JWT_SECRET="..." poetry run pytest tests/test_pipeline_routes.py -v
"""

from __future__ import annotations

import json
import os
import time
import uuid

import asyncpg
import httpx
import pytest
import pytest_asyncio
from jose import jwt

from djtoolkit.api.app import app
from djtoolkit.api.pipeline_routes import broadcast, recover_stale_jobs


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


# ─── Unit tests ───────────────────────────────────────────────────────────────

def test_broadcast_no_listeners():
    """broadcast must not raise if no SSE clients are connected."""
    broadcast("nonexistent-user-id", "job_update", {"job_id": "test"})


def test_recover_stale_jobs_importable():
    """recover_stale_jobs is importable (no DB call at import time)."""
    import inspect
    assert inspect.iscoroutinefunction(recover_stale_jobs)


# ─── Fixtures ─────────────────────────────────────────────────────────────────

@pytest_asyncio.fixture
async def db_user_with_agent():
    """Create a user + registered agent. Yields (user_id, jwt_token, agent_id, api_key)."""
    from djtoolkit.api.auth import create_agent_key

    user_id = str(uuid.uuid4())
    agent_id = str(uuid.uuid4())
    plain_key, key_hash = create_agent_key()
    token = _make_jwt(user_id)

    conn = await asyncpg.connect(os.environ["SUPABASE_DATABASE_URL"])
    await conn.execute(
        "INSERT INTO users (id, email) VALUES ($1, $2)",
        user_id, f"test-pipeline-{user_id}@djtoolkit.test",
    )
    await conn.execute(
        "INSERT INTO agents (id, user_id, api_key_hash, machine_name) VALUES ($1, $2, $3, $4)",
        agent_id, user_id, key_hash, "test-machine",
    )
    yield user_id, token, agent_id, plain_key

    await conn.execute("DELETE FROM users WHERE id = $1", user_id)
    await conn.close()


# ─── Integration tests ────────────────────────────────────────────────────────

@_needs_db
@pytest.mark.asyncio
async def test_pipeline_status_empty(db_user_with_agent):
    user_id, token, agent_id, api_key = db_user_with_agent
    async with _async_client() as client:
        resp = await client.get("/api/pipeline/status", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["pending"] == 0
    assert data["running"] == 0
    assert len(data["agents"]) == 1
    assert data["agents"][0]["id"] == agent_id


@_needs_db
@pytest.mark.asyncio
async def test_fetch_jobs_empty(db_user_with_agent):
    user_id, token, agent_id, api_key = db_user_with_agent
    async with _async_client() as client:
        resp = await client.get("/api/pipeline/jobs", headers={"Authorization": f"Bearer {api_key}"})
    assert resp.status_code == 200, resp.text
    assert resp.json() == []


@_needs_db
@pytest.mark.asyncio
async def test_full_job_lifecycle(db_user_with_agent):
    """pending → claim → report done → track flags updated."""
    user_id, token, agent_id, api_key = db_user_with_agent
    conn = await asyncpg.connect(os.environ["SUPABASE_DATABASE_URL"])

    try:
        # Insert a track and a pending download job
        track_id = await conn.fetchval(
            """
            INSERT INTO tracks (user_id, acquisition_status, source, title, artist, search_string)
            VALUES ($1, 'candidate', 'exportify', 'Pipeline Test', 'Artist', 'artist pipeline test')
            RETURNING id
            """,
            user_id,
        )
        job_id = await conn.fetchval(
            """
            INSERT INTO pipeline_jobs (user_id, track_id, job_type, payload)
            VALUES ($1, $2, 'download', $3)
            RETURNING id::text
            """,
            user_id, track_id,
            json.dumps({"track_id": track_id, "search_string": "artist pipeline test",
                        "artist": "Artist", "title": "Pipeline Test", "duration_ms": 200000}),
        )

        async with _async_client() as client:
            # 1. Agent fetches jobs
            resp = await client.get("/api/pipeline/jobs", headers={"Authorization": f"Bearer {api_key}"})
            assert resp.status_code == 200, resp.text
            jobs = resp.json()
            assert any(j["id"] == job_id for j in jobs), f"Job {job_id} not in {jobs}"

            # 2. Agent claims the job
            resp = await client.post(
                f"/api/pipeline/jobs/{job_id}/claim",
                headers={"Authorization": f"Bearer {api_key}"},
            )
            assert resp.status_code == 200, resp.text
            claimed = resp.json()
            assert claimed["id"] == job_id
            assert claimed["status"] == "claimed"

            # 3. Agent reports success
            resp = await client.put(
                f"/api/pipeline/jobs/{job_id}/result",
                json={
                    "result": {"local_path": "/tmp/test.mp3", "file_format": "mp3", "file_size": 8_000_000},
                    "error": None,
                    "status": "done",
                },
                headers={"Authorization": f"Bearer {api_key}"},
            )
            assert resp.status_code == 204, resp.text

        # 4. Verify track was updated
        track = await conn.fetchrow("SELECT acquisition_status, local_path FROM tracks WHERE id = $1", track_id)
        assert track["acquisition_status"] == "available"
        assert track["local_path"] == "/tmp/test.mp3"

        # 5. Verify job is marked done
        job = await conn.fetchrow("SELECT status FROM pipeline_jobs WHERE id = $1::uuid", job_id)
        assert job["status"] == "done"

        # 6. Verify a fingerprint job was auto-queued
        fp_job = await conn.fetchrow(
            "SELECT job_type FROM pipeline_jobs WHERE track_id = $1 AND job_type = 'fingerprint'", track_id
        )
        assert fp_job is not None, "fingerprint job should have been auto-queued"

    finally:
        await conn.execute("DELETE FROM tracks WHERE id = $1", track_id)
        await conn.close()


@_needs_db
@pytest.mark.asyncio
async def test_claim_race_returns_409(db_user_with_agent):
    """Claiming an already-claimed job returns 409."""
    user_id, token, agent_id, api_key = db_user_with_agent
    conn = await asyncpg.connect(os.environ["SUPABASE_DATABASE_URL"])

    try:
        track_id = await conn.fetchval(
            "INSERT INTO tracks (user_id, acquisition_status, source, title, artist, search_string) VALUES ($1, 'candidate', 'exportify', 'Race Track', 'Artist', 'artist race track') RETURNING id",
            user_id,
        )
        job_id = await conn.fetchval(
            "INSERT INTO pipeline_jobs (user_id, track_id, job_type, payload) VALUES ($1, $2, 'download', '{}') RETURNING id::text",
            user_id, track_id,
        )

        async with _async_client() as client:
            # First claim — should succeed
            r1 = await client.post(
                f"/api/pipeline/jobs/{job_id}/claim",
                headers={"Authorization": f"Bearer {api_key}"},
            )
            assert r1.status_code == 200, r1.text

            # Second claim of same job — should conflict
            r2 = await client.post(
                f"/api/pipeline/jobs/{job_id}/claim",
                headers={"Authorization": f"Bearer {api_key}"},
            )
            assert r2.status_code == 409, f"Expected 409, got {r2.status_code}: {r2.text}"

    finally:
        await conn.execute("DELETE FROM tracks WHERE id = $1", track_id)
        await conn.close()


@_needs_db
@pytest.mark.asyncio
async def test_failed_download_marks_track_failed(db_user_with_agent):
    user_id, token, agent_id, api_key = db_user_with_agent
    conn = await asyncpg.connect(os.environ["SUPABASE_DATABASE_URL"])

    try:
        track_id = await conn.fetchval(
            "INSERT INTO tracks (user_id, acquisition_status, source, title, artist, search_string) VALUES ($1, 'candidate', 'exportify', 'Fail Track', 'Artist', 'artist fail track') RETURNING id",
            user_id,
        )
        job_id = await conn.fetchval(
            "INSERT INTO pipeline_jobs (user_id, track_id, job_type, payload) VALUES ($1, $2, 'download', '{}') RETURNING id::text",
            user_id, track_id,
        )

        async with _async_client() as client:
            await client.post(f"/api/pipeline/jobs/{job_id}/claim", headers={"Authorization": f"Bearer {api_key}"})
            resp = await client.put(
                f"/api/pipeline/jobs/{job_id}/result",
                json={"result": None, "error": "No Soulseek results", "status": "failed"},
                headers={"Authorization": f"Bearer {api_key}"},
            )
        assert resp.status_code == 204, resp.text

        track = await conn.fetchrow("SELECT acquisition_status FROM tracks WHERE id = $1", track_id)
        assert track["acquisition_status"] == "failed"

    finally:
        await conn.execute("DELETE FROM tracks WHERE id = $1", track_id)
        await conn.close()


@_needs_db
@pytest.mark.asyncio
async def test_recover_stale_jobs_resets_old_claims(db_user_with_agent):
    """Jobs claimed more than 5 minutes ago are reset to pending."""
    user_id, token, agent_id, api_key = db_user_with_agent
    conn = await asyncpg.connect(os.environ["SUPABASE_DATABASE_URL"])

    try:
        track_id = await conn.fetchval(
            "INSERT INTO tracks (user_id, acquisition_status, source, title, artist, search_string) VALUES ($1, 'candidate', 'exportify', 'Stale Track', 'Artist', 'artist stale track') RETURNING id",
            user_id,
        )
        # Insert a job that was claimed 10 minutes ago (stale)
        job_id = await conn.fetchval(
            """
            INSERT INTO pipeline_jobs (user_id, track_id, job_type, status, agent_id, claimed_at, payload)
            VALUES ($1, $2, 'download', 'claimed', $3, NOW() - INTERVAL '10 minutes', '{}')
            RETURNING id::text
            """,
            user_id, track_id, agent_id,
        )

        recovered = await recover_stale_jobs()
        assert recovered >= 1, "Should have recovered at least one stale job"

        row = await conn.fetchrow("SELECT status, claimed_at, agent_id FROM pipeline_jobs WHERE id = $1::uuid", job_id)
        assert row["status"] == "pending"
        assert row["claimed_at"] is None
        assert row["agent_id"] is None

    finally:
        await conn.execute("DELETE FROM tracks WHERE id = $1", track_id)
        await conn.close()
