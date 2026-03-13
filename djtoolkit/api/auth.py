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
import base64
from dataclasses import dataclass

import bcrypt as _bcrypt_lib

from fastapi import Header, HTTPException, status
from jose import JWTError, jwt
from cryptography.hazmat.primitives.asymmetric.ec import (
    EllipticCurvePublicKey, SECP256R1, EllipticCurvePublicNumbers,
)
from cryptography.hazmat.backends import default_backend

import logging

from djtoolkit.db.postgres import get_pool

_auth_log = logging.getLogger(__name__)


# ─── Password / key hashing ───────────────────────────────────────────────────
# Use bcrypt directly — passlib 1.7.4 is incompatible with bcrypt 4.x on
# Python 3.14 (detect_wrap_bug tries a 214-byte password which bcrypt 4.x rejects).

def _hash_key(plain: str) -> str:
    return _bcrypt_lib.hashpw(plain.encode(), _bcrypt_lib.gensalt()).decode()


def _verify_key(plain: str, hashed: str) -> bool:
    return _bcrypt_lib.checkpw(plain.encode(), hashed.encode())


def create_agent_key() -> tuple[str, str, str]:
    """Return ``(plain_key, bcrypt_hash, key_prefix)`` for a new agent API key.

    The plain key is displayed to the user once and never stored.
    The hash is stored in ``agents.api_key_hash``.
    The prefix (first 8 hex chars after ``djt_``) is stored in
    ``agents.api_key_prefix`` for indexed lookup.

    Example::

        plain, hashed, prefix = create_agent_key()
        # plain  → "djt_a3f1c2..."   (shown to user once)
        # hashed → "$2b$12$..."       (stored in DB)
        # prefix → "a3f1c2d4"         (stored for indexed lookup)
    """
    plain = "djt_" + secrets.token_hex(20)
    hashed = _hash_key(plain)
    prefix = plain[4:12]  # first 8 chars after djt_
    return plain, hashed, prefix


# ─── Current user context ─────────────────────────────────────────────────────

@dataclass
class CurrentUser:
    """Authenticated identity attached to a request."""

    user_id: str               # UUID from JWT sub / agents.user_id
    email: str | None = None   # from JWT email claim (None for agent keys)
    agent_id: str | None = None  # set when authenticated via agent API key


# ─── JWT verification ─────────────────────────────────────────────────────────

# Supabase ES256 public key — x/y coordinates from your project's JWKS endpoint:
#   GET https://<project-ref>.supabase.co/auth/v1/.well-known/jwks.json
# Set SUPABASE_JWT_EC_X and SUPABASE_JWT_EC_Y in .env (see .env.example).
# These are public key components (not secrets), but are project-specific.
_SUPABASE_EC_X = os.environ.get("SUPABASE_JWT_EC_X", "")
_SUPABASE_EC_Y = os.environ.get("SUPABASE_JWT_EC_Y", "")

# Expected JWT audience — Supabase sets "authenticated" for logged-in users.
_EXPECTED_AUD = os.environ.get("SUPABASE_JWT_AUDIENCE", "authenticated")


def _b64url_to_int(s: str) -> int:
    padded = s + "=" * (-len(s) % 4)
    return int.from_bytes(base64.urlsafe_b64decode(padded), "big")


def _supabase_public_key() -> EllipticCurvePublicKey:
    if not _SUPABASE_EC_X or not _SUPABASE_EC_Y:
        raise RuntimeError(
            "SUPABASE_JWT_EC_X and SUPABASE_JWT_EC_Y must be set. "
            "Get these from: GET https://<project-ref>.supabase.co/auth/v1/.well-known/jwks.json"
        )
    nums = EllipticCurvePublicNumbers(
        x=_b64url_to_int(_SUPABASE_EC_X),
        y=_b64url_to_int(_SUPABASE_EC_Y),
        curve=SECP256R1(),
    )
    return nums.public_key(default_backend())


_public_key: EllipticCurvePublicKey | None = None


def _get_public_key() -> EllipticCurvePublicKey:
    global _public_key
    if _public_key is None:
        _public_key = _supabase_public_key()
    return _public_key


async def verify_jwt(token: str) -> CurrentUser:
    """Decode and verify a Supabase JWT.

    Algorithm selection (in priority order):
    - ES256 when SUPABASE_JWT_EC_X + SUPABASE_JWT_EC_Y are set (production)
    - HS256 when only SUPABASE_JWT_SECRET is set (local dev / tests)
    Raises 401 on any verification failure, including wrong audience.
    """
    credentials_exc = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid or expired token",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        jwt_secret = os.environ.get("SUPABASE_JWT_SECRET")
        ec_x = os.environ.get("SUPABASE_JWT_EC_X", "")
        ec_y = os.environ.get("SUPABASE_JWT_EC_Y", "")
        if ec_x and ec_y:
            key: object = _get_public_key()
            algorithms = ["ES256"]
        elif jwt_secret:
            key = jwt_secret
            algorithms = ["HS256"]
        else:
            raise RuntimeError(
                "No JWT verification keys configured. "
                "Set SUPABASE_JWT_EC_X + SUPABASE_JWT_EC_Y (production) "
                "or SUPABASE_JWT_SECRET (dev/test)."
            )
        payload = jwt.decode(
            token,
            key,
            algorithms=algorithms,
            audience=_EXPECTED_AUD,
        )
        user_id: str | None = payload.get("sub")
        if not user_id:
            raise credentials_exc
        email: str | None = payload.get("email")
    except JWTError:
        raise credentials_exc
    return CurrentUser(user_id=user_id, email=email)


# ─── Agent key verification ───────────────────────────────────────────────────

async def verify_agent_key(token: str) -> CurrentUser:
    """Verify a ``djt_`` agent API key against ``agents.api_key_hash`` in the DB.

    Uses the key prefix (first 8 chars after ``djt_``) for an indexed lookup,
    then bcrypt-verifies only the matching row(s).  Raises 401 if no match.
    """
    credentials_exc = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid agent API key",
        headers={"WWW-Authenticate": "Bearer"},
    )
    if not token.startswith("djt_") or len(token) < 12:
        raise credentials_exc

    prefix = token[4:12]
    pool = await get_pool()
    # Index-backed lookup by prefix, then bcrypt-verify the matching row(s)
    rows = await pool.fetch(
        "SELECT id, user_id, api_key_hash FROM agents WHERE api_key_prefix = $1",
        prefix,
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
        try:
            return await verify_jwt(token)
        except HTTPException:
            await _audit_failed_auth("auth.failed.jwt")
            raise
    try:
        return await verify_agent_key(token)
    except HTTPException:
        await _audit_failed_auth("auth.failed.agent_key", key_prefix=token[4:12] if token.startswith("djt_") and len(token) >= 12 else None)
        raise


async def _audit_failed_auth(action: str, *, key_prefix: str | None = None) -> None:
    """Log a failed authentication attempt.  Fire-and-forget."""
    try:
        from djtoolkit.api.audit import audit_log
        # Use a zeroed UUID since we don't know who attempted the auth
        await audit_log(
            "00000000-0000-0000-0000-000000000000",
            action,
            details={"key_prefix": key_prefix} if key_prefix else None,
        )
    except Exception:
        _auth_log.debug("Failed to audit log auth failure", exc_info=True)
