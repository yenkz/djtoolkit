"""Integration tests for djtoolkit/db/postgres.py.

These tests require a live Supabase connection and are skipped automatically
when SUPABASE_DATABASE_URL is not set.  They verify:

1. get_pool() returns a working connection pool.
2. rls_transaction() sets app.current_user_id for the transaction.
3. RLS isolates tracks between two users (the core multi-tenancy guarantee).

Run manually:
    SUPABASE_DATABASE_URL="postgresql://..." poetry run pytest tests/test_postgres.py -v
"""

import os
import uuid

import pytest
import pytest_asyncio


# ─── skip marker ──────────────────────────────────────────────────────────────
pytestmark = pytest.mark.skipif(
    not os.environ.get("SUPABASE_DATABASE_URL"),
    reason="SUPABASE_DATABASE_URL not set — skipping Postgres integration tests",
)

# ─── imports after skip guard (asyncpg not needed if skipping) ────────────────
import asyncpg  # noqa: E402

from djtoolkit.db.postgres import close_pool, get_pool, rls_transaction  # noqa: E402


# ─── fixtures ─────────────────────────────────────────────────────────────────

@pytest_asyncio.fixture(scope="module")
async def pool():
    p = await get_pool()
    yield p
    await close_pool()


@pytest_asyncio.fixture
async def two_users(pool):
    """Insert two test users, yield their UUIDs, then clean up."""
    user_a = str(uuid.uuid4())
    user_b = str(uuid.uuid4())
    email_a = f"test-{user_a}@djtoolkit.test"
    email_b = f"test-{user_b}@djtoolkit.test"

    # service_role connection bypasses RLS — insert directly
    await pool.execute(
        "INSERT INTO users (id, email) VALUES ($1, $2), ($3, $4)",
        user_a, email_a, user_b, email_b,
    )

    yield user_a, user_b

    await pool.execute(
        "DELETE FROM users WHERE id = ANY($1::uuid[])",
        [user_a, user_b],
    )


# ─── tests ────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_get_pool_returns_pool(pool):
    """get_pool() returns a connected asyncpg pool."""
    assert pool is not None
    assert isinstance(pool, asyncpg.Pool)


@pytest.mark.asyncio
async def test_get_pool_singleton():
    """Calling get_pool() twice returns the same pool object."""
    p1 = await get_pool()
    p2 = await get_pool()
    assert p1 is p2


@pytest.mark.asyncio
async def test_rls_transaction_sets_user_id(pool, two_users):
    """rls_transaction sets app.current_user_id inside the transaction."""
    user_a, _ = two_users
    async with rls_transaction(pool, user_a) as conn:
        value = await conn.fetchval(
            "SELECT current_setting('app.current_user_id', true)"
        )
    assert value == str(user_a)


@pytest.mark.asyncio
async def test_rls_transaction_clears_after_exit(pool, two_users):
    """app.current_user_id is cleared (returns empty string) after the transaction ends."""
    user_a, _ = two_users
    async with rls_transaction(pool, user_a):
        pass  # transaction committed

    # Outside the transaction the setting should be gone (empty string with missing_ok=true)
    raw = await pool.fetchval(
        "SELECT current_setting('app.current_user_id', true)"
    )
    # PostgreSQL returns '' when missing_ok=true and setting is unset
    assert raw in (None, "")


@pytest.mark.asyncio
async def test_rls_isolates_tracks_between_users(pool, two_users):
    """Tracks inserted for user A are not visible when querying as user B."""
    user_a, user_b = two_users

    # Insert one track for each user using service_role (bypasses RLS)
    track_a_id = await pool.fetchval(
        """INSERT INTO tracks (user_id, acquisition_status, source, title, artist)
           VALUES ($1, 'candidate', 'exportify', 'Track A', 'Artist A')
           RETURNING id""",
        user_a,
    )
    track_b_id = await pool.fetchval(
        """INSERT INTO tracks (user_id, acquisition_status, source, title, artist)
           VALUES ($1, 'candidate', 'exportify', 'Track B', 'Artist B')
           RETURNING id""",
        user_b,
    )

    try:
        # Query as user A via RLS — should only see track_a
        async with rls_transaction(pool, user_a) as conn:
            rows_a = await conn.fetch(
                "SELECT id FROM tracks WHERE id = ANY($1::bigint[])",
                [track_a_id, track_b_id],
            )
        ids_a = {r["id"] for r in rows_a}
        assert track_a_id in ids_a, "User A should see their own track"
        assert track_b_id not in ids_a, "User A must NOT see user B's track"

        # Query as user B via RLS — should only see track_b
        async with rls_transaction(pool, user_b) as conn:
            rows_b = await conn.fetch(
                "SELECT id FROM tracks WHERE id = ANY($1::bigint[])",
                [track_a_id, track_b_id],
            )
        ids_b = {r["id"] for r in rows_b}
        assert track_b_id in ids_b, "User B should see their own track"
        assert track_a_id not in ids_b, "User B must NOT see user A's track"

    finally:
        await pool.execute(
            "DELETE FROM tracks WHERE id = ANY($1::bigint[])",
            [track_a_id, track_b_id],
        )
