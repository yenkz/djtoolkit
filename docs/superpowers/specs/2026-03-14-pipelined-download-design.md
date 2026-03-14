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
    tracks_by_job: dict[str, dict],      # {job_id: track_dict}
    queries_by_id: dict[int, list[str]],  # {track_id: [query_variants]}
    report_fn,                            # async (job_id, success, result, error) -> None
    status_fn=None,                       # optional (phase: str) -> None
) -> None:
```

**Contract:** Each track dict in `tracks_by_job` MUST have an `"id"` key whose value is a key in `queries_by_id`. The caller (`execute_download_batch`) builds both dicts from the same job list, so this is always satisfied.

#### Internals

**1. Per-track result collector with per-track events**

Register a single `SearchResultEvent` handler that routes results to per-track lists and signals per-track events (avoids thundering-herd wake of all 50 workers on every result).

```python
results_by_track: dict[int, list] = {t["id"]: [] for t in all_tracks}
track_events: dict[int, asyncio.Event] = {t["id"]: asyncio.Event() for t in all_tracks}

async def on_result(event):
    track_id = ticket_to_track.get(event.result.ticket)
    if track_id is not None:
        results_by_track[track_id].append(event.result)
        track_events[track_id].set()  # wake only this track's worker
```

**2. Per-track worker coroutine**

Each track runs as an independent `asyncio.Task`. Workers are closures capturing `client`, `ticket_to_track`, and shared state from the enclosing `_pipeline_download` scope.

```python
async def _track_worker(job_id, track):
    track_id = track["id"]
    query_variants = queries_by_id[track_id]
    my_event = track_events[track_id]

    # Phase A: Wait for viable results (up to search_timeout_sec)
    # Check whenever new results arrive for this track.
    # "Viable" = _rank_candidates returns a non-empty list.
    deadline = now() + search_timeout_sec
    ranked = []
    while now() < deadline:
        ranked = _rank_candidates(track, results_by_track[track_id], cfg, query_variants[0])
        if ranked:
            break
        my_event.clear()
        remaining = deadline - now()
        if remaining <= 0:
            break
        try:
            await asyncio.wait_for(my_event.wait(), timeout=min(remaining, 2.0))
        except asyncio.TimeoutError:
            pass

    # Phase B: Fallback searches (if no viable results yet)
    # Fire one fallback query at a time, wait up to search_timeout_sec each.
    # Each fallback runs independently — other workers are downloading concurrently.
    if not ranked:
        for variant_idx in range(1, len(query_variants)):
            cmd = GlobalSearchCommand(query_variants[variant_idx])
            await client.execute(cmd)
            ticket_to_track[cmd._ticket] = track_id

            fb_deadline = now() + search_timeout_sec
            while now() < fb_deadline:
                ranked = _rank_candidates(track, results_by_track[track_id], cfg, query_variants[0])
                if ranked:
                    break
                my_event.clear()
                remaining = fb_deadline - now()
                if remaining <= 0:
                    break
                try:
                    await asyncio.wait_for(my_event.wait(), timeout=min(remaining, 2.0))
                except asyncio.TimeoutError:
                    pass
            if ranked:
                break

    # Phase C: Download
    # Snapshot results to avoid data race (list is still being appended to by collector).
    if not ranked:
        await report_fn(job_id, False, None, "No viable search results")
        return

    results_snapshot = list(results_by_track[track_id])
    local_path = await _download_track(client, cfg, track, results_snapshot, query_variants[0])
    if local_path:
        await report_fn(job_id, True, {"local_path": local_path}, None)
    else:
        await report_fn(job_id, False, None, f"No matching file for: {track.get('artist')} - {track.get('title')}")
```

**3. Orchestration**

```python
async def _pipeline_download(...):
    ticket_to_track: dict[int, int] = {}

    # Register result collector
    client.events.register(SearchResultEvent, on_result)
    try:
        if status_fn:
            status_fn("searching")

        # Fire all primary searches at once (same as today)
        for track_id, queries in queries_by_id.items():
            cmd = GlobalSearchCommand(queries[0])
            await client.execute(cmd)
            ticket_to_track[cmd._ticket] = track_id

        if status_fn:
            status_fn("downloading")

        # Run all track workers concurrently.
        # Each worker has its own try/except — a single track failure
        # does not abort other tracks.
        await asyncio.gather(*[
            _track_worker(job_id, track)
            for job_id, track in tracks_by_job.items()
        ])
    finally:
        # Cleanup — unregister even if gather raised
        client.events.unregister(SearchResultEvent, on_result)
```

**Note on error handling:** Each `_track_worker` wraps its body in try/except and calls `report_fn` with failure on any exception. This means `asyncio.gather` never sees unhandled exceptions from workers — a single track's network error does not cancel other tracks. This matches the existing `_download_one` pattern in `execute_download_batch`.

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

### Out of scope

- **CLI `_run_async`**: Uses the same search-then-download pattern but with `rich.progress` bars and direct SQLite writes. Could benefit from pipelining but needs a thin adapter. Separate follow-up.
- **`execute_download` (single-track path)**: Uses `client.searches.search()` (different API). Not affected by this change.

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
| `djtoolkit/downloader/aioslsk_client.py` | Add `_pipeline_download()` function (~80 lines) |
| `djtoolkit/agent/executor.py` | Replace search+download phases with `_pipeline_download()` call in `execute_download_batch` (net deletion — simpler) |

---

## Edge cases

- **Early-arriving results with bad scores**: Workers check `_rank_candidates`, not just "any results". A track with 100 low-quality results keeps waiting; a track with 1 good result starts immediately.
- **Fallback search ticket routing**: Fallback searches register new tickets in the shared `ticket_to_track` map. The result collector routes them to the correct track automatically.
- **All workers finish before search window**: `asyncio.gather` returns when all workers complete. The result collector is unregistered in the finally block. No explicit cancellation of in-flight Soulseek searches is needed — they are fire-and-forget and results simply stop arriving.
- **Worker exception**: Each worker catches its own exceptions and reports failure via `report_fn`. No exception propagates to `asyncio.gather`. This matches the existing `_download_one` pattern.
- **Results list mutation**: Workers snapshot `results_by_track[track_id]` via `list()` before passing to `_download_track`, preventing data races from concurrent result collector appends.

---

## Expected impact

- **First download starts**: ~1-3s after search broadcast (vs 15-60s today)
- **Throughput**: ~8-12 tracks/min (vs ~4-5 today), depending on peer speed
- **Fallback searches**: No longer block the entire batch — only the specific track that needs them
- **Batch completion time**: Dominated by the slowest track, not by search + slowest track
