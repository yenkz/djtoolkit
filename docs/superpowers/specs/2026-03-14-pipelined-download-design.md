# Pipelined Search + Download

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan.

**Goal:** Eliminate the sequential search→download bottleneck in the agent's batch download pipeline by streaming results to downloads as they arrive.

**Problem:** The current `execute_download_batch` runs in two rigid phases: search ALL tracks (15-60s blocking), then download ALL tracks. No download begins until every search (including fallback rounds for other tracks) completes. This wastes 30-60s per batch and limits throughput to ~4-5 tracks/minute.

**Solution:** Replace the two-phase model with a pipelined architecture where each track progresses independently — downloading as soon as viable search results arrive, while searches for other tracks continue in the background.

---

## Architecture

### Current flow (sequential phases)

```
[====== Phase 1: search all 50 tracks (15-60s) ======][== Phase 2: download all ==]
                                                       ↑ no downloads until here
```

### New flow (pipelined per-track)

```
Fire all 50 searches simultaneously
  Track 1:  results arrive at 2s  → download starts at 2s   → done at 30s
  Track 2:  results arrive at 3s  → download starts at 3s   → done at 45s
  Track 3:  no results at 15s     → fallback search at 15s  → results at 20s → download
  Track 4:  results arrive at 1s  → download starts at 1s   → done at 15s
  ...
```

Each track runs as an independent async worker. No track blocks another.

---

## Design

### New function: `_pipeline_download`

Location: `djtoolkit/downloader/aioslsk_client.py`

Replaces the search-then-download pattern in `execute_download_batch`. Reuses all existing primitives (`_rank_candidates`, `_download_track`, `_build_search_queries`).

#### Signature

```python
async def _pipeline_download(
    client,
    cfg: Config,
    tracks_by_job: dict[str, dict],    # {job_id: track_dict}
    queries_by_id: dict[int, list[str]], # {track_id: [query_variants]}
    report_fn,                          # async (job_id, success, result, error) -> None
    status_fn=None,                     # optional (phase: str) -> None
) -> None:
```

#### Internals

**1. Shared result collector**

Register a single `SearchResultEvent` handler that routes results to per-track lists. Signal waiting workers when new results arrive.

```python
results_by_track: dict[int, list] = {t["id"]: [] for t in all_tracks}
new_results: asyncio.Event  # set whenever results arrive, workers clear after waking
```

**2. Per-track worker coroutine**

Each track runs as an independent `asyncio.Task`:

```python
async def _track_worker(job_id, track):
    track_id = track["id"]
    query_variants = queries_by_id[track_id]

    # Phase A: Wait for viable results (up to search_timeout_sec)
    # Check every 2s whether accumulated results contain a viable candidate.
    # "Viable" = _rank_candidates returns a non-empty list.
    deadline = now() + search_timeout_sec
    ranked = []
    while now() < deadline:
        ranked = _rank_candidates(track, results_by_track[track_id], cfg, query_variants[0])
        if ranked:
            break
        await wait_for_results_or_timeout(remaining=min(2.0, deadline - now()))

    # Phase B: Fallback searches (if no viable results yet)
    # Fire one fallback query at a time, wait up to search_timeout_sec each.
    # Each fallback runs independently — other workers are downloading concurrently.
    if not ranked:
        for variant_idx in range(1, len(query_variants)):
            fire_search(query_variants[variant_idx])
            wait up to search_timeout_sec, checking every 2s
            ranked = _rank_candidates(...)
            if ranked:
                break

    # Phase C: Download
    if not ranked:
        report_fn(job_id, False, None, "No viable search results")
        return

    local_path = await _download_track(client, cfg, track, results_by_track[track_id], ...)
    report_fn(job_id, bool(local_path), {"local_path": local_path} if local_path else None, ...)
```

**3. Orchestration**

```python
async def _pipeline_download(...):
    # Register result collector
    client.events.register(SearchResultEvent, on_result)

    # Fire all primary searches at once (same as today)
    for track_id, queries in queries_by_id.items():
        cmd = GlobalSearchCommand(queries[0])
        await client.execute(cmd)
        ticket_to_track[cmd._ticket] = track_id

    # Run all track workers concurrently
    await asyncio.gather(*[
        _track_worker(job_id, track)
        for job_id, track in tracks_by_job.items()
    ])

    # Cleanup
    client.events.unregister(SearchResultEvent, on_result)
```

### Changes to `execute_download_batch`

Location: `djtoolkit/agent/executor.py`

Replace the current Phase 1 (search) + Phase 2 (download) blocks with a single call:

```python
# Before (current):
results_by_track = await _search_all(client, primary_queries, timeout)
# ... fallback rounds ...
await asyncio.gather(*[_download_one(jid, t) for jid, t in tracks_by_job.items()])

# After:
await _pipeline_download(client, cfg, tracks_by_job, queries_by_id, report_fn, status_fn)
```

The rest of `execute_download_batch` (job state tracking, batch totals, error handling for unreported jobs) stays the same.

### Changes to CLI `_run_async`

Location: `djtoolkit/downloader/aioslsk_client.py`

The CLI's `_run_async` function uses the same search-then-download pattern. It should also benefit from pipelining. However, it uses `rich.progress` bars and writes directly to SQLite, so it needs a thin adapter. This is a separate, optional follow-up — the agent path is the priority.

---

## What stays the same

- **Daemon**: poll loop, batch claiming, result reporting, status file — no changes
- **Executor**: `_slsk_session`, `_run_download_batch` wrapper, `_run_job` — minimal changes (swap search+download for `_pipeline_download` call)
- **Primitives**: `_rank_candidates`, `_download_track`, `_build_search_queries`, `_wait_for_transfer` — reused as-is
- **Config**: `search_timeout_sec`, `download_timeout_sec`, `max_download_batch` — same values, same meaning
- **Client lifecycle**: Per-batch `_slsk_session` — unchanged

## What changes

| File | Change |
|------|--------|
| `djtoolkit/downloader/aioslsk_client.py` | Add `_pipeline_download()` function |
| `djtoolkit/agent/executor.py` | Replace search+download phases with `_pipeline_download()` call in `execute_download_batch` |

---

## Edge cases

- **Early-arriving results with bad scores**: Workers check `_rank_candidates`, not just "any results". A track with 100 low-quality results keeps waiting; a track with 1 good result starts immediately.
- **Fallback search ticket routing**: Fallback searches register new tickets in the shared `ticket_to_track` map. The result collector routes them to the correct track automatically.
- **All workers finish before search window**: Fine — `asyncio.gather` returns when all workers complete. The result collector is unregistered in the finally block.
- **Worker exception**: `asyncio.gather` propagates exceptions. The caller (`execute_download_batch`) already has try/except for batch-level failures with per-job cleanup.

---

## Expected impact

- **First download starts**: ~1-3s after search broadcast (vs 15-60s today)
- **Throughput**: ~8-12 tracks/min (vs ~4-5 today), depending on peer speed
- **Fallback searches**: No longer block the entire batch — only the specific track that needs them
- **Batch completion time**: Dominated by the slowest track, not by search + slowest track
