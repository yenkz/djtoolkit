# Pipeline Track Activity Log

**Date:** 2026-03-22
**Status:** Approved

## Problem

After queuing downloads and other pipeline jobs, users have no way to see what happened to a specific track — which jobs ran, what succeeded, what failed, and why. The data exists in `pipeline_jobs` but is not surfaced in the UI.

## Solution

Add per-track job history visibility to the Pipeline Monitor via two complementary views:
1. **Expandable row** — click a track to see a compact job chain strip inline
2. **Detail panel** — slide-out panel with full job timeline, errors, and track flags

## Approach

**Inline API call (no schema changes).** Extend the existing `/api/pipeline/jobs/history` endpoint with a `track_id` filter. Both views fetch on-demand when the user clicks a track. No denormalization or migration needed — queries existing `pipeline_jobs` table.

---

## API Changes

### Extend `GET /api/pipeline/jobs/history`

Add optional `track_id` query parameter. When provided:
- Filter jobs to `track_id = :track_id`
- **Override sort order** to `created_at ASC` (chronological, oldest first). Without `track_id`, keep the existing `created_at DESC` default for the general history view.
- Default `per_page` remains 50 (sufficient — a track rarely has more than ~10 jobs, though retried tracks can accumulate ~20-30)

No changes to the response shape — same fields already returned:

```ts
{
  jobs: [{
    id: string,
    job_type: string,        // download | fingerprint | cover_art | spotify_lookup | audio_analysis | metadata
    status: string,          // pending | claimed | running | done | failed
    error: string | null,
    retry_count: number,
    payload: object | null,
    result: object | null,
    claimed_at: string | null,
    completed_at: string | null,
    created_at: string,
    track_title: string | null,
    track_artist: string | null,
    track_artwork_url: string | null,
    track_album: string | null,
  }],
  total: number,
  page: number,
  per_page: number,
}
```

### API client function

```ts
// New function in web/lib/api.ts
export async function fetchTrackJobs(trackId: number): Promise<PipelineJobList> {
  const res = await apiClient(`/pipeline/jobs/history?track_id=${trackId}&per_page=100`);
  if (!res.ok) throw new Error("Failed to fetch track jobs");
  return res.json();
}
```

Uses the existing `PipelineJob` interface (already defined in api.ts for the history endpoint).

---

## UI: Expandable Row (Quick Glance)

### Interaction

- Clicking the **track info area** (title/artist cell) in the Pipeline Monitor toggles an expansion panel below it. Interactive elements (checkbox, buttons, search query input) retain their own click handlers via `stopPropagation`.
- Only one row can be expanded at a time (expanding another collapses the previous)
- On expand: fetch jobs via `fetchTrackJobs(track.id)`, show a brief loading spinner
- On collapse: clear fetched data

### Layout

A horizontal job chain strip rendered below the track row, inside the same table container:

```
[download: done] → [fingerprint: done] → [cover_art: failed "No art found"] → [metadata: —]     [View details →]
```

### Job chain pills

The pill chain is **source-aware** — it only shows job types relevant to the track's pipeline chain:

- **Exportify tracks** (`source = 'exportify'`): `download → fingerprint → cover_art → metadata`
- **Other tracks** (folder, trackid, etc.): `download → fingerprint → spotify_lookup → cover_art → audio_analysis → metadata`

The track's `source` field is not currently returned by the pipeline tracks API. Add `source` to the selected columns in `GET /api/pipeline/tracks` so the chain strip knows which pills to render.

Each pill's status:

- **done** — green pill, shows job type name
- **failed** — red pill, shows job type + error truncated to ~40 chars
- **pending / claimed / running** — blue pill (running gets pulse animation)
- **not created** — gray dashed outline pill with "—", indicating the pipeline hasn't reached this step yet

If multiple jobs of the same type exist (retries), show only the latest one's status.

### "View details" link

Right-aligned link/button that opens the detail panel for this track.

---

## UI: Detail Panel (Full Log)

### Layout

Slide-out panel from the right side of the screen, similar to the existing `DetailPanel` component in the Catalog page. Width ~380px. Overlay with close button.

### Sections

#### 1. Track Header

- Artwork thumbnail (or initials placeholder)
- Title, artist, album
- Current `acquisition_status` displayed using the pipeline-local `StatusBadge` function (defined in `pipeline/page.tsx`), which handles pipeline-specific statuses like `searching`, `found`, `not_found`, `queued`. Extract it to a shared component or import from the pipeline page.

#### 2. Job Timeline

Vertical timeline, each entry is a card/block. Ordered chronologically (oldest first). For each job:

| Field | Display |
|-------|---------|
| Job type | Bold label (e.g., "Download", "Fingerprint") |
| Status | Colored badge (reuse `StatusBadge` or similar) |
| Created | Relative time (e.g., "2h ago") |
| Claimed | Relative time, or "—" if not claimed |
| Completed | Relative time, or "—" if not completed |
| Error | Full error message in red text (only if failed) |
| Retry count | "Retry 2/3" label (only if retry_count > 0) |
| Payload summary | Key info extracted per job type (see below) |
| Result summary | Key info extracted per job type (see below) |

**Payload summaries by job type:**
- `download`: search_string
- `fingerprint`: (none — no meaningful payload to show)
- `spotify_lookup`: (none)
- `cover_art`: (none)
- `audio_analysis`: (none)
- `metadata`: metadata_source

**Result summaries by job type:**
- `download`: local_path (truncated filename only)
- `fingerprint`: acoustid match or "No match"
- `spotify_lookup`: "Matched" / "No match"
- `cover_art`: "Embedded" / "Not found"
- `audio_analysis`: tempo, key, loudness (one-liner)
- `metadata`: "Written" / filename if renamed

#### 3. Track Processing Flags

Grid of boolean flags with colored dots:

| Flag | Label |
|------|-------|
| fingerprinted | Fingerprinted |
| enriched_spotify | Spotify Enriched |
| enriched_audio | Audio Analyzed |
| metadata_written | Metadata Written |
| cover_art_written | Cover Art |
| in_library | In Library |

Green dot = true, gray dot = false.

This section requires the track's processing flags, which are NOT returned by the pipeline tracks API currently. Options:
- Fetch from `/api/catalog/tracks?id=<trackId>` (existing endpoint, already returns all flags)
- Or add flags to the pipeline tracks API response

Use the catalog tracks endpoint — it already returns everything needed, and this is an on-demand fetch for a single track.

**Data source clarification:** The detail panel header (title, artist, status) should use the `PipelineTrack` already loaded from the row — no extra fetch needed. Only the processing flags grid requires the catalog endpoint fetch, since `PipelineTrack` doesn't include boolean flags.

---

## Component Structure

### New components

| Component | Location | Purpose |
|-----------|----------|---------|
| `JobChainStrip` | `web/components/ui/JobChainStrip.tsx` | Horizontal pill chain for expandable row |
| `PipelineDetailPanel` | `web/components/ui/PipelineDetailPanel.tsx` | Slide-out panel with full job timeline |
| `JobTimelineEntry` | `web/components/ui/PipelineDetailPanel.tsx` | Single job entry in the timeline (internal) |
| `TrackFlagGrid` | `web/components/ui/PipelineDetailPanel.tsx` | Boolean flag grid (internal) |

### Modified files

| File | Change |
|------|--------|
| `web/app/api/pipeline/jobs/history/route.ts` | Add `track_id` query param filter, conditional ASC sort |
| `web/app/api/pipeline/tracks/route.ts` | Add `source` to selected columns |
| `web/lib/api.ts` | Add `fetchTrackJobs()`, `PipelineJobList` type, `source` to `PipelineTrack` |
| `web/app/(app)/pipeline/page.tsx` | Add expand/collapse state, render `JobChainStrip` and `PipelineDetailPanel` |

---

## State Management (Pipeline Page)

```ts
const [expandedTrackId, setExpandedTrackId] = useState<number | null>(null);
const [expandedJobs, setExpandedJobs] = useState<PipelineJob[] | null>(null);
const [expandedLoading, setExpandedLoading] = useState(false);
const [detailTrackId, setDetailTrackId] = useState<number | null>(null);
```

- `expandedTrackId` — which row is expanded (null = none)
- `expandedJobs` — fetched jobs for the expanded row
- `detailTrackId` — which track's detail panel is open (null = closed)

Clicking the track info area toggles `expandedTrackId`. If expanding, fetch jobs. The "View details" link sets `detailTrackId`. The detail panel reuses `expandedJobs` when `detailTrackId === expandedTrackId`; otherwise it fetches independently. On fetch failure, show a `toast.error()` and collapse the row.

---

## Styling

Follow the existing Pipeline Monitor design language:
- LED-style status colors: green (done), red (failed), blue (pending/running), orange (claimed), gray (not created)
- Mono font for data, sans for labels
- Dark surface backgrounds with subtle borders
- Pulse animation for running jobs (reuse existing `led-pulse` keyframes)

---

## Out of Scope

- Real-time updates to the expanded row (user can collapse/re-expand to refresh)
- Editing job data from the detail panel
- Filtering/searching within the job timeline
- `started_at` timestamp (column exists in DB but is never set by the agent)
