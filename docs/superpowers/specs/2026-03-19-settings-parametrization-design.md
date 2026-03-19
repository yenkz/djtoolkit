# Settings Parametrization — Design Spec

**Date:** 2026-03-19
**Status:** Approved

## Problem

The web UI settings page saves tuning parameters (matching thresholds, cover art sources, enabled toggles, etc.) to Supabase `user_settings` JSONB, but the local agent reads config exclusively from `~/.config/djtoolkit/agent/config.toml`. Changing a setting in the UI has no effect on pipeline behavior.

## Approach

**Settings snapshotted into job payload** — when a pipeline job is created (import, chain, retry), the server reads the user's relevant settings from `user_settings` and embeds them in the job's `payload.settings` JSONB. The agent reads tuning params from the payload, falling back to local config for anything missing. Enabled/disabled toggles control whether a job is created at all in the chaining logic.

### Why this approach

- Deterministic: settings are locked at job creation time
- Minimal agent changes: read from payload, fall back to config
- No extra API calls from the agent
- Backward-compatible: old jobs without `settings` in payload use local config as-is

## Settings-to-Job Mapping

### Tuning parameters (embedded in `payload.settings`)

| Job type | Settings key | Type | Default | Agent config field overridden |
|---|---|---|---|---|
| `download` | `min_score` | `number` | `0.86` | `cfg.matching.min_score` AND `cfg.matching.min_score_title` (see note) |
| `download` | `duration_tolerance_ms` | `number` | `2000` | `cfg.matching.duration_tolerance_ms` |
| `download` | `search_timeout_sec` | `number` | `15.0` | `cfg.soulseek.search_timeout_sec` |
| `cover_art` | `coverart_sources` | `string[]` | `["coverartarchive","itunes","deezer"]` | `cfg.cover_art.sources` (see naming note) |

**Note on `min_score`:** The download code in `aioslsk_client.py` filters candidates using `cfg.matching.min_score_title` (default `0.70`), not `cfg.matching.min_score`. The UI exposes a single "Minimum score" slider. On the agent side, the payload `min_score` value overrides both `cfg.matching.min_score` and `cfg.matching.min_score_title` so the user's setting actually affects download filtering.

**Note on cover art source naming:** The CLI config uses short names (`coverart itunes deezer` space-separated), while the web UI uses full names (`["coverartarchive", "itunes", "deezer", "spotify", "lastfm"]`). The agent's `_fetch_art()` function accepts both naming conventions. The payload uses the web UI naming (array of full names). The executor maps `coverartarchive` → the name expected by `_fetch_art`, which already handles both forms.

### Enabled toggles (gate job creation in chaining)

| Toggle | `user_settings` key | Gates job type | Default |
|---|---|---|---|
| Fingerprint | `fingerprint_enabled` | `fingerprint` | `true` |
| Cover Art | `coverart_enabled` | `cover_art` | `true` |
| Audio Analysis | `analysis_enabled` | `audio_analysis` | `false` |
| Loudnorm | `loudnorm_enabled` | `loudnorm` (future) | `false` |

Defaults match the settings page UI initial state (`analysis_enabled` = `false` because it is CPU-intensive and uses optional dependencies; `loudnorm_enabled` = `false` because not yet implemented).

When a toggle is off, the chaining logic skips that step and proceeds to the next in the pipeline.

## Server-side Changes (Next.js)

### New helper: `web/lib/api-server/job-settings.ts`

```typescript
export async function getJobSettings(
  supabase: SupabaseClient,
  userId: string,
  jobType: string
): Promise<Record<string, unknown>>
```

- Fetches `user_settings.settings` JSONB for the user
- Returns only the keys relevant to `jobType`
- Returns empty object if no settings found (agent uses local defaults)

Also exports:

```typescript
export async function isStepEnabled(
  settings: Record<string, unknown>,
  step: "fingerprint" | "cover_art" | "audio_analysis" | "loudnorm"
): boolean
```

- Reads the relevant enabled toggle from the already-fetched settings object
- Returns `true` for `fingerprint` and `cover_art` if not set (default enabled)
- Returns `false` for `audio_analysis` and `loudnorm` if not set (default disabled)

And a convenience function to fetch all settings once:

```typescript
export async function getUserSettings(
  supabase: SupabaseClient,
  userId: string
): Promise<Record<string, unknown>>
```

### Modified: `web/lib/api-server/job-result.ts`

`applyJobResult()` changes:

1. Fetch user settings once at the top via `getUserSettings()`
2. Before inserting each chained job, check `isStepEnabled()` for that step
3. If step is disabled, skip to the next step in the chain
4. Embed `settings: getJobSettings(...)` in the job payload for jobs that have tuning params

**Skip logic (both pipeline variants):**

```
Exportify:
  download
    → [fingerprint_enabled?] → fingerprint
    → [coverart_enabled?]    → cover_art
    → metadata

Non-exportify:
  download
    → [fingerprint_enabled?] → fingerprint
    → spotify_lookup  (always runs, no toggle)
    → [coverart_enabled?]    → cover_art
    → [analysis_enabled?]    → audio_analysis
    → metadata
```

If a step is disabled, the chain skips forward to the next enabled step. `spotify_lookup` has no toggle — it always runs for non-exportify tracks (it provides essential metadata). The chain always terminates at `metadata` (never skipped).

### Modified: Job creation entry points

All endpoints that insert `pipeline_jobs` need settings injection:

| Endpoint | Creates job type | Change |
|---|---|---|
| `web/app/api/catalog/import/csv/route.ts` | `download` | Embed `payload.settings` |
| `web/app/api/catalog/import/trackid/route.ts` | `download` | Embed `payload.settings` |
| `web/app/api/catalog/import/spotify/route.ts` | `download` | Embed `payload.settings` |
| `web/app/api/pipeline/jobs/bulk/route.ts` | `download` | Embed `payload.settings` |
| `web/app/api/catalog/tracks/[id]/reset/route.ts` | `download` | Embed `payload.settings` |

### Retry endpoint: `web/app/api/pipeline/jobs/retry/route.ts`

The retry endpoint resets existing failed/done jobs back to `pending` — it does not create new jobs. The original `payload` (including any `settings` snapshot) is preserved. **No changes needed** — the job re-executes with the settings it was originally created with. This is consistent with the "settings locked at creation time" principle.

If a user wants updated settings to apply, they can delete the failed job and trigger a new one (which will snapshot current settings).

## Agent-side Changes (Python)

### Modified: `djtoolkit/agent/executor.py`

Each executor that has tuning params reads from `payload["settings"]` first, falls back to local config:

**`execute_download()`:**
```python
settings = payload.get("settings", {})
cfg.matching.min_score = settings.get("min_score", cfg.matching.min_score)
cfg.matching.min_score_title = settings.get("min_score", cfg.matching.min_score_title)
cfg.matching.duration_tolerance_ms = settings.get("duration_tolerance_ms", cfg.matching.duration_tolerance_ms)
cfg.soulseek.search_timeout_sec = settings.get("search_timeout_sec", cfg.soulseek.search_timeout_sec)
```

**`execute_download_batch()`:**
Same pattern — read settings from the first job's payload. **Constraint:** batch downloads must only contain jobs from a single user (enforced by the agent's job claiming logic, which authenticates as one user).

**`execute_cover_art()`:**
```python
settings = payload.get("settings", {})
if "coverart_sources" in settings:
    sources = settings["coverart_sources"]  # list from web UI
else:
    sources = [s.strip() for s in cfg.cover_art.sources.split() if s.strip()]
```

**No changes to:** `execute_fingerprint()`, `execute_audio_analysis()`, `execute_metadata()`, `execute_spotify_lookup()` — these have no tuning params from the web UI.

### Backward compatibility

If `payload["settings"]` is missing (old jobs, CLI-created jobs), every executor falls back to local config values. Zero breaking changes.

## Out of Scope

- **Subscription section** — stays as "Coming soon"
- **Paths and credentials** — `downloads_dir`, `library_dir`, Soulseek password, API keys remain local to agent config/keychain
- **Retroactive updates** — changing a setting doesn't affect already-queued jobs (retry preserves original settings)
- **New DB tables or migrations** — `user_settings` JSONB already stores all these fields
- **CLI config changes** — `djtoolkit.toml` and `config.py` are untouched

## Files Changed

| File | Change |
|---|---|
| `web/lib/api-server/job-settings.ts` | **New** — `getUserSettings()`, `getJobSettings()`, `isStepEnabled()` |
| `web/lib/api-server/job-result.ts` | Fetch settings, gate chaining on toggles, embed settings in payload |
| `web/app/api/catalog/import/csv/route.ts` | Embed settings in download job payload |
| `web/app/api/catalog/import/trackid/route.ts` | Embed settings in download job payload |
| `web/app/api/catalog/import/spotify/route.ts` | Embed settings in download job payload |
| `web/app/api/pipeline/jobs/bulk/route.ts` | Embed settings in download job payload |
| `web/app/api/catalog/tracks/[id]/reset/route.ts` | Embed settings in download job payload |
| `djtoolkit/agent/executor.py` | Read tuning params from `payload.settings`, fall back to config |
