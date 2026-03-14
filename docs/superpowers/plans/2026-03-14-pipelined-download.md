# Pipelined Download Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the sequential search-then-download batch pipeline with a pipelined architecture where each track starts downloading as soon as viable search results arrive.

**Architecture:** Add a `_pipeline_download()` function to `aioslsk_client.py` that fires all searches at once, then runs per-track worker coroutines that independently wait for viable results and immediately start downloading. Update `execute_download_batch` in `executor.py` to call it instead of the current `_search_all` + `asyncio.gather(downloads)` pattern.

**Tech Stack:** Python asyncio, aioslsk (SoulSeekClient, GlobalSearchCommand, SearchResultEvent)

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `djtoolkit/downloader/aioslsk_client.py` | Modify (add function) | New `_pipeline_download()` — pipelined search+download engine |
| `djtoolkit/agent/executor.py` | Modify | Simplify `execute_download_batch` to use `_pipeline_download()` |
| `tests/test_aioslsk.py` | Modify (add tests) | Unit tests for `_pipeline_download` |

---

### Task 1: Add `_pipeline_download` to aioslsk_client.py

**Files:**
- Modify: `djtoolkit/downloader/aioslsk_client.py` (add after `_search_all` at line ~321)
- Modify: `tests/test_aioslsk.py` (add async tests at end of file)

This is the core new function. It fires all searches, then runs per-track workers that download as soon as viable results arrive.

- [ ] **Step 1: Write the tests**

Add to the end of `tests/test_aioslsk.py`. These tests mock the aioslsk client to verify the pipelining logic without network access.

```python
# ─── _pipeline_download ─────────────────────────────────────────────────────

import asyncio
from unittest.mock import AsyncMock, patch
from djtoolkit.downloader.aioslsk_client import _pipeline_download


@dataclass
class _MockSearchResultEvent:
    result: object = None


@dataclass
class _MockTicketResult:
    ticket: int = 0
    username: str = "peer1"
    shared_items: list = field(default_factory=list)


class _MockEventBus:
    """Minimal event bus that captures register/unregister and allows manual dispatch."""
    def __init__(self):
        self._handlers: dict[type, list] = {}

    def register(self, event_type, handler):
        self._handlers.setdefault(event_type, []).append(handler)

    def unregister(self, event_type, handler):
        if event_type in self._handlers:
            self._handlers[event_type] = [h for h in self._handlers[event_type] if h is not handler]

    async def dispatch(self, event):
        for handler in self._handlers.get(type(event), []):
            await handler(event)


class _MockClient:
    """Mock SoulSeekClient with controllable search result delivery."""
    def __init__(self):
        self.events = _MockEventBus()
        self._next_ticket = 0
        self._executed_commands = []

    async def execute(self, cmd):
        self._next_ticket += 1
        cmd._ticket = self._next_ticket
        self._executed_commands.append(cmd)


def _make_track(track_id: int, artist: str = "Artist", title: str = "Title"):
    return {
        "id": track_id,
        "artist": artist,
        "title": title,
        "duration_ms": 232_000,
        "search_string": f"{artist} {title}",
    }


@pytest.mark.asyncio
async def test_pipeline_download_starts_download_on_first_viable_result(cfg):
    """Track with viable results should start downloading without waiting for search timeout."""
    client = _MockClient()
    track = _make_track(1, "Big Wild", "City of Sound")
    tracks_by_job = {"job-1": track}
    queries_by_id = {1: ["Big Wild City of Sound"]}
    reports = []

    async def report_fn(job_id, success, result, error):
        reports.append({"job_id": job_id, "success": success, "result": result, "error": error})

    # Mock _download_track to return a path immediately
    with patch("djtoolkit.downloader.aioslsk_client._download_track", new_callable=AsyncMock) as mock_dl:
        mock_dl.return_value = "/downloads/Big Wild - City of Sound.mp3"

        async def _deliver_results():
            """Simulate results arriving 0.1s after search fires."""
            await asyncio.sleep(0.1)
            result = _MockTicketResult(
                ticket=1,
                username="peer1",
                shared_items=[_FileData(
                    "Big Wild - City of Sound.mp3",
                    extension="mp3",
                    filesize=10_000_000,
                    attributes=[_Attribute(_ATTR_DURATION, 232)],
                )],
            )
            from aioslsk.events import SearchResultEvent
            event = SearchResultEvent(result=result)
            await client.events.dispatch(event)

        # Run pipeline and result delivery concurrently
        # Use a short search timeout so the test is fast
        cfg.soulseek.search_timeout_sec = 2.0
        await asyncio.gather(
            _pipeline_download(client, cfg, tracks_by_job, queries_by_id, report_fn),
            _deliver_results(),
        )

    assert len(reports) == 1
    assert reports[0]["success"] is True
    assert reports[0]["result"]["local_path"] == "/downloads/Big Wild - City of Sound.mp3"
    # Download should have been called (track didn't wait for full timeout)
    mock_dl.assert_called_once()


@pytest.mark.asyncio
async def test_pipeline_download_reports_failure_when_no_results(cfg):
    """Track with no search results should report failure after timeout."""
    client = _MockClient()
    track = _make_track(2, "Unknown", "Nonexistent")
    tracks_by_job = {"job-2": track}
    queries_by_id = {2: ["Unknown Nonexistent"]}
    reports = []

    async def report_fn(job_id, success, result, error):
        reports.append({"job_id": job_id, "success": success, "error": error})

    cfg.soulseek.search_timeout_sec = 0.5  # short timeout for test speed
    await _pipeline_download(client, cfg, tracks_by_job, queries_by_id, report_fn)

    assert len(reports) == 1
    assert reports[0]["success"] is False
    assert "No viable search results" in reports[0]["error"]


@pytest.mark.asyncio
async def test_pipeline_download_independent_tracks(cfg):
    """Multiple tracks should progress independently — one failing doesn't block others."""
    client = _MockClient()
    track_ok = _make_track(10, "Big Wild", "City of Sound")
    track_fail = _make_track(11, "Nobody", "Nothing")
    tracks_by_job = {"job-ok": track_ok, "job-fail": track_fail}
    queries_by_id = {
        10: ["Big Wild City of Sound"],
        11: ["Nobody Nothing"],
    }
    reports = []

    async def report_fn(job_id, success, result, error):
        reports.append({"job_id": job_id, "success": success})

    with patch("djtoolkit.downloader.aioslsk_client._download_track", new_callable=AsyncMock) as mock_dl:
        mock_dl.return_value = "/downloads/track.mp3"

        async def _deliver_results():
            await asyncio.sleep(0.1)
            # Only deliver results for track 10 (ticket 1), not track 11
            result = _MockTicketResult(
                ticket=1,
                username="peer1",
                shared_items=[_FileData(
                    "Big Wild - City of Sound.mp3",
                    extension="mp3",
                    filesize=10_000_000,
                    attributes=[_Attribute(_ATTR_DURATION, 232)],
                )],
            )
            from aioslsk.events import SearchResultEvent
            await client.events.dispatch(SearchResultEvent(result=result))

        cfg.soulseek.search_timeout_sec = 0.5
        await asyncio.gather(
            _pipeline_download(client, cfg, tracks_by_job, queries_by_id, report_fn),
            _deliver_results(),
        )

    # Both tracks should have reported
    assert len(reports) == 2
    results_by_job = {r["job_id"]: r["success"] for r in reports}
    assert results_by_job["job-ok"] is True
    assert results_by_job["job-fail"] is False
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `poetry run pytest tests/test_aioslsk.py::test_pipeline_download_starts_download_on_first_viable_result -v`
Expected: FAIL with `ImportError: cannot import name '_pipeline_download'`

- [ ] **Step 3: Implement `_pipeline_download`**

Add after the `_search_all` function (after line 321) in `djtoolkit/downloader/aioslsk_client.py`:

```python
async def _pipeline_download(
    client,
    cfg: Config,
    tracks_by_job: dict[str, dict],
    queries_by_id: dict[int, list[str]],
    report_fn,
    status_fn=None,
) -> None:
    """Pipelined search + download: fire all searches, start downloading
    each track as soon as viable results arrive.

    Each track runs as an independent async worker. No track blocks another.

    Args:
        client: Connected SoulSeekClient instance.
        cfg: App config (search_timeout_sec, download_timeout_sec, matching.*).
        tracks_by_job: {job_id: track_dict} — each track must have an "id" key
            that corresponds to a key in queries_by_id.
        queries_by_id: {track_id: [query_variant, ...]} — progressive fallback queries.
        report_fn: async (job_id, success, result_dict|None, error_str|None) callback.
        status_fn: optional (phase: str) callback for status updates.
    """
    from aioslsk.commands import GlobalSearchCommand
    from aioslsk.events import SearchResultEvent

    all_tracks = list(tracks_by_job.values())
    results_by_track: dict[int, list] = {t["id"]: [] for t in all_tracks}
    track_events: dict[int, asyncio.Event] = {t["id"]: asyncio.Event() for t in all_tracks}
    ticket_to_track: dict[int, int] = {}

    # ── Result collector ────────────────────────────────────────────────
    async def _on_result(event: SearchResultEvent):
        ticket = getattr(event.result, "ticket", None)
        track_id = ticket_to_track.get(ticket)
        if track_id is not None:
            results_by_track[track_id].append(event.result)
            track_events[track_id].set()

    # ── Per-track worker ────────────────────────────────────────────────
    async def _track_worker(job_id: str, track: dict) -> None:
        track_id = track["id"]
        query_variants = queries_by_id[track_id]
        my_event = track_events[track_id]
        label = f"{track.get('artist', '')} - {track.get('title', '')}"

        try:
            # Phase A: wait for viable results from primary search
            deadline = asyncio.get_event_loop().time() + cfg.soulseek.search_timeout_sec
            ranked = []
            while asyncio.get_event_loop().time() < deadline:
                ranked = _rank_candidates(track, results_by_track[track_id], cfg, query_variants[0])
                if ranked:
                    break
                my_event.clear()
                remaining = deadline - asyncio.get_event_loop().time()
                if remaining <= 0:
                    break
                try:
                    await asyncio.wait_for(my_event.wait(), timeout=min(remaining, 2.0))
                except asyncio.TimeoutError:
                    pass

            # Phase B: fallback searches if no viable results
            if not ranked:
                for variant_idx in range(1, len(query_variants)):
                    cmd = GlobalSearchCommand(query_variants[variant_idx])
                    await client.execute(cmd)
                    ticket_to_track[cmd._ticket] = track_id
                    log.info("[%d] Fallback #%d query: «%s»", track_id, variant_idx, query_variants[variant_idx])

                    fb_deadline = asyncio.get_event_loop().time() + cfg.soulseek.search_timeout_sec
                    while asyncio.get_event_loop().time() < fb_deadline:
                        ranked = _rank_candidates(track, results_by_track[track_id], cfg, query_variants[0])
                        if ranked:
                            break
                        my_event.clear()
                        remaining = fb_deadline - asyncio.get_event_loop().time()
                        if remaining <= 0:
                            break
                        try:
                            await asyncio.wait_for(my_event.wait(), timeout=min(remaining, 2.0))
                        except asyncio.TimeoutError:
                            pass
                    if ranked:
                        break

            # Phase C: download
            if not ranked:
                log.warning("[pipeline] No viable results: %s", label)
                await report_fn(job_id, False, None, f"No viable search results for: {label}")
                return

            results_snapshot = list(results_by_track[track_id])
            log.info("[pipeline] Downloading: %s (%d candidates)", label, len(ranked))
            local_path = await _download_track(client, cfg, track, results_snapshot, query_variants[0])
            if local_path:
                log.info("[pipeline] OK: %s", label)
                await report_fn(job_id, True, {"local_path": local_path}, None)
            else:
                log.warning("[pipeline] No matching file: %s", label)
                await report_fn(job_id, False, None, f"No matching file for: {label}")

        except Exception as exc:
            error_msg = f"{type(exc).__name__}: {exc}"
            log.error("[pipeline] Error for %s: %s", label, error_msg)
            await report_fn(job_id, False, None, error_msg)

    # ── Orchestration ───────────────────────────────────────────────────
    client.events.register(SearchResultEvent, _on_result)
    try:
        if status_fn:
            status_fn("searching")

        # Fire all primary searches
        for track_id, queries in queries_by_id.items():
            cmd = GlobalSearchCommand(queries[0])
            await client.execute(cmd)
            ticket_to_track[cmd._ticket] = track_id

        log.info("Pipeline: fired %d searches, starting workers…", len(queries_by_id))
        if status_fn:
            status_fn("downloading")

        # Run all workers concurrently
        await asyncio.gather(*[
            _track_worker(job_id, track)
            for job_id, track in tracks_by_job.items()
        ])
    finally:
        client.events.unregister(SearchResultEvent, _on_result)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `poetry run pytest tests/test_aioslsk.py -v -k pipeline`
Expected: 3 PASSED

- [ ] **Step 5: Run full test suite**

Run: `poetry run pytest tests/ -q --tb=short`
Expected: All tests pass (no regressions)

- [ ] **Step 6: Commit**

```bash
git add djtoolkit/downloader/aioslsk_client.py tests/test_aioslsk.py
git commit -m "feat: add _pipeline_download for streaming search+download"
```

---

### Task 2: Wire `execute_download_batch` to use `_pipeline_download`

**Files:**
- Modify: `djtoolkit/agent/executor.py:134-277` (simplify `execute_download_batch`)

Replace the Phase 1 (search) + Phase 2 (download) blocks with a single `_pipeline_download` call. The job state tracking, batch totals, and error handling for unreported jobs stays the same.

- [ ] **Step 1: Update the import**

In `djtoolkit/agent/executor.py`, change the import at line 157-162:

```python
# Before:
    from djtoolkit.downloader.aioslsk_client import (
        _build_search_queries,
        _search_all,
        _rank_candidates,
        _download_track,
    )

# After:
    from djtoolkit.downloader.aioslsk_client import (
        _build_search_queries,
        _pipeline_download,
    )
```

- [ ] **Step 2: Replace search + download phases**

Replace lines 187-270 (everything inside `async with _slsk_session(...)`) with:

```python
    async with _slsk_session(cfg, credentials) as client:
        await _pipeline_download(
            client, cfg, tracks_by_job, queries_by_id,
            report_fn=_tracking_report,
            status_fn=_update_phase,
        )
```

Keep the `_tracking_report`, `_update_phase`, and `reported_ids` definitions from the daemon wrapper — those are defined in `daemon.py` and passed in.

The full simplified function should look like:

```python
async def execute_download_batch(
    jobs: list[dict], cfg: Config, credentials: dict,
    report_fn=None, status_fn=None,
) -> dict[str, dict]:
    """Pipelined search + download for a batch of tracks.

    Fires all searches at once, then each track starts downloading as soon
    as viable results arrive. No track blocks another.

    Args:
        jobs: List of claimed job dicts with payload.
        cfg: App config.
        credentials: Soulseek credentials.
        report_fn: async callback(job_id, success, result, error) to report
                   each job's result as it completes.
        status_fn: optional callback(phase: str) to report batch phase changes.

    Returns:
        {job_id: {"success": bool, "result": dict|None, "error": str|None}}
    """
    from djtoolkit.downloader.aioslsk_client import (
        _build_search_queries,
        _pipeline_download,
    )

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

    log.info("Batch download: %d tracks", len(tracks_by_job))

    outcomes: dict[str, dict] = {}

    # Wrap report_fn to track outcomes locally
    async def _outcome_report(job_id, success, result, error):
        outcomes[job_id] = {"success": success, "result": result, "error": error}
        if report_fn:
            await report_fn(job_id, success, result, error)

    async with _slsk_session(cfg, credentials) as client:
        await _pipeline_download(
            client, cfg, tracks_by_job, queries_by_id,
            report_fn=_outcome_report,
            status_fn=status_fn,
        )

    log.info(
        "Batch complete: %d ok, %d failed",
        sum(1 for o in outcomes.values() if o["success"]),
        sum(1 for o in outcomes.values() if not o["success"]),
    )
    return outcomes
```

- [ ] **Step 3: Run full test suite**

Run: `poetry run pytest tests/ -q --tb=short`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add djtoolkit/agent/executor.py
git commit -m "refactor: wire execute_download_batch to _pipeline_download"
```

---

### Task 3: Smoke test with live agent

**Files:** None (manual verification)

- [ ] **Step 1: Restart the agent**

```bash
pkill -f "djtoolkit agent run"
poetry run djtoolkit agent run &
```

- [ ] **Step 2: Monitor logs for pipelined behavior**

```bash
tail -f ~/Library/Logs/djtoolkit/agent.log | grep -E "(Pipeline|pipeline|Downloading|OK|FAIL|Fallback)"
```

Expected: Log lines like:
- `Pipeline: fired N searches, starting workers…`
- `[pipeline] Downloading: Artist - Title (X candidates)` — appearing within seconds of search fire (not after 15s)
- `[pipeline] OK: Artist - Title`

- [ ] **Step 3: Verify throughput improvement**

Count tracks completed per minute from the log timestamps. Expected: ~8-12 tracks/min (vs ~4-5 before).
