"""asyncpg connection pool + RLS context helper for the cloud Postgres DB.

Usage
-----
    pool = await get_pool()

    # Read — no RLS (service_role connection)
    rows = await pool.fetch("SELECT id FROM users WHERE email = $1", email)

    # Read/write scoped to one user (sets app.current_user_id for the transaction)
    async with rls_transaction(pool, user_id) as conn:
        rows = await conn.fetch("SELECT * FROM tracks")
        await conn.execute("INSERT INTO tracks ...", ...)

    # Clean up on app shutdown
    await close_pool()
"""

from __future__ import annotations

import os
from contextlib import asynccontextmanager
from typing import AsyncIterator, TYPE_CHECKING

# Lazy import — asyncpg is server-side only and excluded from the agent binary.
# TYPE_CHECKING guard prevents import at runtime in agent mode.
if TYPE_CHECKING:
    import asyncpg


_pool: asyncpg.Pool | None = None


async def get_pool() -> asyncpg.Pool:
    """Return the singleton asyncpg pool, creating it on first call.

    Reads ``SUPABASE_DATABASE_URL`` from the environment.  Raises
    ``RuntimeError`` if the variable is not set.
    """
    global _pool
    if _pool is None:
        url = os.environ.get("SUPABASE_DATABASE_URL")
        if not url:
            raise RuntimeError(
                "SUPABASE_DATABASE_URL is not set. "
                "Add it to your .env file (see .env.example)."
            )
        import asyncpg as _asyncpg
        _pool = await _asyncpg.create_pool(url, min_size=1, max_size=10)
    return _pool


async def close_pool() -> None:
    """Close the pool.  Call during application shutdown."""
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


@asynccontextmanager
async def rls_transaction(
    pool: asyncpg.Pool, user_id: str
) -> AsyncIterator[asyncpg.Connection]:
    """Acquire a connection, open a transaction, and set ``app.current_user_id``.

    The setting is transaction-local (equivalent to ``SET LOCAL``), so it is
    automatically cleared when the transaction ends.

    Example::

        async with rls_transaction(pool, str(current_user.id)) as conn:
            rows = await conn.fetch("SELECT * FROM tracks")
    """
    async with pool.acquire() as conn:
        async with conn.transaction():
            # Drop to authenticated role so RLS policies fire.
            # The pool connects as postgres (superuser) which bypasses RLS;
            # SET LOCAL ROLE reverts automatically at transaction end.
            await conn.execute("SET LOCAL ROLE authenticated")
            # Set the custom GUC that isolation policies filter on.
            await conn.execute(
                "SELECT set_config('app.current_user_id', $1, true)",
                str(user_id),
            )
            yield conn
