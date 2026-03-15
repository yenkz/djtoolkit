"""One-time backfill: fetch Spotify album artwork URLs for tracks missing artwork_url.

Uses Spotify Client Credentials flow (no user auth needed).
Reads tracks from Supabase, calls Spotify API in batches of 50, updates artwork_url.

Usage:
    python scripts/backfill_artwork.py
"""

import os
import sys
import time

import httpx
from dotenv import load_dotenv

# Load .env from project root
load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))
load_dotenv(os.path.join(os.path.dirname(__file__), "..", "web", ".env.local"))

SPOTIFY_CLIENT_ID = os.environ["SPOTIFY_CLIENT_ID"]
SPOTIFY_CLIENT_SECRET = os.environ["SPOTIFY_CLIENT_SECRET"]
SUPABASE_URL = os.environ["NEXT_PUBLIC_SUPABASE_URL"]
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or os.environ["NEXT_PUBLIC_SUPABASE_ANON_KEY"]


def get_spotify_token() -> str:
    """Get a Spotify access token via Client Credentials flow."""
    r = httpx.post(
        "https://accounts.spotify.com/api/token",
        data={"grant_type": "client_credentials"},
        auth=(SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET),
    )
    r.raise_for_status()
    return r.json()["access_token"]


def supabase_rpc(query: str, method: str = "GET") -> list[dict]:
    """Execute a query via Supabase REST API (PostgREST)."""
    r = httpx.post(
        f"{SUPABASE_URL}/rest/v1/rpc/",
        headers={
            "apikey": SUPABASE_KEY,
            "Authorization": f"Bearer {SUPABASE_KEY}",
            "Content-Type": "application/json",
        },
        json={"query": query},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def main():
    # Get Spotify token
    print("Authenticating with Spotify...")
    token = get_spotify_token()
    print("Got Spotify access token")

    # Fetch tracks missing artwork via Supabase REST API
    print("Fetching tracks missing artwork...")
    headers = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
    }

    # Use PostgREST query: tracks where spotify_uri is not null and artwork_url is null
    r = httpx.get(
        f"{SUPABASE_URL}/rest/v1/tracks",
        params={
            "select": "id,spotify_uri",
            "spotify_uri": "not.is.null",
            "artwork_url": "is.null",
            "limit": "1000",
        },
        headers=headers,
        timeout=30,
    )
    r.raise_for_status()
    tracks = r.json()

    if not tracks:
        print("No tracks need artwork backfill!")
        return

    print(f"Found {len(tracks)} tracks missing artwork")

    # Build spotify_id → db_id mapping
    track_map: dict[str, int] = {}
    for t in tracks:
        uri = t["spotify_uri"]
        parts = uri.split(":")
        if len(parts) == 3 and parts[1] == "track":
            track_map[parts[2]] = t["id"]

    spotify_ids = list(track_map.keys())
    updated = 0
    errors = 0

    # Process in batches of 50 (Spotify API limit)
    for i in range(0, len(spotify_ids), 50):
        batch = spotify_ids[i : i + 50]
        batch_num = i // 50 + 1
        total_batches = (len(spotify_ids) + 49) // 50
        print(f"  Batch {batch_num}/{total_batches} ({len(batch)} tracks)...")

        resp = httpx.get(
            "https://api.spotify.com/v1/tracks",
            params={"ids": ",".join(batch)},
            headers={"Authorization": f"Bearer {token}"},
            timeout=30,
        )

        if resp.status_code == 429:
            retry_after = int(resp.headers.get("Retry-After", "5"))
            print(f"  Rate limited, waiting {retry_after}s...")
            time.sleep(retry_after)
            resp = httpx.get(
                "https://api.spotify.com/v1/tracks",
                params={"ids": ",".join(batch)},
                headers={"Authorization": f"Bearer {token}"},
                timeout=30,
            )

        if not resp.is_success:
            print(f"  Spotify API error {resp.status_code}, skipping batch")
            errors += len(batch)
            continue

        data = resp.json()
        for track_data in data.get("tracks") or []:
            if not track_data:
                continue
            images = (track_data.get("album") or {}).get("images") or []
            if not images:
                continue
            # Pick smallest thumbnail for table display
            artwork_url = images[-1].get("url") if len(images) > 1 else images[0].get("url")
            spotify_id = track_data.get("id")
            db_id = track_map.get(spotify_id)

            if db_id and artwork_url:
                # Update via PostgREST PATCH
                patch_resp = httpx.patch(
                    f"{SUPABASE_URL}/rest/v1/tracks",
                    params={"id": f"eq.{db_id}"},
                    headers={
                        **headers,
                        "Content-Type": "application/json",
                        "Prefer": "return=minimal",
                    },
                    json={"artwork_url": artwork_url},
                    timeout=10,
                )
                if patch_resp.is_success:
                    updated += 1
                else:
                    errors += 1

        # Small delay to be nice to Spotify API
        time.sleep(0.2)

    print(f"\nDone! Updated {updated} tracks, {errors} errors, {len(tracks)} total missing")


if __name__ == "__main__":
    main()
