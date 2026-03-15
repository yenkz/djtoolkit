# Vercel Migration Design

**Date:** 2026-03-15
**Status:** Approved
**Scope:** Migrate djtoolkit cloud hosting from Hetzner VPS to Vercel + Supabase

## Motivation

The current Hetzner VPS setup (Docker Compose + Nginx + SSL + Ubuntu) creates an ops burden and security surface area that is disproportionate for a personal tool. The VPS requires OS patching, firewall management, SSH hardening, and Docker runtime maintenance. Vercel eliminates this entire class of concerns by moving compute to a managed serverless platform.

**Goals:**
- Zero infrastructure to manage (no server, Docker, Nginx, SSL)
- Preview deployments per PR, instant rollbacks
- Reduce security surface to application code only
- Maintain current functionality and multi-tenant architecture
- Stay on free tiers ($0/mo)

## Architecture

### Before (Hetzner)

```
Browser --> Nginx --> Next.js (port 3000)
                  --> FastAPI (port 8000) --> Supabase Postgres
Local Agent --> FastAPI --> Supabase Postgres
```

Three Docker containers (api, web, nginx) on a single Ubuntu VPS. GitHub Actions builds images, pushes to GHCR, SSH deploys to Hetzner.

### After (Vercel)

```
Browser --> Vercel Edge --> Next.js pages + API Route Handlers --> Supabase Postgres
Local Agent --> Vercel API Routes --> Supabase Postgres
```

Single Next.js deployment on Vercel. FastAPI backend eliminated. API logic lives in Next.js Route Handlers. Database, auth, and real-time handled by Supabase.

### What stays unchanged

- Supabase Postgres (DB, RLS policies, auth)
- Local agent (Python CLI on user's laptop -- downloads, fingerprints, metadata)
- Next.js frontend pages and components
- Database schema and RLS policies

## API Route Migration

Every FastAPI endpoint becomes a Next.js API Route Handler in `web/app/api/`:

| FastAPI Route | Next.js Route Handler |
|---|---|
| `GET /api/catalog/tracks` | `app/api/catalog/tracks/route.ts` |
| `GET /api/catalog/tracks/{id}` | `app/api/catalog/tracks/[id]/route.ts` |
| `GET /api/catalog/stats` | `app/api/catalog/stats/route.ts` |
| `POST /api/catalog/import/csv` | `app/api/catalog/import/csv/route.ts` |
| `POST /api/catalog/import/spotify` | `app/api/catalog/import/spotify/route.ts` |
| `GET /api/catalog/import/spotify/playlists` | `app/api/catalog/import/spotify/playlists/route.ts` |
| `POST /api/catalog/import/trackid` | `app/api/catalog/import/trackid/route.ts` |
| `GET /api/catalog/import/trackid/{jobId}/status` | `app/api/catalog/import/trackid/[jobId]/status/route.ts` |
| `POST /api/catalog/backfill-artwork` | `app/api/catalog/backfill-artwork/route.ts` |
| `DELETE /api/catalog/tracks/bulk` | `app/api/catalog/tracks/bulk/route.ts` |
| `POST /api/catalog/tracks/{id}/reset` | `app/api/catalog/tracks/[id]/reset/route.ts` |
| `GET /api/pipeline/jobs` | `app/api/pipeline/jobs/route.ts` |
| `POST /api/pipeline/jobs/bulk` | `app/api/pipeline/jobs/bulk/route.ts` |
| `POST /api/pipeline/jobs/batch/claim` | `app/api/pipeline/jobs/batch/claim/route.ts` |
| `POST /api/pipeline/jobs/{id}/claim` | `app/api/pipeline/jobs/[id]/claim/route.ts` |
| `PUT /api/pipeline/jobs/{id}/result` | `app/api/pipeline/jobs/[id]/result/route.ts` |
| `GET /api/pipeline/jobs/history` | `app/api/pipeline/jobs/history/route.ts` |
| `POST /api/pipeline/jobs/retry` | `app/api/pipeline/jobs/retry/route.ts` |
| `GET /api/pipeline/status` | `app/api/pipeline/status/route.ts` |
| `POST /api/agents/register` | `app/api/agents/register/route.ts` |
| `POST /api/agents/heartbeat` | `app/api/agents/heartbeat/route.ts` |
| `GET /api/agents` | `app/api/agents/route.ts` |
| `DELETE /api/agents/{id}` | `app/api/agents/[id]/route.ts` |
| `GET /api/auth/spotify/connect` | `app/api/auth/spotify/connect/route.ts` |
| `GET /api/auth/spotify/callback` | `app/api/auth/spotify/callback/route.ts` |
| `POST /api/auth/spotify/disconnect` | `app/api/auth/spotify/disconnect/route.ts` |
| `GET /health` | `app/api/health/route.ts` |

### Auth pattern

- **Web users:** Supabase server client (`createServerClient` from `@supabase/ssr`) handles JWT verification automatically.
- **Local agents:** Shared `verifyAgentKey()` helper checks `agents.api_key_hash` -- same logic as current `auth.py`, ported to TypeScript.

### DB access pattern

Route handlers use the Supabase server client with the service role key. RLS policies stay as-is -- the Supabase client sets user context automatically. Complex queries use `.rpc()` or raw SQL via the Supabase client.

### Rate limiting

Replace slowapi with Upstash Redis rate limiter (free tier: 10k requests/day). The current system has per-route limits (e.g., `5/hour` for backfill-artwork, `20/hour` for imports, `300/hour` for reads). Vercel's built-in DDoS protection does not provide this granularity, so Upstash should be set up in Phase 1 alongside the shared utilities to avoid a rate-limiting gap during migration. The `@upstash/ratelimit` package integrates directly with Next.js Route Handlers.

### Job result chaining

The `_apply_job_result` function (~130 lines of match/case with DB updates for download -> fingerprint -> cover_art -> metadata auto-queuing) translates directly to TypeScript. Same logic, different syntax. Note: this function performs up to 6 sequential DB queries within a single transaction (e.g., for a cover_art result: update flag, fetch local_path, fetch metadata, reconstruct musical_key, insert metadata job). This should comfortably fit within the 10s timeout.

### Frontend API client changes

The frontend currently points all API calls to an external FastAPI server via `NEXT_PUBLIC_API_URL` (see `web/lib/api.ts`). After migration, API calls become relative (`/api/...`) since the backend lives in the same Next.js app. `NEXT_PUBLIC_API_URL` will be removed, and `web/lib/api.ts` and all files referencing it must be updated to use relative paths.

### Audit logging

The current `audit_log()` helper uses `get_pool()` (asyncpg) to insert audit rows. In Vercel Route Handlers, this becomes a Supabase server client insert. A shared `auditLog()` TypeScript helper will be created in Phase 1 as part of the shared utilities.

### Spotify token encryption migration

Existing Spotify tokens in the DB are encrypted with Python's `cryptography.fernet.Fernet`. The TypeScript port will use a JS Fernet-compatible implementation (e.g., `fernet` npm package) to decrypt existing tokens without breaking backward compatibility. This avoids forcing all users to re-connect Spotify after migration. If a JS Fernet implementation proves unreliable, the fallback is to re-encrypt all tokens in a one-time migration script using Node.js `crypto` (AES-256-CBC, matching Fernet's underlying algorithm).

### Request body size limits

Vercel's free tier has a 4.5MB request body limit. The current CSV import allows up to 10MB (`_MAX_CSV_BYTES`). The limit will be reduced to 4MB for the Vercel deployment. Exportify CSVs for even large libraries (5000+ tracks) are typically under 2MB, so this should not impact real usage. If needed, chunked upload can be added later.

## Solving Serverless Constraints

### TrackID long-poll (30 min -> Supabase Edge Function)

**Problem:** TrackID identification polls an external API for up to 30 minutes. Cannot run in a 10s serverless function.

**Solution:** Supabase Edge Function (Deno runtime, 150s wall-clock on free tier).

1. Next.js route `POST /api/catalog/import/trackid` validates URL, checks cache, creates `trackid_import_jobs` row
2. Invokes Supabase Edge Function via `supabase.functions.invoke('trackid-poll', { body: { job_id, url } })`
3. Edge Function polls TrackID.dev, updates `trackid_import_jobs` row as it progresses
4. For jobs exceeding 120s, the Edge Function re-invokes itself with the TrackID job ID (relay pattern)
5. Frontend polls `GET /api/catalog/import/trackid/{jobId}/status` (unchanged)

**Fallback:** If relay pattern proves too complex, push TrackID identification to the local agent. Cloud stores the result. Trade-off: requires agent to be online.

### Spotify OAuth state store (in-memory -> Supabase table)

**Problem:** `_state_store` is an in-memory dict. Serverless functions don't share memory.

**Solution:** New Supabase table:

```sql
CREATE TABLE oauth_states (
    state      TEXT PRIMARY KEY,
    user_id    UUID NOT NULL,
    return_to  TEXT NOT NULL DEFAULT '/',
    expires_at TIMESTAMPTZ NOT NULL
);
```

- `/api/auth/spotify/connect` -> INSERT state row
- `/api/auth/spotify/callback` -> SELECT + DELETE state row (atomic)
- Expired rows cleaned by the callback itself or pg_cron

### Stale job sweeper (background loop -> pg_cron)

**Problem:** `_stale_job_sweeper()` runs every 60s in-process. No persistent process on Vercel.

**Solution:** Supabase pg_cron (runs inside Postgres, free, already enabled):

```sql
SELECT cron.schedule(
    'sweep-stale-jobs',
    '* * * * *',
    $$
    UPDATE pipeline_jobs
    SET status = 'pending', claimed_at = NULL, agent_id = NULL
    WHERE status = 'claimed'
      AND claimed_at < NOW() - INTERVAL '5 minutes'
    $$
);
```

Same SQL as today. Zero application code.

## Real-Time Updates (SSE -> Supabase Realtime)

**Current:** In-process `asyncio.Queue` per user, SSE endpoint, Nginx buffering config.

**New:** Frontend subscribes directly to Postgres changes via Supabase JS client:

```typescript
const channel = supabase
  .channel('pipeline-jobs')
  .on(
    'postgres_changes',
    {
      event: '*',
      schema: 'public',
      table: 'pipeline_jobs',
      filter: `user_id=eq.${userId}`,
    },
    (payload) => { /* update UI */ }
  )
  .subscribe()
```

RLS policies ensure each user only receives events for their own jobs. No backend involvement.

Bonus: subscribe to `tracks` table changes to update the catalog page in real-time when the agent reports results.

**Eliminated code:**
- `_sse_queues` / `_subscribe` / `_unsubscribe` / `broadcast` system
- `GET /pipeline/events` SSE endpoint
- Nginx SSE buffering config
- `broadcast()` calls in `report_job_result`

## 10-Second Timeout Mitigation

Most endpoints finish in <100ms. Two that could be tight:

1. **Spotify playlist import** -- paginates Spotify API (100 tracks/page). A 500-track playlist = 5 HTTP calls. Should fit in 10s. For 2000+ track playlists: import first batch, return partial result, frontend paginates the rest.

2. **Artwork backfill** -- batches of 50 Spotify API calls. Process one batch per invocation, return progress, frontend calls again for the next batch.

Both solvable with pagination patterns, no architectural change.

## Files Deleted

### Infrastructure (entire files removed)
- `docker-compose.yml`
- `Dockerfile` (Python API image)
- `web/Dockerfile` (Next.js image)
- `nginx/djtoolkit.conf`
- `deploy/setup.sh`
- `.github/workflows/deploy.yml`

### FastAPI backend (entire directory removed from cloud path)
- `djtoolkit/api/app.py`
- `djtoolkit/api/catalog_routes.py`
- `djtoolkit/api/pipeline_routes.py`
- `djtoolkit/api/spotify_auth_routes.py`
- `djtoolkit/api/auth_routes.py`
- `djtoolkit/api/auth.py`
- `djtoolkit/api/audit.py`
- `djtoolkit/api/rate_limit.py`
- `djtoolkit/db/postgres.py`

### Files that stay (local agent only)
- All of `djtoolkit/` except `djtoolkit/api/`
- `djtoolkit/db/database.py` + `schema.sql` (local SQLite)
- `pyproject.toml`, `Makefile`, `djtoolkit.toml`, `.env`

### CI changes

- `.github/workflows/deploy.yml` replaced by Vercel's GitHub integration (push to main = deploy, PR = preview)
- `.github/workflows/ci.yml` kept for Python tests (local agent), web job updated for Vercel build
- `.github/workflows/release.yml` stays unchanged (builds macOS/Windows Setup Assistant for the local agent)

## Environment Variables

### Removed

- `NEXT_PUBLIC_API_URL` -- no longer needed; API routes are same-origin (`/api/...`)
- `HETZNER_HOST`, `HETZNER_USER`, `HETZNER_SSH_KEY` -- no server to deploy to
- `GITHUB_REPOSITORY`, `IMAGE_TAG` -- no Docker images to tag

### Moved to Vercel environment settings

- `SUPABASE_DATABASE_URL` -- used by Route Handlers for direct DB access
- `SUPABASE_JWT_EC_X`, `SUPABASE_JWT_EC_Y`, `SUPABASE_JWT_AUDIENCE` -- JWT verification
- `SUPABASE_SERVICE_ROLE_KEY` -- server-side Supabase client
- `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` -- Spotify OAuth
- `SPOTIFY_CALLBACK_URL` -- update to Vercel domain (e.g., `https://djtoolkit.com/api/auth/spotify/callback`)
- `SPOTIFY_TOKEN_ENCRYPTION_KEY` -- Fernet key for encrypted tokens
- `PLATFORM_FRONTEND_URL` -- update to Vercel domain or remove (same-origin)
- `PLATFORM_SPOTIFY_CLIENT_ID`, `PLATFORM_SPOTIFY_CLIENT_SECRET` -- if separate from user-facing keys

### Already on Vercel (no change)

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`

## Migration Strategy

### Phase 1 -- Foundation (no user-facing changes)

- Set up Vercel project, connect GitHub repo, configure environment variables
- Create shared utilities: `verifyAgentKey()`, `getAuthUser()`, Supabase server client helper, `auditLog()` helper
- Set up Upstash Redis rate limiter (matching current per-route limits)
- Add `oauth_states` table to Supabase schema
- Enable pg_cron for stale job sweeper and expired OAuth state cleanup
- Add `vercel.json` with route config
- Update `web/lib/api.ts` to use relative paths (`/api/...`), remove `NEXT_PUBLIC_API_URL`

### Phase 2 -- Port API routes (Vercel preview deploys for testing)

- Port pipeline routes first (agent-facing -- easiest to test with the local agent)
- Port catalog routes (tracks, stats, bulk delete, track reset, import/csv)
- Port agent management routes
- Port Spotify OAuth (connect/callback/disconnect) using `oauth_states` table, with Fernet-compatible token decryption
- Port Spotify import + artwork backfill with pagination safety (4MB CSV limit)

### Phase 3 -- Replace real-time + TrackID

- Add Supabase Realtime subscriptions in frontend (pipeline page, catalog page)
- Remove SSE EventSource connection from frontend
- Create Supabase Edge Function for TrackID polling
- Port TrackID import route to invoke the Edge Function

### Phase 4 -- Verify + cutover

- Test full flow end-to-end: sign up -> connect Spotify -> import playlist -> agent downloads -> real-time updates
- Verify local agent works against Vercel API routes (check response format compatibility)
- Point `djtoolkit.com` DNS to Vercel
- Decommission Hetzner VPS
- Remove Docker/Nginx/deploy infrastructure files from repo

### Phase 5 -- Cleanup

- Delete FastAPI backend files
- Update CI workflow
- Update CLAUDE.md and docs

## Scalability

This architecture scales well for multi-tenant growth:

| Component | Free tier limit | Upgrade path |
|---|---|---|
| Vercel | 100GB bandwidth, 100k invocations/mo | Pro ($20/mo): 1TB, 60s timeout |
| Supabase Postgres | 500MB DB, 2GB bandwidth | Pro ($25/mo): 8GB, dedicated compute |
| Supabase Realtime | Thousands of concurrent WebSockets | Scales with plan |
| Supabase Edge Functions | 500k invocations/mo | Scales with plan |
| pg_cron | Runs inside Postgres | N/A |

Serverless functions scale horizontally by design. RLS policies scope all data per user. Agent key system is per-user. The scaling ceiling is cost, not architecture.

For high-traffic scenarios (thousands of concurrent bulk imports), a job queue service like Inngest or Trigger.dev (Vercel-integrated, free tiers available) can be added incrementally.

## Rewrite Scope

- ~1200-1500 lines of TypeScript (API route handlers, shared utilities, rate limiting setup)
- ~1500 lines of Python + 15 infrastructure files deleted
- ~50 lines of new SQL (oauth_states table, pg_cron schedules)
- ~1 Supabase Edge Function (TrackID polling, ~100 lines of Deno/TypeScript)
- Frontend: replace SSE EventSource with Supabase Realtime subscriptions (~30 lines changed)
- Frontend: update `web/lib/api.ts` and references to remove `NEXT_PUBLIC_API_URL` (~8 files)
