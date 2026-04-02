# Pipeline Job Failures Visibility — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface post-download job failures in the Pipeline Monitor UI so users can see and retry failed cover_art, audio_analysis, metadata, etc. jobs.

**Architecture:** Add a "Job Failures" virtual filter to the existing Pipeline Monitor that queries `pipeline_jobs` instead of `tracks.acquisition_status`. A new API endpoint groups failed jobs by track, the `pipeline_status` RPC gains a `job_failures` count, and the batch_complete notification deep-links to the filtered view.

**Tech Stack:** Next.js API routes, Supabase PostgreSQL (RPC + migration), React (existing pipeline page), TypeScript

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `supabase/migrations/20260402300000_job_failures_visibility.sql` | Add `job_failures` to RPC, update notification URL |
| Create | `web/app/api/pipeline/tracks/with-failed-jobs/route.ts` | API: tracks grouped with their failed jobs |
| Modify | `web/lib/api.ts` | Client: new fetch function + updated types |
| Modify | `web/app/(app)/pipeline/page.tsx` | UI: filter, LCD, data source switching, retry wiring |

---

### Task 1: Supabase Migration — RPC + Notification URL

**Files:**
- Create: `supabase/migrations/20260402300000_job_failures_visibility.sql`

- [ ] **Step 1: Write the migration SQL**

```sql
-- 1. Update pipeline_status RPC to include job_failures count
CREATE OR REPLACE FUNCTION pipeline_status(p_user_id UUID)
RETURNS JSON
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT json_build_object(
    'candidate',     count(*) FILTER (WHERE acquisition_status = 'candidate'),
    'searching',     count(*) FILTER (WHERE acquisition_status = 'searching'),
    'found',         count(*) FILTER (WHERE acquisition_status = 'found'),
    'not_found',     count(*) FILTER (WHERE acquisition_status = 'not_found'),
    'queued',        count(*) FILTER (WHERE acquisition_status = 'queued'),
    'downloading',   count(*) FILTER (WHERE acquisition_status = 'downloading'),
    'failed',        count(*) FILTER (WHERE acquisition_status = 'failed'),
    'paused',        count(*) FILTER (WHERE acquisition_status = 'paused'),
    'job_failures',  (
      SELECT count(DISTINCT track_id)
      FROM pipeline_jobs
      WHERE user_id = p_user_id
        AND status = 'failed'
    )
  )
  FROM tracks
  WHERE user_id = p_user_id;
$$;
```

Create this file at `supabase/migrations/20260402300000_job_failures_visibility.sql`.

- [ ] **Step 2: Update the batch_complete notification URL in `chain_pipeline_job()`**

In the same migration file, append the trigger replacement. The key change is in the `INSERT INTO push_notifications` at the bottom of the function — change the `url` value from `'/pipeline'` to a CASE expression.

The full trigger function is long (~350 lines). The only change is in the `batch_complete` notification block. Replace lines 339-348 of `supabase/migrations/20260327100000_analysis_complete_notification.sql` (the INSERT INTO push_notifications for batch_complete). The entire `chain_pipeline_job()` function must be included in the `CREATE OR REPLACE FUNCTION` since it replaces the whole function.

Copy the entire existing `chain_pipeline_job()` from `supabase/migrations/20260327100000_analysis_complete_notification.sql` and change only the notification insert block (currently at lines 339-348) from:

```sql
        INSERT INTO push_notifications (user_id, type, title, body, url, data)
        VALUES (
            NEW.user_id,
            'batch_complete',
            'Pipeline complete',
            _done_count || ' tracks processed (' ||
                _done_count || ' succeeded, ' || _failed_count || ' failed)',
            '/pipeline',
            jsonb_build_object('done', _done_count, 'failed', _failed_count)
        );
```

to:

```sql
        INSERT INTO push_notifications (user_id, type, title, body, url, data)
        VALUES (
            NEW.user_id,
            'batch_complete',
            'Pipeline complete',
            _done_count || ' tracks processed (' ||
                _done_count || ' succeeded, ' || _failed_count || ' failed)',
            CASE WHEN _failed_count > 0
                 THEN '/pipeline?filter=job_failures'
                 ELSE '/pipeline'
            END,
            jsonb_build_object('done', _done_count, 'failed', _failed_count)
        );
```

- [ ] **Step 3: Apply the migration**

Run via Supabase MCP `apply_migration` tool or:

```bash
supabase db push
```

- [ ] **Step 4: Verify the RPC returns job_failures**

Test in Supabase SQL Editor:

```sql
SELECT pipeline_status('<your-user-id>');
```

Expected: JSON object now includes `"job_failures": <number>` alongside the existing status counts.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260402300000_job_failures_visibility.sql
git commit -m "feat(db): add job_failures count to pipeline_status RPC + deep-link notification"
```

---

### Task 2: API Endpoint — Tracks With Failed Jobs

**Files:**
- Create: `web/app/api/pipeline/tracks/with-failed-jobs/route.ts`

Reference: `web/app/api/pipeline/jobs/history/route.ts` for the pattern of querying `pipeline_jobs` + batch-fetching track metadata.

- [ ] **Step 1: Create the endpoint**

Create `web/app/api/pipeline/tracks/with-failed-jobs/route.ts`:

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
  const search = sp.get("search");

  // 1. Get distinct track_ids that have failed jobs, with count for pagination
  // Using a CTE via RPC would be ideal, but we can do it in two queries:
  // First get the total count of distinct tracks with failed jobs
  const { count: totalCount, error: countErr } = await supabase
    .from("pipeline_jobs")
    .select("track_id", { count: "exact", head: true })
    // Supabase JS doesn't support DISTINCT count, so we'll get all track_ids
    .eq("user_id", user.userId)
    .eq("status", "failed");

  if (countErr) {
    return jsonError("Failed to count failed jobs", 500);
  }

  // Get all distinct track_ids with failed jobs
  const { data: failedJobRows, error: jobsErr } = await supabase
    .from("pipeline_jobs")
    .select("track_id")
    .eq("user_id", user.userId)
    .eq("status", "failed")
    .not("track_id", "is", null);

  if (jobsErr) {
    return jsonError("Failed to fetch failed jobs", 500);
  }

  // Deduplicate track_ids
  const allTrackIds = [...new Set(
    failedJobRows
      .map((r) => r.track_id)
      .filter((id): id is number => id != null)
  )];

  // Apply search filter if present — we need to fetch track metadata first
  let filteredTrackIds = allTrackIds;

  if (search && search.trim()) {
    // Fetch track metadata for search filtering
    const { data: searchTracks } = await supabase
      .from("tracks")
      .select("id")
      .in("id", allTrackIds)
      .or(
        `title.ilike.%${search.trim()}%,artist.ilike.%${search.trim()}%`
      );
    filteredTrackIds = (searchTracks ?? []).map((t) => t.id);
  }

  const total = filteredTrackIds.length;
  const offset = (page - 1) * perPage;
  const pageTrackIds = filteredTrackIds.slice(offset, offset + perPage);

  if (pageTrackIds.length === 0) {
    return NextResponse.json({ tracks: [], total, page, per_page: perPage });
  }

  // 2. Batch-fetch track metadata for this page
  const { data: tracks, error: tracksErr } = await supabase
    .from("tracks")
    .select(
      "id, title, artist, album, artwork_url, acquisition_status, source, created_at, updated_at"
    )
    .in("id", pageTrackIds);

  if (tracksErr) {
    return jsonError("Failed to fetch tracks", 500);
  }

  // 3. Batch-fetch all failed jobs for these tracks
  const { data: failedJobs, error: failedErr } = await supabase
    .from("pipeline_jobs")
    .select("id, job_type, error, completed_at, track_id, retry_count")
    .eq("user_id", user.userId)
    .eq("status", "failed")
    .in("track_id", pageTrackIds)
    .order("completed_at", { ascending: false });

  if (failedErr) {
    return jsonError("Failed to fetch failed job details", 500);
  }

  // 4. Group failed jobs by track_id
  const jobsByTrack = new Map<number, typeof failedJobs>();
  for (const job of failedJobs ?? []) {
    if (job.track_id == null) continue;
    const list = jobsByTrack.get(job.track_id) ?? [];
    list.push(job);
    jobsByTrack.set(job.track_id, list);
  }

  // 5. Merge and return
  const enrichedTracks = (tracks ?? []).map((t) => ({
    ...t,
    failed_jobs: (jobsByTrack.get(t.id) ?? []).map((j) => ({
      id: String(j.id),
      job_type: j.job_type,
      error: j.error,
      completed_at: j.completed_at,
      retry_count: j.retry_count,
    })),
  }));

  return NextResponse.json({
    tracks: enrichedTracks,
    total,
    page,
    per_page: perPage,
  });
}
```

- [ ] **Step 2: Verify the endpoint works**

Start the dev server and test:

```bash
cd web && npm run dev
```

Then in another terminal:

```bash
curl -s 'http://localhost:3000/api/pipeline/tracks/with-failed-jobs' \
  -H 'Cookie: <your-session-cookie>' | jq '.total, .tracks[0].failed_jobs'
```

Expected: Returns a count and tracks with `failed_jobs` arrays. If no failed jobs exist, returns `{ tracks: [], total: 0 }`.

- [ ] **Step 3: Commit**

```bash
git add web/app/api/pipeline/tracks/with-failed-jobs/route.ts
git commit -m "feat(api): add tracks-with-failed-jobs endpoint for pipeline UI"
```

---

### Task 3: Client Library — Types + Fetch Function

**Files:**
- Modify: `web/lib/api.ts`

- [ ] **Step 1: Add the `FailedJob` interface and `TrackWithFailedJobs` interface**

After the `PipelineTrack` interface (line 313 in `web/lib/api.ts`), add:

```typescript
export interface FailedJob {
  id: string;
  job_type: string;
  error: string | null;
  completed_at: string | null;
  retry_count: number;
}

export interface TrackWithFailedJobs {
  id: number;
  title: string;
  artist: string;
  album: string | null;
  artwork_url: string | null;
  acquisition_status: string;
  source: string | null;
  created_at: string;
  updated_at: string;
  failed_jobs: FailedJob[];
}

export interface TrackWithFailedJobsList {
  tracks: TrackWithFailedJobs[];
  total: number;
  page: number;
  per_page: number;
}
```

- [ ] **Step 2: Add `job_failures` to `PipelineMonitorStatus`**

In `web/lib/api.ts`, update the `PipelineMonitorStatus` interface (currently at line 315) to add the field after `paused`:

Change:

```typescript
export interface PipelineMonitorStatus {
  candidate: number;
  searching: number;
  found: number;
  not_found: number;
  queued: number;
  downloading: number;
  failed: number;
  paused: number;
  agents: { id: string; machine_name: string; last_seen_at: string; capabilities: string[] }[];
}
```

to:

```typescript
export interface PipelineMonitorStatus {
  candidate: number;
  searching: number;
  found: number;
  not_found: number;
  queued: number;
  downloading: number;
  failed: number;
  paused: number;
  job_failures: number;
  agents: { id: string; machine_name: string; last_seen_at: string; capabilities: string[] }[];
}
```

- [ ] **Step 3: Add `fetchTracksWithFailedJobs` function**

After `fetchPipelineTracks` (around line 358), add:

```typescript
export async function fetchTracksWithFailedJobs(params: {
  page?: number;
  per_page?: number;
  search?: string;
}): Promise<TrackWithFailedJobsList> {
  const sp = new URLSearchParams();
  if (params.page) sp.set("page", String(params.page));
  if (params.per_page) sp.set("per_page", String(params.per_page));
  if (params.search) sp.set("search", params.search);
  const res = await apiClient(`/pipeline/tracks/with-failed-jobs?${sp}`);
  if (!res.ok) throw new Error("Failed to fetch tracks with failed jobs");
  return res.json();
}
```

- [ ] **Step 4: Commit**

```bash
git add web/lib/api.ts
git commit -m "feat(client): add fetchTracksWithFailedJobs + job_failures status type"
```

---

### Task 4: Pipeline Status API — Pass Through job_failures

**Files:**
- Modify: `web/app/api/pipeline/status/route.ts`

- [ ] **Step 1: Update the status route to include job_failures**

The status route at `web/app/api/pipeline/status/route.ts` already reads from the RPC and falls back to count queries. The RPC will now return `job_failures`, but the fallback path and the `PIPELINE_STATUSES` array need updating.

In `web/app/api/pipeline/status/route.ts`, update the `PIPELINE_STATUSES` array (line 7) to recognize the new field, and handle it in the fallback path.

Change:

```typescript
const PIPELINE_STATUSES = [
  "candidate", "searching", "found", "not_found",
  "queued", "downloading", "failed", "paused",
] as const;
```

to:

```typescript
const PIPELINE_STATUSES = [
  "candidate", "searching", "found", "not_found",
  "queued", "downloading", "failed", "paused",
] as const;

// job_failures comes from the RPC as a subquery on pipeline_jobs, not from tracks
const JOB_FAILURE_KEY = "job_failures";
```

Then update the RPC success path (around line 53-58) to also extract `job_failures`:

Change:

```typescript
  } else {
    const row = Array.isArray(rpcResult.data) ? rpcResult.data[0] : rpcResult.data;
    counts = {};
    for (const s of PIPELINE_STATUSES) {
      counts[s] = row?.[s] ?? 0;
    }
  }
```

to:

```typescript
  } else {
    const row = Array.isArray(rpcResult.data) ? rpcResult.data[0] : rpcResult.data;
    counts = {};
    for (const s of PIPELINE_STATUSES) {
      counts[s] = row?.[s] ?? 0;
    }
    counts[JOB_FAILURE_KEY] = row?.[JOB_FAILURE_KEY] ?? 0;
  }
```

For the fallback path (lines 34-52), add a separate count query for job_failures after the existing count queries. After the `counts` object is built from PIPELINE_STATUSES (around line 52), add:

```typescript
    // Fallback: count job failures separately from pipeline_jobs
    const { data: jfRows } = await supabase
      .from("pipeline_jobs")
      .select("track_id")
      .eq("user_id", user.userId)
      .eq("status", "failed");
    counts[JOB_FAILURE_KEY] = new Set((jfRows ?? []).map((r) => r.track_id)).size;
```

- [ ] **Step 2: Commit**

```bash
git add web/app/api/pipeline/status/route.ts
git commit -m "feat(api): pass through job_failures count from pipeline_status RPC"
```

---

### Task 5: Pipeline UI — Filter, LCD, Data Source, Retry

**Files:**
- Modify: `web/app/(app)/pipeline/page.tsx`

This is the largest task. All changes are in the existing pipeline page.

- [ ] **Step 1: Update imports**

At the top of `web/app/(app)/pipeline/page.tsx` (line 6-16), add the new imports alongside the existing ones:

Change:

```typescript
import {
  fetchPipelineMonitorStatus,
  fetchPipelineTracks,
  retryPipelineTrack,
  bulkPipelineAction,
  bulkCreateJobs,
  fetchTrackJobs,
  type PipelineMonitorStatus,
  type PipelineTrack,
  type PipelineTrackList,
  type PipelineJob,
  type AcquisitionStatus,
} from "@/lib/api";
```

to:

```typescript
import {
  fetchPipelineMonitorStatus,
  fetchPipelineTracks,
  fetchTracksWithFailedJobs,
  retryPipelineTrack,
  retryPipelineJobs,
  bulkPipelineAction,
  bulkCreateJobs,
  fetchTrackJobs,
  type PipelineMonitorStatus,
  type PipelineTrack,
  type PipelineTrackList,
  type PipelineJob,
  type AcquisitionStatus,
  type TrackWithFailedJobs,
  type TrackWithFailedJobsList,
} from "@/lib/api";
```

- [ ] **Step 2: Update filter type and options**

Change the `FILTER_OPTIONS` array (lines 93-103) and its type to support the virtual `job_failures` filter:

Change:

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
  { value: "paused", label: "Paused" },
];
```

to:

```typescript
type FilterValue = AcquisitionStatus | "job_failures" | "";

const FILTER_OPTIONS: { value: FilterValue; label: string }[] = [
  { value: "", label: "All" },
  { value: "candidate", label: "Candidate" },
  { value: "searching", label: "Searching" },
  { value: "found", label: "Found" },
  { value: "queued", label: "Queued" },
  { value: "downloading", label: "Downloading" },
  { value: "not_found", label: "Not Found" },
  { value: "failed", label: "Failed" },
  { value: "paused", label: "Paused" },
  { value: "job_failures", label: "Job Failures" },
];
```

- [ ] **Step 3: Update state types and add job failures state**

Update the `statusFilter` state type (line 173) and add state for the job failures data:

Change:

```typescript
  const [statusFilter, setStatusFilter] = useState<AcquisitionStatus | "">("");
```

to:

```typescript
  const [statusFilter, setStatusFilter] = useState<FilterValue>("");
  const [jobFailuresData, setJobFailuresData] = useState<TrackWithFailedJobsList | null>(null);
```

- [ ] **Step 4: Read query param on mount for deep-link support**

Add a `useEffect` after the existing state declarations (after line 185) to read `?filter=` from the URL:

```typescript
  /* ── Read ?filter= query param on mount ──────────────────────── */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const filter = params.get("filter");
    if (filter && FILTER_OPTIONS.some((f) => f.value === filter)) {
      setStatusFilter(filter as FilterValue);
    }
  }, []);
```

- [ ] **Step 5: Update `loadTracks` to handle job_failures filter**

Replace the `loadTracks` callback (lines 206-224):

Change:

```typescript
  const loadTracks = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchPipelineTracks({
        page,
        per_page: perPage,
        status: statusFilter || undefined,
        sort_by: sortBy,
        sort_dir: sortDir,
        search: search || undefined,
      });
      setTrackData(data);
      setSelected(new Set());
    } catch {
      toast.error("Failed to load pipeline tracks");
    } finally {
      setLoading(false);
    }
  }, [page, perPage, statusFilter, sortBy, sortDir, search]);
```

to:

```typescript
  const loadTracks = useCallback(async () => {
    setLoading(true);
    try {
      if (statusFilter === "job_failures") {
        const data = await fetchTracksWithFailedJobs({
          page,
          per_page: perPage,
          search: search || undefined,
        });
        setJobFailuresData(data);
        setTrackData(null);
      } else {
        const data = await fetchPipelineTracks({
          page,
          per_page: perPage,
          status: statusFilter || undefined,
          sort_by: sortBy,
          sort_dir: sortDir,
          search: search || undefined,
        });
        setTrackData(data);
        setJobFailuresData(null);
      }
      setSelected(new Set());
    } catch {
      toast.error("Failed to load pipeline tracks");
    } finally {
      setLoading(false);
    }
  }, [page, perPage, statusFilter, sortBy, sortDir, search]);
```

- [ ] **Step 6: Add the LCD counter**

Update the LCD stat bar (lines 666-674). Change:

```typescript
      <div className="grid grid-cols-4 md:grid-cols-7 gap-3 mb-6">
        <LCDDisplay value={status?.candidate ?? 0} label="Candidates" />
        <LCDDisplay value={status?.searching ?? 0} label="Searching" />
        <LCDDisplay value={status?.found ?? 0} label="Found" />
        <LCDDisplay value={status?.downloading ?? 0} label="Downloading" />
        <LCDDisplay value={status?.not_found ?? 0} label="Not Found" />
        <LCDDisplay value={status?.failed ?? 0} label="Failed" />
        <LCDDisplay value={status?.paused ?? 0} label="Paused" />
      </div>
```

to:

```typescript
      <div className="grid grid-cols-4 md:grid-cols-8 gap-3 mb-6">
        <LCDDisplay value={status?.candidate ?? 0} label="Candidates" />
        <LCDDisplay value={status?.searching ?? 0} label="Searching" />
        <LCDDisplay value={status?.found ?? 0} label="Found" />
        <LCDDisplay value={status?.downloading ?? 0} label="Downloading" />
        <LCDDisplay value={status?.not_found ?? 0} label="Not Found" />
        <LCDDisplay value={status?.failed ?? 0} label="Failed" />
        <LCDDisplay value={status?.paused ?? 0} label="Paused" />
        <LCDDisplay value={status?.job_failures ?? 0} label="Job Failures" />
      </div>
```

- [ ] **Step 7: Update filter button count logic**

The filter button count logic (lines 678-684) needs to handle `job_failures`:

Change:

```typescript
        {FILTER_OPTIONS.map((f) => {
          const count = f.value
            ? (status?.[f.value] ?? 0)
            : Object.values(status ?? {}).reduce(
                (a, v) => a + (typeof v === "number" ? v : 0),
                0,
              );
```

to:

```typescript
        {FILTER_OPTIONS.map((f) => {
          const count = f.value
            ? (status?.[f.value as keyof PipelineMonitorStatus] as number ?? 0)
            : Object.entries(status ?? {}).reduce(
                (a, [k, v]) => a + (typeof v === "number" && k !== "job_failures" ? v : 0),
                0,
              );
```

Note: The "All" count excludes `job_failures` since those tracks overlap with other statuses (they're `available`, `candidate`, etc.).

Also update the filter button `onClick` to use the `FilterValue` type (line 690):

Change:

```typescript
              onClick={() => {
                setStatusFilter(f.value as AcquisitionStatus | "");
                setPage(1);
              }}
```

to:

```typescript
              onClick={() => {
                setStatusFilter(f.value as FilterValue);
                setPage(1);
              }}
```

- [ ] **Step 8: Add "Retry All Failed Jobs" bulk action**

Add a new bulk action button in the bulk action toolbar (around line 718). After the existing `failedCount > 0` block and before the candidates block, add:

```typescript
          {(status?.job_failures ?? 0) > 0 && (
            <BulkBtn
              label={`Retry All Failed Jobs (${status?.job_failures ?? 0})`}
              color="var(--led-orange)"
              onClick={() => setConfirmAction("retry_failed_jobs")}
            />
          )}
```

Update the `BulkAction` type (line 159) to include the new action:

Change:

```typescript
type BulkAction =
  | "retry_failed"
  | "delete_failed"
  | "delete_candidates"
  | "pause_candidates"
  | "resume_paused"
  | "queue_candidates"
  | "delete_selected";
```

to:

```typescript
type BulkAction =
  | "retry_failed"
  | "delete_failed"
  | "delete_candidates"
  | "pause_candidates"
  | "resume_paused"
  | "queue_candidates"
  | "delete_selected"
  | "retry_failed_jobs";
```

Add the confirm label for the new action. In `CONFIRM_LABELS` (line 489), add after the `delete_selected` entry:

```typescript
    retry_failed_jobs: {
      title: "Retry All Failed Jobs",
      desc: `Retry all ${status?.job_failures ?? 0} tracks with failed pipeline jobs?`,
      btn: "Retry All",
      color: "var(--led-orange)",
    },
```

Update `handleBulkAction` (line 537) to handle the new action. Add a special case before the existing `bulkPipelineAction` call:

Change:

```typescript
  async function handleBulkAction(action: BulkAction) {
    setBulkActing(true);
    try {
      const result = await bulkPipelineAction(action);
```

to:

```typescript
  async function handleBulkAction(action: BulkAction) {
    setBulkActing(true);
    try {
      if (action === "retry_failed_jobs") {
        const result = await retryPipelineJobs({ filter_status: "failed" });
        toast.success(`${result.retried} job${result.retried !== 1 ? "s" : ""} retried`);
        loadStatus();
        loadTracks();
        setBulkActing(false);
        setConfirmAction(null);
        return;
      }
      const result = await bulkPipelineAction(action);
```

Also add to the `verbs` map (line 543):

```typescript
        retry_failed_jobs: "retried",
```

- [ ] **Step 9: Add job failures table rendering**

In the track table body section (around lines 1183-1253), add an alternate rendering path for when `statusFilter === "job_failures"`. Insert this **before** the existing `loading && !trackData` check:

Change:

```typescript
        {/* Table body */}
        {loading && !trackData ? (
```

to:

```typescript
        {/* Table body */}
        {statusFilter === "job_failures" ? (
          loading && !jobFailuresData ? (
            <div style={{ padding: "40px 20px", textAlign: "center" }}>
              <span className="font-mono" style={{ fontSize: 13, color: "var(--hw-text-dim)" }}>
                Loading...
              </span>
            </div>
          ) : !jobFailuresData || jobFailuresData.tracks.length === 0 ? (
            <div style={{ padding: "40px 20px", textAlign: "center" }}>
              <span style={{ fontSize: 14, color: "var(--hw-text-dim)" }}>
                No job failures found.
              </span>
            </div>
          ) : (
            jobFailuresData.tracks.map((track) => (
              <JobFailureRow
                key={track.id}
                track={track}
                onRetryJob={async (jobId) => {
                  try {
                    await retryPipelineJobs({ job_ids: [jobId] });
                    toast.success("Job queued for retry");
                    loadStatus();
                    loadTracks();
                  } catch {
                    toast.error("Retry failed");
                  }
                }}
                onExpand={() => handleExpand(track.id)}
                isExpanded={expandedTrackId === track.id}
                expandedJobs={expandedTrackId === track.id ? expandedJobs : null}
                expandedLoading={expandedTrackId === track.id && expandedLoading}
              />
            ))
          )
        ) : loading && !trackData ? (
```

- [ ] **Step 10: Update pagination to work with both data sources**

Update the `totalPages` derived value (line 576) to account for both data sources:

Change:

```typescript
  const totalPages = trackData
    ? Math.ceil(trackData.total / trackData.per_page)
    : 0;
```

to:

```typescript
  const activeData = statusFilter === "job_failures" ? jobFailuresData : trackData;
  const totalPages = activeData
    ? Math.ceil(activeData.total / activeData.per_page)
    : 0;
```

Update the pagination display (line 1263) to use `activeData`:

Change:

```typescript
      {trackData && totalPages > 0 && (
```

to:

```typescript
      {activeData && totalPages > 0 && (
```

And in the page display (line 1263):

Change:

```typescript
            Page {trackData.page} of {totalPages} ({trackData.total} tracks)
```

to:

```typescript
            Page {activeData.page} of {totalPages} ({activeData.total} tracks)
```

- [ ] **Step 11: Add the `JobFailureRow` component**

Add a new component at the bottom of the file, after the existing `TrackRow` component (after line ~1600 or wherever `TrackRow` ends):

```typescript
/* ── JobFailureRow ───────────────────────────────────────────────────────── */

function JobFailureRow({
  track,
  onRetryJob,
  onExpand,
  isExpanded,
  expandedJobs,
  expandedLoading,
}: {
  track: TrackWithFailedJobs;
  onRetryJob: (jobId: string) => void;
  onExpand: () => void;
  isExpanded: boolean;
  expandedJobs: PipelineJob[] | null;
  expandedLoading: boolean;
}) {
  return (
    <div>
      <div
        className="grid items-center gap-3 px-4 py-2.5 cursor-pointer"
        style={{
          gridTemplateColumns: "44px 1fr 120px 1fr 80px",
          borderBottom: "1px solid var(--hw-list-border, var(--hw-border))",
          background: isExpanded
            ? "color-mix(in srgb, var(--led-red) 3%, var(--hw-list-row-bg, var(--hw-surface)))"
            : "var(--hw-list-row-bg, var(--hw-surface))",
        }}
        onClick={onExpand}
      >
        {/* Artwork */}
        <div
          style={{
            width: 36,
            height: 36,
            borderRadius: 4,
            overflow: "hidden",
            background: "var(--hw-surface)",
            border: "1px solid var(--hw-border)",
            flexShrink: 0,
          }}
        >
          {track.artwork_url ? (
            <img
              src={track.artwork_url}
              alt=""
              style={{ width: "100%", height: "100%", objectFit: "cover" }}
            />
          ) : (
            <div
              style={{
                width: "100%",
                height: "100%",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 14,
                color: "var(--hw-text-muted)",
              }}
            >
              ♪
            </div>
          )}
        </div>

        {/* Track info */}
        <div className="min-w-0">
          <div
            className="font-mono truncate"
            style={{ fontSize: 13, fontWeight: 600, color: "var(--hw-text)" }}
          >
            {track.title || "Unknown Title"}
          </div>
          <div
            className="font-mono truncate"
            style={{ fontSize: 11, color: "var(--hw-text-dim)" }}
          >
            {track.artist || "Unknown Artist"}
          </div>
        </div>

        {/* Track status badge */}
        <StatusBadge status={track.acquisition_status} />

        {/* Failed job pills */}
        <div className="flex flex-wrap gap-1.5">
          {track.failed_jobs.map((job) => (
            <span
              key={job.id}
              className="font-mono inline-flex items-center gap-1"
              style={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: 0.3,
                color: "var(--led-red)",
                background: "color-mix(in srgb, var(--led-red) 8%, transparent)",
                border: "1px solid color-mix(in srgb, var(--led-red) 25%, transparent)",
                padding: "2px 8px",
                borderRadius: 3,
              }}
              title={job.error ?? "Unknown error"}
            >
              {job.job_type.replace("_", " ")}
            </span>
          ))}
        </div>

        {/* Retry all jobs for this track */}
        <div className="flex gap-1">
          {track.failed_jobs.map((job) => (
            <button
              key={job.id}
              onClick={(e) => {
                e.stopPropagation();
                onRetryJob(job.id);
              }}
              className="font-mono"
              title={`Retry ${job.job_type}`}
              style={{
                fontSize: 10,
                padding: "3px 8px",
                borderRadius: 3,
                border: "1px solid color-mix(in srgb, var(--led-orange) 40%, transparent)",
                background: "color-mix(in srgb, var(--led-orange) 8%, transparent)",
                color: "var(--led-orange)",
                cursor: "pointer",
              }}
            >
              ↻
            </button>
          ))}
        </div>
      </div>

      {/* Expansion panel — reuse existing job chain strip */}
      {isExpanded && (
        <div
          style={{
            borderBottom: "1px solid var(--hw-list-border, var(--hw-border))",
            background: "color-mix(in srgb, var(--led-red) 3%, var(--hw-list-row-bg, var(--hw-surface)))",
            padding: "10px 16px 10px 60px",
          }}
        >
          {expandedLoading ? (
            <span className="font-mono" style={{ fontSize: 11, color: "var(--hw-text-muted)" }}>
              Loading job history...
            </span>
          ) : expandedJobs ? (
            <div className="space-y-2">
              {expandedJobs
                .filter((j) => j.status === "failed")
                .map((job) => (
                  <div
                    key={job.id}
                    className="flex items-start gap-3 font-mono"
                    style={{ fontSize: 11 }}
                  >
                    <span
                      style={{
                        color: "var(--led-red)",
                        fontWeight: 700,
                        minWidth: 100,
                      }}
                    >
                      {job.job_type}
                    </span>
                    <span style={{ color: "var(--hw-text-dim)", flex: 1 }}>
                      {job.error ?? "Unknown error"}
                    </span>
                    <span style={{ color: "var(--hw-text-muted)", fontSize: 10 }}>
                      {job.completed_at ? relativeTime(job.completed_at) : ""}
                    </span>
                    <button
                      onClick={() => onRetryJob(job.id)}
                      className="font-mono"
                      style={{
                        fontSize: 10,
                        padding: "2px 8px",
                        borderRadius: 3,
                        border: "1px solid color-mix(in srgb, var(--led-orange) 40%, transparent)",
                        background: "color-mix(in srgb, var(--led-orange) 8%, transparent)",
                        color: "var(--led-orange)",
                        cursor: "pointer",
                      }}
                    >
                      Retry
                    </button>
                  </div>
                ))}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 12: Verify the full flow in the browser**

```bash
cd web && npm run dev
```

1. Open `/pipeline` — verify the new "Job Failures" LCD counter and filter button appear
2. Click "Job Failures" filter — verify it shows tracks with failed jobs (or "No job failures found" if none)
3. If failures exist, verify the red job-type pills render with correct labels
4. Click expand on a row — verify error details show
5. Click individual retry button — verify toast + data refresh
6. Click "Retry All Failed Jobs" bulk button — verify confirm dialog + retry
7. Visit `/pipeline?filter=job_failures` directly — verify the filter is pre-selected

- [ ] **Step 13: Commit**

```bash
git add web/app/\\(app\\)/pipeline/page.tsx
git commit -m "feat(ui): add Job Failures filter with per-job retry to Pipeline Monitor"
```
