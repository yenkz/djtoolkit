# Pipeline Track Activity Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface per-track job history in the Pipeline Monitor via expandable rows (job chain strip) and a slide-out detail panel.

**Architecture:** Extend the existing `/api/pipeline/jobs/history` endpoint with a `track_id` filter. Two new UI components (`JobChainStrip`, `PipelineDetailPanel`) fetch job data on-demand when a track is clicked. No schema changes — queries existing `pipeline_jobs` table.

**Tech Stack:** Next.js (React), TypeScript, Supabase JS client, existing design system (LED colors, mono font)

**Spec:** `docs/superpowers/specs/2026-03-22-pipeline-track-activity-log-design.md`

---

## File Structure

### New files
| File | Responsibility |
|------|---------------|
| `web/components/ui/JobChainStrip.tsx` | Horizontal pill chain showing job type + status for expandable row |
| `web/components/ui/PipelineDetailPanel.tsx` | Slide-out panel with track header, job timeline, and processing flags |

### Modified files
| File | Change |
|------|--------|
| `web/app/api/pipeline/jobs/history/route.ts` | Add `track_id` filter, conditional ASC sort |
| `web/app/api/pipeline/tracks/route.ts` | Add `source` to selected columns |
| `web/lib/api.ts` | Add `fetchTrackJobs()`, `source` to `PipelineTrack` |
| `web/app/(app)/pipeline/page.tsx` | Expand/collapse state, render new components, wire up TrackRow |

---

### Task 1: API — Add `track_id` filter to job history endpoint

**Files:**
- Modify: `web/app/api/pipeline/jobs/history/route.ts`

- [ ] **Step 1: Add `track_id` query param parsing**

In `web/app/api/pipeline/jobs/history/route.ts`, after the existing `jobTypeFilter` parsing (around line 23), add:

```typescript
const trackIdParam = searchParams.get("track_id");
const trackId = trackIdParam ? parseInt(trackIdParam, 10) : null;
```

- [ ] **Step 2: Apply `track_id` filter to BOTH countQuery and dataQuery**

After the existing status/job_type filter blocks (after line 50), add the `track_id` filter to both queries:

```typescript
if (trackId && !isNaN(trackId)) {
  countQuery = countQuery.eq("track_id", trackId);
  dataQuery = dataQuery.eq("track_id", trackId);
}
```

- [ ] **Step 3: Conditional sort order**

The `.order("created_at", { ascending: false })` is currently chained in the `dataQuery` builder at line 40. Replace it so the sort direction depends on whether `track_id` is provided. Move the `.order()` after the filter blocks (after the new `track_id` filter), and remove it from line 40. The modified `dataQuery` builder and sort:

```typescript
// Line 34-41: remove .order() from the chain
let dataQuery = supabase
  .from("pipeline_jobs")
  .select(
    "id, job_type, status, track_id, payload, result, error, retry_count, claimed_at, completed_at, created_at"
  )
  .eq("user_id", user.userId)
  .range((page - 1) * perPage, page * perPage - 1);

// After all filters are applied:
// When fetching for a specific track, show chronological order (oldest first)
// For general history, show newest first
dataQuery = dataQuery.order("created_at", { ascending: !!trackId });
```

- [ ] **Step 4: Verify manually**

Start the dev server (`cd web && npm run dev`), then test:
```bash
# Existing behavior unchanged (newest first)
curl -s 'http://localhost:3000/api/pipeline/jobs/history?per_page=2' | jq '.jobs | length'

# New: filter by track_id (oldest first)
curl -s 'http://localhost:3000/api/pipeline/jobs/history?track_id=1&per_page=100' | jq '.jobs[0].created_at'
```

- [ ] **Step 5: Commit**

```bash
git add web/app/api/pipeline/jobs/history/route.ts
git commit -m "feat(api): add track_id filter to pipeline job history endpoint"
```

---

### Task 2: API — Add `source` to pipeline tracks endpoint

**Files:**
- Modify: `web/app/api/pipeline/tracks/route.ts:26-30`
- Modify: `web/lib/api.ts:286-297`

- [ ] **Step 1: Add `source` to API columns**

In `web/app/api/pipeline/tracks/route.ts`, update the `columns` array (line 28) to include `"source"`:

```typescript
const columns = [
  "id", "title", "artist", "album", "artwork_url",
  "acquisition_status", "search_string", "search_results_count", "source",
  "created_at", "updated_at",
].join(",");
```

- [ ] **Step 2: Add `source` to `PipelineTrack` interface**

In `web/lib/api.ts`, add `source` to the `PipelineTrack` interface (after line 294):

```typescript
export interface PipelineTrack {
  id: number;
  title: string;
  artist: string;
  album: string | null;
  artwork_url: string | null;
  acquisition_status: AcquisitionStatus;
  search_string: string | null;
  search_results_count: number | null;
  source: string | null;
  created_at: string;
  updated_at: string;
}
```

- [ ] **Step 3: Commit**

```bash
git add web/app/api/pipeline/tracks/route.ts web/lib/api.ts
git commit -m "feat(api): add source field to pipeline tracks endpoint"
```

---

### Task 3: API client — Add `fetchTrackJobs` function

**Files:**
- Modify: `web/lib/api.ts`

- [ ] **Step 1: Add `fetchTrackJobs` function**

In `web/lib/api.ts`, after the existing `fetchPipelineJobs` function (around line 259), add:

```typescript
export async function fetchTrackJobs(trackId: number): Promise<PipelineJobList> {
  const res = await apiClient(`/pipeline/jobs/history?track_id=${trackId}&per_page=100`);
  if (!res.ok) throw new Error("Failed to fetch track jobs");
  return res.json();
}
```

- [ ] **Step 2: TypeScript check**

```bash
cd web && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add web/lib/api.ts
git commit -m "feat(api): add fetchTrackJobs client function"
```

---

### Task 4: UI — Create `JobChainStrip` component

**Files:**
- Create: `web/components/ui/JobChainStrip.tsx`

- [ ] **Step 1: Create the component file**

Create `web/components/ui/JobChainStrip.tsx`:

```tsx
"use client";

import { type PipelineJob } from "@/lib/api";

const EXPORTIFY_CHAIN = ["download", "fingerprint", "cover_art", "metadata"];
const DEFAULT_CHAIN = ["download", "fingerprint", "spotify_lookup", "cover_art", "audio_analysis", "metadata"];

const JOB_LABELS: Record<string, string> = {
  download: "Download",
  fingerprint: "Fingerprint",
  spotify_lookup: "Spotify",
  cover_art: "Cover Art",
  audio_analysis: "Analysis",
  metadata: "Metadata",
};

const STATUS_COLORS: Record<string, { color: string; bg: string; border: string; pulse?: boolean }> = {
  done: { color: "var(--led-green)", bg: "color-mix(in srgb, var(--led-green) 10%, transparent)", border: "color-mix(in srgb, var(--led-green) 30%, transparent)" },
  failed: { color: "var(--led-red)", bg: "color-mix(in srgb, var(--led-red) 10%, transparent)", border: "color-mix(in srgb, var(--led-red) 30%, transparent)" },
  pending: { color: "var(--led-blue)", bg: "color-mix(in srgb, var(--led-blue) 10%, transparent)", border: "color-mix(in srgb, var(--led-blue) 30%, transparent)" },
  claimed: { color: "var(--led-orange)", bg: "color-mix(in srgb, var(--led-orange) 10%, transparent)", border: "color-mix(in srgb, var(--led-orange) 30%, transparent)" },
  running: { color: "var(--led-blue)", bg: "color-mix(in srgb, var(--led-blue) 10%, transparent)", border: "color-mix(in srgb, var(--led-blue) 30%, transparent)", pulse: true },
  none: { color: "var(--hw-text-muted)", bg: "transparent", border: "var(--hw-border)" },
};

interface JobChainStripProps {
  jobs: PipelineJob[];
  source: string | null;
  onViewDetails: () => void;
}

export default function JobChainStrip({ jobs, source, onViewDetails }: JobChainStripProps) {
  const chain = source === "exportify" ? EXPORTIFY_CHAIN : DEFAULT_CHAIN;

  // For each job type, find the latest job (highest created_at)
  const latestByType = new Map<string, PipelineJob>();
  for (const job of jobs) {
    const existing = latestByType.get(job.job_type);
    if (!existing || job.created_at > existing.created_at) {
      latestByType.set(job.job_type, job);
    }
  }

  return (
    <div
      className="flex items-center gap-2 flex-wrap"
      style={{ padding: "10px 16px 10px 88px" }}
    >
      {chain.map((type, i) => {
        const job = latestByType.get(type);
        const status = job?.status ?? "none";
        const colors = STATUS_COLORS[status] ?? STATUS_COLORS.none;
        const label = JOB_LABELS[type] ?? type;
        const errorSnippet =
          status === "failed" && job?.error
            ? `: ${job.error.length > 40 ? job.error.slice(0, 40) + "…" : job.error}`
            : "";

        return (
          <span key={type} className="inline-flex items-center gap-1.5">
            {i > 0 && (
              <span
                className="font-mono"
                style={{ fontSize: 10, color: "var(--hw-text-muted)", marginRight: 2 }}
              >
                →
              </span>
            )}
            <span
              className="font-mono inline-flex items-center gap-1"
              style={{
                fontSize: 10,
                fontWeight: 600,
                color: colors.color,
                background: colors.bg,
                border: status === "none"
                  ? `1px dashed ${colors.border}`
                  : `1px solid ${colors.border}`,
                padding: "2px 8px",
                borderRadius: 3,
                whiteSpace: "nowrap",
              }}
            >
              <span
                style={{
                  width: 5,
                  height: 5,
                  borderRadius: "50%",
                  background: colors.color,
                  ...(colors.pulse ? { animation: "led-pulse 1.5s infinite" } : {}),
                }}
              />
              {status === "none" ? "—" : label}
              {errorSnippet && (
                <span style={{ fontWeight: 400, opacity: 0.8 }}>{errorSnippet}</span>
              )}
            </span>
          </span>
        );
      })}

      <button
        onClick={(e) => {
          e.stopPropagation();
          onViewDetails();
        }}
        className="font-mono"
        style={{
          fontSize: 10,
          fontWeight: 600,
          color: "var(--led-blue)",
          background: "none",
          border: "none",
          cursor: "pointer",
          marginLeft: "auto",
          padding: "2px 6px",
        }}
      >
        View details →
      </button>
    </div>
  );
}
```

- [ ] **Step 2: TypeScript check**

```bash
cd web && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add web/components/ui/JobChainStrip.tsx
git commit -m "feat(ui): add JobChainStrip component for expandable pipeline rows"
```

---

### Task 5: UI — Create `PipelineDetailPanel` component

**Files:**
- Create: `web/components/ui/PipelineDetailPanel.tsx`

- [ ] **Step 1: Create the component file**

Create `web/components/ui/PipelineDetailPanel.tsx`:

```tsx
"use client";

import { useEffect, useState, useCallback } from "react";
import { type PipelineJob, type PipelineTrack, fetchTracksByIds } from "@/lib/api";

/* ── Status colors (same as pipeline page) ─────────────────────────────── */

const JOB_STATUS_COLORS: Record<string, { color: string; bg: string }> = {
  done: { color: "var(--led-green)", bg: "color-mix(in srgb, var(--led-green) 10%, transparent)" },
  failed: { color: "var(--led-red)", bg: "color-mix(in srgb, var(--led-red) 10%, transparent)" },
  pending: { color: "var(--led-blue)", bg: "color-mix(in srgb, var(--led-blue) 10%, transparent)" },
  claimed: { color: "var(--led-orange)", bg: "color-mix(in srgb, var(--led-orange) 10%, transparent)" },
  running: { color: "var(--led-blue)", bg: "color-mix(in srgb, var(--led-blue) 10%, transparent)" },
};

const JOB_LABELS: Record<string, string> = {
  download: "Download",
  fingerprint: "Fingerprint",
  spotify_lookup: "Spotify Lookup",
  cover_art: "Cover Art",
  audio_analysis: "Audio Analysis",
  metadata: "Metadata",
};

/* ── Helpers ────────────────────────────────────────────────────────────── */

function relativeTime(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function payloadSummary(job: PipelineJob): string | null {
  if (!job.payload) return null;
  const p = job.payload as Record<string, unknown>;
  if (job.job_type === "download" && p.search_string) return `"${p.search_string}"`;
  if (job.job_type === "metadata" && p.metadata_source) return `source: ${p.metadata_source}`;
  return null;
}

function resultSummary(job: PipelineJob): string | null {
  if (!job.result) return null;
  const r = job.result as Record<string, unknown>;
  if (job.job_type === "download" && r.local_path) {
    const path = String(r.local_path);
    return path.split("/").pop() ?? path;
  }
  if (job.job_type === "fingerprint") {
    return r.acoustid ? `AcoustID: ${r.acoustid}` : "No match";
  }
  if (job.job_type === "spotify_lookup") {
    return (r as Record<string, unknown>).matched === false ? "No match" : "Matched";
  }
  if (job.job_type === "cover_art") {
    return r.cover_art_written ? "Embedded" : "Not found";
  }
  if (job.job_type === "audio_analysis") {
    const parts: string[] = [];
    if (r.tempo) parts.push(`${Math.round(Number(r.tempo))} BPM`);
    if (r.key != null) parts.push(`key: ${r.key}`);
    if (r.loudness != null) parts.push(`${Number(r.loudness).toFixed(1)} LUFS`);
    return parts.join(", ") || null;
  }
  if (job.job_type === "metadata") {
    return r.metadata_written ? "Written" : "Skipped";
  }
  return null;
}

/* ── Track flags grid ──────────────────────────────────────────────────── */

interface TrackFlags {
  fingerprinted: boolean;
  enriched_spotify: boolean;
  enriched_audio: boolean;
  metadata_written: boolean;
  cover_art_written: boolean;
  in_library: boolean;
}

const FLAG_LABELS: { key: keyof TrackFlags; label: string }[] = [
  { key: "fingerprinted", label: "Fingerprinted" },
  { key: "enriched_spotify", label: "Spotify Enriched" },
  { key: "enriched_audio", label: "Audio Analyzed" },
  { key: "metadata_written", label: "Metadata Written" },
  { key: "cover_art_written", label: "Cover Art" },
  { key: "in_library", label: "In Library" },
];

function TrackFlagGrid({ flags }: { flags: TrackFlags | null }) {
  if (!flags) return null;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
      {FLAG_LABELS.map(({ key, label }) => (
        <div key={key} className="flex items-center gap-2">
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: flags[key] ? "var(--led-green)" : "var(--hw-text-muted)",
              opacity: flags[key] ? 1 : 0.3,
            }}
          />
          <span
            className="font-mono"
            style={{ fontSize: 10, color: flags[key] ? "var(--hw-text)" : "var(--hw-text-muted)" }}
          >
            {label}
          </span>
        </div>
      ))}
    </div>
  );
}

/* ── Job timeline entry ────────────────────────────────────────────────── */

function JobTimelineEntry({ job }: { job: PipelineJob }) {
  const colors = JOB_STATUS_COLORS[job.status] ?? JOB_STATUS_COLORS.pending;
  const label = JOB_LABELS[job.job_type] ?? job.job_type;
  const payload = payloadSummary(job);
  const result = resultSummary(job);

  return (
    <div
      style={{
        padding: "10px 12px",
        borderLeft: `3px solid ${colors.color}`,
        background: colors.bg,
        borderRadius: "0 4px 4px 0",
      }}
    >
      {/* Header: type + status */}
      <div className="flex items-center gap-2" style={{ marginBottom: 4 }}>
        <span className="font-mono" style={{ fontSize: 12, fontWeight: 700, color: "var(--hw-text)" }}>
          {label}
        </span>
        <span
          className="font-mono uppercase"
          style={{
            fontSize: 9,
            fontWeight: 700,
            color: colors.color,
            letterSpacing: 0.5,
          }}
        >
          {job.status}
        </span>
        {job.retry_count > 0 && (
          <span className="font-mono" style={{ fontSize: 9, color: "var(--led-orange)" }}>
            retry {job.retry_count}/3
          </span>
        )}
      </div>

      {/* Timestamps */}
      <div className="font-mono" style={{ fontSize: 9, color: "var(--hw-text-muted)", marginBottom: 4 }}>
        created {relativeTime(job.created_at)}
        {job.claimed_at && <> · claimed {relativeTime(job.claimed_at)}</>}
        {job.completed_at && <> · completed {relativeTime(job.completed_at)}</>}
      </div>

      {/* Error */}
      {job.status === "failed" && job.error && (
        <div
          className="font-mono"
          style={{
            fontSize: 10,
            color: "var(--led-red)",
            background: "color-mix(in srgb, var(--led-red) 5%, transparent)",
            padding: "4px 8px",
            borderRadius: 3,
            marginTop: 4,
            wordBreak: "break-word",
          }}
        >
          {job.error}
        </div>
      )}

      {/* Payload summary */}
      {payload && (
        <div className="font-mono" style={{ fontSize: 9, color: "var(--hw-text-dim)", marginTop: 4 }}>
          {payload}
        </div>
      )}

      {/* Result summary */}
      {result && (
        <div className="font-mono" style={{ fontSize: 9, color: "var(--led-green)", marginTop: 2 }}>
          → {result}
        </div>
      )}
    </div>
  );
}

/* ── Main panel ────────────────────────────────────────────────────────── */

interface PipelineDetailPanelProps {
  track: PipelineTrack;
  jobs: PipelineJob[];
  onClose: () => void;
}

export default function PipelineDetailPanel({ track, jobs, onClose }: PipelineDetailPanelProps) {
  const [flags, setFlags] = useState<TrackFlags | null>(null);

  const loadFlags = useCallback(async () => {
    try {
      const tracks = await fetchTracksByIds([track.id]);
      if (tracks.length > 0) {
        const t = tracks[0] as Record<string, unknown>;
        setFlags({
          fingerprinted: !!t.fingerprinted,
          enriched_spotify: !!t.enriched_spotify,
          enriched_audio: !!t.enriched_audio,
          metadata_written: !!t.metadata_written,
          cover_art_written: !!t.cover_art_written,
          in_library: !!t.in_library,
        });
      }
    } catch {
      // Flags section is optional — fail silently
    }
  }, [track.id]);

  useEffect(() => {
    loadFlags();
  }, [loadFlags]);

  // Escape key to close
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const artistColor = (() => {
    let h = 0;
    for (let i = 0; i < track.artist.length; i++) {
      h = track.artist.charCodeAt(i) + ((h << 5) - h);
    }
    return `hsl(${((h % 360) + 360) % 360}, 55%, 45%)`;
  })();

  return (
    <>
      {/* Keyframe for slide-in animation */}
      <style>{`
        @keyframes detailPanelSlideIn {
          from { transform: translateX(100%); }
          to { transform: translateX(0); }
        }
      `}</style>

      {/* Overlay */}
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.4)",
          zIndex: 59,
        }}
      />

      {/* Panel */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Job details for ${track.title}`}
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          width: 380,
          height: "100vh",
          background: "var(--hw-surface)",
          borderLeft: "1px solid var(--hw-border)",
          zIndex: 60,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          animation: "detailPanelSlideIn 0.2s ease-out",
        }}
      >
        {/* Close button */}
        <div
          style={{
            padding: "12px 16px",
            borderBottom: "1px solid var(--hw-border)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span className="font-mono uppercase" style={{ fontSize: 9, fontWeight: 700, color: "var(--hw-text-dim)", letterSpacing: 1.5 }}>
            Job Details
          </span>
          <button
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              color: "var(--hw-text-dim)",
              cursor: "pointer",
              fontSize: 12,
              fontFamily: "monospace",
            }}
          >
            ✕ Close
          </button>
        </div>

        {/* Scrollable content */}
        <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
          {/* ── Track header ── */}
          <div className="flex gap-3" style={{ marginBottom: 20 }}>
            <div
              style={{
                width: 52,
                height: 52,
                borderRadius: 4,
                backgroundImage: track.artwork_url
                  ? `url(${track.artwork_url})`
                  : `linear-gradient(135deg, ${artistColor}44 0%, ${artistColor}11 100%)`,
                backgroundSize: "cover",
                backgroundPosition: "center",
                flexShrink: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {!track.artwork_url && (
                <span className="font-sans" style={{ fontSize: 16, fontWeight: 800, color: `${artistColor}88` }}>
                  {track.artist.slice(0, 2).toUpperCase()}
                </span>
              )}
            </div>
            <div style={{ minWidth: 0 }}>
              <div className="font-sans truncate" style={{ fontSize: 14, fontWeight: 700, color: "var(--hw-text)" }}>
                {track.title}
              </div>
              <div className="font-sans truncate" style={{ fontSize: 12, color: "var(--hw-text-dim)" }}>
                {track.artist}
              </div>
              {track.album && (
                <div className="font-sans truncate" style={{ fontSize: 11, color: "var(--hw-text-muted)" }}>
                  {track.album}
                </div>
              )}
              <span
                className="font-mono uppercase inline-block"
                style={{
                  fontSize: 9,
                  fontWeight: 700,
                  marginTop: 4,
                  padding: "2px 8px",
                  borderRadius: 3,
                  color: "var(--hw-text-dim)",
                  background: "var(--hw-raised)",
                  border: "1px solid var(--hw-border)",
                }}
              >
                {track.acquisition_status.replace("_", " ")}
              </span>
            </div>
          </div>

          {/* ── Job timeline ── */}
          <div style={{ marginBottom: 20 }}>
            <span className="font-mono uppercase" style={{ fontSize: 9, fontWeight: 700, color: "var(--hw-text-dim)", letterSpacing: 1.5 }}>
              Job Timeline
            </span>
            <div className="flex flex-col gap-2" style={{ marginTop: 8 }}>
              {jobs.length === 0 ? (
                <span className="font-mono" style={{ fontSize: 11, color: "var(--hw-text-muted)" }}>
                  No jobs found for this track
                </span>
              ) : (
                jobs.map((job) => <JobTimelineEntry key={job.id} job={job} />)
              )}
            </div>
          </div>

          {/* ── Processing flags ── */}
          <div>
            <span className="font-mono uppercase" style={{ fontSize: 9, fontWeight: 700, color: "var(--hw-text-dim)", letterSpacing: 1.5 }}>
              Processing Flags
            </span>
            <div style={{ marginTop: 8 }}>
              {flags ? (
                <TrackFlagGrid flags={flags} />
              ) : (
                <span className="font-mono" style={{ fontSize: 10, color: "var(--hw-text-muted)" }}>
                  Loading...
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
```

- [ ] **Step 2: TypeScript check**

```bash
cd web && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add web/components/ui/PipelineDetailPanel.tsx
git commit -m "feat(ui): add PipelineDetailPanel with job timeline and track flags"
```

---

### Task 6: UI — Wire up expand/collapse and detail panel in Pipeline page

**Files:**
- Modify: `web/app/(app)/pipeline/page.tsx`

- [ ] **Step 1: Add imports**

At the top of `web/app/(app)/pipeline/page.tsx`, add to imports:

```typescript
import JobChainStrip from "@/components/ui/JobChainStrip";
import PipelineDetailPanel from "@/components/ui/PipelineDetailPanel";
```

Add `fetchTrackJobs` and `type PipelineJob` to the existing `@/lib/api` import.

- [ ] **Step 2: Add expand/collapse and detail panel state**

In the `PipelineMonitorPage` component, after the existing state declarations (around line 178), add:

```typescript
const [expandedTrackId, setExpandedTrackId] = useState<number | null>(null);
const [expandedJobs, setExpandedJobs] = useState<PipelineJob[] | null>(null);
const [expandedLoading, setExpandedLoading] = useState(false);
const [detailTrack, setDetailTrack] = useState<PipelineTrack | null>(null);
```

- [ ] **Step 3: Add expand handler**

After the existing `handleSort` function, add:

```typescript
async function handleExpand(trackId: number) {
  if (expandedTrackId === trackId) {
    // Collapse
    setExpandedTrackId(null);
    setExpandedJobs(null);
    return;
  }
  setExpandedTrackId(trackId);
  setExpandedJobs(null);
  setExpandedLoading(true);
  try {
    const data = await fetchTrackJobs(trackId);
    setExpandedJobs(data.jobs);
  } catch {
    toast.error("Failed to load job history");
    setExpandedTrackId(null);
  } finally {
    setExpandedLoading(false);
  }
}
```

- [ ] **Step 4: Add `onExpand` and `isExpanded` props to TrackRow**

Update the TrackRow function signature to add new props:

```typescript
// Add to the props type:
isExpanded: boolean;
onExpand: () => void;
```

- [ ] **Step 5: Make the track info cell clickable for expand**

In TrackRow, wrap the track info `<div>` (the one with title/artist/album) with a click handler. Replace the existing track info cell with:

```tsx
{/* Track info — click to expand */}
<div
  className="min-w-0 cursor-pointer"
  onClick={(e) => {
    e.stopPropagation();
    onExpand();
  }}
>
  <div
    className="truncate text-sm"
    style={{ fontWeight: 600, color: "var(--hw-text)" }}
  >
    {track.title}
  </div>
  <div
    className="truncate text-xs"
    style={{ color: "var(--hw-text-dim)" }}
  >
    {track.artist}
    {track.album && (
      <span style={{ color: "var(--hw-text-muted)" }}>
        {" "}
        &middot; {track.album}
      </span>
    )}
  </div>
</div>
```

- [ ] **Step 6: Render expanded JobChainStrip below TrackRow**

In the table body's `.map()` where `TrackRow` is rendered, update to render the chain strip below an expanded row. Replace the single `<TrackRow ... />` with:

```tsx
<div key={track.id}>
  <TrackRow
    track={track}
    editingQuery={editingQuery}
    editValue={editValue}
    retrying={retrying.has(track.id)}
    queuing={queuing.has(track.id)}
    isSelected={selected.has(track.id)}
    isExpanded={expandedTrackId === track.id}
    onToggleSelect={() => toggleSelect(track.id)}
    onExpand={() => handleExpand(track.id)}
    onEditStart={(id, val) => {
      setEditingQuery(id);
      setEditValue(val);
    }}
    onEditChange={setEditValue}
    onEditCancel={() => setEditingQuery(null)}
    onEditSubmit={(id) => {
      handleRetry(id, editValue);
      setEditingQuery(null);
    }}
    onRetry={(id) => handleRetry(id)}
    onQueue={(id) => handleQueue(id)}
  />
  {expandedTrackId === track.id && (
    <div
      style={{
        borderBottom: "1px solid var(--hw-list-border, var(--hw-border))",
        background: "color-mix(in srgb, var(--led-blue) 3%, var(--hw-list-row-bg, var(--hw-surface)))",
      }}
    >
      {expandedLoading ? (
        <div className="font-mono" style={{ padding: "10px 16px 10px 88px", fontSize: 11, color: "var(--hw-text-muted)" }}>
          Loading job history...
        </div>
      ) : expandedJobs ? (
        <JobChainStrip
          jobs={expandedJobs}
          source={track.source}
          onViewDetails={() => setDetailTrack(track)}
        />
      ) : null}
    </div>
  )}
</div>
```

Note: the wrapping `<div key={track.id}>` replaces the `key` that was previously on `<TrackRow>`.

- [ ] **Step 7: Render PipelineDetailPanel**

At the bottom of the return JSX (before the closing `</div>` of the page), add:

Also add state to hold detail panel jobs independently:

```typescript
const [detailJobs, setDetailJobs] = useState<PipelineJob[] | null>(null);
```

When "View details" is clicked, copy the current `expandedJobs` into `detailJobs` so the panel survives row collapse:

Update the `onViewDetails` handler in the `JobChainStrip` render (Task 6 Step 6) to also set `detailJobs`:

```tsx
onViewDetails={() => {
  setDetailTrack(track);
  setDetailJobs(expandedJobs);
}}
```

Then render the panel using `detailJobs`:

```tsx
{detailTrack && detailJobs && (
  <PipelineDetailPanel
    track={detailTrack}
    jobs={detailJobs}
    onClose={() => {
      setDetailTrack(null);
      setDetailJobs(null);
    }}
  />
)}
```

- [ ] **Step 8: Pass new props from TrackRow usage**

Make sure the `TrackRow` component invocation passes `isExpanded` and `onExpand`. This was already done in step 6 above.

- [ ] **Step 9: TypeScript check**

```bash
cd web && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add web/app/\(app\)/pipeline/page.tsx
git commit -m "feat(ui): wire up expandable rows and detail panel in pipeline monitor"
```

---

### Task 7: Visual QA and push

- [ ] **Step 1: Run dev server and test**

```bash
cd web && npm run dev
```

Open `http://localhost:3000/pipeline` and verify:
1. Click a track's title/artist area — row expands with job chain pills
2. Click again — row collapses
3. Expanding a different track collapses the previous one
4. Pill colors match status (green=done, red=failed, blue=pending, dashed gray=not created)
5. Failed pills show truncated error
6. "View details →" opens the slide-out panel
7. Panel shows track header, full job timeline with timestamps/errors/results, and processing flags
8. Escape key closes the panel
9. Clicking overlay closes the panel
10. Checkbox, Queue, Retry buttons still work without triggering expand

- [ ] **Step 2: Push all commits**

```bash
git push
```
