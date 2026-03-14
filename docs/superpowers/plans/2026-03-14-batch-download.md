# Batch Download Pipeline Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace per-job sequential Soulseek downloads with batch search + parallel download, matching the CLI's performance.

**Architecture:** New `POST /pipeline/jobs/batch/claim` endpoint returns all pending downloads pre-claimed. Agent daemon collects them and dispatches to `execute_download_batch()`, which fires `_search_all()` for all tracks simultaneously, downloads in parallel, and retries locally before reporting per-job results.

**Tech Stack:** Python 3.14, asyncio, aioslsk, FastAPI, asyncpg, httpx

**Spec:** `docs/superpowers/specs/2026-03-14-batch-download-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `djtoolkit/config.py` | Modify | Add `max_download_batch` to `AgentConfig` |
| `djtoolkit/api/pipeline_routes.py` | Modify | Add `POST /pipeline/jobs/batch/claim` endpoint |
| `djtoolkit/agent/client.py` | Modify | Add `batch_claim_downloads()` method |
| `djtoolkit/agent/executor.py` | Modify | Add `execute_download_batch()`, refactor shared client |
| `djtoolkit/agent/daemon.py` | Modify | Split poll loop for batch downloads vs individual jobs |
| `djtoolkit/agent/jobs/download.py` | Delete | Superseded by executor batch function |
| `tests/test_batch_download.py` | Create | Tests for batch claim endpoint and batch executor |

---

## Chunk 1: Config + Server Endpoint

### Task 1: Add `max_download_batch` config

**Files:**
- Modify: `djtoolkit/config.py:98-104` (AgentConfig dataclass)

- [ ] **Step 1: Add the field**

In `djtoolkit/config.py`, add `max_download_batch` to `AgentConfig`:

```python
@dataclass
class AgentConfig:
    cloud_url: str = "https://api.djtoolkit.com"
    api_key: str = ""           # env: DJTOOLKIT_AGENT_KEY
    poll_interval_sec: float = 30.0
    max_concurrent_jobs: int = 2
    max_download_batch: int = 50
    local_db_path: str = "~/.djtoolkit/agent.db"
```

- [ ] **Step 2: Commit**

```bash
git add djtoolkit/config.py
git commit -m "feat: add max_download_batch to AgentConfig"
```

### Task 2: Add batch claim endpoint

**Files:**
- Modify: `djtoolkit/api/pipeline_routes.py:429` (insert before `report_job_result`)
- Test: `tests/test_batch_download.py`

- [ ] **Step 1: Write the failing test**

Create `tests/test_batch_download.py`:

```python
"""Tests for batch download pipeline."""

import pytest
import uuid


@pytest.mark.asyncio
async def test_batch_claim_returns_pending_downloads(
    async_client, auth_headers, seed_download_jobs,
):
    """POST /pipeline/jobs/batch/claim should return all pending download jobs."""
    resp = await async_client.post(
        "/api/pipeline/jobs/batch/claim",
        params={"type": "download", "limit": 50},
        headers=auth_headers,
    )
    assert resp.status_code == 200
    jobs = resp.json()
    assert len(jobs) == len(seed_download_jobs)
    assert all(j["status"] == "claimed" for j in jobs)
    assert all(j["job_type"] == "download" for j in jobs)


@pytest.mark.asyncio
async def test_batch_claim_returns_empty_when_no_jobs(
    async_client, auth_headers,
):
    """POST /pipeline/jobs/batch/claim should return [] when nothing pending."""
    resp = await async_client.post(
        "/api/pipeline/jobs/batch/claim",
        params={"type": "download", "limit": 50},
        headers=auth_headers,
    )
    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.asyncio
async def test_batch_claim_is_atomic(
    async_client, auth_headers, seed_download_jobs,
):
    """Second call to batch claim should return [] (all already claimed)."""
    resp1 = await async_client.post(
        "/api/pipeline/jobs/batch/claim",
        params={"type": "download", "limit": 50},
        headers=auth_headers,
    )
    assert resp1.status_code == 200
    assert len(resp1.json()) == len(seed_download_jobs)

    # Second call — nothing left
    resp2 = await async_client.post(
        "/api/pipeline/jobs/batch/claim",
        params={"type": "download", "limit": 50},
        headers=auth_headers,
    )
    assert resp2.status_code == 200
    assert resp2.json() == []


@pytest.mark.asyncio
async def test_batch_claim_respects_limit(
    async_client, auth_headers, seed_download_jobs,
):
    """Limit parameter should cap the number of claimed jobs."""
    resp = await async_client.post(
        "/api/pipeline/jobs/batch/claim",
        params={"type": "download", "limit": 2},
        headers=auth_headers,
    )
    assert resp.status_code == 200
    assert len(resp.json()) == 2
```

Note: `seed_download_jobs` fixture creates 5 pending download jobs for the test user. `async_client` and `auth_headers` should follow the project's existing test patterns — check `tests/conftest.py` for existing fixtures or create minimal ones matching the pattern.

- [ ] **Step 2: Run tests to verify they fail**

Run: `poetry run pytest tests/test_batch_download.py -v`
Expected: FAIL (endpoint not found, 404)

- [ ] **Step 3: Implement the endpoint**

In `djtoolkit/api/pipeline_routes.py`, add after the `claim_job` endpoint (around line 429):

```python
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
```

Also update the module docstring (line 1-9) to include the new route:

```python
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `poetry run pytest tests/test_batch_download.py -v`
Expected: PASS (all 4 tests)

- [ ] **Step 5: Commit**

```bash
git add djtoolkit/api/pipeline_routes.py tests/test_batch_download.py
git commit -m "feat: add POST /pipeline/jobs/batch/claim endpoint"
```

---

## Chunk 2: Agent Client + Batch Executor

### Task 3: Add `batch_claim_downloads()` to AgentClient

**Files:**
- Modify: `djtoolkit/agent/client.py:139` (append new method)

- [ ] **Step 1: Add the method**

Append to `AgentClient` class in `djtoolkit/agent/client.py`:

```python
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
```

- [ ] **Step 2: Commit**

```bash
git add djtoolkit/agent/client.py
git commit -m "feat: add batch_claim_downloads to AgentClient"
```

### Task 4: Implement `execute_download_batch()`

**Files:**
- Modify: `djtoolkit/agent/executor.py` (add batch function)

- [ ] **Step 1: Add the batch executor function**

Add after the existing `execute_download` function in `executor.py`:

```python
async def execute_download_batch(
    jobs: list[dict], cfg: Config, credentials: dict,
    report_fn=None,
) -> dict[str, dict]:
    """Batch search + parallel download for multiple tracks.

    Mirrors the CLI's run() from aioslsk_client.py:
    Phase 1: Batch search (_search_all for all tracks, one timeout window)
    Phase 2: Parallel download (asyncio.gather)
    Phase 3: Per-track local retry (next peer or fallback query)

    Args:
        jobs: List of claimed job dicts with payload.
        cfg: App config.
        credentials: Soulseek credentials.
        report_fn: async callback(job_id, success, result, error) to report
                   each job's result as it completes. If None, results are
                   returned in a dict.

    Returns:
        {job_id: {"success": bool, "result": dict|None, "error": str|None}}
    """
    from djtoolkit.downloader.aioslsk_client import (
        _build_search_queries,
        _search_all,
        _rank_candidates,
        _download_track,
    )

    client = await get_slsk_client(cfg, credentials)

    # Build track dicts and query variants
    tracks_by_job: dict[str, dict] = {}
    queries_by_id: dict[int, list[str]] = {}

    for job in jobs:
        payload = job.get("payload") or {}
        job_id = job["id"]
        track_id = payload.get("track_id", 0)
        track = {
            "id": track_id,
            "artist": payload.get("artist", ""),
            "title": payload.get("title", ""),
            "duration_ms": payload.get("duration_ms"),
            "search_string": payload.get("search_string", ""),
        }
        tracks_by_job[job_id] = track
        queries_by_id[track_id] = _build_search_queries(track)

    all_tracks = list(tracks_by_job.values())
    log.info("Batch download: %d tracks", len(all_tracks))

    # ── Phase 1: Batch search ────────────────────────────────────────────
    primary_queries = {t["id"]: queries_by_id[t["id"]][0] for t in all_tracks}
    results_by_track = await _search_all(client, primary_queries, cfg.soulseek.search_timeout_sec)

    hits = sum(1 for r in results_by_track.values() if r)
    log.info("Batch search: %d/%d tracks got results", hits, len(all_tracks))

    # Fallback rounds for tracks with no results
    def _needs_better(t):
        res = results_by_track.get(t["id"], [])
        return not res or not _rank_candidates(t, res, cfg, queries_by_id[t["id"]][0])

    fallback_idx: dict[int, int] = {t["id"]: 1 for t in all_tracks}
    for _round in range(3):
        needing = [t for t in all_tracks
                   if _needs_better(t) and fallback_idx[t["id"]] < len(queries_by_id[t["id"]])]
        if not needing:
            break

        fb_queries = {}
        for t in needing:
            idx = fallback_idx[t["id"]]
            fb_queries[t["id"]] = queries_by_id[t["id"]][idx]
            fallback_idx[t["id"]] += 1

        log.info("Fallback search round %d: %d tracks", _round + 1, len(fb_queries))
        fb_results = await _search_all(client, fb_queries, cfg.soulseek.search_timeout_sec)
        for tid, res in fb_results.items():
            if res:
                results_by_track.setdefault(tid, []).extend(res)

    # ── Phase 2: Parallel download with local retry ──────────────────────
    outcomes: dict[str, dict] = {}

    async def _download_one(job_id: str, track: dict):
        track_id = track["id"]
        results = results_by_track.get(track_id, [])
        label = f"{track.get('artist')} - {track.get('title')}"

        if not results:
            error = f"No search results for: {label}"
            log.warning("[batch] %s", error)
            outcomes[job_id] = {"success": False, "result": None, "error": error}
            if report_fn:
                await report_fn(job_id, False, None, error)
            return

        # Try download with local retry (up to 2 retries)
        last_error = None
        for attempt in range(3):
            try:
                local_path = await _download_track(
                    client, cfg, track, results, queries_by_id[track_id][0],
                )
                if local_path:
                    result = {"local_path": local_path}
                    log.info("[batch] OK: %s", label)
                    outcomes[job_id] = {"success": True, "result": result, "error": None}
                    if report_fn:
                        await report_fn(job_id, True, result, None)
                    return
                last_error = f"No matching file for: {label}"
            except Exception as exc:
                last_error = f"{type(exc).__name__}: {exc}"
                log.warning("[batch] attempt %d failed for %s: %s", attempt + 1, label, last_error)

        # All local retries exhausted
        log.error("[batch] FAIL after 3 attempts: %s", label)
        outcomes[job_id] = {"success": False, "result": None, "error": last_error}
        if report_fn:
            await report_fn(job_id, False, None, last_error)

    await asyncio.gather(*[
        _download_one(job_id, track)
        for job_id, track in tracks_by_job.items()
    ])

    log.info(
        "Batch complete: %d ok, %d failed",
        sum(1 for o in outcomes.values() if o["success"]),
        sum(1 for o in outcomes.values() if not o["success"]),
    )
    return outcomes
```

- [ ] **Step 2: Commit**

```bash
git add djtoolkit/agent/executor.py
git commit -m "feat: add execute_download_batch with batch search + parallel download"
```

---

## Chunk 3: Daemon Integration + Cleanup

### Task 5: Update daemon poll loop

**Files:**
- Modify: `djtoolkit/agent/daemon.py`
- Modify: `djtoolkit/agent/executor.py` (import update)

- [ ] **Step 1: Update imports in daemon.py**

In `djtoolkit/agent/daemon.py`, update the executor import (line 16):

```python
from djtoolkit.agent.executor import execute_job, execute_download_batch, shutdown_slsk_client
```

- [ ] **Step 2: Add `_run_download_batch` wrapper in daemon.py**

Add after the existing `_run_job` function (around line 167):

```python
    async def _run_download_batch(jobs: list[dict]) -> None:
        """Execute a batch of download jobs and report results individually."""
        job_ids = [j["id"] for j in jobs]
        log.info("Starting download batch: %d jobs (%s…)", len(jobs), job_ids[0][:8])

        for job in jobs:
            save_job_state(job["id"], "claimed", job.get("payload") or {})

        async def _report(job_id, success, result, error):
            if success:
                save_job_state(job_id, "completed", {}, result)
            else:
                save_job_state(job_id, "failed", {}, {"error": error})

            reported = await client.report_result(
                job_id, success=success, result=result, error=error,
            )
            if reported:
                cleanup_job(job_id)
                log.info("Job %s: %s", job_id, "ok" if success else "failed")
            else:
                log.warning("Job %s result report failed; saved locally", job_id)

        reported_ids: set[str] = set()
        original_report = _report

        async def _tracking_report(job_id, success, result, error):
            reported_ids.add(job_id)
            await original_report(job_id, success, result, error)

        try:
            await execute_download_batch(jobs, cfg, creds, report_fn=_tracking_report)
        except Exception:
            log.exception("Download batch failed entirely")
            # Report only jobs that weren't already reported via callback
            for job in jobs:
                jid = job["id"]
                if jid in reported_ids:
                    continue
                save_job_state(jid, "failed", {}, {"error": "Batch execution failed"})
                await client.report_result(jid, success=False, error="Batch execution failed")
                cleanup_job(jid)

        log.info("Download batch finished: %d jobs", len(jobs))
```

- [ ] **Step 3: Modify `_poll_loop` to use batch downloads**

Replace the body of `_poll_loop` (lines 191-227) with:

```python
    async def _poll_loop() -> None:
        # Offset from heartbeat by half the interval
        try:
            await asyncio.wait_for(
                shutdown_event.wait(), timeout=poll_interval / 2,
            )
            return
        except asyncio.TimeoutError:
            pass

        while not shutdown_event.is_set():
            # Clean up completed tasks
            done = {t for t in active_tasks if t.done()}
            active_tasks.difference_update(done)

            # ── Batch-claim download jobs ─────────────────────────────────
            download_batch_running = any(
                t.get_name() == "download-batch" for t in active_tasks
            )
            if not download_batch_running:
                download_jobs = await client.batch_claim_downloads(
                    limit=cfg.agent.max_download_batch,
                )
                if download_jobs:
                    task = asyncio.create_task(
                        _run_download_batch(download_jobs),
                        name="download-batch",
                    )
                    active_tasks.add(task)

            # ── Individual jobs (non-download) ────────────────────────────
            slots = max_concurrent - len(active_tasks)
            if slots > 0:
                try:
                    jobs = await client.poll_jobs(limit=slots)
                except AgentRevoked:
                    log.error("API key revoked during poll. Shutting down.")
                    shutdown_event.set()
                    return

                for job in jobs:
                    if job.get("job_type") == "download":
                        continue  # handled by batch path
                    claimed = await client.claim_job(job["id"])
                    if claimed:
                        task = asyncio.create_task(_run_job(claimed))
                        active_tasks.add(task)

            try:
                await asyncio.wait_for(
                    shutdown_event.wait(), timeout=poll_interval,
                )
                return
            except asyncio.TimeoutError:
                pass
```

- [ ] **Step 4: Commit**

```bash
git add djtoolkit/agent/daemon.py
git commit -m "feat: daemon batch-claims download jobs, dispatches as single batch task"
```

### Task 6: Delete `agent/jobs/download.py`

**Files:**
- Delete: `djtoolkit/agent/jobs/download.py`

- [ ] **Step 1: Verify no imports reference it**

Run: `poetry run python -c "import djtoolkit.agent.jobs.download"` — if this works, search for any imports:

```bash
grep -r "agent.jobs.download\|agent/jobs/download\|from djtoolkit.agent.jobs" djtoolkit/
```

Expected: No hits in production code (only possibly in the spec/plan docs).

- [ ] **Step 2: Delete the file**

```bash
git rm djtoolkit/agent/jobs/download.py
```

- [ ] **Step 3: Clean up `agent/jobs/__init__.py` if it exists**

Check if `djtoolkit/agent/jobs/__init__.py` imports from `download.py`. If so, remove the import. If `__init__.py` is empty after removal, delete it too.

- [ ] **Step 4: Commit**

```bash
git add -A djtoolkit/agent/jobs/
git commit -m "chore: delete agent/jobs/download.py (superseded by batch executor)"
```

### Task 7: Manual smoke test

- [ ] **Step 1: Start the API server**

```bash
make api
```

- [ ] **Step 2: Start the agent**

In another terminal:

```bash
cd ~/Code/djtoolkit && poetry run djtoolkit agent run
```

- [ ] **Step 3: Import a few tracks from the UI**

Import 3-5 tracks from a Spotify playlist or CSV.

- [ ] **Step 4: Watch agent logs**

```bash
tail -f ~/Library/Logs/djtoolkit/agent.log
```

Expected output pattern:
```
INFO djtoolkit.agent.daemon: Starting download batch: 5 jobs (abc123…)
INFO djtoolkit.agent.executor: Batch download: 5 tracks
INFO djtoolkit.agent.executor: Batch search: 4/5 tracks got results
INFO djtoolkit.agent.executor: [batch] OK: Artist - Title
INFO djtoolkit.agent.executor: Batch complete: 4 ok, 1 failed
INFO djtoolkit.agent.daemon: Download batch finished: 5 jobs
```

- [ ] **Step 5: Verify tracks appear in catalog**

Check the UI catalog — downloaded tracks should show as `available` with `local_path` set.

- [ ] **Step 6: Commit all uncommitted changes and push**

```bash
git push
```
