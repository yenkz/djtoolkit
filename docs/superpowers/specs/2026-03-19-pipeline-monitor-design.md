# Pipeline Monitor — Track-Centric Soulseek Monitoring

**Date:** 2026-03-19
**Status:** Approved

## Problem

The current pipeline page is job-centric — each processing step (download, fingerprint, metadata, cover art) is tracked as a separate job. This makes it hard to understand what's happening to a track end-to-end. Users want to see: was my track found on Soulseek? Is it downloading? Did it fail? What search query was used?

Additionally, the catalog currently shows all imported tracks regardless of whether they exist on disk. This misrepresents what the user actually has.

## Design Principles

- **Catalog = what you truly have on disk.** Tracks that haven't been downloaded don't belong in the catalog.
- **Track-centric, not job-centric.** One row per track, showing its full journey from import to download.
- **Leverage existing infrastructure.** Supabase Realtime is already wired — no new transport layer needed.

## Approach

Expand `acquisition_status` vocabulary to reflect granular search/transfer states. The agent writes status transitions as they happen; the web UI subscribes via Supabase Realtime. The pipeline page becomes a live track monitor. The catalog filters to `available` tracks only.

## Data Model Changes

### Expanded `acquisition_status` values

| Status | Meaning | Set by | aioslsk mapping |
|---|---|---|---|
| `candidate` | Imported, waiting to be processed | Importers (unchanged) | n/a |
| `searching` | Search query broadcast, collecting results | Agent before `_search_all()` | `SearchRequestSentEvent` |
| `found` | Viable results exist, ready for download | Agent after search phase | `len(request.results) > 0` + passes `_rank_candidates` |
| `not_found` | Zero viable results after all fallback rounds | Agent after exhausting queries | All search rounds return empty |
| `queued` | Transfer enqueued with peer, waiting in queue | Agent during transfer | `TransferState.State.QUEUED` / `INITIALIZING` |
| `downloading` | Transfer actively in progress | Agent during transfer | `TransferState.State.DOWNLOADING` |
| `available` | File on disk, download complete | Agent on transfer complete (unchanged) | `TransferState.State.COMPLETE` |
| `failed` | Transfer failed after retries | Agent on terminal failure (unchanged) | `TransferState.State.FAILED` / `ABORTED` / `INCOMPLETE` |
| `duplicate` | Fingerprint match detected | Chromaprint (unchanged) | n/a |

### New column

```sql
ALTER TABLE tracks ADD COLUMN search_results_count INTEGER DEFAULT NULL;
```

- `NULL` = not searched yet
- `0` = searched, nothing found
- `> 0` = number of viable (post-filter, passing `_rank_candidates`) results

**Definition of "viable":** A result is viable if it passes `_rank_candidates` — correct audio extension, within duration tolerance, relevance score above `min_score_title`. Raw search results that fail scoring are not counted. If raw results exist but none pass filtering, the track goes to `not_found` with `search_results_count = 0`.

### Catalog filter

The catalog page query changes to:

```sql
WHERE acquisition_status = 'available'
```

All other statuses are exclusively the pipeline monitor's domain.

**Implementation:** The catalog page frontend passes `?status=available` as a default filter parameter. The API route (`/api/catalog/tracks`) is not changed — it already supports `?status=` filtering. This avoids breaking other API consumers.

## Pipeline Monitor UI

Replaces the current `/pipeline` page entirely.

### Layout (top to bottom)

1. **Realtime indicator** — green pulsing dot + "Realtime · Supabase" label. Agent name + last seen time on the right.

2. **LCD stat bar** — one LCD display per active status showing count: Candidates, Searching, Found, Downloading, Not Found, Failed. Uses existing `LCDDisplay` component style (amber monospace, glow, inset shadow). Counts are global (not affected by pagination or filters).

3. **Filter buttons** — toggle by status. Monospace uppercase, orange border when active. Each button shows count in parentheses.

4. **Track table** — one row per track with these columns:

| Column | Content | Sortable |
|---|---|---|
| Artwork | Album art thumbnail (40×40px), placeholder if none | No |
| Track | Title (bold) + Artist (dim below) | Yes (by title) |
| Status | LED-styled badge with colored dot. Pulsing animation for `searching` and `downloading` | Yes (by priority: downloading > queued > searching > found > candidate > not_found > failed) |
| Search Query | Monospace, truncated with ellipsis. **Inline-editable** for `not_found` tracks (click to edit, enter to save via the retry endpoint with `{ "search_string": "..." }`) | No |
| Results | Viable result count. Green if > 0, red if 0, dash if not searched | Yes |
| Actions | Retry button for `not_found` and `failed` tracks | No |

### Pagination

- Server-side via Supabase `.range()`
- Default page size: 25 (options: 25 / 50 / 100)
- Page controls at bottom (prev/next + page indicator)
- LCD stat bar counts always show global totals, unaffected by page

### Sorting

- Clickable column headers with sort direction indicator
- Default: sort by `updated_at DESC` (most recently active first) — this naturally surfaces downloading/searching tracks at the top
- For explicit status sorting: use client-side sort within the current page (status priority map: downloading=1, queued=2, searching=3, found=4, candidate=5, not_found=6, failed=7). Server-side status priority sorting would require a computed column, which is not worth the complexity.
- Other columns (title, results): sort via Supabase `.order()` query

### Realtime updates

- Subscribe to Supabase Realtime on `tracks` table, filtered by `user_id=eq.${userId}` only (Supabase Realtime does not support `NOT IN` filters). Filter out `available`/`duplicate` events client-side.
- On INSERT/UPDATE event: update the affected row in-place (no full page reload). Ignore events where `acquisition_status` is `available` or `duplicate`.
- Debounce toast notifications to avoid spam during batch operations
- Fallback: poll every 10s if Realtime subscription stalls

## Backend Changes

### Agent status transitions in `aioslsk_client.py`

Add `_set_status()` calls at each phase in `_run_async`:

```text
Phase 1 (search):
  Before _search_all()         → set all batch tracks to 'searching'
  After search + scoring:
    If viable results exist     → set to 'found', write search_results_count
    If no viable results        → set to 'not_found', write search_results_count = 0

Phase 2 (download):
  Per-track (not bulk):
    Transfer enters QUEUED      → set to 'queued'
    Transfer enters DOWNLOADING → set to 'downloading'
    Transfer COMPLETE           → set to 'available' + local_path (unchanged)
    Transfer FAILED/ABORTED/INCOMPLETE → set to 'failed' (unchanged)
```

**Note on batch search granularity:** The current `_search_all()` broadcasts all searches in a single batch and waits one timeout window. This means all tracks transition to `searching` simultaneously and resolve together. The `searching` state is therefore a synchronized batch state, not truly per-track. This is acceptable for the UI — a batch of tracks pulsing as "searching" at the same time is expected behavior when the agent processes a batch.

Remove the current bulk `_set_status(adapter, track["id"], "downloading")` loop — status transitions happen per-track as aioslsk reports them.

### Retry endpoint

```http
PUT /api/pipeline/tracks/{id}/retry
```

- Validates track belongs to current user
- Validates `acquisition_status` is `not_found` or `failed`
- Resets `acquisition_status` to `candidate`
- Clears `search_results_count` to `NULL`
- Optionally accepts `{ "search_string": "new query" }` in body to update the search query before retry
- Returns updated track object
- Agent picks up the track on next poll cycle (already queries for `candidate` tracks)

### Pipeline status endpoint update

```http
GET /api/pipeline/status
```

Update to return counts grouped by the new `acquisition_status` values instead of job-level counts.

## Migration

```sql
-- New column for search result count
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS search_results_count INTEGER DEFAULT NULL;

-- No migration needed for acquisition_status — it's a TEXT column, new values work immediately
```

Supabase migration via `mcp__supabase__apply_migration` or manual SQL.

## What changes, what stays

| Component | Change |
|---|---|
| `acquisition_status` values | Add: `searching`, `found`, `not_found`, `queued` |
| `tracks` table | Add: `search_results_count` column |
| `aioslsk_client.py` | Add `_set_status()` calls at each phase transition |
| `/pipeline` page | **Replace** with track-centric monitor |
| `/catalog` page | Filter to `WHERE acquisition_status = 'available'`; add artwork column |
| `/api/pipeline/status` | Update counts to use new status values |
| `/api/pipeline/tracks/{id}/retry` | **New endpoint** |
| Supabase Realtime subscription | Subscribe to `tracks` table by `user_id`, filter `available`/`duplicate` client-side |
| `pipeline_jobs` table + `/api/pipeline/jobs/*` routes | **Deprecate for downloads.** Download monitoring moves to track-level status. The `pipeline_jobs` table and job-based API routes remain for non-download job types (fingerprint, metadata, cover_art) until those are also migrated. No immediate deletion. |
| Existing importers | Unchanged (still set `candidate` / `available`) |
| Chromaprint / metadata / mover | Unchanged (operate on `available` tracks) |

## Out of scope

- Interactive Soulseek search from the browser (type query, browse results, pick files)
- Per-transfer metrics (speed, bytes, peer username) — user explicitly doesn't need this
- Download history / summary view
- Manual search query override before first search (only on retry after not_found)
