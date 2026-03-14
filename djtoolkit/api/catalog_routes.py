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

import asyncio
import io
import json
import os
import time
import uuid
from typing import Optional

import httpx
from cryptography.fernet import Fernet
from fastapi import APIRouter, BackgroundTasks, Body, Depends, File, HTTPException, Query, Request, UploadFile, status
from pydantic import BaseModel, field_validator

from djtoolkit.api.audit import audit_log
from djtoolkit.api.auth import CurrentUser, get_current_user
from djtoolkit.api.rate_limit import limiter
from djtoolkit.db.postgres import get_pool, rls_transaction
from djtoolkit.importers.exportify import parse_csv_rows
from djtoolkit.utils.search_string import build as build_search_string

router = APIRouter(prefix="/catalog", tags=["catalog"])

_MAX_CSV_BYTES = 10 * 1024 * 1024  # 10 MB

# ─── TrackID constants ─────────────────────────────────────────────────────────
_TRACKID_BASE = "https://trackid.dev"
_TRACKID_CONFIDENCE = 0.7
_TRACKID_POLL_INTERVAL = 7    # seconds
_TRACKID_POLL_TIMEOUT = 1800  # 30 minutes (long DJ sets can take 10-20 min)


# ─── JSONB helpers ────────────────────────────────────────────────────────────

def _decode_jsonb(value):
    """Return a Python object from a JSONB column value.

    asyncpg may return JSONB as a raw JSON string (when the parameter was sent
    via a ::jsonb text cast) or as an already-parsed Python object, depending on
    driver version and connection setup.  This helper handles both cases.
    """
    if value is None:
        return None
    if isinstance(value, (str, bytes)):
        return json.loads(value)
    return value  # already deserialized


# ─── TrackID job helpers (Postgres-backed) ────────────────────────────────────

async def _job_create(job_id: str, user_id: str, youtube_url: str) -> None:
    pool = await get_pool()
    await pool.execute(
        """
        INSERT INTO trackid_import_jobs (id, user_id, youtube_url, status, progress, step)
        VALUES ($1, $2, $3, 'queued', 0, 'Queued…')
        """,
        job_id, user_id, youtube_url,
    )


async def _job_update(job_id: str, *, status: str, progress: int, step: str,
                      error: str | None = None, result: dict | None = None) -> None:
    pool = await get_pool()
    # Serialize to JSON string + explicit cast: asyncpg infers TEXT for $6 in UPDATE
    # without a cast hint, and rejects a dict.  Pass a JSON string + ::jsonb so
    # PostgreSQL casts it correctly.
    await pool.execute(
        """
        UPDATE trackid_import_jobs
        SET status = $2, progress = $3, step = $4, error = $5,
            result = $6::jsonb, updated_at = NOW()
        WHERE id = $1
        """,
        job_id, status, progress, step, error,
        json.dumps(result) if result is not None else None,
    )


async def _job_get(job_id: str) -> dict | None:
    pool = await get_pool()
    row = await pool.fetchrow(
        "SELECT status, progress, step, error, result FROM trackid_import_jobs WHERE id = $1",
        job_id,
    )
    if row is None:
        return None
    return {
        "status": row["status"],
        "progress": row["progress"],
        "step": row["step"],
        "error": row["error"],
        "result": _decode_jsonb(row["result"]),
    }


async def _save_trackid_cache(normalized_url: str, tracks: list[dict]) -> None:
    """Persist filtered tracks to the shared trackid_url_cache table."""
    try:
        pool = await get_pool()
        await pool.execute(
            """
            INSERT INTO trackid_url_cache (youtube_url, tracks, track_count)
            VALUES ($1, $2::jsonb, $3)
            ON CONFLICT (youtube_url) DO UPDATE
              SET tracks = EXCLUDED.tracks,
                  track_count = EXCLUDED.track_count,
                  updated_at = NOW()
            """,
            normalized_url, json.dumps(tracks), len(tracks),
        )
    except Exception:
        pass  # Cache write failure is non-fatal


async def _load_trackid_cache(normalized_url: str) -> list[dict] | None:
    """Return cached tracks for this URL, or None if not in cache."""
    try:
        pool = await get_pool()
        row = await pool.fetchrow(
            "SELECT tracks FROM trackid_url_cache WHERE youtube_url = $1",
            normalized_url,
        )
        if row is None:
            return None
        return _decode_jsonb(row["tracks"])
    except Exception:
        return None


async def _run_trackid_background(
    local_job_id: str,
    normalized_url: str,
    user_id: str,
    queue_jobs: bool,
) -> None:
    """Background task: submit to TrackID.dev, poll for completion, insert tracks."""

    async def _fail(msg: str) -> None:
        try:
            await _job_update(local_job_id, status="failed", progress=0, step="", error=msg)
        except Exception:
            pass  # Best-effort — don't mask the original error

    try:
        await _run_trackid_inner(local_job_id, normalized_url, user_id, queue_jobs, _fail)
    except Exception as exc:
        await _fail(f"Unexpected error: {exc}")


async def _run_trackid_inner(
    local_job_id: str,
    normalized_url: str,
    user_id: str,
    queue_jobs: bool,
    _fail,
) -> None:
    # 1. Submit
    await _job_update(local_job_id, status="submitting", progress=5, step="Submitting to TrackID.dev…")
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.post(
                f"{_TRACKID_BASE}/api/analyze",
                json={"url": normalized_url},
                headers={"User-Agent": "djtoolkit/1.0"},
            )
            if r.status_code == 429:
                await _fail("TrackID.dev rate limit reached. Try again in a few minutes.")
                return
            if not r.is_success:
                await _fail(f"TrackID.dev submission failed: {r.status_code}")
                return
            trackid_job_id = r.json()["jobId"]
    except httpx.RequestError as exc:
        await _fail(f"Could not reach TrackID.dev: {exc}")
        return

    # 2. Poll
    poll_url = f"{_TRACKID_BASE}/api/job/{trackid_job_id}"
    start = time.monotonic()
    job: dict = {}

    async with httpx.AsyncClient(timeout=30) as client:
        while True:
            if time.monotonic() - start > _TRACKID_POLL_TIMEOUT:
                await _fail("TrackID.dev job timed out after 5 minutes.")
                return

            try:
                r = await client.get(poll_url, headers={"User-Agent": "djtoolkit/1.0"})
                if r.status_code == 429:
                    await asyncio.sleep(15)
                    continue
                if not r.is_success:
                    await _fail(f"TrackID.dev poll error: {r.status_code}")
                    return
                job = r.json()
            except httpx.RequestError:
                await asyncio.sleep(10)
                continue

            job_status = job.get("status", "")
            pct = min(int(job.get("progress", 0)), 90)  # cap at 90 until we finish inserting
            step = job.get("currentStep") or job_status
            await _job_update(local_job_id, status=job_status, progress=pct, step=step)

            if job_status == "completed":
                break
            if job_status == "failed":
                await _fail("TrackID.dev job failed on server.")
                return

            await asyncio.sleep(_TRACKID_POLL_INTERVAL)

    # 3. Filter and deduplicate tracks
    # TrackID fingerprints in overlapping 30-second windows, so the same track
    # can appear many times.  Sort by confidence descending, then keep only the
    # first occurrence of each (title, artist) pair (case-insensitive).
    # duration_ms from TrackID is always 30 000 ms (the window size, not the
    # real track duration), so we store NULL instead.
    await _job_update(local_job_id, status="inserting", progress=95, step="Saving tracks to your library…")
    seen_keys: set[tuple[str, str]] = set()
    raw_tracks = sorted(job.get("tracks", []), key=lambda t: -t.get("confidence", 0))
    tracks: list[dict] = []
    for track in raw_tracks:
        if track.get("isUnknown"):
            continue
        if track.get("confidence", 0) < _TRACKID_CONFIDENCE:
            continue
        artist = track.get("artist") or ""
        title = track.get("title") or ""
        key = (title.lower().strip(), artist.lower().strip())
        if key in seen_keys:
            continue
        seen_keys.add(key)
        tracks.append({
            "title": title or None,
            "artist": artist or None,
            "artists": artist or None,
            "duration_ms": None,  # TrackID window size (30s) is not the real duration
            "search_string": build_search_string(artist, title) if (artist or title) else None,
        })

    # 4. Save to shared URL cache (before inserting for this user)
    await _save_trackid_cache(normalized_url, tracks)

    # 5. Insert
    try:
        pool = await get_pool()
        async with rls_transaction(pool, user_id) as conn:
            inserted, skipped, jobs_created, ids = await _insert_tracks_and_create_jobs(
                conn, user_id, tracks, "trackid", queue_jobs=queue_jobs
            )
    except Exception as exc:
        await _fail(str(exc))
        return

    await _job_update(
        local_job_id,
        status="completed",
        progress=100,
        step=f"Done — {inserted} track{'s' if inserted != 1 else ''} identified",
        result={"imported": inserted, "skipped_duplicates": skipped, "jobs_created": jobs_created, "track_ids": ids},
    )


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
    track_ids: list[int] = []


class SpotifyPlaylist(BaseModel):
    id: str
    name: str
    track_count: Optional[int] = None
    owner: Optional[str] = None
    owner_id: Optional[str] = None
    image_url: Optional[str] = None
    is_owner: bool = False


_MAX_BULK_ITEMS = 1000


class BulkTrackIdsRequest(BaseModel):
    track_ids: list[int]

    @field_validator("track_ids")
    @classmethod
    def validate_track_ids_size(cls, v: list[int]) -> list[int]:
        if len(v) > _MAX_BULK_ITEMS:
            raise ValueError(f"track_ids cannot exceed {_MAX_BULK_ITEMS} items")
        return v


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
    await audit_log(user_id, "spotify.token_refresh", resource_type="spotify")
    return new_access


def _map_spotify_track(item: dict) -> dict:
    """Map a Spotify playlist track item to our tracks schema."""
    # Spotify API uses "track" in the old format and "item" in the new format
    track = item.get("track") or item.get("item") or {}
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
) -> tuple[int, int, int, list[int]]:
    """Insert tracks (ON CONFLICT DO NOTHING) and optionally create download jobs.

    Returns (inserted, skipped_duplicates, jobs_created, inserted_ids).
    When queue_jobs=False, tracks are inserted but no pipeline_jobs rows are created.
    """
    inserted = 0
    skipped = 0
    jobs_created = 0
    inserted_ids: list[int] = []

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
            inserted_ids.append(result)  # always collect newly-inserted IDs
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

    # For Spotify/CSV tracks (have spotify_uri): re-fetch to also include any
    # pre-existing tracks skipped by ON CONFLICT DO NOTHING.
    # For TrackID tracks (no spotify_uri): the loop already collected all IDs above.
    spotify_uris = [t["spotify_uri"] for t in tracks if t.get("spotify_uri")]
    if spotify_uris:
        rows = await conn.fetch(
            "SELECT id FROM tracks WHERE user_id = $1 AND spotify_uri = ANY($2)",
            user_id, spotify_uris,
        )
        inserted_ids = [r["id"] for r in rows]

    return inserted, skipped, jobs_created, inserted_ids


# ─── Endpoints ────────────────────────────────────────────────────────────────

@router.get("/tracks", response_model=TrackListResponse)
@limiter.limit("300/hour")
async def list_tracks(
    request: Request,
    page: int = Query(1, ge=1),
    per_page: int = Query(50, ge=1, le=1000),
    status_filter: Optional[str] = Query(None, alias="status"),
    search: Optional[str] = Query(None),
    id: Optional[list[int]] = Query(None),
    user: CurrentUser = Depends(get_current_user),
):
    pool = await get_pool()
    offset = (page - 1) * per_page

    conditions = ["t.user_id = $1"]
    args: list = [user.user_id]

    if id:
        args.append(id)
        conditions.append(f"t.id = ANY(${len(args)})")

    if status_filter:
        args.append(status_filter)
        conditions.append(f"t.acquisition_status = ${len(args)}")

    if search:
        args.append(f"%{search}%")
        conditions.append(f"(t.title ILIKE ${len(args)} OR t.artist ILIKE ${len(args)})")

    where = " AND ".join(conditions)

    total = await pool.fetchval(f"SELECT COUNT(*) FROM tracks t WHERE {where}", *args)

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
@limiter.limit("300/hour")
async def get_track(
    request: Request,
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
@limiter.limit("300/hour")
async def catalog_stats(request: Request, user: CurrentUser = Depends(get_current_user)):
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
@limiter.limit("20/hour")
async def import_csv(
    request: Request,
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
        inserted, skipped, jobs_created, ids = await _insert_tracks_and_create_jobs(
            conn, user.user_id, tracks, "exportify", queue_jobs=queue_jobs
        )

    await audit_log(
        user.user_id, "track.import.csv",
        resource_type="track",
        details={"imported": inserted, "skipped": skipped, "jobs_created": jobs_created, "filename": file.filename},
        ip_address=request.client.host if request.client else None,
    )
    return ImportResult(imported=inserted, skipped_duplicates=skipped, jobs_created=jobs_created, track_ids=ids)


class SpotifyImportRequest(BaseModel):
    playlist_id: str



@router.post("/import/spotify", response_model=ImportResult, status_code=status.HTTP_201_CREATED)
@limiter.limit("20/hour")
async def import_spotify(
    request: Request,
    body: SpotifyImportRequest = Body(...),
    queue_jobs: bool = Query(True),
    user: CurrentUser = Depends(get_current_user),
):
    access_token = await _get_spotify_token(user.user_id)

    # Paginate through the full playlist
    tracks: list[dict] = []
    url = f"https://api.spotify.com/v1/playlists/{body.playlist_id}/items"
    params: dict = {"limit": 100}

    async with httpx.AsyncClient() as client:
        while url:
            r = await client.get(url, headers={"Authorization": f"Bearer {access_token}"}, params=params)
            if r.status_code == 401:
                raise HTTPException(status_code=400, detail="Spotify token expired or revoked. Please reconnect Spotify in Settings.")
            if r.status_code == 403:
                raise HTTPException(
                    status_code=403,
                    detail="This playlist can't be imported — Spotify restricts API access to it. Try a different playlist.",
                )
            if not r.is_success:
                raise HTTPException(status_code=502, detail=f"Spotify API error: {r.status_code}")
            data = r.json()
            for item in data.get("items", []):
                # Spotify uses "track" (old API) or "item" (new API)
                track_data = item.get("track") or item.get("item")
                if track_data and track_data.get("uri"):
                    tracks.append(_map_spotify_track(item))
            url = data.get("next")
            params = {}  # next URL already has params

    pool = await get_pool()
    async with rls_transaction(pool, user.user_id) as conn:
        inserted, skipped, jobs_created, ids = await _insert_tracks_and_create_jobs(
            conn, user.user_id, tracks, "spotify", queue_jobs=queue_jobs
        )

    await audit_log(
        user.user_id, "track.import.spotify",
        resource_type="track",
        details={"imported": inserted, "skipped": skipped, "jobs_created": jobs_created, "playlist_id": body.playlist_id},
        ip_address=request.client.host if request.client else None,
    )
    return ImportResult(imported=inserted, skipped_duplicates=skipped, jobs_created=jobs_created, track_ids=ids)


@router.get("/import/spotify/playlists", response_model=list[SpotifyPlaylist])
@limiter.limit("300/hour")
async def list_spotify_playlists(request: Request, user: CurrentUser = Depends(get_current_user)):
    access_token = await _get_spotify_token(user.user_id)

    # Get the user's Spotify ID to determine playlist ownership
    spotify_user_id: str | None = None
    seen_ids: set[str] = set()
    playlists: list[SpotifyPlaylist] = []
    url = "https://api.spotify.com/v1/me/playlists"
    params = {"limit": 50}

    async with httpx.AsyncClient() as client:
        me = await client.get("https://api.spotify.com/v1/me", headers={"Authorization": f"Bearer {access_token}"})
        if me.is_success:
            spotify_user_id = me.json().get("id")

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
                    owner_obj = p.get("owner") or {}
                    owner_id = owner_obj.get("id")
                    playlists.append(SpotifyPlaylist(
                        id=p["id"],
                        name=p["name"],
                        track_count=(p.get("tracks") or p.get("items") or {}).get("total"),
                        owner=owner_obj.get("display_name"),
                        owner_id=owner_id,
                        image_url=images[0]["url"] if images else None,
                        is_owner=(owner_id == spotify_user_id) if spotify_user_id and owner_id else False,
                    ))
            url = data.get("next")
            params = {}

    return playlists


class TrackIdImportRequest(BaseModel):
    url: str


@router.post("/import/trackid", status_code=status.HTTP_202_ACCEPTED)
@limiter.limit("20/hour")
async def import_trackid_url(
    request: Request,
    body: TrackIdImportRequest = Body(...),
    queue_jobs: bool = Query(True),
    background_tasks: BackgroundTasks = ...,
    user: CurrentUser = Depends(get_current_user),
):
    """Flow 3: validate URL, check cache, start background polling job if needed."""
    from djtoolkit.importers.trackid import validate_url

    try:
        normalized = validate_url(body.url)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(e))

    local_job_id = str(uuid.uuid4())

    # Cache hit — insert immediately and return a pre-completed job
    cached_tracks = await _load_trackid_cache(normalized)
    if cached_tracks is not None:
        try:
            pool = await get_pool()
            async with rls_transaction(pool, user.user_id) as conn:
                inserted, skipped, jobs_created, ids = await _insert_tracks_and_create_jobs(
                    conn, user.user_id, cached_tracks, "trackid", queue_jobs=queue_jobs
                )
        except Exception as exc:
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(exc))

        await _job_create(local_job_id, user.user_id, normalized)
        await _job_update(
            local_job_id,
            status="completed",
            progress=100,
            step=f"Done — {inserted} track{'s' if inserted != 1 else ''} identified (cached)",
            result={"imported": inserted, "skipped_duplicates": skipped, "jobs_created": jobs_created, "track_ids": ids},
        )
        await audit_log(
            user.user_id, "track.import.trackid",
            resource_type="trackid_job",
            resource_id=local_job_id,
            details={"url": normalized, "cached": True, "imported": inserted},
            ip_address=request.client.host if request.client else None,
        )
        return {"job_id": local_job_id}

    # Cache miss — start background job
    await _job_create(local_job_id, user.user_id, normalized)
    background_tasks.add_task(_run_trackid_background, local_job_id, normalized, user.user_id, queue_jobs)
    await audit_log(
        user.user_id, "track.import.trackid",
        resource_type="trackid_job",
        resource_id=local_job_id,
        details={"url": normalized},
        ip_address=request.client.host if request.client else None,
    )
    return {"job_id": local_job_id}


@router.get("/import/trackid/{job_id}/status")
@limiter.limit("300/hour")
async def trackid_job_status(
    request: Request,
    job_id: str,
    user: CurrentUser = Depends(get_current_user),
):
    """Poll the status of a TrackID background import job."""
    job = await _job_get(job_id)
    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")
    return job


@router.delete("/tracks/bulk", response_model=BulkDeleteResult)
@limiter.limit("30/hour")
async def bulk_delete_tracks(
    request: Request,
    body: BulkTrackIdsRequest = Body(...),
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
    await audit_log(
        user.user_id, "track.bulk_delete",
        resource_type="track",
        details={"deleted": deleted, "requested_ids": body.track_ids},
        ip_address=request.client.host if request.client else None,
    )
    return BulkDeleteResult(deleted=deleted)


@router.post("/tracks/{track_id}/reset", status_code=status.HTTP_204_NO_CONTENT)
@limiter.limit("300/hour")
async def reset_track(
    request: Request,
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
    await audit_log(
        user.user_id, "track.reset",
        resource_type="track",
        resource_id=str(track_id),
        ip_address=request.client.host if request.client else None,
    )
