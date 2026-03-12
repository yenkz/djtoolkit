"""HTTP client for the djtoolkit cloud API (agent-facing endpoints)."""

from __future__ import annotations

import httpx


class AgentClient:
    def __init__(self, cloud_url: str, api_key: str) -> None:
        self._base = cloud_url.rstrip("/")
        self._headers = {"Authorization": f"Bearer {api_key}"}

    def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(headers=self._headers, timeout=30.0)

    async def heartbeat(self, machine_name: str, capabilities: list[str]) -> None:
        async with self._client() as c:
            r = await c.post(
                f"{self._base}/agents/heartbeat",
                json={"machine_name": machine_name, "capabilities": capabilities},
            )
            r.raise_for_status()

    async def fetch_jobs(self, limit: int = 2) -> list[dict]:
        async with self._client() as c:
            r = await c.get(f"{self._base}/pipeline/jobs", params={"limit": limit})
            r.raise_for_status()
            return r.json()

    async def claim_job(self, job_id: str) -> dict | None:
        """Atomically claim a job. Returns the job dict, or None if already claimed (409)."""
        async with self._client() as c:
            r = await c.post(f"{self._base}/pipeline/jobs/{job_id}/claim")
            if r.status_code == 409:
                return None
            r.raise_for_status()
            return r.json()

    async def report_result(
        self,
        job_id: str,
        result: dict | None,
        error: str | None,
    ) -> None:
        status = "done" if error is None else "failed"
        async with self._client() as c:
            r = await c.put(
                f"{self._base}/pipeline/jobs/{job_id}/result",
                json={"result": result, "error": error, "status": status},
            )
            r.raise_for_status()
