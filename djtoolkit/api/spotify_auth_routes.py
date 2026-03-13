"""Spotify OAuth 2.0 Authorization Code flow.

Connects a user's Spotify account so the platform can read their playlists.

Flow:
  1. Frontend redirects to GET /api/auth/spotify/connect?token=<jwt>&return_to=<path>
  2. This endpoint validates the JWT, stores state, redirects to Spotify.
  3. Spotify redirects to GET /api/auth/spotify/callback?code=<code>&state=<state>
  4. Backend exchanges code for tokens, encrypts and stores them in users table.
  5. Redirects browser to ${PLATFORM_FRONTEND_URL}${return_to}?spotify=connected

Required env vars:
  SPOTIFY_CLIENT_ID            Spotify app client ID
  SPOTIFY_CLIENT_SECRET        Spotify app client secret
  SPOTIFY_CALLBACK_URL         Must match redirect URI registered in Spotify app
                               e.g. http://localhost:8000/api/auth/spotify/callback
  SPOTIFY_TOKEN_ENCRYPTION_KEY Fernet key for encrypting stored tokens
  PLATFORM_FRONTEND_URL        Frontend origin, e.g. http://localhost:3000
"""

from __future__ import annotations

import asyncio
import datetime
import os
import secrets
import time
import urllib.parse
from urllib.parse import urlencode

import httpx
from cryptography.fernet import Fernet
from fastapi import APIRouter, HTTPException, Query, Depends
from fastapi.responses import RedirectResponse

from djtoolkit.api.auth import verify_jwt, get_current_user, CurrentUser
from djtoolkit.db.postgres import get_pool


router = APIRouter(prefix="/auth/spotify", tags=["spotify-auth"])

# In-memory state store: state_token -> {user_id, return_to, expires_at}
# Single-instance only — fine for a personal tool.
_state_store: dict[str, dict] = {}
_STATE_TTL = 600  # 10 minutes

_SCOPES = "playlist-read-private playlist-read-collaborative user-library-read"


def _sanitize_return_to(value: str) -> str:
    """Reject open-redirect payloads; return a safe relative path or '/'."""
    decoded = urllib.parse.unquote(value)
    if (
        not decoded
        or "://" in decoded
        or decoded.startswith("//")
        or decoded.startswith("/\\")
    ):
        return "/"
    return decoded


async def _cleanup_expired_states() -> None:
    """Background task: evict expired OAuth state tokens every 5 minutes."""
    while True:
        await asyncio.sleep(300)
        now = time.time()
        expired_keys = [k for k, v in list(_state_store.items()) if v["expires_at"] < now]
        for k in expired_keys:
            _state_store.pop(k, None)


def _fernet() -> Fernet:
    key = os.environ.get("SPOTIFY_TOKEN_ENCRYPTION_KEY")
    if not key:
        raise HTTPException(status_code=500, detail="SPOTIFY_TOKEN_ENCRYPTION_KEY not configured")
    return Fernet(key.encode())


def _client_id() -> str:
    return os.environ.get("PLATFORM_SPOTIFY_CLIENT_ID") or os.environ.get("SPOTIFY_CLIENT_ID", "")


def _client_secret() -> str:
    return os.environ.get("PLATFORM_SPOTIFY_CLIENT_SECRET") or os.environ.get("SPOTIFY_CLIENT_SECRET", "")


def _callback_url() -> str:
    return os.environ.get("SPOTIFY_CALLBACK_URL", "http://localhost:8000/api/auth/spotify/callback")


def _frontend_url() -> str:
    return os.environ.get("PLATFORM_FRONTEND_URL", "http://localhost:3000")


@router.get("/connect")
async def spotify_connect(
    token: str = Query(..., description="Supabase JWT"),
    return_to: str = Query("/", description="Frontend path to redirect to after auth"),
):
    """Initiate Spotify OAuth. Accepts JWT as query param since it's a browser redirect."""
    try:
        user = await verify_jwt(token)
    except HTTPException:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    state = secrets.token_urlsafe(32)
    _state_store[state] = {
        "user_id": user.user_id,
        "email": user.email,
        "return_to": _sanitize_return_to(return_to),   # sanitize here
        "expires_at": time.time() + _STATE_TTL,
    }

    params = urlencode({
        "client_id": _client_id(),
        "response_type": "code",
        "redirect_uri": _callback_url(),
        "state": state,
        "scope": _SCOPES,
        "show_dialog": "true",
    })
    return RedirectResponse(f"https://accounts.spotify.com/authorize?{params}")


@router.get("/callback")
async def spotify_callback(
    code: str = Query(None),
    state: str = Query(None),
    error: str = Query(None),
):
    """Handle Spotify OAuth callback — exchange code for tokens and store them."""
    frontend = _frontend_url()

    if error or not code or not state:
        return RedirectResponse(f"{frontend}/?spotify=error")

    state_data = _state_store.pop(state, None)
    if not state_data or time.time() > state_data["expires_at"]:
        return RedirectResponse(f"{frontend}/?spotify=error&reason=expired")

    user_id = state_data["user_id"]
    email = state_data.get("email", "")
    return_to = state_data["return_to"]

    # Exchange authorization code for tokens
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            "https://accounts.spotify.com/api/token",
            data={
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": _callback_url(),
            },
            auth=(_client_id(), _client_secret()),
        )

    if resp.status_code != 200:
        return RedirectResponse(f"{frontend}{return_to}?spotify=error")

    tokens = resp.json()
    access_token = tokens["access_token"]
    refresh_token = tokens.get("refresh_token", "")
    expires_in = tokens.get("expires_in", 3600)
    expires_at = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=expires_in)

    f = _fernet()
    encrypted_access = f.encrypt(access_token.encode()).decode()
    encrypted_refresh = f.encrypt(refresh_token.encode()).decode() if refresh_token else None

    pool = await get_pool()
    await pool.execute(
        """
        INSERT INTO users (id, email, spotify_access_token, spotify_refresh_token, spotify_token_expires_at)
        VALUES ($4, $5, $1, $2, $3)
        ON CONFLICT (id) DO UPDATE
        SET spotify_access_token     = EXCLUDED.spotify_access_token,
            spotify_refresh_token    = EXCLUDED.spotify_refresh_token,
            spotify_token_expires_at = EXCLUDED.spotify_token_expires_at,
            updated_at               = now()
        """,
        encrypted_access,
        encrypted_refresh,
        expires_at,
        user_id,
        email,
    )

    sep = "&" if "?" in return_to else "?"
    return RedirectResponse(f"{frontend}{return_to}{sep}spotify=connected")


@router.post("/disconnect")
async def spotify_disconnect(user: CurrentUser = Depends(get_current_user)):
    """Remove stored Spotify tokens for the current user."""
    pool = await get_pool()
    await pool.execute(
        """
        UPDATE users
        SET spotify_access_token     = NULL,
            spotify_refresh_token    = NULL,
            spotify_token_expires_at = NULL,
            updated_at               = now()
        WHERE id = $1
        """,
        user.user_id,
    )
