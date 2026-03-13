"""Tests for djtoolkit/api/auth.py and /api/agents routes.

Unit tests (no DB needed):
  - create_agent_key format and bcrypt round-trip
  - verify_jwt succeeds with a valid token
  - verify_jwt raises 401 on expired / wrong-secret tokens
  - get_current_user dispatches by token shape (no actual DB call for JWT path)

Integration tests (require SUPABASE_DATABASE_URL + SUPABASE_JWT_SECRET):
  - Full agent register → key auth → heartbeat → list → delete cycle
  - User A's agent key cannot list User B's agents (isolation)

Run manually:
    SUPABASE_DATABASE_URL="..." SUPABASE_JWT_SECRET="..." poetry run pytest tests/test_auth.py -v
"""

from __future__ import annotations

import os
import time
import uuid

import asyncpg
import httpx
import pytest
import pytest_asyncio
from fastapi.testclient import TestClient
from jose import jwt

from djtoolkit.api.auth import CurrentUser, create_agent_key, verify_jwt
from djtoolkit.api.app import app


# ─── skip markers ─────────────────────────────────────────────────────────────

_needs_jwt = pytest.mark.skipif(
    not os.environ.get("SUPABASE_JWT_SECRET"),
    reason="SUPABASE_JWT_SECRET not set",
)
_needs_db = pytest.mark.skipif(
    not (os.environ.get("SUPABASE_DATABASE_URL") and os.environ.get("SUPABASE_JWT_SECRET")),
    reason="SUPABASE_DATABASE_URL or SUPABASE_JWT_SECRET not set",
)

# ─── helpers ──────────────────────────────────────────────────────────────────

def _make_jwt(user_id: str, *, expired: bool = False, wrong_secret: bool = False) -> str:
    """Create a signed JWT mimicking what Supabase Auth would issue."""
    secret = os.environ.get("SUPABASE_JWT_SECRET", "test-secret")
    if wrong_secret:
        secret = "totally-wrong-secret"
    now = int(time.time())
    payload = {
        "sub": user_id,
        "aud": "authenticated",    # Supabase always includes this
        "iat": now - 3600 if expired else now,
        "exp": now - 1 if expired else now + 3600,
    }
    return jwt.encode(payload, secret, algorithm="HS256")


def _make_jwt_with_aud(user_id: str, aud: str) -> str:
    """Create a JWT with a specific audience claim for testing audience validation."""
    secret = os.environ.get("SUPABASE_JWT_SECRET", "test-secret")
    now = int(time.time())
    payload = {"sub": user_id, "aud": aud, "iat": now, "exp": now + 3600}
    return jwt.encode(payload, secret, algorithm="HS256")


# ─── unit tests: create_agent_key ─────────────────────────────────────────────

def test_create_agent_key_format():
    """Plain key starts with djt_ and is ~44 chars; bcrypt hash verifies."""
    import bcrypt
    plain, hashed = create_agent_key()
    assert plain.startswith("djt_")
    assert len(plain) > 20
    assert bcrypt.checkpw(plain.encode(), hashed.encode()), "bcrypt hash must verify against the plain key"


def test_create_agent_key_unique():
    """Two consecutive calls return different keys."""
    plain1, _ = create_agent_key()
    plain2, _ = create_agent_key()
    assert plain1 != plain2


# ─── unit tests: verify_jwt ───────────────────────────────────────────────────

@pytest.fixture()
def hs256_env(monkeypatch):
    """Clear EC key env vars so verify_jwt uses the HS256 / SUPABASE_JWT_SECRET path."""
    monkeypatch.delenv("SUPABASE_JWT_EC_X", raising=False)
    monkeypatch.delenv("SUPABASE_JWT_EC_Y", raising=False)


@_needs_jwt
@pytest.mark.asyncio
async def test_verify_jwt_valid(hs256_env):
    """Valid JWT resolves to CurrentUser with correct user_id."""
    user_id = str(uuid.uuid4())
    token = _make_jwt(user_id)
    user = await verify_jwt(token)
    assert isinstance(user, CurrentUser)
    assert user.user_id == user_id
    assert user.agent_id is None


@_needs_jwt
@pytest.mark.asyncio
async def test_verify_jwt_expired(hs256_env):
    """Expired JWT raises HTTP 401."""
    from fastapi import HTTPException
    user_id = str(uuid.uuid4())
    token = _make_jwt(user_id, expired=True)
    with pytest.raises(HTTPException) as exc_info:
        await verify_jwt(token)
    assert exc_info.value.status_code == 401


@_needs_jwt
@pytest.mark.asyncio
async def test_verify_jwt_wrong_secret(hs256_env):
    """JWT signed with wrong secret raises HTTP 401."""
    from fastapi import HTTPException
    user_id = str(uuid.uuid4())
    token = _make_jwt(user_id, wrong_secret=True)
    with pytest.raises(HTTPException) as exc_info:
        await verify_jwt(token)
    assert exc_info.value.status_code == 401


@_needs_jwt
@pytest.mark.asyncio
async def test_verify_jwt_wrong_audience(hs256_env):
    """JWT with wrong 'aud' claim raises HTTP 401."""
    from fastapi import HTTPException
    token = _make_jwt_with_aud(str(uuid.uuid4()), aud="service_role")
    with pytest.raises(HTTPException) as exc_info:
        await verify_jwt(token)
    assert exc_info.value.status_code == 401


@_needs_jwt
@pytest.mark.asyncio
async def test_verify_jwt_correct_audience(hs256_env):
    """JWT with aud='authenticated' passes validation."""
    user_id = str(uuid.uuid4())
    token = _make_jwt_with_aud(user_id, aud="authenticated")
    user = await verify_jwt(token)
    assert user.user_id == user_id


# ─── unit tests: get_current_user dispatch (JWT path, no DB) ──────────────────

@_needs_jwt
def test_get_current_user_jwt_path(monkeypatch):
    """A 3-segment token goes through JWT verification (no DB needed)."""
    monkeypatch.delenv("SUPABASE_JWT_EC_X", raising=False)
    monkeypatch.delenv("SUPABASE_JWT_EC_Y", raising=False)
    user_id = str(uuid.uuid4())
    token = _make_jwt(user_id)
    with TestClient(app, raise_server_exceptions=True) as client:
        # Use a route that requires auth; the GET /api/agents endpoint suffices.
        resp = client.get(
            "/api/agents",
            headers={"Authorization": f"Bearer {token}"},
        )
    # Either 200 (DB connected) or 500 (no DB) — but NOT 401 for a valid JWT.
    assert resp.status_code != 401, f"Expected valid JWT to pass auth, got 401: {resp.json()}"


@_needs_jwt
def test_get_current_user_missing_header():
    """Missing Authorization header returns 422."""
    with TestClient(app, raise_server_exceptions=True) as client:
        resp = client.get("/api/agents")
    assert resp.status_code == 422


@_needs_jwt
def test_get_current_user_wrong_scheme():
    """Non-Bearer Authorization scheme returns 401."""
    with TestClient(app, raise_server_exceptions=True) as client:
        resp = client.get(
            "/api/agents",
            headers={"Authorization": "Basic dXNlcjpwYXNz"},
        )
    assert resp.status_code == 401


# ─── integration tests: full agent lifecycle ──────────────────────────────────

@pytest_asyncio.fixture
async def test_user_jwt():
    """A fresh JWT for a throw-away user UUID (no DB row needed for JWT auth)."""
    user_id = str(uuid.uuid4())
    token = _make_jwt(user_id)
    return user_id, token


def _async_client():
    """Return an httpx AsyncClient that drives the ASGI app in the same event loop.

    Using ASGITransport instead of TestClient avoids the event loop mismatch:
    TestClient runs the app in a thread with its own loop, which causes asyncpg
    pool operations to fail with "Future attached to a different loop".
    """
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
    )


@_needs_db
@pytest.mark.asyncio
async def test_agent_register_and_auth(test_user_jwt):
    """Register agent, authenticate with the returned key, then clean up."""
    from djtoolkit.db.postgres import close_pool

    user_id, jwt_token = test_user_jwt

    # Use a direct connection for setup/teardown — avoids pool singleton conflicts.
    conn = await asyncpg.connect(os.environ["SUPABASE_DATABASE_URL"])
    await conn.execute(
        "INSERT INTO users (id, email) VALUES ($1, $2)",
        user_id, f"test-{user_id}@djtoolkit.test",
    )

    try:
        async with _async_client() as client:
            # 1. Register a new agent
            resp = await client.post(
                "/api/agents/register",
                json={"machine_name": "test-machine", "capabilities": ["fpcalc"]},
                headers={"Authorization": f"Bearer {jwt_token}"},
            )
            assert resp.status_code == 201, resp.text
            data = resp.json()
            agent_id = data["agent_id"]
            api_key = data["api_key"]
            assert api_key.startswith("djt_")

            # 2. Authenticate using the agent key
            resp = await client.get(
                "/api/agents",
                headers={"Authorization": f"Bearer {api_key}"},
            )
            assert resp.status_code == 200, resp.text
            agents = resp.json()
            assert any(a["id"] == agent_id for a in agents)

            # 3. Heartbeat with the agent key
            resp = await client.post(
                "/api/agents/heartbeat",
                json={"capabilities": ["fpcalc", "librosa"]},
                headers={"Authorization": f"Bearer {api_key}"},
            )
            assert resp.status_code == 204, resp.text

            # 4. Delete the agent
            resp = await client.delete(
                f"/api/agents/{agent_id}",
                headers={"Authorization": f"Bearer {jwt_token}"},
            )
            assert resp.status_code == 204, resp.text

            # 5. Revoked key no longer authenticates
            resp = await client.get(
                "/api/agents",
                headers={"Authorization": f"Bearer {api_key}"},
            )
            assert resp.status_code == 401, "Deleted agent key should be rejected"

    finally:
        await conn.execute("DELETE FROM users WHERE id = $1", user_id)
        await conn.close()
        await close_pool()


@_needs_db
@pytest.mark.asyncio
async def test_agent_isolation_between_users():
    """User A's JWT cannot see or delete User B's agents."""
    from djtoolkit.db.postgres import close_pool

    user_a = str(uuid.uuid4())
    user_b = str(uuid.uuid4())
    jwt_a = _make_jwt(user_a)
    jwt_b = _make_jwt(user_b)

    conn = await asyncpg.connect(os.environ["SUPABASE_DATABASE_URL"])
    await conn.execute(
        "INSERT INTO users (id, email) VALUES ($1, $2), ($3, $4)",
        user_a, f"test-{user_a}@djtoolkit.test",
        user_b, f"test-{user_b}@djtoolkit.test",
    )

    try:
        async with _async_client() as client:
            # User B registers an agent
            resp = await client.post(
                "/api/agents/register",
                json={"machine_name": "user-b-machine"},
                headers={"Authorization": f"Bearer {jwt_b}"},
            )
            assert resp.status_code == 201, resp.text
            agent_b_id = resp.json()["agent_id"]

            # User A lists agents — should NOT see user B's agent
            resp = await client.get(
                "/api/agents",
                headers={"Authorization": f"Bearer {jwt_a}"},
            )
            assert resp.status_code == 200, resp.text
            agent_ids_a = [a["id"] for a in resp.json()]
            assert agent_b_id not in agent_ids_a, "User A must not see User B's agents"

            # User A tries to delete User B's agent — should 404
            resp = await client.delete(
                f"/api/agents/{agent_b_id}",
                headers={"Authorization": f"Bearer {jwt_a}"},
            )
            assert resp.status_code == 404, "User A must not delete User B's agents"

    finally:
        await conn.execute(
            "DELETE FROM users WHERE id = ANY($1::uuid[])",
            [user_a, user_b],
        )
        await conn.close()
        await close_pool()
