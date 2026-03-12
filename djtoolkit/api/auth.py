"""Dual-path authentication for djtoolkit API.

Two credential types are accepted:
  - Supabase JWT (3-segment Bearer token) — issued by Supabase Auth for web users.
  - Agent API key  (``djt_`` prefix)      — bcrypt-verified against the ``agents`` table.

Usage (FastAPI)::

    @router.get("/catalog/tracks")
    async def list_tracks(user: CurrentUser = Depends(get_current_user)):
        ...

Generating an agent key (one-time, shown to the user)::

    plain_key, key_hash = create_agent_key()
    # store key_hash in agents.api_key_hash; display plain_key once
"""

from __future__ import annotations

import os
import secrets
from dataclasses import dataclass

import bcrypt as _bcrypt_lib

from fastapi import Header, HTTPException, status
from jose import JWTError, jwt

from djtoolkit.db.postgres import get_pool


# ─── Password / key hashing ───────────────────────────────────────────────────
# Use bcrypt directly — passlib 1.7.4 is incompatible with bcrypt 4.x on
# Python 3.14 (detect_wrap_bug tries a 214-byte password which bcrypt 4.x rejects).

def _hash_key(plain: str) -> str:
    return _bcrypt_lib.hashpw(plain.encode(), _bcrypt_lib.gensalt()).decode()


def _verify_key(plain: str, hashed: str) -> bool:
    return _bcrypt_lib.checkpw(plain.encode(), hashed.encode())


def create_agent_key() -> tuple[str, str]:
    """Return ``(plain_key, bcrypt_hash)`` for a new agent API key.

    The plain key is displayed to the user once and never stored.
    The hash is stored in ``agents.api_key_hash``.

    Example::

        plain, hashed = create_agent_key()
        # plain  → "djt_a3f1c2..."   (shown to user once)
        # hashed → "$2b$12$..."       (stored in DB)
    """
    plain = "djt_" + secrets.token_hex(20)
    hashed = _hash_key(plain)
    return plain, hashed


# ─── Current user context ─────────────────────────────────────────────────────

@dataclass
class CurrentUser:
    """Authenticated identity attached to a request."""

    user_id: str               # UUID from JWT sub / agents.user_id
    agent_id: str | None = None  # set when authenticated via agent API key


# ─── JWT verification ─────────────────────────────────────────────────────────

def _jwt_secret() -> str:
    secret = os.environ.get("SUPABASE_JWT_SECRET")
    if not secret:
        raise RuntimeError(
            "SUPABASE_JWT_SECRET is not set. Add it to your .env file."
        )
    return secret


async def verify_jwt(token: str) -> CurrentUser:
    """Decode and verify a Supabase JWT.  Raises 401 on any failure."""
    credentials_exc = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid or expired token",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(
            token,
            _jwt_secret(),
            algorithms=["HS256"],
            options={"verify_aud": False},
        )
        user_id: str | None = payload.get("sub")
        if not user_id:
            raise credentials_exc
    except JWTError:
        raise credentials_exc
    return CurrentUser(user_id=user_id)


# ─── Agent key verification ───────────────────────────────────────────────────

async def verify_agent_key(token: str) -> CurrentUser:
    """Verify a ``djt_`` agent API key against ``agents.api_key_hash`` in the DB.

    Raises 401 if the key is not found or does not match any stored hash.
    """
    credentials_exc = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid agent API key",
        headers={"WWW-Authenticate": "Bearer"},
    )
    pool = await get_pool()
    # Fetch all agents; bcrypt verification is the slow step — do it in Python.
    # For MVP scale (each user has ≤ ~5 agents) a full-table scan is fine.
    rows = await pool.fetch(
        "SELECT id, user_id, api_key_hash FROM agents"
    )
    for row in rows:
        try:
            if _verify_key(token, row["api_key_hash"]):
                return CurrentUser(
                    user_id=str(row["user_id"]),
                    agent_id=str(row["id"]),
                )
        except Exception:
            continue
    raise credentials_exc


# ─── FastAPI dependency ───────────────────────────────────────────────────────

async def get_current_user(
    authorization: str = Header(..., alias="Authorization"),
) -> CurrentUser:
    """FastAPI dependency — resolves to ``CurrentUser`` from JWT or agent key.

    Dispatches based on token shape:
    - Three dot-separated segments → Supabase JWT
    - ``djt_`` prefix              → agent API key
    """
    if not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authorization header must use Bearer scheme",
            headers={"WWW-Authenticate": "Bearer"},
        )
    token = authorization[len("Bearer "):]

    if token.count(".") == 2:
        return await verify_jwt(token)
    return await verify_agent_key(token)
