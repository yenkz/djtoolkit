# Pipeline Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the job-centric pipeline page with a track-centric Soulseek download monitor that shows real-time search/transfer status per track, and filter the catalog to only show tracks that are actually on disk.

**Architecture:** Expand `acquisition_status` on the `tracks` table with granular states (`searching`, `found`, `not_found`, `queued`). The agent writes status transitions during the aioslsk download flow. The web UI subscribes via Supabase Realtime. A new pipeline page renders a track table with status badges, filters, pagination, and sorting. The catalog page filters to `available` tracks only.

**Tech Stack:** Python (aioslsk, supabase-py), Next.js 14 (App Router, TypeScript), Supabase (PostgreSQL, Realtime), Tailwind CSS

**Spec:** `docs/superpowers/specs/2026-03-19-pipeline-monitor-design.md`

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `djtoolkit/db/pg_schema.sql` | Update CHECK constraint comment + allowed values |
| Modify | `djtoolkit/downloader/aioslsk_client.py` | Add `_set_status()` calls at each phase transition, add `search_results_count` writes |
| Modify | `djtoolkit/adapters/supabase.py` | Update `count_by_acquisition_status()` to include new statuses |
| Modify | `web/app/api/pipeline/status/route.ts` | Return track-level status counts instead of job counts |
| Create | `web/app/api/pipeline/tracks/route.ts` | Paginated list of pipeline (non-available) tracks |
| Create | `web/app/api/pipeline/tracks/[id]/retry/route.ts` | Retry endpoint for not_found/failed tracks |
| Modify | `web/lib/api.ts` | Add pipeline monitor types + fetch functions |
| Create | `web/app/(app)/pipeline/page.tsx` | Replace with track-centric monitor (full rewrite) |
| Modify | `web/app/(app)/catalog/page.tsx` | Add `?status=available` default filter + artwork column |
| Modify | `tests/test_aioslsk.py` | Add tests for new status transitions |

---

## Task 1: Database Migration — Expand CHECK Constraint + Add Column

**Files:**
- Modify: `djtoolkit/db/pg_schema.sql:124-126` (CHECK constraint comment)
- Run: Supabase migration SQL

- [ ] **Step 1: Apply Supabase migration**

Run the migration via the Supabase MCP tool or manual SQL:

```sql
-- Expand CHECK constraint to allow new acquisition_status values
ALTER TABLE tracks DROP CONSTRAINT IF EXISTS tracks_acquisition_status_check;
ALTER TABLE tracks ADD CONSTRAINT tracks_acquisition_status_check CHECK (
    acquisition_status IN (
        'candidate', 'searching', 'found', 'not_found', 'queued',
        'downloading', 'available', 'failed', 'duplicate'
    )
);

-- New column for search result count
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS search_results_count INTEGER DEFAULT NULL;
```

- [ ] **Step 2: Verify migration**

Run a test query to confirm the constraint accepts new values:

```sql
-- Should succeed (then revert)
UPDATE tracks SET acquisition_status = 'searching' WHERE false;
UPDATE tracks SET acquisition_status = 'not_found' WHERE false;
```

- [ ] **Step 3: Update pg_schema.sql comment**

Update the CHECK constraint in `djtoolkit/db/pg_schema.sql` to reflect the new allowed values and add the `search_results_count` column definition so the schema file stays in sync with production.

- [ ] **Step 4: Commit**

```bash
git add djtoolkit/db/pg_schema.sql
git commit -m "feat: expand acquisition_status CHECK constraint + add search_results_count"
```

---

## Task 2: Backend — Agent Status Transitions in aioslsk_client.py

**Files:**
- Modify: `djtoolkit/downloader/aioslsk_client.py:580-584` (`_set_status` helper)
- Modify: `djtoolkit/downloader/aioslsk_client.py:589-784` (`_run_async` flow)
- Test: `tests/test_aioslsk.py`

- [ ] **Step 1: Write failing test for search phase status transitions**

In `tests/test_aioslsk.py`, add a test that verifies `_set_status` is called with `'searching'` before the search phase, and with `'found'`/`'not_found'` + `search_results_count` after:

```python
class TestStatusTransitions:
    """Verify acquisition_status transitions during download pipeline."""

    def test_searching_status_set_before_search(self):
        """All tracks should be set to 'searching' before _search_all runs."""
        adapter = MagicMock()
        # ... setup tracks, mock _search_all to return empty
        # Assert: adapter.update_track called with acquisition_status='searching'
        # for each track before search begins

    def test_found_status_after_viable_results(self):
        """Tracks with viable results should be set to 'found' + search_results_count."""
        adapter = MagicMock()
        # ... setup tracks, mock _search_all to return results that pass _rank_candidates
        # Assert: adapter.update_track called with acquisition_status='found',
        # search_results_count=<viable_count>

    def test_not_found_status_after_no_viable_results(self):
        """Tracks with zero viable results should be set to 'not_found'."""
        adapter = MagicMock()
        # ... setup tracks, mock _search_all to return empty
        # Assert: adapter.update_track called with acquisition_status='not_found',
        # search_results_count=0
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `poetry run pytest tests/test_aioslsk.py::TestStatusTransitions -v`
Expected: FAIL — test class/methods don't exist yet or assertions fail

- [ ] **Step 3: Update `_set_status` to support `search_results_count`**

Modify `_set_status` at line 580 to accept an optional `search_results_count` parameter:

```python
def _set_status(
    adapter: "SupabaseAdapter",
    track_id: int,
    status: str,
    local_path: str | None = None,
    search_results_count: int | None = None,
) -> None:
    updates: dict = {"acquisition_status": status}
    if local_path is not None:
        updates["local_path"] = local_path
    if search_results_count is not None:
        updates["search_results_count"] = search_results_count
    adapter.update_track(track_id, updates)
```

- [ ] **Step 4: Add 'searching' status before Phase 1**

In `_run_async`, after building `tracks` list (line 691) and before `_search_all` (line 708), add:

```python
# Set all tracks to 'searching' before broadcast
for track in tracks:
    _set_status(adapter, track["id"], "searching")
```

- [ ] **Step 5: Add 'found'/'not_found' after search + scoring**

After Phase 1b fallback search completes (around line 771, before Phase 2), classify each track and store the viable count to avoid redundant `_rank_candidates` calls later:

```python
# Classify found/not_found and cache viable counts for Phase 2
viable_counts: dict[int, int] = {}
for track in tracks:
    tid = track["id"]
    res = results_by_track[tid]
    ranked = _rank_candidates(track, res, cfg, queries_by_track[tid][0]) if res else []
    viable_counts[tid] = len(ranked)
    if ranked:
        _set_status(adapter, tid, "found", search_results_count=len(ranked))
    else:
        _set_status(adapter, tid, "not_found", search_results_count=0)
```

- [ ] **Step 6: Remove bulk 'downloading' and add per-track transitions in `_do_download`**

Remove the bulk status loop at line 776-777:

```python
# REMOVE this:
for track in tracks:
    _set_status(adapter, track["id"], "downloading")
```

In `_do_download` (line 641), add two status transitions. Set `queued` before starting the download, then `downloading` right before calling `_download_track`. Both calls go in `_do_download` (which already has access to `adapter` and `track_id`):

```python
# In _do_download, after checking results are non-empty:
if not results:
    # ... existing no-results handling (already sets 'failed')
    return

_set_status(adapter, track_id, "queued")
_set_status(adapter, track_id, "downloading")
local_path = await _download_track(client, cfg, track, results, query,
                                    progress=progress, task_id=task_id)
```

Note: `queued` → `downloading` happens quickly in sequence here. The `queued` state will be visible in the UI briefly via Supabase Realtime before transitioning. This is acceptable — true queue-position tracking (waiting for peer slots) would require hooking into `TransferProgressEvent` which is a refinement for later.

- [ ] **Step 7: Skip download for 'not_found' tracks**

After the found/not_found classification, filter the download phase to only process `found` tracks. Use the `viable_counts` dict from Step 5 instead of re-calling `_rank_candidates`:

```python
# Phase 2: only download tracks that were found (viable_counts > 0)
found_tracks = [t for t in tracks if viable_counts.get(t["id"], 0) > 0]

await asyncio.gather(*[
    _do_download(client, track, results_by_track[track["id"]], queries_by_track[track["id"]][0])
    for track in found_tracks
])
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `poetry run pytest tests/test_aioslsk.py -v`
Expected: All tests PASS

- [ ] **Step 9: Commit**

```bash
git add djtoolkit/downloader/aioslsk_client.py tests/test_aioslsk.py
git commit -m "feat: add granular status transitions in aioslsk download pipeline"
```

---

## Task 3: Backend — Update Pipeline Status Endpoint

**Files:**
- Modify: `web/app/api/pipeline/status/route.ts`

- [ ] **Step 1: Rewrite status endpoint to return track-level counts**

Replace the `pipeline_jobs` count queries with per-status `head: true` count queries on the `tracks` table. Keep the existing auth pattern (`getAuthUser`, `createServiceClient`, `rateLimit`, `jsonError`), and keep the agents query unchanged.

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";
import { rateLimit, limiters } from "@/lib/api-server/rate-limit";
import { createServiceClient } from "@/lib/supabase/service";
import { jsonError } from "@/lib/api-server/errors";

const PIPELINE_STATUSES = [
  "candidate", "searching", "found", "not_found",
  "queued", "downloading", "failed",
] as const;

export async function GET(request: NextRequest) {
  const rateLimitResponse = await rateLimit(request, limiters.read);
  if (rateLimitResponse) return rateLimitResponse;

  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  const supabase = createServiceClient();

  // Count each pipeline status with efficient head-only queries
  const countPromises = PIPELINE_STATUSES.map((s) =>
    supabase
      .from("tracks")
      .select("*", { count: "exact", head: true })
      .eq("user_id", user.userId)
      .eq("acquisition_status", s)
  );

  const agentsPromise = supabase
    .from("agents")
    .select("id, machine_name, last_seen_at, capabilities")
    .eq("user_id", user.userId)
    .order("last_seen_at", { ascending: false, nullsFirst: false });

  const [agentsResult, ...countResults] = await Promise.all([
    agentsPromise,
    ...countPromises,
  ]);

  if (countResults.some((r) => r.error) || agentsResult.error) {
    return jsonError("Failed to fetch pipeline status", 500);
  }

  const counts: Record<string, number> = {};
  PIPELINE_STATUSES.forEach((s, i) => {
    counts[s] = countResults[i].count ?? 0;
  });

  const agents = (agentsResult.data ?? []).map((r) => ({
    id: String(r.id),
    machine_name: r.machine_name,
    last_seen_at: r.last_seen_at ?? null,
    capabilities: Array.isArray(r.capabilities) ? r.capabilities : [],
  }));

  return NextResponse.json({ ...counts, agents });
}
```

- [ ] **Step 2: Verify endpoint returns new shape**

Run: `cd web && npm run dev` and test with curl:
```bash
curl -H "Authorization: Bearer <token>" http://localhost:3000/api/pipeline/status
```

Expected: JSON with per-status counts + agents array.

- [ ] **Step 3: Commit**

```bash
git add web/app/api/pipeline/status/route.ts
git commit -m "feat: update pipeline status endpoint to return track-level counts"
```

---

## Task 4: Backend — Retry Endpoint

**Files:**
- Create: `web/app/api/pipeline/tracks/[id]/retry/route.ts`

- [ ] **Step 1: Create retry endpoint**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";
import { rateLimit, limiters } from "@/lib/api-server/rate-limit";
import { createServiceClient } from "@/lib/supabase/service";
import { jsonError } from "@/lib/api-server/errors";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const rateLimitResponse = await rateLimit(request, limiters.write);
  if (rateLimitResponse) return rateLimitResponse;

  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  const { id: trackId } = await params;
  const supabase = createServiceClient();

  // Verify track belongs to user and is retryable
  const { data: track, error: fetchErr } = await supabase
    .from("tracks")
    .select("id, acquisition_status, user_id")
    .eq("id", trackId)
    .single();

  if (fetchErr || !track) {
    return jsonError("Track not found", 404);
  }
  if (track.user_id !== user.userId) {
    return jsonError("Forbidden", 403);
  }
  if (!["not_found", "failed"].includes(track.acquisition_status)) {
    return jsonError(
      `Cannot retry track with status '${track.acquisition_status}'`,
      400
    );
  }

  // Optional: update search_string if provided
  const body = await request.json().catch(() => ({}));
  const updates: Record<string, unknown> = {
    acquisition_status: "candidate",
    search_results_count: null,
  };
  if (body.search_string && typeof body.search_string === "string") {
    updates.search_string = body.search_string.trim();
  }

  const { data: updated, error: updateErr } = await supabase
    .from("tracks")
    .update(updates)
    .eq("id", trackId)
    .select()
    .single();

  if (updateErr) {
    return jsonError(updateErr.message, 500);
  }

  return NextResponse.json(updated);
}
```

- [ ] **Step 2: Verify endpoint works**

Test with curl:
```bash
# Retry without search string change
curl -X PUT -H "Authorization: Bearer <token>" \
  http://localhost:3000/api/pipeline/tracks/<track-id>/retry

# Retry with updated search string
curl -X PUT -H "Authorization: Bearer <token>" \
  -d '{"search_string": "new query"}' \
  http://localhost:3000/api/pipeline/tracks/<track-id>/retry
```

- [ ] **Step 3: Commit**

```bash
git add web/app/api/pipeline/tracks/
git commit -m "feat: add retry endpoint for not_found/failed tracks"
```

---

## Task 5: Frontend — API Client Types + Functions

**Files:**
- Modify: `web/lib/api.ts`

- [ ] **Step 1: Add pipeline monitor types**

Add to `web/lib/api.ts`:

```typescript
/* ── Pipeline Monitor types ───────────────────────────────────── */

export type AcquisitionStatus =
  | "candidate"
  | "searching"
  | "found"
  | "not_found"
  | "queued"
  | "downloading"
  | "failed";

export interface PipelineTrack {
  id: number;
  title: string;
  artist: string;
  album: string | null;
  artwork_url: string | null;
  acquisition_status: AcquisitionStatus;
  search_string: string | null;
  search_results_count: number | null;
  updated_at: string;
}

export interface PipelineMonitorStatus {
  candidate: number;
  searching: number;
  found: number;
  not_found: number;
  queued: number;
  downloading: number;
  failed: number;
  agents: { id: string; machine_name: string; last_seen_at: string; capabilities: string[] }[];
}

export interface PipelineTrackList {
  tracks: PipelineTrack[];
  total: number;
  page: number;
  per_page: number;
}
```

- [ ] **Step 2: Add fetch functions**

```typescript
export async function fetchPipelineMonitorStatus(): Promise<PipelineMonitorStatus> {
  const res = await apiClient("/pipeline/status");
  if (!res.ok) throw new Error("Failed to fetch pipeline status");
  return res.json();
}

export async function fetchPipelineTracks(params: {
  page?: number;
  per_page?: number;
  status?: AcquisitionStatus;
  sort_by?: string;
  sort_dir?: "asc" | "desc";
}): Promise<PipelineTrackList> {
  const sp = new URLSearchParams();
  if (params.page) sp.set("page", String(params.page));
  if (params.per_page) sp.set("per_page", String(params.per_page));
  if (params.status) sp.set("status", params.status);
  if (params.sort_by) sp.set("sort_by", params.sort_by);
  if (params.sort_dir) sp.set("sort_dir", params.sort_dir);
  const res = await apiClient(`/pipeline/tracks?${sp}`);
  if (!res.ok) throw new Error("Failed to fetch pipeline tracks");
  return res.json();
}

export async function retryPipelineTrack(
  trackId: number,
  searchString?: string
): Promise<PipelineTrack> {
  const body = searchString ? { search_string: searchString } : {};
  const res = await apiClient(`/pipeline/tracks/${trackId}/retry`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("Failed to retry track");
  return res.json();
}
```

- [ ] **Step 3: Commit**

```bash
git add web/lib/api.ts
git commit -m "feat: add pipeline monitor API types and fetch functions"
```

---

## Task 6: Backend — Pipeline Tracks List Endpoint

**Files:**
- Create: `web/app/api/pipeline/tracks/route.ts`

The pipeline monitor needs a paginated list of non-available tracks. This is separate from the catalog tracks endpoint.

- [ ] **Step 1: Create pipeline tracks list endpoint**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";
import { rateLimit, limiters } from "@/lib/api-server/rate-limit";
import { createServiceClient } from "@/lib/supabase/service";
import { jsonError } from "@/lib/api-server/errors";

export async function GET(request: NextRequest) {
  const rateLimitResponse = await rateLimit(request, limiters.read);
  if (rateLimitResponse) return rateLimitResponse;

  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  const supabase = createServiceClient();

  const sp = request.nextUrl.searchParams;
  const page = Math.max(1, Number(sp.get("page")) || 1);
  const perPage = Math.min(100, Math.max(1, Number(sp.get("per_page")) || 25));
  const status = sp.get("status");
  const sortBy = sp.get("sort_by") || "updated_at";
  const sortDir = sp.get("sort_dir") === "asc";
  const offset = (page - 1) * perPage;

  const columns = [
    "id", "title", "artist", "album", "artwork_url",
    "acquisition_status", "search_string", "search_results_count",
    "updated_at",
  ].join(",");

  let query = supabase
    .from("tracks")
    .select(columns, { count: "exact" })
    .eq("user_id", user.userId)
    .not("acquisition_status", "in", "(available,duplicate)");

  if (status) {
    query = query.eq("acquisition_status", status);
  }

  query = query.order(sortBy, { ascending: sortDir }).range(offset, offset + perPage - 1);

  const { data, error, count } = await query;

  if (error) {
    return jsonError(error.message, 500);
  }

  return NextResponse.json({
    tracks: data || [],
    total: count || 0,
    page,
    per_page: perPage,
  });
}
```

- [ ] **Step 2: Verify endpoint**

```bash
curl -H "Authorization: Bearer <token>" \
  "http://localhost:3000/api/pipeline/tracks?page=1&per_page=25"
```

- [ ] **Step 3: Commit**

```bash
git add web/app/api/pipeline/tracks/route.ts
git commit -m "feat: add pipeline tracks list endpoint with pagination + sorting"
```

---

## Task 7: Frontend — Pipeline Monitor Page (Full Rewrite)

**Files:**
- Modify: `web/app/(app)/pipeline/page.tsx` (full rewrite)

This is the largest task. The current 1027-line job-centric page gets replaced with a track-centric monitor.

- [ ] **Step 1: Write the new pipeline page**

Replace `web/app/(app)/pipeline/page.tsx` entirely. Key sections:

**State and types:**
```typescript
"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { toast } from "sonner";
import {
  fetchPipelineMonitorStatus,
  fetchPipelineTracks,
  retryPipelineTrack,
  type PipelineMonitorStatus,
  type PipelineTrack,
  type PipelineTrackList,
  type AcquisitionStatus,
} from "@/lib/api";
import { createClient } from "@/lib/supabase/client";
import LCDDisplay from "@/components/ui/LCDDisplay";
```

**Status LED color map** (matching existing design system):
```typescript
const STATUS_LED: Record<string, { color: string; bg: string; border: string; pulse?: boolean }> = {
  candidate: {
    color: "var(--hw-text-dim)",
    bg: "transparent",
    border: "transparent",
  },
  searching: {
    color: "var(--led-orange)",
    bg: "color-mix(in srgb, var(--led-orange) 7%, transparent)",
    border: "color-mix(in srgb, var(--led-orange) 20%, transparent)",
    pulse: true,
  },
  found: {
    color: "var(--led-green)",
    bg: "color-mix(in srgb, var(--led-green) 7%, transparent)",
    border: "color-mix(in srgb, var(--led-green) 20%, transparent)",
  },
  not_found: {
    color: "var(--led-red)",
    bg: "color-mix(in srgb, var(--led-red) 7%, transparent)",
    border: "color-mix(in srgb, var(--led-red) 20%, transparent)",
  },
  queued: {
    color: "var(--led-blue)",
    bg: "color-mix(in srgb, var(--led-blue) 7%, transparent)",
    border: "color-mix(in srgb, var(--led-blue) 20%, transparent)",
  },
  downloading: {
    color: "var(--led-blue)",
    bg: "color-mix(in srgb, var(--led-blue) 7%, transparent)",
    border: "color-mix(in srgb, var(--led-blue) 20%, transparent)",
    pulse: true,
  },
  failed: {
    color: "var(--led-red)",
    bg: "color-mix(in srgb, var(--led-red) 7%, transparent)",
    border: "color-mix(in srgb, var(--led-red) 20%, transparent)",
  },
};
```

**Main component state:**
```typescript
export default function PipelineMonitorPage() {
  const [status, setStatus] = useState<PipelineMonitorStatus | null>(null);
  const [trackData, setTrackData] = useState<PipelineTrackList | null>(null);
  const [statusFilter, setStatusFilter] = useState<AcquisitionStatus | "">("");
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(25);
  const [sortBy, setSortBy] = useState("updated_at");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [editingQuery, setEditingQuery] = useState<number | null>(null); // track id being edited
  const [editValue, setEditValue] = useState("");
  const [retrying, setRetrying] = useState<Set<number>>(new Set());
  const refreshRef = useRef<ReturnType<typeof setTimeout>>();
  // ... data loading, realtime subscription, render
}
```

**Realtime subscription** (subscribe by user_id, filter client-side). Important: the cleanup function must be returned from the effect itself, not from a nested `.then()`:

```typescript
useEffect(() => {
  const supabase = createClient();
  let channel: ReturnType<typeof supabase.channel> | null = null;

  async function setup() {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;
    channel = supabase
      .channel("pipeline-tracks")
      .on("postgres_changes", {
        event: "*",
        schema: "public",
        table: "tracks",
        filter: `user_id=eq.${session.user.id}`,
      }, (payload) => {
        const row = payload.new as Record<string, unknown>;
        if (["available", "duplicate"].includes(row.acquisition_status as string)) return;
        // Debounced refresh
        clearTimeout(refreshRef.current);
        refreshRef.current = setTimeout(() => {
          loadStatus();
          loadTracks();
        }, 1000);
      })
      .subscribe();
  }
  setup();

  return () => {
    if (channel) supabase.removeChannel(channel);
  };
}, []);
```

**LCD stat bar:**
```typescript
<div className="grid grid-cols-3 md:grid-cols-6 gap-3 mb-6">
  <LCDDisplay value={status?.candidate ?? 0} label="Candidates" />
  <LCDDisplay value={status?.searching ?? 0} label="Searching" />
  <LCDDisplay value={status?.found ?? 0} label="Found" />
  <LCDDisplay value={status?.downloading ?? 0} label="Downloading" />
  <LCDDisplay value={status?.not_found ?? 0} label="Not Found" />
  <LCDDisplay value={status?.failed ?? 0} label="Failed" />
</div>
```

**Filter buttons:**
```typescript
const FILTER_OPTIONS: { value: AcquisitionStatus | ""; label: string }[] = [
  { value: "", label: "All" },
  { value: "candidate", label: "Candidate" },
  { value: "searching", label: "Searching" },
  { value: "found", label: "Found" },
  { value: "queued", label: "Queued" },
  { value: "downloading", label: "Downloading" },
  { value: "not_found", label: "Not Found" },
  { value: "failed", label: "Failed" },
];
```

Render as horizontal button group with counts from `status`.

**Track table** with artwork, title/artist, status badge, search query (inline editable for not_found), results count, retry action.

**Pagination** at the bottom: prev/next + page size selector (25/50/100).

**Sortable column headers:** Click to toggle sort. Arrow indicator for direction.

**Retry handler:**
```typescript
async function handleRetry(trackId: number, newSearchString?: string) {
  setRetrying((prev) => new Set(prev).add(trackId));
  try {
    await retryPipelineTrack(trackId, newSearchString);
    toast.success("Track queued for retry");
    loadStatus();
    loadTracks();
  } catch {
    toast.error("Retry failed");
  } finally {
    setRetrying((prev) => {
      const next = new Set(prev);
      next.delete(trackId);
      return next;
    });
  }
}
```

**Inline search query edit** (for not_found tracks):
```typescript
// On click: setEditingQuery(track.id), setEditValue(track.search_string)
// On enter: handleRetry(track.id, editValue), setEditingQuery(null)
// On escape: setEditingQuery(null)
```

- [ ] **Step 2: Add CSS for pulse animation**

Add to `globals.css` (if not already present):

```css
@keyframes led-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}
```

- [ ] **Step 3: Verify page renders**

Run: `cd web && npm run dev`
Open: `http://localhost:3000/pipeline`
Expected: LCD stat bar, filter buttons, track table with pagination. Realtime updates when track statuses change.

- [ ] **Step 4: Commit**

```bash
git add web/app/(app)/pipeline/page.tsx web/app/globals.css
git commit -m "feat: replace pipeline page with track-centric monitor"
```

---

## Task 8: Frontend — Catalog Filter + Artwork Column

**Files:**
- Modify: `web/app/(app)/catalog/page.tsx`

- [ ] **Step 1: Add default status=available filter**

Find where `fetchCatalogTracks` (or equivalent) is called and ensure `status=available` is always passed:

```typescript
// In the fetch/load function, add default status filter:
const params = new URLSearchParams();
params.set("status", "available");  // Catalog = what you truly have
// ... existing pagination, sort, search params
```

- [ ] **Step 2: Add artwork thumbnail to track list/table**

In the track row component (TrackListRow or similar), add an artwork column as the first element:

```typescript
{/* Artwork thumbnail */}
<div className="w-10 h-10 rounded overflow-hidden flex-shrink-0 bg-[var(--hw-surface)]">
  {track.artwork_url ? (
    <img src={track.artwork_url} alt="" className="w-full h-full object-cover" />
  ) : (
    <div className="w-full h-full flex items-center justify-center text-[var(--hw-text-dim)] text-xs">
      ♪
    </div>
  )}
</div>
```

- [ ] **Step 3: Verify catalog shows only available tracks**

Run: `cd web && npm run dev`
Open: `http://localhost:3000/catalog`
Expected: Only tracks with `acquisition_status = 'available'` appear. Tracks in `candidate`, `searching`, `downloading`, etc. are not visible.

- [ ] **Step 4: Commit**

```bash
git add web/app/(app)/catalog/page.tsx
git commit -m "feat: filter catalog to available tracks only + add artwork column"
```

---

## Task 9: Backend — Update SupabaseAdapter Status Counts

**Files:**
- Modify: `djtoolkit/adapters/supabase.py`
- Test: `tests/test_supabase_adapter.py`

- [ ] **Step 1: Write failing test**

```python
def test_count_by_acquisition_status_includes_new_statuses(self):
    """count_by_acquisition_status should include all 9 status values."""
    adapter = SupabaseAdapter(mock_client)
    # Mock the query to return counts
    result = adapter.count_by_acquisition_status("user-123")
    assert "searching" in result
    assert "found" in result
    assert "not_found" in result
    assert "queued" in result
```

- [ ] **Step 2: Run test to verify it fails**

Run: `poetry run pytest tests/test_supabase_adapter.py -k "count_by_acquisition_status" -v`

- [ ] **Step 3: Update count_by_acquisition_status**

Ensure the method returns counts for all 9 statuses (including the 4 new ones), defaulting to 0 for missing statuses:

```python
ALL_STATUSES = [
    "candidate", "searching", "found", "not_found", "queued",
    "downloading", "available", "failed", "duplicate",
]

def count_by_acquisition_status(self, user_id: str) -> dict[str, int]:
    result = (
        self._client.table("tracks").select("acquisition_status")
        .eq("user_id", user_id)
        .execute()
    )
    counts = {s: 0 for s in ALL_STATUSES}
    for row in result.data:
        s = row["acquisition_status"]
        if s in counts:
            counts[s] += 1
    return counts
```

- [ ] **Step 4: Run tests**

Run: `poetry run pytest tests/test_supabase_adapter.py -v`

- [ ] **Step 5: Commit**

```bash
git add djtoolkit/adapters/supabase.py tests/test_supabase_adapter.py
git commit -m "feat: update count_by_acquisition_status to include new statuses"
```

---

## Task 10: Integration Verification

- [ ] **Step 1: End-to-end smoke test**

1. Import a CSV with a few tracks → verify they appear in pipeline monitor as `candidate`
2. Run `djtoolkit download` → watch statuses transition: `candidate` → `searching` → `found`/`not_found` → `queued` → `downloading` → `available`/`failed`
3. Verify `available` tracks disappear from pipeline monitor and appear in catalog
4. Verify `not_found` tracks show retry button and inline-editable search query
5. Edit a search query and click retry → verify track resets to `candidate`
6. Verify LCD stat bar counts update in real-time via Supabase Realtime

- [ ] **Step 2: Verify catalog filter**

Open catalog page — confirm only `available` tracks are shown. Import new tracks — confirm they do NOT appear in catalog until downloaded.

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "feat: pipeline monitor — track-centric Soulseek monitoring

Replaces job-centric pipeline page with track-centric monitor.
Expands acquisition_status with searching/found/not_found/queued states.
Filters catalog to available-only. Adds retry flow for failed searches."
```
