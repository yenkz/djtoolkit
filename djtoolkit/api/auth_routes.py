"""Agent management routes.

All endpoints require a valid Supabase JWT (web users managing their agents).

Routes
------
POST   /agents/register         Register a new agent; returns the plain API key once.
POST   /agents/heartbeat        Agent reports it is alive + current capabilities.
GET    /agents                  List all agents for the authenticated user.
DELETE /agents/{agent_id}       Remove an agent (and revoke its key).
"""

from __future__ import annotations

import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel

from djtoolkit.api.audit import audit_log
from djtoolkit.api.auth import CurrentUser, create_agent_key, get_current_user
from djtoolkit.api.rate_limit import limiter, _get_agent_rate_limit_key
from djtoolkit.db.postgres import get_pool


router = APIRouter(prefix="/agents", tags=["agents"])


# ─── Request / response models ────────────────────────────────────────────────

class AgentRegisterRequest(BaseModel):
    machine_name: Optional[str] = None
    capabilities: Optional[list[str]] = None


class AgentRegisterResponse(BaseModel):
    agent_id: str
    api_key: str     # shown once — not stored in plain form
    message: str = "Store this key securely — it will not be shown again."


class AgentHeartbeatRequest(BaseModel):
    capabilities: Optional[list[str]] = None
    version: Optional[str] = None
    active_jobs: Optional[int] = None


class AgentOut(BaseModel):
    id: str
    machine_name: Optional[str]
    last_seen_at: Optional[str]
    capabilities: Optional[list[str]]
    created_at: str


# ─── Endpoints ────────────────────────────────────────────────────────────────

@router.post("/register", response_model=AgentRegisterResponse, status_code=status.HTTP_201_CREATED)
@limiter.limit("10/hour")
async def register_agent(
    request: Request,
    body: AgentRegisterRequest,
    user: CurrentUser = Depends(get_current_user),
):
    """Register a new local agent for the authenticated user.

    Returns the plain API key once.  Store it in the agent's config.
    """
    plain_key, key_hash, key_prefix = create_agent_key()
    agent_id = str(uuid.uuid4())
    pool = await get_pool()
    await pool.execute(
        """
        INSERT INTO agents (id, user_id, api_key_hash, api_key_prefix, machine_name, capabilities)
        VALUES ($1, $2, $3, $4, $5, $6)
        """,
        agent_id,
        user.user_id,
        key_hash,
        key_prefix,
        body.machine_name,
        body.capabilities or [],
    )
    await audit_log(
        user.user_id, "agent.register",
        resource_type="agent",
        resource_id=agent_id,
        details={"machine_name": body.machine_name},
        ip_address=request.client.host if request.client else None,
    )
    return AgentRegisterResponse(agent_id=agent_id, api_key=plain_key)


@router.post("/heartbeat", status_code=status.HTTP_204_NO_CONTENT)
@limiter.limit("200/hour", key_func=_get_agent_rate_limit_key)
async def agent_heartbeat(
    request: Request,
    body: AgentHeartbeatRequest,
    user: CurrentUser = Depends(get_current_user),
):
    """Update ``last_seen_at`` for the authenticated agent.

    Only callable with an agent API key (not a JWT) — ``user.agent_id`` must be set.
    """
    if user.agent_id is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Heartbeat requires an agent API key, not a JWT",
        )
    pool = await get_pool()
    updates = ["last_seen_at = NOW()"]
    args: list = [user.agent_id]

    if body.capabilities is not None:
        updates.append(f"capabilities = ${len(args) + 1}")
        args.append(body.capabilities)

    if body.version is not None:
        updates.append(f"version = ${len(args) + 1}")
        args.append(body.version)

    if body.active_jobs is not None:
        updates.append(f"active_jobs = ${len(args) + 1}")
        args.append(body.active_jobs)

    await pool.execute(
        f"UPDATE agents SET {', '.join(updates)} WHERE id = $1",
        *args,
    )


@router.get("", response_model=list[AgentOut])
@limiter.limit("300/hour")
async def list_agents(request: Request, user: CurrentUser = Depends(get_current_user)):
    """List all registered agents for the authenticated user."""
    pool = await get_pool()
    rows = await pool.fetch(
        """
        SELECT id, machine_name, last_seen_at, capabilities, created_at
        FROM agents
        WHERE user_id = $1
        ORDER BY created_at DESC
        """,
        user.user_id,
    )
    return [
        AgentOut(
            id=str(r["id"]),
            machine_name=r["machine_name"],
            last_seen_at=r["last_seen_at"].isoformat() if r["last_seen_at"] else None,
            capabilities=list(r["capabilities"]) if r["capabilities"] else [],
            created_at=r["created_at"].isoformat(),
        )
        for r in rows
    ]


@router.delete("/{agent_id}", status_code=status.HTTP_204_NO_CONTENT)
@limiter.limit("300/hour")
async def delete_agent(
    request: Request,
    agent_id: str,
    user: CurrentUser = Depends(get_current_user),
):
    """Delete an agent, revoking its API key.

    Only the owning user can delete their agents.
    """
    pool = await get_pool()
    result = await pool.execute(
        "DELETE FROM agents WHERE id = $1 AND user_id = $2",
        agent_id,
        user.user_id,
    )
    # asyncpg returns "DELETE N" — check the count
    deleted = int(result.split()[-1])
    if deleted == 0:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Agent not found")
    await audit_log(
        user.user_id, "agent.delete",
        resource_type="agent",
        resource_id=agent_id,
        ip_address=request.client.host if request.client else None,
    )
