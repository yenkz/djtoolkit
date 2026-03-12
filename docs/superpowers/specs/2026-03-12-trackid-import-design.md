# TrackID.dev Import — Design Spec

**Date:** 2026-03-12
**Status:** Approved

---

## Overview

Add a third music ingest flow (Flow 3) that accepts a YouTube URL of a DJ mix, submits it to the [TrackID.dev](https://trackid.dev/docs) API for track identification, and inserts the identified tracks into the DB as `candidate` for subsequent Soulseek download.

---

## Context

djtoolkit currently has two ingest flows:

| Flow | Source | Resulting status |
| --- | --- | --- |
| 1 | Exportify CSV | `candidate` |
| 2 | Local folder scan | `available` |
| 3 (new) | YouTube mix URL via TrackID.dev | `candidate` |

TrackID.dev is a free, no-auth API that uses AcoustID / Chromaprint fingerprinting to identify tracks in DJ sets. It accepts YouTube URLs and returns identified tracks with artist, title, confidence score, and AcoustID identifier. Rate limit: 10 requests per 15 minutes per IP.

---

## Data Flow

```text
make import-trackid URL=<youtube_url>
    → djtoolkit import trackid --url <youtube_url> [--force]
        → validate + normalize URL (see URL Normalization below)
        → check trackid_jobs cache (by normalized URL) — skip if already processed (unless --force)
        → POST https://trackid.dev/api/analyze → get jobId
        → poll GET https://trackid.dev/api/job/{jobId} every poll_interval_sec
            → handle 429 with exponential backoff
            → display Rich progress bar (step description + %)
            → break on status: completed | failed | poll_timeout_sec exceeded
        → filter: confidence >= threshold AND NOT isUnknown
        → insert each passing track: acquisition_status='candidate', source='trackid'
        → mark job in trackid_jobs: status, tracks_found, tracks_imported
        → print summary: {identified, imported, skipped_low_confidence, skipped_unknown, failed}
```

---

## Module Structure

### New file: `djtoolkit/importers/trackid.py`

| Function | Signature | Responsibility |
| --- | --- | --- |
| `validate_url` | `(url: str) -> str` | Normalize + validate YouTube URL; raise `ValueError` if invalid; return normalized form |
| `submit_job` | `(url: str, cfg: Config) -> str` | POST `/api/analyze`, return `jobId` |
| `poll_job` | `(job_id: str, cfg: Config) -> dict` | Poll with interval, Rich progress; raises `PollTimeoutError` on timeout, `RuntimeError` on API `failed` status; returns completed job dict only on success |
| `import_trackid` | `(url: str, cfg: Config) -> dict` | Orchestrate full flow; handle cache; return stats dict |

### CLI (`__main__.py`)

New subcommand added to the `import` command group:

```text
djtoolkit import trackid --url <youtube_url> [--force]
```

`--force` bypasses the cache and re-submits a URL that was already processed (see `--force` behavior below).

### Makefile

```makefile
import-trackid:
    poetry run djtoolkit import trackid --url $(URL)
```

---

## Configuration

New `[trackid]` section in `djtoolkit.toml` and `djtoolkit.toml.example`:

```toml
[trackid]
confidence_threshold = 0.7    # 0.0–1.0; tracks below this are skipped
poll_interval_sec = 7         # seconds between job status polls (clamped to 3–10 in poll_job)
poll_timeout_sec = 1800       # max total poll time in seconds (default 30 min); 0 = unlimited
base_url = "https://trackid.dev"  # overridable for testing
```

New `TrackIdConfig` dataclass added to `config.py`. `load()` must wire it explicitly:

```python
trackid=_make(TrackIdConfig, "trackid"),
```

---

## Database

### New table: `trackid_jobs`

Cache to prevent resubmitting the same YouTube URL. Must be added in two places:

1. **`schema.sql`** — for fresh installs via `make setup`
2. **`database.py` `migrate()`** — idempotent `CREATE TABLE IF NOT EXISTS` for existing installs via `make migrate-db`
3. **`database.py` `wipe()`** — must `DROP TABLE IF EXISTS trackid_jobs` alongside the other tables

Schema:

| Column | Type | Notes |
| --- | --- | --- |
| `id` | INTEGER PK | |
| `youtube_url` | TEXT UNIQUE | Normalized URL (canonical form) |
| `job_id` | TEXT UNIQUE | TrackID.dev job ID |
| `status` | TEXT | `queued`, `completed`, `failed` |
| `tracks_found` | INTEGER | Total tracks identified by API (including unknown + below threshold) |
| `tracks_imported` | INTEGER | Tracks actually inserted into `tracks` table |
| `created_at` | TEXT | ISO 8601 timestamp |
| `updated_at` | TEXT | ISO 8601 timestamp; updated when job completes |

### `tracks` table — new rows from Flow 3

No schema changes required. The `source` column comment in `schema.sql` must be updated to include `'trackid'`:

```sql
source TEXT NOT NULL, -- 'exportify' | 'folder' | 'trackid'
```

API fields map to existing columns:

| Column | Value | Notes |
| --- | --- | --- |
| `acquisition_status` | `candidate` | |
| `source` | `trackid` | |
| `artist` | API `artist` | |
| `artists` | API `artist` | Single value (no multi-artist from this API) |
| `title` | API `title` | |
| `duration_ms` | API `duration * 1000` | API returns seconds; DB stores milliseconds |
| `search_string` | built via `utils/search_string.py` | |
| all others | NULL | |

**API fields not stored:**

- `confidence` — used for filtering at import time only; not persisted
- `acoustidId` — the `fingerprints` table requires a full Chromaprint string (not available until after download + `fpcalc`); pre-population is not possible; this field is discarded at import time (not deferred)
- `timestamp` — position in mix; out of scope
- `youtubeUrl` (per-track) — out of scope

**Deduplication:** No uniqueness constraint is applied at insert time. The same track can be inserted multiple times (e.g., from two different mixes, or already present from Exportify). This is intentional — cross-source dedup is deferred to `make fingerprint` post-download, same as all other flows. Do not add any UNIQUE index to the `tracks` table for this flow.

---

## URL Normalization

`validate_url()` must normalize before using as cache key, so that equivalent URLs for the same video map to the same `trackid_jobs` row:

1. Accept these input forms: `youtube.com/watch?v=ID`, `youtu.be/ID`, `youtube.com/embed/ID`
2. Strip tracking parameters (`?si=`, `&feature=`, etc.) — keep only `v=ID`
3. Canonical output: `https://www.youtube.com/watch?v=ID`
4. Raise `ValueError` for any URL that doesn't yield a valid video ID

---

## `--force` Behavior

When `--force` is passed for a URL that already exists in `trackid_jobs`:

1. The existing `trackid_jobs` row is **updated** (not deleted + re-inserted) — `job_id`, `status`, `tracks_found`, `tracks_imported`, `updated_at` are overwritten
2. Previously inserted `tracks` rows from the prior job are **left in place** — they are not deleted
3. New tracks are inserted normally; this may produce duplicates for the same artist/title
4. Dedup is handled downstream by `make fingerprint`, as with all other flows

This is the intended behavior: `--force` means "re-analyze the mix and add whatever we find," not "replace the previous import."

---

## Error Handling

| Scenario | Behavior |
| --- | --- |
| Invalid / non-YouTube URL | `ValueError` before any HTTP call; clear error message, exit non-zero |
| URL already in cache | Warning + skip; `--force` re-submits and updates cache entry |
| Job status `failed` | `poll_job()` raises `RuntimeError`; `import_trackid()` catches, sets `trackid_jobs.status='failed'`, exits non-zero |
| `poll_timeout_sec` exceeded | `poll_job()` raises `PollTimeoutError`; `import_trackid()` catches, leaves `trackid_jobs.status='queued'` (not `'timeout'`), exits non-zero |
| 429 during initial POST | `submit_job()` applies exponential backoff (15s start, max 3 retries); abort if exhausted |
| 429 during polling | Same exponential backoff as above |
| `tracks: []` (empty result) | Warning: "TrackID found 0 tracks in this mix"; job marked done, `tracks_found=0` |
| All tracks below threshold | Warning: "0 tracks met confidence threshold (lowest: X.XX)"; job marked done in cache |
| `isUnknown: true` tracks | Counted in `skipped_unknown` stats; not inserted |
| Network error during poll | Retry up to 3 times with 10s wait; abort if persistent (job stays `queued` in cache) |
| Duplicate artist/title in DB | Inserted anyway; dedup handled downstream by `make fingerprint` |

---

## Stats Output

`import_trackid()` returns and CLI prints:

| Key | Meaning |
| --- | --- |
| `identified` | Total tracks returned by API (excluding `isUnknown`) |
| `imported` | Tracks inserted into `tracks` table |
| `skipped_low_confidence` | Tracks filtered out by confidence threshold |
| `skipped_unknown` | Tracks with `isUnknown: true` |
| `failed` | 1 if job failed, else 0 |

---

## Best Practices Compliance

| Practice | Implementation |
| --- | --- |
| Poll every 5–10s | `poll_interval_sec = 7` default; clamped to [3, 10] inside `poll_job()` |
| Handle rate limiting | 429 → exponential backoff, max 3 retries |
| Check completed + failed | Poll loop handles both terminal states |
| Validate YouTube URLs | `validate_url()` called before any HTTP request |
| Cache results | `trackid_jobs` table; skip on re-submission |
| Use HTTPS | `base_url = "https://trackid.dev"` |
| Don't poll < 3s | `poll_interval_sec` clamped to minimum 3 inside `poll_job()` |
| Don't submit same URL twice | Cache check (normalized URL) at start of `import_trackid()` |

---

## Explicitly Out of Scope

- **Timestamp storage**: API `timestamp` (position in mix) not stored — we care about track identity, not mix position.
- **Source URL on tracks**: `source='trackid'` is sufficient; the YouTube mix URL is not stored on individual track rows.
- **acoustidId as dedup key**: Import-time dedup skipped intentionally; the existing Chromaprint pipeline handles it post-download. The `acoustidId` field from the API response is discarded.
- **Per-track youtubeUrl**: Not stored.
- **Async implementation**: djtoolkit CLI is synchronous; blocking poll loop is sufficient.
