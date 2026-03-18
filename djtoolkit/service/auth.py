"""JWT verification dependency for FastAPI routes.

Mirrors the Next.js auth pattern: verify Supabase JWTs by calling
supabase.auth.get_user(token) with a service-role client.
"""

from fastapi import HTTPException, Request


def _get_supabase_client():
    """Lazy import and return the singleton Supabase client."""
    from djtoolkit.db.supabase_client import get_client

    return get_client()


async def get_current_user(request: Request) -> str:
    """FastAPI dependency — extract and verify Supabase JWT.

    Returns the user ID string. Raises HTTPException(401) on failure.
    """
    auth_header = request.headers.get("Authorization")
    if not auth_header or not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Authorization header must use Bearer scheme")

    token = auth_header[len("Bearer "):]

    try:
        client = _get_supabase_client()
        response = client.auth.get_user(token)
        if response.user is None:
            raise HTTPException(status_code=401, detail="Invalid or expired token")
        return response.user.id
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
