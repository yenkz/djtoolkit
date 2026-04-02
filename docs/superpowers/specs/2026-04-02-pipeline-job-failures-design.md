# Pipeline Job Failures Visibility

**Date:** 2026-04-02
**Status:** Approved

## Problem

When a pipeline batch completes, the notification reports failed job counts from `pipeline_jobs` (e.g. "737 tracks processed, 14 failed"). But the Pipeline Monitor UI only shows tracks filtered by `tracks.acquisition_status` — and only download jobs that exceed max retries update `acquisition_status` to `failed`. Post-download job failures (cover_art, audio_analysis, metadata, fingerprint, spotify_lookup) are invisible in the UI.

## Solution

Add a "Job Failures" filter to the existing Pipeline Monitor that queries `pipeline_jobs` directly, showing tracks grouped with their failed jobs. Include per-job retry, bulk retry, and a deep-link from the batch_complete notification.

## Design

### 1. New API endpoint

**`GET /api/pipeline/tracks/with-failed-jobs`**

Queries `pipeline_jobs` where `status = 'failed'`, groups by `track_id`, returns track rows enriched with a `failed_jobs` array. Supports pagination and search (by title/artist).

Steps:
1. Fetch distinct `track_id`s from `pipeline_jobs WHERE status='failed' AND user_id=:uid` with count for pagination
2. Batch-fetch track metadata for the page of track IDs
3. Batch-fetch all failed jobs for those track IDs
4. Merge and return

Response shape:

```json
{
  "tracks": [
    {
      "id": 123,
      "title": "Track Name",
      "artist": "Artist Name",
      "album": "Album",
      "artwork_url": "https://...",
      "acquisition_status": "available",
      "failed_jobs": [
        { "id": "uuid", "job_type": "cover_art", "error": "404 Not Found", "completed_at": "2026-04-02T..." },
        { "id": "uuid", "job_type": "audio_analysis", "error": "librosa timeout", "completed_at": "2026-04-02T..." }
      ]
    }
  ],
  "total": 14,
  "page": 1,
  "per_page": 25
}
```

### 2. Updated `pipeline_status` RPC + LCD bar

Add a `job_failures` count to the existing `pipeline_status` RPC — count of distinct `track_id`s with failed jobs:

```sql
'job_failures', (
  SELECT count(DISTINCT track_id)
  FROM pipeline_jobs
  WHERE user_id = p_user_id
    AND status = 'failed'
)
```

This powers:
- A new **"Job Failures"** LCD counter in the stat bar (8th counter, after Paused), using red LED color
- The count displayed on the new filter button

The `PipelineMonitorStatus` TypeScript interface gains a `job_failures: number` field.

### 3. Frontend filter + table behavior

**Filter bar:** New `"job_failures"` filter option after "Failed". Label: "Job Failures".

When selected:
- Track list switches from `fetchPipelineTracks` to a new `fetchTracksWithFailedJobs` client function
- Each track row shows track info (artwork, title, artist, album) with the `acquisition_status` badge, plus **red pills** for each failed job type (e.g. "cover_art", "audio_analysis")
- Expanding a row shows failed job details (error message, timestamp) using the existing expand/detail pattern

**Actions:**
- **Per-job retry:** Each failed job gets a retry button. Calls existing `retryPipelineJobs({ job_ids: [jobId] })`.
- **Bulk "Retry All Failed Jobs":** Button in the bulk actions toolbar when `job_failures > 0`. Calls existing `retryPipelineJobs({ filter_status: 'failed' })`.

No new components — reuses existing expand/detail/retry patterns.

### 4. Notification deep-link

Update the `batch_complete` notification trigger to set `url: '/pipeline?filter=job_failures'` when `_failed_count > 0` (otherwise `'/pipeline'`).

The pipeline page reads the `filter` query param on mount and initializes `statusFilter` accordingly.

## Changes by file

| Layer | File | Change |
|---|---|---|
| DB | New migration | Add `job_failures` to `pipeline_status` RPC |
| DB | New migration | Update `batch_complete` notification URL to deep-link |
| API | `web/app/api/pipeline/tracks/with-failed-jobs/route.ts` (new) | Tracks-with-failed-jobs endpoint |
| API | `web/app/api/pipeline/status/route.ts` | Pass through `job_failures` from RPC |
| Client | `web/lib/api.ts` | Add `fetchTracksWithFailedJobs`, update `PipelineMonitorStatus` type |
| UI | `web/app/(app)/pipeline/page.tsx` | Filter option, LCD counter, conditional data source, failed-job pills, bulk retry button, query param init |

## Not changing

- No new UI components — reuse existing expand/detail/retry patterns
- No changes to the job retry API — already supports `job_ids` and `filter_status`
- No changes to `tracks` table schema or `acquisition_status` logic
