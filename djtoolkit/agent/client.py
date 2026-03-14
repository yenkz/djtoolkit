"""HTTP client for agent-to-cloud API communication.

Wraps httpx.AsyncClient with bearer-token auth, retry logic,
and typed methods for the agent API surface.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

log = logging.getLogger(__name__)

MAX_BACKOFF = 300  # 5 minutes


class AgentRevoked(Exception):
    """Raised when the cloud returns 401 — agent key has been revoked."""


class AgentClient:
    """Async HTTP client for djtoolkit agent API calls."""

    def __init__(self, cloud_url: str, api_key: str, timeout: float = 30.0):
        self._base_url = cloud_url.rstrip("/") + "/api"
        self._api_key = api_key
        self._timeout = timeout
        self._client: httpx.AsyncClient | None = None
        self._consecutive_errors = 0

    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                base_url=self._base_url,
                headers={"Authorization": f"Bearer {self._api_key}"},
                timeout=self._timeout,
            )
        return self._client

    async def close(self) -> None:
        if self._client and not self._client.is_closed:
            await self._client.aclose()
            self._client = None

    def _backoff_seconds(self) -> float:
        """Exponential backoff: 5, 15, 45, 135, 300 (capped)."""
        return min(5 * (3 ** self._consecutive_errors), MAX_BACKOFF)

    async def _request(
        self, method: str, path: str, **kwargs: Any
    ) -> httpx.Response:
        client = await self._get_client()
        try:
            resp = await client.request(method, path, **kwargs)
        except httpx.HTTPError as exc:
            self._consecutive_errors += 1
            backoff = self._backoff_seconds()
            log.warning(
                "Network error (%s), will retry in %.0fs: %s",
                type(exc).__name__, backoff, exc,
            )
            raise

        if resp.status_code == 401:
            raise AgentRevoked("API key revoked or invalid (HTTP 401)")

        self._consecutive_errors = 0
        return resp

    # ─── Agent API methods ───────────────────────────────────────────────

    async def heartbeat(
        self,
        capabilities: list[str],
        version: str,
        active_jobs: int,
    ) -> bool:
        """Send heartbeat. Returns True on success, False on error."""
        try:
            resp = await self._request(
                "POST", "/agents/heartbeat",
                json={
                    "capabilities": capabilities,
                    "version": version,
                    "active_jobs": active_jobs,
                },
            )
            return resp.status_code == 204
        except httpx.HTTPError:
            return False

    async def poll_jobs(self, limit: int = 2) -> list[dict]:
        """Fetch pending jobs from the cloud. Returns list of job dicts."""
        try:
            resp = await self._request(
                "GET", "/pipeline/jobs", params={"limit": limit},
            )
            if resp.status_code == 200:
                return resp.json()
            return []
        except httpx.HTTPError:
            return []

    async def claim_job(self, job_id: str) -> dict | None:
        """Atomically claim a job. Returns claimed job dict or None."""
        try:
            resp = await self._request("POST", f"/pipeline/jobs/{job_id}/claim")
            if resp.status_code == 200:
                return resp.json()
            log.warning("Failed to claim job %s: %s", job_id, resp.status_code)
            return None
        except httpx.HTTPError:
            return None

    async def report_result(
        self,
        job_id: str,
        success: bool,
        result: dict | None = None,
        error: str | None = None,
    ) -> bool:
        """Report job completion or failure. Returns True on success."""
        body: dict[str, Any] = {
            "status": "done" if success else "failed",
        }
        if result is not None:
            body["result"] = result
        if error is not None:
            body["error"] = error
        try:
            resp = await self._request(
                "PUT", f"/pipeline/jobs/{job_id}/result", json=body,
            )
            if resp.status_code != 204:
                log.warning(
                    "Result report for %s returned %d: %s",
                    job_id, resp.status_code, resp.text[:200],
                )
            return resp.status_code == 204
        except httpx.HTTPError:
            return False

    async def batch_claim_downloads(self, limit: int = 50) -> list[dict]:
        """Batch-claim all pending download jobs. Returns pre-claimed job dicts."""
        try:
            resp = await self._request(
                "POST", "/pipeline/jobs/batch/claim",
                params={"type": "download", "limit": limit},
            )
            if resp.status_code == 200:
                return resp.json()
            return []
        except httpx.HTTPError:
            return []
