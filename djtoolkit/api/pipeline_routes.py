"""Pipeline routes — job queue for local agents.

Routes
------
GET  /pipeline/jobs              Fetch pending jobs (agent polls)
POST /pipeline/jobs/{id}/claim   Atomically claim a job (FOR UPDATE SKIP LOCKED)
PUT  /pipeline/jobs/{id}/result  Agent reports result + cloud updates track flags
GET  /pipeline/status            Queue depth + agent health summary
GET  /pipeline/events            SSE stream for real-time UI updates
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from djtoolkit.api.auth import CurrentUser, get_current_user
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


class JobResultRequest(BaseModel):
    result: Optional[dict]
    error: Optional[str]
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


class BulkJobsRequest(BaseModel):
    track_ids: list[int]


class BulkJobsResult(BaseModel):
    created: int


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
async def bulk_create_jobs(
    body: BulkJobsRequest,
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

    return BulkJobsResult(created=created)


@router.get("/jobs", response_model=list[JobOut])
async def fetch_jobs(
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


@router.post("/jobs/{job_id}/claim", response_model=JobOut)
async def claim_job(
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
async def report_job_result(
    job_id: str,
    body: JobResultRequest,
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
                # Mark track as failed
                await conn.execute(
                    "UPDATE tracks SET acquisition_status = 'failed', updated_at = NOW() WHERE id = $1 AND user_id = $2",
                    job["track_id"], user.user_id,
                )

    # Broadcast job update to any listening SSE connections
    broadcast(user.user_id, "job_update", {
        "job_id": job_id,
        "job_type": job["job_type"],
        "status": body.status,
        "track_id": job["track_id"],
    })


@router.get("/status", response_model=PipelineStatusResponse)
async def pipeline_status(user: CurrentUser = Depends(get_current_user)):
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
async def pipeline_events(
    request: Request,
    token: Optional[str] = Query(None),
    user: CurrentUser = Depends(get_current_user),
):
    """Server-Sent Events stream for real-time pipeline updates.

    EventSource doesn't support custom headers, so the JWT can be passed
    as the ``token`` query parameter instead of Authorization header.
    """
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
