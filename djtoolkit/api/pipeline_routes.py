"""Pipeline routes — job queue for local agents.

Routes
------
GET  /pipeline/jobs                Fetch pending jobs (agent polls)
POST /pipeline/jobs/batch/claim    Batch-claim all pending jobs of a type
POST /pipeline/jobs/{id}/claim     Atomically claim a single job
PUT  /pipeline/jobs/{id}/result    Agent reports result + cloud updates track flags
GET  /pipeline/status              Queue depth + agent health summary
GET  /pipeline/events              SSE stream for real-time UI updates
"""

import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, field_validator

from djtoolkit.api.audit import audit_log
from djtoolkit.api.auth import CurrentUser, get_current_user, verify_jwt
from djtoolkit.api.rate_limit import limiter, _get_agent_rate_limit_key
from djtoolkit.db.postgres import get_pool

router = APIRouter(prefix="/pipeline", tags=["pipeline"])
log = logging.getLogger(__name__)



def _jsonb(val) -> dict | None:
    """Safely decode asyncpg JSONB — handles both dict and raw JSON string."""
    if val is None:
        return None
    if isinstance(val, str):
        return json.loads(val) if val else None
    return dict(val)

# ─── SSE broadcaster ──────────────────────────────────────────────────────────
# Simple in-process pub/sub — sufficient for MVP single-process deployment.
# For multi-process deployment, replace with Redis pub/sub.

_sse_queues: dict[str, set[asyncio.Queue]] = {}  # user_id → set of queues


def _subscribe(user_id: str) -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue(maxsize=100)
    _sse_queues.setdefault(user_id, set()).add(q)
    return q


def _unsubscribe(user_id: str, q: asyncio.Queue) -> None:
    if user_id in _sse_queues:
        _sse_queues[user_id].discard(q)


def broadcast(user_id: str, event_type: str, data: dict) -> None:
    """Push an SSE event to all active connections for a user."""
    payload = json.dumps({"type": event_type, "data": data})
    for q in list(_sse_queues.get(user_id, set())):
        try:
            q.put_nowait(payload)
        except asyncio.QueueFull:
            pass


# ─── Request / response models ────────────────────────────────────────────────

class JobOut(BaseModel):
    id: str
    job_type: str
    status: str
    track_id: Optional[int]
    payload: Optional[dict]
    created_at: str


class JobDetailOut(BaseModel):
    id: str
    job_type: str
    status: str
    track_id: Optional[int]
    payload: Optional[dict]
    result: Optional[dict]
    error: Optional[str]
    retry_count: int
    claimed_at: Optional[str]
    completed_at: Optional[str]
    created_at: str
    track_title: Optional[str]
    track_artist: Optional[str]
    track_artwork_url: Optional[str]
    track_album: Optional[str]


class JobListResponse(BaseModel):
    jobs: list[JobDetailOut]
    total: int
    page: int
    per_page: int


class JobResultRequest(BaseModel):
    result: Optional[dict] = None
    error: Optional[str] = None
    status: str  # 'done' | 'failed'


class AgentStatus(BaseModel):
    id: str
    machine_name: Optional[str]
    last_seen_at: Optional[str]
    capabilities: Optional[list[str]]


class PipelineStatusResponse(BaseModel):
    pending: int
    running: int
    agents: list[AgentStatus]


_MAX_BULK_ITEMS = 1000


class BulkJobsRequest(BaseModel):
    track_ids: list[int]

    @field_validator("track_ids")
    @classmethod
    def validate_track_ids_size(cls, v: list[int]) -> list[int]:
        if len(v) > _MAX_BULK_ITEMS:
            raise ValueError(f"track_ids cannot exceed {_MAX_BULK_ITEMS} items")
        return v


class BulkJobsResult(BaseModel):
    created: int


class RetryJobsRequest(BaseModel):
    job_ids: Optional[list[str]] = None
    filter_status: Optional[str] = None
    filter_job_type: Optional[str] = None

    @field_validator("job_ids")
    @classmethod
    def validate_job_ids_size(cls, v: Optional[list[str]]) -> Optional[list[str]]:
        if v and len(v) > _MAX_BULK_ITEMS:
            raise ValueError(f"job_ids cannot exceed {_MAX_BULK_ITEMS} items")
        return v


class RetryJobsResult(BaseModel):
    retried: int


# ─── Helpers ──────────────────────────────────────────────────────────────────

async def _apply_job_result(conn, job_id: str, user_id: str, job_type: str, result: dict) -> None:
    """Update track flags based on completed job result."""
    track_id = await conn.fetchval(
        "SELECT track_id FROM pipeline_jobs WHERE id = $1", job_id
    )
    if not track_id:
        return

    match job_type:
        case "download":
            local_path = result.get("local_path")
            if local_path:
                await conn.execute(
                    "UPDATE tracks SET acquisition_status = 'available', local_path = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3",
                    local_path, track_id, user_id,
                )
                # Auto-queue fingerprint job
                await conn.execute(
                    """
                    INSERT INTO pipeline_jobs (user_id, track_id, job_type, payload)
                    VALUES ($1, $2, 'fingerprint', $3)
                    """,
                    user_id, track_id,
                    json.dumps({"track_id": track_id, "local_path": local_path}),
                )

        case "fingerprint":
            fingerprint = result.get("fingerprint")
            if fingerprint:
                # Insert into fingerprints table and link track
                fp_id = await conn.fetchval(
                    "INSERT INTO fingerprints (user_id, track_id, fingerprint, acoustid, duration) VALUES ($1, $2, $3, $4, $5) RETURNING id",
                    user_id, track_id, fingerprint,
                    result.get("acoustid"), result.get("duration"),
                )
                # Duplicate check — exact Chromaprint match against existing in-library tracks
                dupe = await conn.fetchrow(
                    """
                    SELECT t.id FROM fingerprints f
                    JOIN tracks t ON t.fingerprint_id = f.id
                    WHERE f.user_id = $1
                      AND f.fingerprint = $2
                      AND f.id != $3
                      AND t.in_library = TRUE
                    LIMIT 1
                    """,
                    user_id, fingerprint, fp_id,
                )
                if dupe:
                    await conn.execute(
                        "UPDATE tracks SET acquisition_status = 'duplicate', fingerprinted = TRUE, fingerprint_id = $1, updated_at = NOW() WHERE id = $2",
                        fp_id, track_id,
                    )
                else:
                    await conn.execute(
                        "UPDATE tracks SET fingerprinted = TRUE, fingerprint_id = $1, updated_at = NOW() WHERE id = $2",
                        fp_id, track_id,
                    )
                    # Auto-queue cover_art job
                    local_path = await conn.fetchval("SELECT local_path FROM tracks WHERE id = $1", track_id)
                    if local_path:
                        row = await conn.fetchrow("SELECT artist, album, title FROM tracks WHERE id = $1", track_id)
                        await conn.execute(
                            """
                            INSERT INTO pipeline_jobs (user_id, track_id, job_type, payload)
                            VALUES ($1, $2, 'cover_art', $3)
                            """,
                            user_id, track_id,
                            json.dumps({
                                "track_id": track_id,
                                "local_path": local_path,
                                "artist": row["artist"] or "",
                                "album": row["album"] or "",
                                "title": row["title"] or "",
                            }),
                        )

        case "metadata":
            new_path = result.get("local_path")
            updates = ["metadata_written = TRUE", "updated_at = NOW()"]
            args: list = [track_id, user_id]
            if new_path:
                updates.append(f"local_path = ${len(args) + 1}")
                args.append(new_path)
            await conn.execute(
                f"UPDATE tracks SET {', '.join(updates)} WHERE id = $1 AND user_id = $2",
                *args,
            )

        case "cover_art":
            if result.get("cover_art_written"):
                await conn.execute(
                    "UPDATE tracks SET cover_art_written = TRUE, cover_art_embedded_at = NOW(), updated_at = NOW() WHERE id = $1 AND user_id = $2",
                    track_id, user_id,
                )
            # Auto-queue metadata job (regardless of cover_art success)
            local_path = await conn.fetchval("SELECT local_path FROM tracks WHERE id = $1", track_id)
            if local_path:
                row = await conn.fetchrow(
                    """SELECT title, artist, album, artists, year, release_date,
                              genres, record_label, isrc, tempo, key, mode,
                              duration_ms, enriched_spotify, enriched_audio
                       FROM tracks WHERE id = $1""",
                    track_id,
                )
                # Reconstruct musical_key from key + mode columns
                musical_key = ""
                if row["key"] is not None and row["mode"] is not None:
                    key_names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
                    k = int(row["key"])
                    if 0 <= k < 12:
                        musical_key = f"{key_names[k]}{'m' if row['mode'] == 0 else ''}"
                await conn.execute(
                    """
                    INSERT INTO pipeline_jobs (user_id, track_id, job_type, payload)
                    VALUES ($1, $2, 'metadata', $3)
                    """,
                    user_id, track_id,
                    json.dumps({
                        "track_id": track_id,
                        "local_path": local_path,
                        "title": row["title"] or "",
                        "artist": row["artist"] or "",
                        "album": row["album"] or "",
                        "artists": row["artists"] or "",
                        "year": row["year"],
                        "release_date": row["release_date"] or "",
                        "genres": row["genres"] or "",
                        "record_label": row["record_label"] or "",
                        "isrc": row["isrc"] or "",
                        "bpm": row["tempo"],
                        "musical_key": musical_key,
                        "duration_ms": row["duration_ms"],
                        "metadata_source": "spotify" if row["enriched_spotify"] else (
                            "audio-analysis" if row["enriched_audio"] else None
                        ),
                    }),
                )


# ─── Stale job recovery (called during lifespan or background task) ───────────

async def recover_stale_jobs() -> int:
    """Reset claimed jobs that haven't progressed in 5 minutes.

    Returns the number of jobs reset.
    """
    pool = await get_pool()
    result = await pool.execute(
        """
        UPDATE pipeline_jobs
        SET status = 'pending', claimed_at = NULL, agent_id = NULL
        WHERE status = 'claimed'
          AND claimed_at < NOW() - INTERVAL '5 minutes'
        """
    )
    count = int(result.split()[-1])
    if count:
        log.info("Recovered %d stale job(s) → pending", count)
    return count


# ─── Background stale-job sweeper ─────────────────────────────────────────────

async def _stale_job_sweeper() -> None:
    """Background task: run stale job recovery every 60 seconds."""
    while True:
        await asyncio.sleep(60)
        try:
            await recover_stale_jobs()
        except Exception as exc:
            log.warning("stale_job_sweeper error: %s", exc)


# Register sweeper on startup — imported by app.py
def start_background_tasks(app) -> None:
    @app.on_event("startup")
    async def _start():
        asyncio.create_task(_stale_job_sweeper())


# ─── Endpoints ────────────────────────────────────────────────────────────────

@router.post("/jobs/bulk", response_model=BulkJobsResult, status_code=status.HTTP_201_CREATED)
@limiter.limit("30/hour")
async def bulk_create_jobs(
    request: Request,
    body: BulkJobsRequest = Body(...),
    user: CurrentUser = Depends(get_current_user),
):
    """Create one download job per track_id. Skips tracks the user doesn't own,
    non-candidate tracks, and tracks that already have a pending/running job."""
    if not body.track_ids:
        return BulkJobsResult(created=0)

    pool = await get_pool()
    async with pool.acquire() as conn:
        created = 0
        for track_id in body.track_ids:
            track = await conn.fetchrow(
                """SELECT id, title, artist, search_string, duration_ms
                   FROM tracks
                   WHERE id = $1 AND user_id = $2 AND acquisition_status = 'candidate'""",
                track_id, user.user_id,
            )
            if track is None:
                continue  # not found or not owned — skip silently

            existing = await conn.fetchval(
                """SELECT id FROM pipeline_jobs
                   WHERE track_id = $1 AND status IN ('pending', 'claimed', 'running')
                   LIMIT 1""",
                track_id,
            )
            if existing:
                continue

            await conn.execute(
                """INSERT INTO pipeline_jobs (user_id, track_id, job_type, payload)
                   VALUES ($1, $2, 'download', $3)""",
                user.user_id, track_id,
                json.dumps({
                    "track_id": track_id,
                    "search_string": track["search_string"] or "",
                    "artist": track["artist"] or "",
                    "title": track["title"] or "",
                    "duration_ms": track["duration_ms"] or 0,
                }),
            )
            created += 1

    await audit_log(
        user.user_id, "job.bulk_create",
        resource_type="pipeline_job",
        details={"created": created, "requested_track_ids": body.track_ids},
        ip_address=request.client.host if request.client else None,
    )
    return BulkJobsResult(created=created)


@router.post("/jobs/retry", response_model=RetryJobsResult)
@limiter.limit("30/hour")
async def retry_jobs(
    request: Request,
    body: RetryJobsRequest = Body(...),
    user: CurrentUser = Depends(get_current_user),
):
    """Retry failed (or done) jobs by resetting them to pending.

    Either provide explicit job_ids, or use filter_status/filter_job_type
    to retry all matching jobs.
    """
    pool = await get_pool()

    if body.job_ids:
        # Retry specific jobs by ID
        result = await pool.execute(
            """
            UPDATE pipeline_jobs
            SET status = 'pending',
                claimed_at = NULL,
                completed_at = NULL,
                agent_id = NULL,
                error = NULL,
                result = NULL
            WHERE user_id = $1
              AND id = ANY($2::uuid[])
              AND status IN ('failed', 'done')
            """,
            user.user_id, body.job_ids,
        )
        retried = int(result.split()[-1])
    else:
        # Retry by filter
        where = ["user_id = $1", "status IN ('failed', 'done')"]
        args: list = [user.user_id]
        idx = 2

        if body.filter_status and body.filter_status in ("failed", "done"):
            where[-1] = f"status = ${idx}"
            args.append(body.filter_status)
            idx += 1
        if body.filter_job_type:
            where.append(f"job_type = ${idx}")
            args.append(body.filter_job_type)
            idx += 1

        result = await pool.execute(
            f"""
            UPDATE pipeline_jobs
            SET status = 'pending',
                claimed_at = NULL,
                completed_at = NULL,
                agent_id = NULL,
                error = NULL,
                result = NULL
            WHERE {' AND '.join(where)}
            """,
            *args,
        )
        retried = int(result.split()[-1])

    if retried:
        broadcast(user.user_id, "job_update", {"action": "retry", "count": retried})

    await audit_log(
        user.user_id, "job.retry",
        resource_type="pipeline_job",
        details={
            "retried": retried,
            "job_ids": body.job_ids,
            "filter_status": body.filter_status,
            "filter_job_type": body.filter_job_type,
        },
        ip_address=request.client.host if request.client else None,
    )
    return RetryJobsResult(retried=retried)


@router.get("/jobs", response_model=list[JobOut])
@limiter.limit("300/hour")
async def fetch_jobs(
    request: Request,
    limit: int = Query(2, ge=1, le=10),
    user: CurrentUser = Depends(get_current_user),
):
    """Return pending jobs for the authenticated user's agent to process."""
    pool = await get_pool()
    rows = await pool.fetch(
        """
        SELECT id, job_type, status, track_id, payload, created_at
        FROM pipeline_jobs
        WHERE user_id = $1 AND status = 'pending'
        ORDER BY priority DESC, created_at ASC
        LIMIT $2
        """,
        user.user_id, limit,
    )
    return [
        JobOut(
            id=str(r["id"]),
            job_type=r["job_type"],
            status=r["status"],
            track_id=r["track_id"],
            payload=_jsonb(r["payload"]),
            created_at=r["created_at"].isoformat(),
        )
        for r in rows
    ]


@router.post("/jobs/batch/claim", response_model=list[JobOut])
@limiter.limit("60/hour")
async def batch_claim_jobs(
    request: Request,
    type: str = Query(..., description="Job type to claim"),
    limit: int = Query(50, ge=1, le=100),
    user: CurrentUser = Depends(get_current_user),
):
    """Atomically claim all pending jobs of a given type.

    Returns pre-claimed jobs — caller skips the separate claim step.
    Uses FOR UPDATE SKIP LOCKED to avoid races with other agents.
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            rows = await conn.fetch(
                """
                UPDATE pipeline_jobs
                SET status = 'claimed',
                    claimed_at = NOW(),
                    agent_id = $1
                WHERE id = ANY(
                    SELECT id FROM pipeline_jobs
                    WHERE user_id = $2
                      AND status = 'pending'
                      AND job_type = $3
                    ORDER BY priority DESC, created_at ASC
                    FOR UPDATE SKIP LOCKED
                    LIMIT $4
                )
                RETURNING id, job_type, status, track_id, payload, created_at
                """,
                user.agent_id, user.user_id, type, limit,
            )

    return [
        JobOut(
            id=str(r["id"]),
            job_type=r["job_type"],
            status=r["status"],
            track_id=r["track_id"],
            payload=_jsonb(r["payload"]),
            created_at=r["created_at"].isoformat(),
        )
        for r in rows
    ]


@router.post("/jobs/{job_id}/claim", response_model=JobOut)
@limiter.limit("100/hour")
async def claim_job(
    request: Request,
    job_id: str,
    user: CurrentUser = Depends(get_current_user),
):
    """Atomically claim a pending job using FOR UPDATE SKIP LOCKED.

    Returns 409 if the job has already been claimed by another agent.
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            row = await conn.fetchrow(
                """
                UPDATE pipeline_jobs
                SET status = 'claimed',
                    claimed_at = NOW(),
                    agent_id = $1
                WHERE id = (
                    SELECT id FROM pipeline_jobs
                    WHERE id = $2
                      AND user_id = $3
                      AND status = 'pending'
                    FOR UPDATE SKIP LOCKED
                    LIMIT 1
                )
                RETURNING id, job_type, status, track_id, payload, created_at
                """,
                user.agent_id, job_id, user.user_id,
            )

    if not row:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Job is not available (already claimed or not found)",
        )

    return JobOut(
        id=str(row["id"]),
        job_type=row["job_type"],
        status=row["status"],
        track_id=row["track_id"],
        payload=_jsonb(row["payload"]),
        created_at=row["created_at"].isoformat(),
    )


@router.put("/jobs/{job_id}/result", status_code=status.HTTP_204_NO_CONTENT)
@limiter.limit("100/hour")
async def report_job_result(
    request: Request,
    job_id: str,
    body: JobResultRequest = Body(...),
    user: CurrentUser = Depends(get_current_user),
):
    """Agent reports completion or failure of a job.

    On success, track flags are updated and the next pipeline job is auto-queued.
    """
    if body.status not in ("done", "failed"):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="status must be 'done' or 'failed'",
        )

    pool = await get_pool()

    # Verify job belongs to this user
    job = await pool.fetchrow(
        "SELECT job_type, track_id FROM pipeline_jobs WHERE id = $1 AND user_id = $2",
        job_id, user.user_id,
    )
    if not job:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")

    try:
        async with pool.acquire() as conn:
            async with conn.transaction():
                await conn.execute(
                    """
                    UPDATE pipeline_jobs
                    SET status = $1,
                        result = $2,
                        error  = $3,
                        completed_at = NOW()
                    WHERE id = $4
                    """,
                    body.status,
                    json.dumps(body.result) if body.result else None,
                    body.error,
                    job_id,
                )

                if body.status == "done" and body.result:
                    await _apply_job_result(conn, job_id, user.user_id, job["job_type"], body.result)
                elif body.status == "failed" and job["job_type"] == "download":
                    retry_count = await conn.fetchval(
                        "SELECT retry_count FROM pipeline_jobs WHERE id = $1", job_id,
                    ) or 0
                    if retry_count < 3:
                        # Re-queue with incremented retry count
                        payload = await conn.fetchval(
                            "SELECT payload FROM pipeline_jobs WHERE id = $1", job_id,
                        )
                        await conn.execute(
                            """
                            INSERT INTO pipeline_jobs (user_id, track_id, job_type, payload, retry_count)
                            VALUES ($1, $2, 'download', $3, $4)
                            """,
                            user.user_id, job["track_id"], payload, retry_count + 1,
                        )
                    else:
                        # Max retries exceeded — mark track as failed
                        await conn.execute(
                            "UPDATE tracks SET acquisition_status = 'failed', updated_at = NOW() WHERE id = $1 AND user_id = $2",
                            job["track_id"], user.user_id,
                        )
    except HTTPException:
        raise
    except Exception:
        log.exception("report_job_result failed for job %s (type=%s)", job_id, job.get("job_type"))
        raise

    # Broadcast job update to any listening SSE connections
    broadcast(user.user_id, "job_update", {
        "job_id": job_id,
        "job_type": job["job_type"],
        "status": body.status,
        "track_id": job["track_id"],
    })

    await audit_log(
        user.user_id, "job.result",
        resource_type="pipeline_job",
        resource_id=job_id,
        details={"job_type": job["job_type"], "status": body.status, "track_id": job["track_id"]},
        ip_address=request.client.host if request.client else None,
    )


@router.get("/jobs/history", response_model=JobListResponse)
@limiter.limit("600/hour")
async def list_jobs(
    request: Request,
    page: int = Query(1, ge=1),
    per_page: int = Query(50, ge=1, le=200),
    status_filter: Optional[str] = Query(None, alias="status"),
    job_type: Optional[str] = Query(None),
    user: CurrentUser = Depends(get_current_user),
):
    """List all pipeline jobs with optional filtering by status and type."""
    pool = await get_pool()

    where = ["j.user_id = $1"]
    args: list = [user.user_id]
    idx = 2

    if status_filter:
        where.append(f"j.status = ${idx}")
        args.append(status_filter)
        idx += 1
    if job_type:
        where.append(f"j.job_type = ${idx}")
        args.append(job_type)
        idx += 1

    where_clause = " AND ".join(where)

    total = await pool.fetchval(
        f"SELECT COUNT(*) FROM pipeline_jobs j WHERE {where_clause}",
        *args,
    )

    offset = (page - 1) * per_page
    args.extend([per_page, offset])
    rows = await pool.fetch(
        f"""
        SELECT j.id, j.job_type, j.status, j.track_id, j.payload, j.result,
               j.error, j.retry_count, j.claimed_at, j.completed_at, j.created_at,
               t.title AS track_title, t.artist AS track_artist,
               t.artwork_url AS track_artwork_url, t.album AS track_album
        FROM pipeline_jobs j
        LEFT JOIN tracks t ON t.id = j.track_id
        WHERE {where_clause}
        ORDER BY j.created_at DESC
        LIMIT ${idx} OFFSET ${idx + 1}
        """,
        *args,
    )

    return JobListResponse(
        jobs=[
            JobDetailOut(
                id=str(r["id"]),
                job_type=r["job_type"],
                status=r["status"],
                track_id=r["track_id"],
                payload=_jsonb(r["payload"]),
                result=_jsonb(r["result"]),
                error=r["error"],
                retry_count=r["retry_count"],
                claimed_at=r["claimed_at"].isoformat() if r["claimed_at"] else None,
                completed_at=r["completed_at"].isoformat() if r["completed_at"] else None,
                created_at=r["created_at"].isoformat(),
                track_title=r["track_title"],
                track_artist=r["track_artist"],
                track_artwork_url=r["track_artwork_url"],
                track_album=r["track_album"],
            )
            for r in rows
        ],
        total=total,
        page=page,
        per_page=per_page,
    )


@router.get("/status", response_model=PipelineStatusResponse)
@limiter.limit("300/hour")
async def pipeline_status(request: Request, user: CurrentUser = Depends(get_current_user)):
    pool = await get_pool()

    pending = await pool.fetchval(
        "SELECT COUNT(*) FROM pipeline_jobs WHERE user_id = $1 AND status = 'pending'",
        user.user_id,
    )
    running = await pool.fetchval(
        "SELECT COUNT(*) FROM pipeline_jobs WHERE user_id = $1 AND status IN ('claimed', 'running')",
        user.user_id,
    )
    agent_rows = await pool.fetch(
        "SELECT id, machine_name, last_seen_at, capabilities FROM agents WHERE user_id = $1 ORDER BY last_seen_at DESC NULLS LAST",
        user.user_id,
    )

    return PipelineStatusResponse(
        pending=pending,
        running=running,
        agents=[
            AgentStatus(
                id=str(r["id"]),
                machine_name=r["machine_name"],
                last_seen_at=r["last_seen_at"].isoformat() if r["last_seen_at"] else None,
                capabilities=list(r["capabilities"]) if r["capabilities"] else [],
            )
            for r in agent_rows
        ],
    )


@router.get("/events")
@limiter.limit("300/hour")
async def pipeline_events(
    request: Request,
    token: Optional[str] = Query(None),
):
    """Server-Sent Events stream for real-time pipeline updates.

    EventSource doesn't support custom headers, so the JWT is passed
    as the ``token`` query parameter instead of Authorization header.
    """
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing token")
    user = await verify_jwt(token)
    async def event_generator():
        q = _subscribe(user.user_id)
        try:
            # Send a heartbeat comment every 15s to keep the connection alive
            while True:
                try:
                    payload = await asyncio.wait_for(q.get(), timeout=15.0)
                    yield f"data: {payload}\n\n"
                except asyncio.TimeoutError:
                    yield ": heartbeat\n\n"

                if await request.is_disconnected():
                    break
        finally:
            _unsubscribe(user.user_id, q)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",  # Nginx: disable buffering for SSE
        },
    )
