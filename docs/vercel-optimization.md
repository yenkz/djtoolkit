# Vercel Free Tier Optimization

Vercel free tier provides 4 hours of Fluid Active CPU per billing cycle.
This document tracks optimizations applied and potential next steps.

## Applied

### Pipeline status RPC (2026-03-30)

Replaced 8 parallel `count` queries in `/api/pipeline/status` with a single
`pipeline_status` Supabase RPC. Reduces Supabase round-trips from 9 to 2
per request (RPC + agents query). Fallback to old approach if RPC unavailable.

- Migration: `supabase/migrations/20260330000000_pipeline_status_rpc.sql`
- Route: `web/app/api/pipeline/status/route.ts`

## Potential next optimizations

### 1. Move agent heartbeat + job polling to Supabase direct (HIGH impact)

The agent daemon routes all traffic through Vercel (`/api/agents/heartbeat`,
`/api/pipeline/jobs/*/claim`, etc.). Each request spins up a serverless function.
With `poll_interval_sec = 60`, each agent generates ~2,160 requests/day
(heartbeat + job polling).

The agent already stores Supabase credentials in the OS keychain. Adding a
`SupabaseAgentClient` that writes `last_seen_at`, claims jobs, and reports
results directly via Supabase client would eliminate all of these Vercel
invocations.

**Files to modify:**
- `djtoolkit/agent/client.py` — add `SupabaseAgentClient`
- `djtoolkit/agent/daemon.py` — use direct client when credentials available
- Keep HTTP client as fallback for backward compatibility

### 2. Batch N+1 queries in catalog/analyze (MEDIUM impact)

`/api/catalog/analyze` loops through up to 1,000 track IDs making 3 queries
per track (ownership check, active job check, insert). Total: up to 3,000 DB
operations per request.

Replace with:
1. Single bulk query to fetch all eligible tracks
2. Single bulk query to check existing active jobs
3. Single bulk insert for new jobs

**File:** `web/app/api/catalog/analyze/route.ts`

### 3. Remove Vercel Analytics + SpeedInsights (LOW impact, easy)

`web/app/layout.tsx` includes `<Analytics />` and `<SpeedInsights />` from
`@vercel/analytics` and `@vercel/speed-insights`. These add CPU overhead to
every page load. For a small-user tool, browser DevTools suffices.

**File:** `web/app/layout.tsx`

### 4. Verify catalog_stats RPC is active (LOW effort, potentially HIGH impact)

`/api/catalog/stats` has a fallback that fetches ALL track rows and aggregates
in JavaScript if the `catalog_stats` RPC doesn't exist. If the RPC was never
applied, every catalog page load is extremely expensive.

Check: `SELECT proname FROM pg_proc WHERE proname = 'catalog_stats';`

**File:** `web/app/api/catalog/stats/route.ts`
**Migration:** `supabase/migrations/20260328000000_catalog_stats_rpc.sql`
