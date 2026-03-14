# Batch Download Pipeline Design

**Date:** 2026-03-14
**Status:** Approved

## Problem

The agent creates a new Soulseek client per download job, searches one track at a time, and sleeps `search_timeout_sec` (15s) per query variant. A 50-track import takes 50 x 15s x 3 variants = ~37 minutes of search time alone, vs ~15s total with `make download`'s batch approach.

## Solution

Batch-claim all pending download jobs in one API call, search all tracks simultaneously with a single timeout window, download in parallel, and retry failed tracks locally before reporting failure to the server.

## Architecture

### Persistent Soulseek Client

The agent maintains a single long-lived `SoulSeekClient` instance (already implemented in `executor.py`). It connects once at startup and stays alive for all download batches. The daemon calls `shutdown_slsk_client()` on exit.

### Batch Claim Endpoint

New server endpoint:

```
POST /pipeline/jobs/batch/claim?type=download&limit=50
```

- Fetches and claims all pending download jobs atomically in one transaction (`FOR UPDATE SKIP LOCKED`)
- Sets `status='claimed'`, `agent_id`, `claimed_at` for all returned jobs
- Returns the full list of claimed jobs (up to `limit`)
- Returns `[]` if no pending download jobs
- Uses `POST` because the request mutates state (claims jobs)

This replaces the two-step fetch+claim flow for download jobs. The daemon skips the separate `claim_job()` call for download batches since jobs arrive pre-claimed.

Non-download jobs continue using the existing `GET /pipeline/jobs` + `POST /pipeline/jobs/{id}/claim` two-step flow.

### Batch Executor

New function `execute_download_batch(jobs, cfg, credentials)` in `executor.py`. Mirrors the CLI's `run()` from `aioslsk_client.py`:

```
Phase 1: Batch search
  - Build query variants for all tracks
  - Fire _search_all() with primary queries for all tracks
  - Single search_timeout_sec wait (15s) — results stream in during the wait
  - Fallback rounds (up to 3) for tracks with no results or no scorable matches

Phase 2: Parallel download
  - asyncio.gather() all tracks that have results
  - Per track: _download_track() tries best-scoring peer
  - Local retry: if peer fails, try next-best peer from existing results
  - If all peers exhausted, run fallback search + retry (up to 2 local retries)

Phase 3: Report results
  - For each job: report success or failure to server individually
  - Server auto-queues downstream jobs (fingerprint -> cover_art -> metadata)
```

### Daemon Poll Loop

The daemon's `_poll_loop` splits download and non-download job handling:

```python
while not shutdown:
    # 1. Batch-claim all pending downloads (pre-claimed, no separate claim step)
    download_jobs = await client.batch_claim_downloads(limit=max_batch_size)
    if download_jobs:
        task = asyncio.create_task(
            _run_download_batch(download_jobs)
        )
        active_tasks.add(task)

    # 2. Individual jobs for non-download types (existing two-step: fetch + claim)
    slots = max_concurrent - len(active_tasks)
    if slots > 0:
        other_jobs = await client.poll_jobs(limit=slots)
        for job in other_jobs:
            if job["job_type"] == "download":
                continue  # skip — handled by batch path above
            claimed = await client.claim_job(job["id"])
            if claimed:
                task = asyncio.create_task(_run_job(claimed))
                active_tasks.add(task)

    await sleep(poll_interval)
```

A download batch runs as a single asyncio task. While it's running, non-download jobs (fingerprint, cover_art, metadata) can still execute concurrently in their own tasks.

Note: the existing `poll_jobs` endpoint does not gain an `exclude_type` parameter. Instead, the daemon filters client-side — any download jobs returned by `poll_jobs` are skipped (they'll be picked up by the batch path on the next cycle, or may already be claimed by it).

### Stale Job Timeout

The existing stale job sweeper resets claimed jobs after 5 minutes. A batch of 50 tracks could take longer than 5 minutes (15s search + N downloads). To prevent the sweeper from resetting batch jobs mid-execution:

- The batch executor calls `client.heartbeat()` periodically (reusing the existing heartbeat endpoint), which updates `claimed_at` for all active batch jobs
- Alternatively, the batch executor reports results for each track as soon as it completes (not waiting for the whole batch), so completed jobs leave the "claimed" state quickly
- The 5-minute timeout is sufficient for any individual track within the batch since per-track download time is bounded by aioslsk's transfer timeout

## Two-Layer Retry

### Layer 1: Agent-local retry (immediate, within the batch)

When a download fails for a specific track:

1. Try the next-best peer from the existing search results
2. If all peers exhausted, run a fallback search with a simplified query variant
3. Up to 2 local retries per track before giving up

This is fast — no server round-trip, the client is connected, and alternative peers may already be available from the batch search.

### Layer 2: Server-side retry (delayed, across poll cycles)

When a track fails all local retries, the agent reports failure. The server's existing `_apply_job_result` logic creates a new job with `retry_count + 1`:

- `retry_count < 3`: new pending download job created
- New job picked up on the next agent poll cycle (in the next batch)
- After 3 server retries: track marked as `failed`

Maximum total attempts: 3 server tries x (1 initial + 2 local retries) = **9 attempts** before a track is marked failed.

```
Import 50 tracks
  +-- Agent batch-claims all 50
     +-- Batch search (one 15s window)
     +-- Parallel download
        |-- Track A: peer 1 OK -> report success immediately
        |-- Track B: peer 1 FAIL -> peer 2 OK -> report success  (local retry)
        |-- Track C: peer 1 FAIL -> peer 2 FAIL -> fallback      (local retry)
        |            search -> peer 3 OK -> report success
        +-- Track D: all local retries exhausted
           +-- Report failure to server
              +-- Server creates new job (retry_count=1)
              +-- Next poll cycle: agent picks it up in next batch
```

## Reused Functions

From `aioslsk_client.py` (no changes needed):

| Function | Purpose | Note |
|----------|---------|------|
| `_make_settings(cfg)` | Build aioslsk Settings (includes `error_mode=ALL` for NAT) | |
| `_search_all(client, queries, timeout)` | Fire all searches simultaneously, collect results | Uses `cmd._ticket` (private attr) — fragile on aioslsk upgrades |
| `_build_search_queries(track)` | Generate query variants (primary + fallbacks) | |
| `_rank_candidates(track, results, cfg, query)` | Score and filter search results | |
| `_download_track(client, cfg, track, results, query)` | Download best match from results | |

## File Changes

| File | Change |
|------|--------|
| `api/pipeline_routes.py` | Add `POST /pipeline/jobs/batch/claim` endpoint with `type` and `limit` query params |
| `agent/client.py` | Add `batch_claim_downloads(limit)` method calling the new endpoint |
| `agent/executor.py` | Add `execute_download_batch()`. Keep `execute_download()` as fallback for single retried jobs (it already uses the persistent client via `get_slsk_client()`) |
| `agent/daemon.py` | Split poll loop: batch downloads via `batch_claim_downloads()` + individual other jobs via existing `poll_jobs()`+`claim_job()`. Filter out download jobs from `poll_jobs` client-side |
| `agent/jobs/download.py` | Delete — superseded by `executor.py`'s `execute_download()` and `execute_download_batch()`. No other files import from it |
| `config.py` | Add `max_download_batch: int = 50` to `AgentConfig` |

## Configuration

New config key in `[agent]` section of `djtoolkit.toml`:

```toml
[agent]
max_download_batch = 50   # max tracks per batch search+download cycle
```

Existing config used by the batch executor:

```toml
[soulseek]
search_timeout_sec = 15.0  # seconds to collect search responses per round
```

## Performance Comparison

| Metric | Before (per-job) | After (batch) |
|--------|-------------------|---------------|
| Search time (50 tracks) | 50 x 15s x 3 = 37.5 min | 15s x 4 rounds = 1 min |
| Soulseek connections | 1 per job | 1 persistent |
| Download concurrency | 1 track at a time | all tracks in parallel |
| Retry latency (local) | N/A | immediate (same session) |
| Retry latency (server) | 30s+ poll cycle | 30s+ poll cycle |

## Cross-Platform

Nothing in this design is platform-specific:
- `asyncio`, `aioslsk`, `pathlib.Path` — cross-platform
- REST API calls — HTTP, platform-agnostic
- Listening port `error_mode=ALL` in `_make_settings` — handles NAT on both macOS and Windows
