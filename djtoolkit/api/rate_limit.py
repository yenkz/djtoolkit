"""Rate limiting helpers for the djtoolkit API.

Uses slowapi with user_id as the primary key (extracted from auth tokens),
falling back to client IP for unauthenticated endpoints.
"""

from __future__ import annotations

from slowapi import Limiter
from slowapi.util import get_remote_address
from starlette.requests import Request


def _get_rate_limit_key(request: Request) -> str:
    """Extract user_id from the Authorization header for rate limiting.

    Falls back to client IP when the header is missing or unparseable
    (e.g. unauthenticated endpoints like /health or Spotify OAuth callback).
    """
    auth = request.headers.get("authorization", "")
    if auth.startswith("Bearer "):
        token = auth[len("Bearer "):]
        # JWT: decode the sub claim without full verification (rate limiting
        # only needs a stable key, not cryptographic proof).
        if token.count(".") == 2:
            import base64
            import json

            try:
                payload_b64 = token.split(".")[1]
                # Add padding
                padded = payload_b64 + "=" * (-len(payload_b64) % 4)
                payload = json.loads(base64.urlsafe_b64decode(padded))
                sub = payload.get("sub")
                if sub:
                    return f"user:{sub}"
            except Exception:
                pass
        # Agent key: use the prefix as the key (stable, no DB lookup needed)
        if token.startswith("djt_") and len(token) >= 12:
            return f"agent:{token[4:12]}"
    return get_remote_address(request)


def _get_agent_rate_limit_key(request: Request) -> str:
    """Rate limit key for agent-specific endpoints.

    Uses agent key prefix when available, falls back to the standard key.
    """
    auth = request.headers.get("authorization", "")
    if auth.startswith("Bearer "):
        token = auth[len("Bearer "):]
        if token.startswith("djt_") and len(token) >= 12:
            return f"agent:{token[4:12]}"
    return _get_rate_limit_key(request)


limiter = Limiter(key_func=_get_rate_limit_key)
