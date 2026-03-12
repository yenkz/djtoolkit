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
|---|---|---|
| 1 | Exportify CSV | `candidate` |
| 2 | Local folder scan | `available` |
| 3 (new) | YouTube mix URL via TrackID.dev | `candidate` |

TrackID.dev is a free, no-auth API that uses AcoustID / Chromaprint fingerprinting to identify tracks in DJ sets. It accepts YouTube URLs and returns identified tracks with artist, title, confidence score, and AcoustID identifier. Rate limit: 10 requests per 15 minutes per IP.

---

## Data Flow

```
make import-trackid URL=<youtube_url>
    → djtoolkit import trackid --url <youtube_url> [--force]
        → validate URL format (regex, raise early if invalid)
        → check trackid_jobs cache — skip if already processed (unless --force)
        → POST https://trackid.dev/api/analyze → get jobId
        → poll GET https://trackid.dev/api/job/{jobId} every 5–10s
            → handle 429 with exponential backoff
            → display Rich progress bar (step description + %)
            → break on status: completed | failed
        → filter: confidence >= threshold AND NOT isUnknown
        → insert each passing track: acquisition_status='candidate', source='trackid'
        → mark job in trackid_jobs: status, tracks_found, tracks_imported
        → print summary: {identified, imported, skipped_low_confidence, failed}
```

---

## Module Structure

### New file: `djtoolkit/importers/trackid.py`

| Function | Signature | Responsibility |
|---|---|---|
| `validate_url` | `(url: str) -> str` | Normalize + validate YouTube URL; raise `ValueError` if invalid |
| `submit_job` | `(url: str, cfg: Config) -> str` | POST `/api/analyze`, return `jobId` |
| `poll_job` | `(job_id: str, cfg: Config) -> dict` | Poll with interval, Rich progress, return completed job dict |
| `import_trackid` | `(url: str, cfg: Config) -> dict` | Orchestrate full flow; handle cache; return stats dict |

### CLI (`__main__.py`)

New subcommand added to the `import` command group:

```
djtoolkit import trackid --url <youtube_url> [--force]
```

`--force` bypasses the cache and re-submits a URL that was already processed.

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
poll_interval_sec = 7         # seconds between job status polls (min 3, max 10)
base_url = "https://trackid.dev"  # overridable for testing
```

New `TrackIdConfig` dataclass added to `config.py`.

---

## Database

### New table: `trackid_jobs`

Cache to prevent resubmitting the same YouTube URL. Added to `schema.sql` and `database.py` migration (idempotent `CREATE TABLE IF NOT EXISTS`).

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `youtube_url` | TEXT UNIQUE | Normalized URL |
| `job_id` | TEXT | TrackID.dev job ID |
| `status` | TEXT | `queued`, `completed`, `failed` |
| `tracks_found` | INTEGER | Total tracks identified by API |
| `tracks_imported` | INTEGER | Tracks inserted into `tracks` table |
| `created_at` | TEXT | ISO 8601 timestamp |

### `tracks` table — new rows from Flow 3

No schema changes required. API fields map to existing columns:

| Column | Value | Notes |
|---|---|---|
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
- `acoustidId` — the `fingerprints` table requires a full Chromaprint string (not available until after download + `fpcalc`); pre-population is not possible
- `timestamp` — position in mix; out of scope
- `youtubeUrl` (per-track) — out of scope

**Deduplication:** handled downstream by `make fingerprint` after download — same as all other flows. No import-time dedup.

---

## Error Handling

| Scenario | Behavior |
|---|---|
| Invalid YouTube URL | `ValueError` before any HTTP call; printed as clear error, exit non-zero |
| URL already in cache | Warning + skip; `--force` re-submits and overwrites cache entry |
| Job status `failed` | Error printed with job ID; exit non-zero; `trackid_jobs.status = 'failed'` |
| 429 rate limit | Exponential backoff starting at 15s, max 3 retries; abort with message if exhausted |
| All tracks below threshold | Warning: "0 tracks met confidence threshold (lowest: X.XX)"; job still marked done in cache |
| `isUnknown: true` tracks | Silently skipped — no artist/title available |
| Network error during poll | Retry up to 3 times with 10s wait; abort if persistent (job stays `queued` in cache) |
| Duplicate track in DB | Inserted anyway; dedup handled downstream by `make fingerprint` |

**Non-goal:** No auto-retry of failed jobs. User re-runs with `--force` if needed — avoids hammering the rate limit.

---

## Best Practices Compliance

| Practice | Implementation |
|---|---|
| Poll every 5–10s | `poll_interval_sec = 7` default |
| Handle rate limiting | 429 → exponential backoff, max 3 retries |
| Check completed + failed | Poll loop handles both terminal states |
| Validate YouTube URLs | `validate_url()` called before any HTTP request |
| Cache results | `trackid_jobs` table; skip on re-submission |
| Use HTTPS | `base_url = "https://trackid.dev"` |
| Don't poll < 3s | `poll_interval_sec` clamped to minimum 3 in code |
| Don't submit same URL twice | Cache check at start of `import_trackid()` |

---

## Explicitly Out of Scope

- **Timestamp storage**: API `timestamp` (position in mix) not stored — we care about track identity, not mix position.
- **Source URL on tracks**: `source='trackid'` is sufficient; the YouTube mix URL is not stored on individual track rows.
- **acoustidId as dedup key**: Import-time dedup skipped intentionally; the existing Chromaprint pipeline handles it post-download.
- **Per-track youtubeUrl**: Not stored; out of scope.
- **Async implementation**: djtoolkit CLI is synchronous; blocking poll loop is sufficient.
