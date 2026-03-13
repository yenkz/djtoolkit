"""Catalog routes — track listing, stats, CSV/Spotify import.

Routes
------
GET  /catalog/tracks                 Paginated, filterable track list (RLS-scoped)
GET  /catalog/tracks/{id}            Single track
GET  /catalog/stats                  Counts by status + processing flags
POST /catalog/import/csv             Upload Exportify CSV → insert tracks + create jobs
POST /catalog/import/spotify         Import from connected Spotify playlist
GET  /catalog/import/spotify/playlists  List user's Spotify playlists
POST /catalog/tracks/{id}/reset      Retry a failed track (reset to candidate)
"""

from __future__ import annotations

import io
import json
import os
import uuid
from typing import Optional

import httpx
from cryptography.fernet import Fernet
from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
from pydantic import BaseModel

from djtoolkit.api.auth import CurrentUser, get_current_user
from djtoolkit.db.postgres import get_pool, rls_transaction
from djtoolkit.importers.exportify import parse_csv_rows
from djtoolkit.utils.search_string import build as build_search_string

router = APIRouter(prefix="/catalog", tags=["catalog"])

_MAX_CSV_BYTES = 10 * 1024 * 1024  # 10 MB


# ─── Response models ──────────────────────────────────────────────────────────

class TrackOut(BaseModel):
    id: int
    acquisition_status: str
    source: str
    title: Optional[str]
    artist: Optional[str]
    artists: Optional[str]
    album: Optional[str]
    year: Optional[int]
    duration_ms: Optional[int]
    genres: Optional[str]
    spotify_uri: Optional[str]
    local_path: Optional[str]
    fingerprinted: bool
    enriched_spotify: bool
    enriched_audio: bool
    metadata_written: bool
    cover_art_written: bool
    in_library: bool
    metadata_source: Optional[str]
    already_owned: bool = False
    created_at: str
    updated_at: str


class TrackListResponse(BaseModel):
    tracks: list[TrackOut]
    total: int
    page: int
    per_page: int


class CatalogStats(BaseModel):
    total: int
    by_status: dict[str, int]
    flags: dict[str, int]


class ImportResult(BaseModel):
    imported: int
    skipped_duplicates: int
    jobs_created: int


class SpotifyPlaylist(BaseModel):
    id: str
    name: str
    track_count: Optional[int] = None
    owner: Optional[str] = None
    image_url: Optional[str] = None


class BulkTrackIdsRequest(BaseModel):
    track_ids: list[int]


class BulkDeleteResult(BaseModel):
    deleted: int


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _row_to_track(r) -> TrackOut:
    return TrackOut(
        id=r["id"],
        acquisition_status=r["acquisition_status"],
        source=r["source"],
        title=r["title"],
        artist=r["artist"],
        artists=r["artists"],
        album=r["album"],
        year=r["year"],
        duration_ms=r["duration_ms"],
        genres=r["genres"],
        spotify_uri=r["spotify_uri"],
        local_path=r["local_path"],
        fingerprinted=bool(r["fingerprinted"]),
        enriched_spotify=bool(r["enriched_spotify"]),
        enriched_audio=bool(r["enriched_audio"]),
        metadata_written=bool(r["metadata_written"]),
        cover_art_written=bool(r["cover_art_written"]),
        in_library=bool(r["in_library"]),
        metadata_source=r["metadata_source"],
        already_owned=bool(r.get("already_owned", False)),
        created_at=r["created_at"].isoformat(),
        updated_at=r["updated_at"].isoformat(),
    )


def _fernet() -> Fernet:
    key = os.environ.get("SPOTIFY_TOKEN_ENCRYPTION_KEY")
    if not key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="SPOTIFY_TOKEN_ENCRYPTION_KEY not configured",
        )
    return Fernet(key.encode())


async def _get_spotify_token(user_id: str) -> str:
    """Decrypt and return the user's Spotify access token, refreshing if needed."""
    pool = await get_pool()
    row = await pool.fetchrow(
        "SELECT spotify_access_token, spotify_refresh_token, spotify_token_expires_at FROM users WHERE id = $1",
        user_id,
    )
    if not row or not row["spotify_access_token"]:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Spotify not connected. Visit /auth/spotify/connect first.",
        )

    f = _fernet()
    access_token = f.decrypt(row["spotify_access_token"].encode()).decode()

    # Refresh if expired (with 60s buffer)
    import datetime
    if row["spotify_token_expires_at"]:
        expires_at = row["spotify_token_expires_at"]
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=datetime.timezone.utc)
        now = datetime.datetime.now(datetime.timezone.utc)
        if (expires_at - now).total_seconds() < 60:
            refresh_token = f.decrypt(row["spotify_refresh_token"].encode()).decode()
            access_token = await _refresh_spotify_token(user_id, refresh_token, f)

    return access_token


async def _refresh_spotify_token(user_id: str, refresh_token: str, f: Fernet) -> str:
    client_id = os.environ.get("PLATFORM_SPOTIFY_CLIENT_ID") or os.environ.get("SPOTIFY_CLIENT_ID", "")
    client_secret = os.environ.get("PLATFORM_SPOTIFY_CLIENT_SECRET") or os.environ.get("SPOTIFY_CLIENT_SECRET", "")
    async with httpx.AsyncClient() as client:
        r = await client.post(
            "https://accounts.spotify.com/api/token",
            data={
                "grant_type": "refresh_token",
                "refresh_token": refresh_token,
                "client_id": client_id,
                "client_secret": client_secret,
            },
        )
        r.raise_for_status()
        data = r.json()

    new_access = data["access_token"]
    new_enc = f.encrypt(new_access.encode()).decode()

    import datetime
    expires_at = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=data.get("expires_in", 3600))
    pool = await get_pool()
    await pool.execute(
        "UPDATE users SET spotify_access_token = $1, spotify_token_expires_at = $2 WHERE id = $3",
        new_enc, expires_at, user_id,
    )
    return new_access


def _map_spotify_track(item: dict) -> dict:
    """Map a Spotify playlist track item to our tracks schema."""
    track = item.get("track") or {}
    artists_list = track.get("artists") or []
    primary_artist = artists_list[0]["name"] if artists_list else ""
    all_artists = "|".join(a["name"] for a in artists_list)
    album = (track.get("album") or {})
    release_date = album.get("release_date", "")
    year = int(release_date[:4]) if release_date and len(release_date) >= 4 else None

    t = {
        "title": track.get("name"),
        "artist": primary_artist,
        "artists": all_artists,
        "album": album.get("name"),
        "year": year,
        "release_date": release_date,
        "duration_ms": track.get("duration_ms"),
        "isrc": (track.get("external_ids") or {}).get("isrc"),
        "spotify_uri": track.get("uri"),
        "popularity": track.get("popularity"),
        "explicit": track.get("explicit", False),
        "added_by": (item.get("added_by") or {}).get("id"),
        "added_at": item.get("added_at"),
    }
    t["search_string"] = build_search_string(t.get("artist", ""), t.get("title", ""))
    return t


async def _insert_tracks_and_create_jobs(
    conn, user_id: str, tracks: list[dict], source: str, *, queue_jobs: bool = True
) -> tuple[int, int, int]:
    """Insert tracks (ON CONFLICT DO NOTHING) and optionally create download jobs.

    Returns (inserted, skipped_duplicates, jobs_created).
    When queue_jobs=False, tracks are inserted but no pipeline_jobs rows are created.
    """
    inserted = 0
    skipped = 0
    jobs_created = 0

    for t in tracks:
        result = await conn.fetchval(
            """
            INSERT INTO tracks (
                user_id, acquisition_status, source,
                title, artist, artists, album, year, release_date,
                duration_ms, isrc, genres, spotify_uri, popularity,
                explicit, added_by, added_at, search_string
            ) VALUES (
                $1, 'candidate', $2,
                $3, $4, $5, $6, $7, $8,
                $9, $10, $11, $12, $13,
                $14, $15, $16, $17
            )
            ON CONFLICT (user_id, spotify_uri) DO NOTHING
            RETURNING id
            """,
            user_id, source,
            t.get("title"), t.get("artist"), t.get("artists"),
            t.get("album"), t.get("year"), t.get("release_date"),
            t.get("duration_ms"), t.get("isrc"), t.get("genres"),
            t.get("spotify_uri"), t.get("popularity"),
            t.get("explicit", False), t.get("added_by"), t.get("added_at"),
            t.get("search_string"),
        )
        if result is None:
            skipped += 1
        else:
            inserted += 1
            if queue_jobs:
                # Create download job for this new candidate
                await conn.execute(
                    """
                    INSERT INTO pipeline_jobs (user_id, track_id, job_type, payload)
                    VALUES ($1, $2, 'download', $3)
                    """,
                    user_id, result,
                    json.dumps({
                        "track_id": result,
                        "search_string": t.get("search_string", ""),
                        "artist": t.get("artist", ""),
                        "title": t.get("title", ""),
                        "duration_ms": t.get("duration_ms", 0),
                    }),
                )
                jobs_created += 1

    return inserted, skipped, jobs_created


# ─── Endpoints ────────────────────────────────────────────────────────────────

@router.get("/tracks", response_model=TrackListResponse)
async def list_tracks(
    page: int = Query(1, ge=1),
    per_page: int = Query(50, ge=1, le=1000),
    status_filter: Optional[str] = Query(None, alias="status"),
    search: Optional[str] = Query(None),
    user: CurrentUser = Depends(get_current_user),
):
    pool = await get_pool()
    offset = (page - 1) * per_page

    conditions = ["user_id = $1"]
    args: list = [user.user_id]

    if status_filter:
        args.append(status_filter)
        conditions.append(f"acquisition_status = ${len(args)}")

    if search:
        args.append(f"%{search}%")
        conditions.append(f"(title ILIKE ${len(args)} OR artist ILIKE ${len(args)})")

    where = " AND ".join(conditions)

    total = await pool.fetchval(f"SELECT COUNT(*) FROM tracks WHERE {where}", *args)

    args_page = args + [per_page, offset]
    rows = await pool.fetch(
        f"""
        SELECT t.*,
               (owned.id IS NOT NULL) AS already_owned
        FROM tracks t
        LEFT JOIN LATERAL (
            SELECT id FROM tracks o
            WHERE o.user_id = t.user_id
              AND o.spotify_uri IS NOT NULL
              AND o.spotify_uri = t.spotify_uri
              AND o.acquisition_status = 'available'
              AND o.id != t.id
            LIMIT 1
        ) owned ON TRUE
        WHERE {where}
        ORDER BY t.created_at DESC
        LIMIT ${len(args_page)-1} OFFSET ${len(args_page)}
        """,
        *args_page,
    )

    return TrackListResponse(
        tracks=[_row_to_track(r) for r in rows],
        total=total,
        page=page,
        per_page=per_page,
    )


@router.get("/tracks/{track_id}", response_model=TrackOut)
async def get_track(
    track_id: int,
    user: CurrentUser = Depends(get_current_user),
):
    pool = await get_pool()
    row = await pool.fetchrow(
        "SELECT * FROM tracks WHERE id = $1 AND user_id = $2",
        track_id, user.user_id,
    )
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Track not found")
    return _row_to_track(row)


@router.get("/stats", response_model=CatalogStats)
async def catalog_stats(user: CurrentUser = Depends(get_current_user)):
    pool = await get_pool()

    status_rows = await pool.fetch(
        "SELECT acquisition_status, COUNT(*) AS n FROM tracks WHERE user_id = $1 GROUP BY acquisition_status",
        user.user_id,
    )
    flag_row = await pool.fetchrow(
        """
        SELECT
            COUNT(*) FILTER (WHERE fingerprinted)    AS fingerprinted,
            COUNT(*) FILTER (WHERE enriched_spotify) AS enriched_spotify,
            COUNT(*) FILTER (WHERE enriched_audio)   AS enriched_audio,
            COUNT(*) FILTER (WHERE metadata_written) AS metadata_written,
            COUNT(*) FILTER (WHERE cover_art_written) AS cover_art_written,
            COUNT(*) FILTER (WHERE in_library)       AS in_library,
            COUNT(*)                                  AS total
        FROM tracks WHERE user_id = $1
        """,
        user.user_id,
    )

    return CatalogStats(
        total=flag_row["total"] if flag_row else 0,
        by_status={r["acquisition_status"]: r["n"] for r in status_rows},
        flags={
            k: flag_row[k] if flag_row else 0
            for k in ("fingerprinted", "enriched_spotify", "enriched_audio",
                      "metadata_written", "cover_art_written", "in_library")
        },
    )


@router.post("/import/csv", response_model=ImportResult, status_code=status.HTTP_201_CREATED)
async def import_csv(
    file: UploadFile = File(...),
    queue_jobs: bool = Query(True),
    user: CurrentUser = Depends(get_current_user),
):
    if file.content_type not in ("text/csv", "application/csv", "text/plain", "application/octet-stream"):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="File must be a CSV",
        )

    # Extension check — content-type can be spoofed; filename provides a second signal.
    if file.filename and not file.filename.lower().endswith(".csv"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="File must have a .csv extension.",
        )

    raw = await file.read()
    if len(raw) > _MAX_CSV_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="CSV must be under 10 MB",
        )

    try:
        tracks = parse_csv_rows(raw)
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Could not parse CSV: {exc}",
        )

    pool = await get_pool()
    async with rls_transaction(pool, user.user_id) as conn:
        inserted, skipped, jobs_created = await _insert_tracks_and_create_jobs(
            conn, user.user_id, tracks, "exportify", queue_jobs=queue_jobs
        )

    return ImportResult(imported=inserted, skipped_duplicates=skipped, jobs_created=jobs_created)


class SpotifyImportRequest(BaseModel):
    playlist_id: str


@router.post("/import/spotify", response_model=ImportResult, status_code=status.HTTP_201_CREATED)
async def import_spotify(
    body: SpotifyImportRequest,
    queue_jobs: bool = Query(True),
    user: CurrentUser = Depends(get_current_user),
):
    access_token = await _get_spotify_token(user.user_id)

    # Paginate through the full playlist
    tracks: list[dict] = []
    url = f"https://api.spotify.com/v1/playlists/{body.playlist_id}/tracks"
    params = {"limit": 100, "fields": "items(added_by,added_at,track),next"}

    async with httpx.AsyncClient() as client:
        while url:
            r = await client.get(url, headers={"Authorization": f"Bearer {access_token}"}, params=params)
            if r.status_code == 401:
                raise HTTPException(status_code=400, detail="Spotify token expired or revoked. Please reconnect Spotify in Settings.")
            if r.status_code == 403:
                try:
                    err_body = r.json()
                    err_msg = (err_body.get("error") or {}).get("message", r.text)
                except Exception:
                    err_msg = r.text
                scopes = r.headers.get("X-OAuth-Scopes", "unknown")
                raise HTTPException(
                    status_code=403,
                    detail=f"Spotify denied access: {err_msg}. Token scopes: [{scopes}]. Try disconnecting and reconnecting Spotify.",
                )
            if not r.is_success:
                raise HTTPException(status_code=502, detail=f"Spotify API error: {r.status_code}")
            data = r.json()
            for item in data.get("items", []):
                if item.get("track") and item["track"].get("uri"):
                    tracks.append(_map_spotify_track(item))
            url = data.get("next")
            params = {}  # next URL already has params

    pool = await get_pool()
    async with rls_transaction(pool, user.user_id) as conn:
        inserted, skipped, jobs_created = await _insert_tracks_and_create_jobs(
            conn, user.user_id, tracks, "spotify", queue_jobs=queue_jobs
        )

    return ImportResult(imported=inserted, skipped_duplicates=skipped, jobs_created=jobs_created)


@router.get("/import/spotify/playlists", response_model=list[SpotifyPlaylist])
async def list_spotify_playlists(user: CurrentUser = Depends(get_current_user)):
    access_token = await _get_spotify_token(user.user_id)

    seen_ids: set[str] = set()
    playlists: list[SpotifyPlaylist] = []
    url = "https://api.spotify.com/v1/me/playlists"
    params = {"limit": 50}

    async with httpx.AsyncClient() as client:
        while url:
            r = await client.get(url, headers={"Authorization": f"Bearer {access_token}"}, params=params)
            if r.status_code == 401:
                raise HTTPException(status_code=400, detail="Spotify token expired or revoked. Please reconnect Spotify in Settings.")
            if not r.is_success:
                raise HTTPException(status_code=502, detail=f"Spotify API error: {r.status_code}")
            data = r.json()
            for p in (data.get("items") or []):
                if p and p["id"] not in seen_ids:
                    seen_ids.add(p["id"])
                    images = p.get("images") or []
                    playlists.append(SpotifyPlaylist(
                        id=p["id"],
                        name=p["name"],
                        track_count=(p.get("tracks") or {}).get("total"),
                        owner=(p.get("owner") or {}).get("display_name"),
                        image_url=images[0]["url"] if images else None,
                    ))
            url = data.get("next")
            params = {}

    return playlists


class TrackIdImportRequest(BaseModel):
    url: str


@router.post("/import/trackid", response_model=ImportResult, status_code=status.HTTP_201_CREATED)
async def import_trackid_url(
    body: TrackIdImportRequest,
    queue_jobs: bool = Query(True),
    user: CurrentUser = Depends(get_current_user),
):
    """Flow 3: submit a YouTube mix URL to TrackID.dev, poll for results, insert candidates."""
    import asyncio
    import time
    from djtoolkit.importers.trackid import validate_url

    _BASE = "https://trackid.dev"
    _CONFIDENCE = 0.3
    _POLL_INTERVAL = 7   # seconds between polls
    _POLL_TIMEOUT = 300  # 5 minutes max for onboarding

    try:
        normalized = validate_url(body.url)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(e))

    # Submit job
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.post(
                f"{_BASE}/api/analyze",
                json={"url": normalized},
                headers={"User-Agent": "djtoolkit/1.0"},
            )
            if r.status_code == 429:
                raise HTTPException(status_code=429, detail="TrackID.dev rate limit reached. Try again in a few minutes.")
            if not r.is_success:
                raise HTTPException(status_code=502, detail=f"TrackID.dev submission failed: {r.status_code}")
            job_id = r.json()["jobId"]
    except httpx.RequestError as exc:
        raise HTTPException(status_code=502, detail=f"Could not reach TrackID.dev: {exc}")

    # Poll until completed or timeout
    poll_url = f"{_BASE}/api/job/{job_id}"
    start = time.monotonic()

    async with httpx.AsyncClient(timeout=30) as client:
        while True:
            if time.monotonic() - start > _POLL_TIMEOUT:
                raise HTTPException(status_code=504, detail="TrackID.dev job timed out. Try a shorter mix or retry later.")

            try:
                r = await client.get(poll_url, headers={"User-Agent": "djtoolkit/1.0"})
                if r.status_code == 429:
                    await asyncio.sleep(15)
                    continue
                if not r.is_success:
                    raise HTTPException(status_code=502, detail=f"TrackID.dev poll error: {r.status_code}")
                job = r.json()
            except httpx.RequestError:
                await asyncio.sleep(10)
                continue

            job_status = job.get("status", "")
            if job_status == "completed":
                break
            if job_status == "failed":
                raise HTTPException(status_code=502, detail="TrackID.dev job failed on server.")

            await asyncio.sleep(_POLL_INTERVAL)

    # Filter by confidence / unknown and build track list
    tracks: list[dict] = []
    for track in job.get("tracks", []):
        if track.get("isUnknown"):
            continue
        if track.get("confidence", 0) < _CONFIDENCE:
            continue
        artist = track.get("artist") or ""
        title = track.get("title") or ""
        duration_sec = track.get("duration")
        tracks.append({
            "title": title or None,
            "artist": artist or None,
            "artists": artist or None,
            "duration_ms": int(duration_sec * 1000) if duration_sec is not None else None,
            "search_string": build_search_string(artist, title) if (artist or title) else None,
        })

    pool = await get_pool()
    async with rls_transaction(pool, user.user_id) as conn:
        inserted, skipped, jobs_created = await _insert_tracks_and_create_jobs(
            conn, user.user_id, tracks, "trackid", queue_jobs=queue_jobs
        )

    return ImportResult(imported=inserted, skipped_duplicates=skipped, jobs_created=jobs_created)


@router.delete("/tracks/bulk", response_model=BulkDeleteResult)
async def bulk_delete_tracks(
    body: BulkTrackIdsRequest,
    user: CurrentUser = Depends(get_current_user),
):
    """Delete candidate tracks the user chose not to download.

    Only deletes tracks with acquisition_status='candidate' owned by the requesting user.
    Available/downloading/failed tracks are silently ignored.
    """
    if not body.track_ids:
        return BulkDeleteResult(deleted=0)

    pool = await get_pool()
    async with rls_transaction(pool, user.user_id) as conn:
        result = await conn.execute(
            """DELETE FROM tracks
               WHERE id = ANY($1::bigint[])
                 AND user_id = $2
                 AND acquisition_status = 'candidate'""",
            body.track_ids, user.user_id,
        )
    # asyncpg returns "DELETE N" as the command tag
    deleted = int(result.split()[-1])
    return BulkDeleteResult(deleted=deleted)


@router.post("/tracks/{track_id}/reset", status_code=status.HTTP_204_NO_CONTENT)
async def reset_track(
    track_id: int,
    user: CurrentUser = Depends(get_current_user),
):
    """Reset a failed track back to candidate so it can be retried."""
    pool = await get_pool()
    result = await pool.execute(
        """
        UPDATE tracks
        SET acquisition_status = 'candidate', updated_at = NOW()
        WHERE id = $1 AND user_id = $2 AND acquisition_status = 'failed'
        """,
        track_id, user.user_id,
    )
    if int(result.split()[-1]) == 0:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Track not found or not in failed state",
        )
    # Create a new download job for the reset track
    row = await pool.fetchrow("SELECT * FROM tracks WHERE id = $1", track_id)
    if row:
        await pool.execute(
            """
            INSERT INTO pipeline_jobs (user_id, track_id, job_type, payload)
            VALUES ($1, $2, 'download', $3)
            """,
            user.user_id, track_id,
            json.dumps({
                "track_id": track_id,
                "search_string": row["search_string"] or "",
                "artist": row["artist"] or "",
                "title": row["title"] or "",
                "duration_ms": row["duration_ms"] or 0,
            }),
        )
