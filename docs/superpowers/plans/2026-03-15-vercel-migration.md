# Vercel Migration Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate djtoolkit from Hetzner VPS (Docker/Nginx/FastAPI) to Vercel + Supabase serverless.

**Architecture:** Next.js API Route Handlers replace FastAPI. Supabase Realtime replaces SSE. pg_cron replaces background sweepers. Supabase Edge Function handles TrackID long-poll. Frontend API client switches from `NEXT_PUBLIC_API_URL` to relative paths.

**Tech Stack:** Next.js 16 (App Router), TypeScript, Supabase JS (`@supabase/supabase-js`, `@supabase/ssr`), `@upstash/ratelimit`, `bcryptjs`, `fernet` (npm), Supabase Edge Functions (Deno)

**Spec:** `docs/superpowers/specs/2026-03-15-vercel-migration-design.md`

---

## File Structure

### New files (created)

```
web/
├── app/api/
│   ├── health/route.ts                                    # Health check
│   ├── catalog/
│   │   ├── tracks/
│   │   │   ├── route.ts                                   # GET paginated tracks
│   │   │   ├── bulk/route.ts                              # DELETE bulk delete candidates
│   │   │   └── [id]/
│   │   │       ├── route.ts                               # GET single track
│   │   │       └── reset/route.ts                         # POST reset failed track
│   │   ├── stats/route.ts                                 # GET catalog stats
│   │   ├── import/
│   │   │   ├── csv/route.ts                               # POST CSV import
│   │   │   ├── spotify/
│   │   │   │   ├── route.ts                               # POST import from playlist
│   │   │   │   └── playlists/route.ts                     # GET list playlists
│   │   │   └── trackid/
│   │   │       ├── route.ts                               # POST start TrackID job
│   │   │       └── [jobId]/status/route.ts                # GET poll job status
│   │   └── backfill-artwork/route.ts                      # POST backfill artwork
│   ├── pipeline/
│   │   ├── jobs/
│   │   │   ├── route.ts                                   # GET pending jobs (agent)
│   │   │   ├── bulk/route.ts                              # POST bulk create jobs
│   │   │   ├── batch/claim/route.ts                       # POST batch claim
│   │   │   ├── history/route.ts                           # GET job history
│   │   │   ├── retry/route.ts                             # POST retry failed jobs
│   │   │   └── [id]/
│   │   │       ├── claim/route.ts                         # POST claim single job
│   │   │       └── result/route.ts                        # PUT report result
│   │   └── status/route.ts                                # GET pipeline status
│   ├── agents/
│   │   ├── route.ts                                       # GET list agents
│   │   ├── register/route.ts                              # POST register agent
│   │   ├── heartbeat/route.ts                             # POST agent heartbeat
│   │   └── [id]/route.ts                                  # DELETE agent
│   └── auth/spotify/
│       ├── connect/route.ts                               # GET initiate OAuth
│       ├── callback/route.ts                              # GET OAuth callback
│       └── disconnect/route.ts                            # POST disconnect
├── lib/
│   ├── api-server/
│   │   ├── auth.ts                                        # getAuthUser(), verifyAgentKey(), verifyJwt()
│   │   ├── db.ts                                          # createServiceClient(), raw SQL helper
│   │   ├── audit.ts                                       # auditLog() fire-and-forget
│   │   ├── rate-limit.ts                                  # Upstash rate limiter factory
│   │   ├── fernet.ts                                      # Fernet encrypt/decrypt for Spotify tokens
│   │   ├── errors.ts                                      # jsonError() helper for consistent error responses
│   │   └── job-result.ts                                  # applyJobResult() chaining logic
│   └── supabase/
│       └── service.ts                                     # Supabase service-role client (new)
├── vercel.json                                            # Route config (if needed)
└── .env.local.example                                     # Updated (remove NEXT_PUBLIC_API_URL)

supabase/
└── functions/
    └── trackid-poll/
        └── index.ts                                       # Supabase Edge Function
```

### Modified files

```
web/lib/api.ts                    # Remove NEXT_PUBLIC_API_URL, use relative /api/...
web/app/(app)/pipeline/page.tsx   # Replace EventSource with Supabase Realtime
web/app/(app)/catalog/page.tsx    # Replace NEXT_PUBLIC_API_URL ref, add Realtime
web/app/(app)/import/page.tsx     # Remove NEXT_PUBLIC_API_URL ref
web/app/(app)/agents/page.tsx     # Remove CLOUD_URL ref
web/app/(app)/settings/page.tsx   # Remove NEXT_PUBLIC_API_URL ref
web/next.config.ts                # Remove output: "standalone"
web/package.json                  # Add bcryptjs, @upstash/ratelimit, fernet
web/.env.local.example            # Remove NEXT_PUBLIC_API_URL, add UPSTASH_*
```

### Deleted files (Phase 5)

```
docker-compose.yml, Dockerfile, web/Dockerfile
nginx/djtoolkit.conf, deploy/setup.sh
.github/workflows/deploy.yml
djtoolkit/api/app.py, catalog_routes.py, pipeline_routes.py
djtoolkit/api/spotify_auth_routes.py, auth_routes.py
djtoolkit/api/auth.py, audit.py, rate_limit.py
djtoolkit/db/postgres.py
```

---

## Chunk 1: Foundation (Phase 1)

### Task 1: Install dependencies and configure Vercel

**Files:**
- Modify: `web/package.json`
- Modify: `web/next.config.ts`
- Create: `web/vercel.json`
- Modify: `web/.env.local.example`

- [ ] **Step 1: Install new dependencies**

```bash
cd web && npm install bcryptjs @upstash/ratelimit @upstash/redis fernet
npm install -D @types/bcryptjs @types/fernet
```

- [ ] **Step 2: Update next.config.ts — remove standalone output**

Vercel handles builds natively; `output: "standalone"` is for Docker only.

```typescript
// web/next.config.ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // output: "standalone" removed — Vercel handles deployment natively
};

export default nextConfig;
```

- [ ] **Step 3: Create vercel.json**

```json
{
  "framework": "nextjs",
  "regions": ["fra1"]
}
```

`fra1` (Frankfurt) matches Supabase eu-central-1 for lowest latency.

- [ ] **Step 4: Update .env.local.example**

Remove `NEXT_PUBLIC_API_URL`. Add Upstash and server-side env vars:

```bash
# Supabase (public — baked into JS bundle)
NEXT_PUBLIC_SUPABASE_URL=<your-supabase-url>
NEXT_PUBLIC_SUPABASE_ANON_KEY=<your-anon-key>

# Supabase (server-side only — never exposed to browser)
SUPABASE_SERVICE_ROLE_KEY=<your-service-role-key>
SUPABASE_DATABASE_URL=<your-database-url>
SUPABASE_JWT_EC_X=<ec-public-key-x>
SUPABASE_JWT_EC_Y=<ec-public-key-y>
SUPABASE_JWT_AUDIENCE=authenticated

# Spotify OAuth (server-side only)
SPOTIFY_CLIENT_ID=<your-spotify-client-id>
SPOTIFY_CLIENT_SECRET=<your-spotify-client-secret>
SPOTIFY_CALLBACK_URL=http://localhost:3000/api/auth/spotify/callback
SPOTIFY_TOKEN_ENCRYPTION_KEY=<fernet-key>
PLATFORM_FRONTEND_URL=http://localhost:3000

# Upstash Redis (server-side only — rate limiting)
UPSTASH_REDIS_REST_URL=<your-upstash-url>
UPSTASH_REDIS_REST_TOKEN=<your-upstash-token>
```

- [ ] **Step 5: Commit**

```bash
git add web/package.json web/package-lock.json web/next.config.ts web/vercel.json web/.env.local.example
git commit -m "feat: add Vercel migration dependencies and config"
```

---

### Task 2: Create shared server utilities — errors and DB

**Files:**
- Create: `web/lib/api-server/errors.ts`
- Create: `web/lib/supabase/service.ts`
- Create: `web/lib/api-server/db.ts`

- [ ] **Step 1: Create error helper**

```typescript
// web/lib/api-server/errors.ts
import { NextResponse } from "next/server";

export function jsonError(detail: string, status: number): NextResponse {
  return NextResponse.json({ detail }, { status });
}
```

- [ ] **Step 2: Create Supabase service-role client**

```typescript
// web/lib/supabase/service.ts
import { createClient } from "@supabase/supabase-js";

/**
 * Service-role client for server-side API route handlers.
 * Bypasses RLS — use only in trusted server code.
 */
export function createServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}
```

- [ ] **Step 3: Create raw SQL helper**

For complex queries (joins, FOR UPDATE SKIP LOCKED, etc.) that can't use the Supabase query builder.

Reference: The Python backend uses `asyncpg` with raw SQL for nearly all queries. The Supabase JS client's `.rpc()` can call Postgres functions, but for this migration we use the `supabase.rpc('exec_sql', ...)` pattern or direct `postgres` connection from `@supabase/supabase-js` v2's `.from()`.

```typescript
// web/lib/api-server/db.ts
import { createServiceClient } from "@/lib/supabase/service";

/**
 * Execute a raw SQL query via Supabase's service-role client.
 * Uses the `rpc` method with a Postgres function or direct `.from()`.
 *
 * For most queries, use createServiceClient().from('table')... directly.
 * This helper is for complex SQL that the query builder can't express.
 */
export async function query<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc("exec_sql", {
    query: sql,
    params,
  });
  if (error) throw error;
  return (data ?? []) as T[];
}

// Re-export for convenience
export { createServiceClient };
```

Note: The `exec_sql` RPC function may need to be created in Supabase, OR we use the Supabase REST API with `.from()` for simple queries and raw SQL via the database URL for complex ones. The implementer should evaluate the best approach per-route and may replace this helper with direct Supabase client calls.

- [ ] **Step 4: Commit**

```bash
git add web/lib/api-server/errors.ts web/lib/supabase/service.ts web/lib/api-server/db.ts
git commit -m "feat: add shared server utilities — errors, service client, db helper"
```

---

### Task 3: Create auth utilities

**Files:**
- Create: `web/lib/api-server/auth.ts`

Port the dual-path auth from `djtoolkit/api/auth.py`. Two credential types:
- Supabase JWT (3-segment Bearer token) — web users
- Agent API key (`djt_` prefix) — bcrypt-verified against `agents` table

- [ ] **Step 1: Create auth module**

```typescript
// web/lib/api-server/auth.ts
import { NextRequest } from "next/server";
import bcrypt from "bcryptjs";
import { createServiceClient } from "@/lib/supabase/service";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { jsonError } from "./errors";

export interface CurrentUser {
  userId: string;
  email?: string | null;
  agentId?: string | null;
}

/**
 * Authenticate from Authorization header (Bearer JWT or djt_ agent key).
 * Used by API route handlers.
 * Returns CurrentUser or a NextResponse error.
 */
export async function getAuthUser(
  request: NextRequest
): Promise<CurrentUser | Response> {
  const auth = request.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) {
    return jsonError("Authorization header must use Bearer scheme", 401);
  }
  const token = auth.slice(7);

  // JWT path: 3 dot-separated segments
  if (token.split(".").length === 3) {
    return verifyJwt(token);
  }

  // Agent key path: djt_ prefix
  return verifyAgentKey(token);
}

/**
 * Authenticate from Supabase SSR cookies (for routes called by the browser
 * where the frontend doesn't send an Authorization header).
 */
export async function getAuthUserFromCookies(): Promise<CurrentUser | Response> {
  const cookieStore = await cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll() {
          // read-only in route handlers
        },
      },
    }
  );
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return jsonError("Not authenticated", 401);
  return { userId: user.id, email: user.email };
}

async function verifyJwt(token: string): Promise<CurrentUser | Response> {
  // Use Supabase's own token verification via getUser()
  const supabase = createServiceClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser(token);
  if (error || !user) {
    return jsonError("Invalid or expired token", 401);
  }
  return { userId: user.id, email: user.email };
}

async function verifyAgentKey(
  token: string
): Promise<CurrentUser | Response> {
  if (!token.startsWith("djt_") || token.length < 12) {
    return jsonError("Invalid agent API key", 401);
  }

  const prefix = token.slice(4, 12);
  const supabase = createServiceClient();
  const { data: rows, error } = await supabase
    .from("agents")
    .select("id, user_id, api_key_hash")
    .eq("api_key_prefix", prefix);

  if (error || !rows?.length) {
    return jsonError("Invalid agent API key", 401);
  }

  for (const row of rows) {
    if (await bcrypt.compare(token, row.api_key_hash)) {
      return {
        userId: row.user_id,
        agentId: row.id,
      };
    }
  }
  return jsonError("Invalid agent API key", 401);
}

/**
 * Type guard: check if getAuthUser result is an error response.
 */
export function isAuthError(
  result: CurrentUser | Response
): result is Response {
  return result instanceof Response;
}
```

- [ ] **Step 2: Commit**

```bash
git add web/lib/api-server/auth.ts
git commit -m "feat: add dual-path auth — JWT + agent key verification"
```

---

### Task 4: Create audit log and rate limiting utilities

**Files:**
- Create: `web/lib/api-server/audit.ts`
- Create: `web/lib/api-server/rate-limit.ts`

- [ ] **Step 1: Create audit log helper**

Port from `djtoolkit/api/audit.py`. Fire-and-forget — never throws.

```typescript
// web/lib/api-server/audit.ts
import { createServiceClient } from "@/lib/supabase/service";

export async function auditLog(
  userId: string,
  action: string,
  opts?: {
    resourceType?: string;
    resourceId?: string;
    details?: Record<string, unknown>;
    ipAddress?: string;
  }
): Promise<void> {
  try {
    const supabase = createServiceClient();
    await supabase.from("audit_logs").insert({
      user_id: userId,
      action,
      resource_type: opts?.resourceType ?? null,
      resource_id: opts?.resourceId ?? null,
      details: opts?.details ?? null,
      ip_address: opts?.ipAddress ?? null,
    });
  } catch {
    // Fire-and-forget — never block the request
  }
}

export function getClientIp(request: Request): string | undefined {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    undefined
  );
}
```

- [ ] **Step 2: Create rate limiter**

```typescript
// web/lib/api-server/rate-limit.ts
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { NextRequest } from "next/server";
import { jsonError } from "./errors";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

/**
 * Pre-configured rate limiters matching the FastAPI slowapi config.
 */
export const limiters = {
  /** 300 requests/hour — standard read endpoints */
  read: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(300, "1h") }),
  /** 100 requests/hour — agent claim/result endpoints */
  agent: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(100, "1h") }),
  /** 60 requests/hour — batch claim */
  batch: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(60, "1h") }),
  /** 30 requests/hour — bulk create, retry */
  write: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(30, "1h") }),
  /** 20 requests/hour — imports, OAuth */
  import: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(20, "1h") }),
  /** 10 requests/hour — agent registration */
  register: new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(10, "1h"),
  }),
  /** 5 requests/hour — backfill */
  backfill: new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(5, "1h"),
  }),
};

/**
 * Apply rate limiting. Returns null if allowed, or a 429 Response if exceeded.
 */
export async function rateLimit(
  request: NextRequest,
  limiter: Ratelimit,
  identifier?: string
): Promise<Response | null> {
  const ip =
    identifier ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown";
  const { success } = await limiter.limit(ip);
  if (!success) {
    return jsonError("Rate limit exceeded", 429);
  }
  return null;
}
```

- [ ] **Step 3: Commit**

```bash
git add web/lib/api-server/audit.ts web/lib/api-server/rate-limit.ts
git commit -m "feat: add audit logging and Upstash rate limiting"
```

---

### Task 5: Create Fernet compatibility helper

**Files:**
- Create: `web/lib/api-server/fernet.ts`

Port from Python's `cryptography.fernet.Fernet` used in `catalog_routes.py` and `spotify_auth_routes.py` for encrypting/decrypting Spotify tokens.

- [ ] **Step 1: Create Fernet helper**

```typescript
// web/lib/api-server/fernet.ts
import { Token, Secret } from "fernet";

const _key = () => {
  const key = process.env.SPOTIFY_TOKEN_ENCRYPTION_KEY;
  if (!key) throw new Error("SPOTIFY_TOKEN_ENCRYPTION_KEY not configured");
  return new Secret(key);
};

export function fernetEncrypt(plaintext: string): string {
  const token = new Token({ secret: _key() });
  return token.encode(plaintext);
}

export function fernetDecrypt(ciphertext: string): string {
  const token = new Token({
    secret: _key(),
    token: ciphertext,
    ttl: 0, // no TTL enforcement
  });
  return token.decode();
}
```

- [ ] **Step 2: Commit**

```bash
git add web/lib/api-server/fernet.ts
git commit -m "feat: add Fernet encrypt/decrypt for Spotify token migration"
```

---

### Task 6: Update frontend API client to use relative paths

**Files:**
- Modify: `web/lib/api.ts`
- Modify: `web/app/(app)/pipeline/page.tsx` (only the API_URL const for now — SSE replacement is Phase 3)
- Modify: `web/app/(app)/catalog/page.tsx`
- Modify: `web/app/(app)/import/page.tsx`
- Modify: `web/app/(app)/agents/page.tsx`
- Modify: `web/app/(app)/settings/page.tsx`

- [ ] **Step 1: Update api.ts base URL**

Change line 3 from:
```typescript
const API_BASE = `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"}/api`;
```
To:
```typescript
const API_BASE = "/api";
```

- [ ] **Step 2: Remove NEXT_PUBLIC_API_URL from all page files**

In each page file that references `NEXT_PUBLIC_API_URL` or `API_URL`:
- `pipeline/page.tsx`: Change `const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"` to `const API_URL = ""` (SSE URL becomes `/api/pipeline/events?token=...` — this will be fully replaced in Phase 3)
- `catalog/page.tsx`: Replace any `NEXT_PUBLIC_API_URL` usage with empty string or relative path
- `import/page.tsx`: Remove the `NEXT_PUBLIC_API_URL` reference used for agent config display — replace with `window.location.origin`
- `agents/page.tsx`: Change `CLOUD_URL` from `NEXT_PUBLIC_API_URL` to `window.location.origin`
- `settings/page.tsx`: Replace `NEXT_PUBLIC_API_URL` with empty string for Spotify connect redirect

The implementer should read each file, find the exact usage, and replace accordingly. The pattern is always the same: remove the env var reference, use relative path or `window.location.origin`.

- [ ] **Step 3: Commit**

```bash
git add web/lib/api.ts web/app/
git commit -m "feat: switch frontend API client to relative paths, remove NEXT_PUBLIC_API_URL"
```

---

### Task 7: Set up Supabase infrastructure (manual + SQL)

**Files:** None (Supabase dashboard / SQL editor)

- [ ] **Step 1: Create oauth_states table**

Run in Supabase SQL Editor:

```sql
CREATE TABLE IF NOT EXISTS oauth_states (
    state      TEXT PRIMARY KEY,
    user_id    UUID NOT NULL,
    return_to  TEXT NOT NULL DEFAULT '/',
    expires_at TIMESTAMPTZ NOT NULL
);

-- Index for cleanup queries
CREATE INDEX IF NOT EXISTS idx_oauth_states_expires
  ON oauth_states (expires_at);
```

- [ ] **Step 2: Enable pg_cron for stale job sweeper**

```sql
-- Stale job recovery — every minute
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

-- OAuth state cleanup — every 5 minutes
SELECT cron.schedule(
    'cleanup-oauth-states',
    '*/5 * * * *',
    $$
    DELETE FROM oauth_states WHERE expires_at < NOW()
    $$
);
```

- [ ] **Step 3: Enable Supabase Realtime on pipeline_jobs and tracks tables**

In Supabase Dashboard → Database → Replication:
- Enable `pipeline_jobs` table for Realtime
- Enable `tracks` table for Realtime

- [ ] **Step 4: Set up Upstash Redis (free tier)**

Go to https://upstash.com → create a Redis database (eu-central region).
Copy `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.
Add to Vercel environment variables and local `.env.local`.

- [ ] **Step 5: Document completion — no git commit (infrastructure only)**

---

## Chunk 2: Pipeline Routes (Phase 2a)

Port pipeline routes first — these are agent-facing and easiest to test in isolation.

### Task 8: Health check route

**Files:**
- Create: `web/app/api/health/route.ts`

- [ ] **Step 1: Create health check**

```typescript
// web/app/api/health/route.ts
import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({ status: "ok" });
}
```

- [ ] **Step 2: Verify it works**

```bash
cd web && npm run dev
# In another terminal:
curl http://localhost:3000/api/health
# Expected: {"status":"ok"}
```

- [ ] **Step 3: Commit**

```bash
git add web/app/api/health/route.ts
git commit -m "feat: add /api/health route handler"
```

---

### Task 9: Pipeline — fetch pending jobs (GET /api/pipeline/jobs)

**Files:**
- Create: `web/app/api/pipeline/jobs/route.ts`

Port from `pipeline_routes.py:480-509`. Agent polls this to get work.

- [ ] **Step 1: Create route handler**

```typescript
// web/app/api/pipeline/jobs/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";
import { rateLimit, limiters } from "@/lib/api-server/rate-limit";
import { createServiceClient } from "@/lib/supabase/service";

export async function GET(request: NextRequest) {
  const rl = await rateLimit(request, limiters.read);
  if (rl) return rl;

  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  const limit = Math.min(
    Math.max(Number(request.nextUrl.searchParams.get("limit") ?? 2), 1),
    10
  );

  const supabase = createServiceClient();
  const { data: rows, error } = await supabase
    .from("pipeline_jobs")
    .select("id, job_type, status, track_id, payload, created_at")
    .eq("user_id", user.userId)
    .eq("status", "pending")
    .order("priority", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) {
    return NextResponse.json({ detail: error.message }, { status: 500 });
  }

  return NextResponse.json(
    (rows ?? []).map((r) => ({
      id: r.id,
      job_type: r.job_type,
      status: r.status,
      track_id: r.track_id,
      payload: r.payload,
      created_at: r.created_at,
    }))
  );
}
```

- [ ] **Step 2: Test with curl against dev server**

```bash
# With a valid agent API key:
curl -H "Authorization: Bearer djt_<key>" http://localhost:3000/api/pipeline/jobs
# Expected: JSON array of pending jobs (or empty [])
```

- [ ] **Step 3: Commit**

```bash
git add web/app/api/pipeline/jobs/route.ts
git commit -m "feat: port GET /api/pipeline/jobs route handler"
```

---

### Task 10: Pipeline — bulk create jobs (POST /api/pipeline/jobs/bulk)

**Files:**
- Create: `web/app/api/pipeline/jobs/bulk/route.ts`

Port from `pipeline_routes.py:344-398`.

- [ ] **Step 1: Create route handler**

The implementer should read `pipeline_routes.py:344-398` and port the logic:
- Validate `track_ids` array (max 1000)
- For each track_id: verify ownership + candidate status, check no existing pending/claimed/running job, insert pipeline_job
- Audit log the action
- Return `{ created: N }`

Key Supabase patterns:
- Use `supabase.from("tracks").select("id, title, artist, search_string, duration_ms").eq("id", trackId).eq("user_id", user.userId).eq("acquisition_status", "candidate").single()` for each track check
- Use `supabase.from("pipeline_jobs").insert(...)` for job creation

- [ ] **Step 2: Test with curl**

- [ ] **Step 3: Commit**

```bash
git add web/app/api/pipeline/jobs/bulk/route.ts
git commit -m "feat: port POST /api/pipeline/jobs/bulk route handler"
```

---

### Task 11: Pipeline — batch claim (POST /api/pipeline/jobs/batch/claim)

**Files:**
- Create: `web/app/api/pipeline/jobs/batch/claim/route.ts`

Port from `pipeline_routes.py:512-558`. This uses `FOR UPDATE SKIP LOCKED` — requires raw SQL since Supabase query builder doesn't support row locking.

- [ ] **Step 1: Create route handler**

The implementer should read `pipeline_routes.py:512-558` and port the logic. The SQL is complex (UPDATE ... WHERE id = ANY(SELECT ... FOR UPDATE SKIP LOCKED) RETURNING ...). Use `supabase.rpc()` with a Postgres function, or use the Supabase client's raw SQL capability.

If Supabase RPC approach is used, create a Postgres function first:

```sql
CREATE OR REPLACE FUNCTION batch_claim_jobs(
  p_agent_id UUID,
  p_user_id UUID,
  p_job_type TEXT,
  p_limit INT
)
RETURNS SETOF pipeline_jobs AS $$
  UPDATE pipeline_jobs
  SET status = 'claimed', claimed_at = NOW(), agent_id = p_agent_id
  WHERE id = ANY(
    SELECT id FROM pipeline_jobs
    WHERE user_id = p_user_id
      AND status = 'pending'
      AND job_type = p_job_type
    ORDER BY priority DESC, created_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  )
  RETURNING *
$$ LANGUAGE sql;
```

- [ ] **Step 2: Test with curl**

- [ ] **Step 3: Commit**

```bash
git add web/app/api/pipeline/jobs/batch/claim/route.ts
git commit -m "feat: port POST /api/pipeline/jobs/batch/claim route handler"
```

---

### Task 12: Pipeline — claim single job (POST /api/pipeline/jobs/[id]/claim)

**Files:**
- Create: `web/app/api/pipeline/jobs/[id]/claim/route.ts`

Port from `pipeline_routes.py:561-607`. Similar to batch claim but for a single job. Same `FOR UPDATE SKIP LOCKED` pattern.

- [ ] **Step 1: Create route handler**

Similar RPC function or raw SQL pattern as Task 11, but for a single job by ID.

- [ ] **Step 2: Test with curl**

- [ ] **Step 3: Commit**

```bash
git add "web/app/api/pipeline/jobs/[id]/claim/route.ts"
git commit -m "feat: port POST /api/pipeline/jobs/{id}/claim route handler"
```

---

### Task 13: Pipeline — job result chaining logic

**Files:**
- Create: `web/lib/api-server/job-result.ts`

Port `_apply_job_result` from `pipeline_routes.py:161-298`. This is the most complex piece — handles the download → fingerprint → cover_art → metadata auto-queuing chain.

- [ ] **Step 1: Create job result module**

The implementer should read `pipeline_routes.py:161-298` carefully and port the full match/case logic. Key behaviors:

- **download** result: update track to `available`, set `local_path`, auto-queue `fingerprint` job
- **fingerprint** result: insert fingerprint row, check for duplicates against in-library tracks, if duplicate mark track, else auto-queue `cover_art` job
- **cover_art** result: update `cover_art_written` flag, auto-queue `metadata` job with full track metadata
- **metadata** result: update `metadata_written` flag and optionally `local_path`

Each case does multiple sequential DB operations. Use the Supabase service client for each query.

```typescript
// web/lib/api-server/job-result.ts
import { SupabaseClient } from "@supabase/supabase-js";

export async function applyJobResult(
  supabase: SupabaseClient,
  jobId: string,
  userId: string,
  jobType: string,
  result: Record<string, unknown>
): Promise<void> {
  // Get track_id for this job
  const { data: job } = await supabase
    .from("pipeline_jobs")
    .select("track_id")
    .eq("id", jobId)
    .single();

  if (!job?.track_id) return;
  const trackId = job.track_id;

  switch (jobType) {
    case "download":
      await handleDownloadResult(supabase, userId, trackId, result);
      break;
    case "fingerprint":
      await handleFingerprintResult(supabase, userId, trackId, result);
      break;
    case "cover_art":
      await handleCoverArtResult(supabase, userId, trackId, result);
      break;
    case "metadata":
      await handleMetadataResult(supabase, userId, trackId, result);
      break;
  }
}

// Implementer: port each handler from pipeline_routes.py:169-298
// Each function follows the same pattern:
// 1. Update the track row with the result
// 2. Auto-queue the next pipeline job if applicable

async function handleDownloadResult(
  supabase: SupabaseClient,
  userId: string,
  trackId: number,
  result: Record<string, unknown>
) {
  const localPath = result.local_path as string | undefined;
  if (!localPath) return;

  await supabase
    .from("tracks")
    .update({
      acquisition_status: "available",
      local_path: localPath,
      updated_at: new Date().toISOString(),
    })
    .eq("id", trackId)
    .eq("user_id", userId);

  // Auto-queue fingerprint job
  await supabase.from("pipeline_jobs").insert({
    user_id: userId,
    track_id: trackId,
    job_type: "fingerprint",
    payload: { track_id: trackId, local_path: localPath },
  });
}

// handleFingerprintResult, handleCoverArtResult, handleMetadataResult
// follow the same pattern — port from pipeline_routes.py:187-298
async function handleFingerprintResult(
  supabase: SupabaseClient,
  userId: string,
  trackId: number,
  result: Record<string, unknown>
) {
  // Port from pipeline_routes.py:187-236
  // Insert fingerprint, check duplicates, auto-queue cover_art
  // Implementer: read the Python source for full logic
}

async function handleCoverArtResult(
  supabase: SupabaseClient,
  userId: string,
  trackId: number,
  result: Record<string, unknown>
) {
  // Port from pipeline_routes.py:250-298
  // Update cover_art_written, auto-queue metadata job with full track data
  // Implementer: read the Python source for full logic
}

async function handleMetadataResult(
  supabase: SupabaseClient,
  userId: string,
  trackId: number,
  result: Record<string, unknown>
) {
  // Port from pipeline_routes.py:238-248
  const updates: Record<string, unknown> = {
    metadata_written: true,
    updated_at: new Date().toISOString(),
  };
  if (result.local_path) {
    updates.local_path = result.local_path;
  }
  await supabase
    .from("tracks")
    .update(updates)
    .eq("id", trackId)
    .eq("user_id", userId);
}
```

- [ ] **Step 2: Commit**

```bash
git add web/lib/api-server/job-result.ts
git commit -m "feat: port job result chaining logic (download→fingerprint→cover_art→metadata)"
```

---

### Task 14: Pipeline — report job result (PUT /api/pipeline/jobs/[id]/result)

**Files:**
- Create: `web/app/api/pipeline/jobs/[id]/result/route.ts`

Port from `pipeline_routes.py:610-693`. Uses the `applyJobResult` from Task 13.

- [ ] **Step 1: Create route handler**

Key logic:
1. Validate status is `done` or `failed`
2. Verify job belongs to user
3. Update job row (status, result, error, completed_at)
4. If `done` + has result → call `applyJobResult()`
5. If `failed` + download type → retry logic (up to 3 retries, then mark track failed)
6. Audit log

The implementer should read `pipeline_routes.py:610-693` for full logic.

- [ ] **Step 2: Test with curl**

- [ ] **Step 3: Commit**

```bash
git add "web/app/api/pipeline/jobs/[id]/result/route.ts"
git commit -m "feat: port PUT /api/pipeline/jobs/{id}/result route handler"
```

---

### Task 15: Pipeline — remaining routes (history, retry, status)

**Files:**
- Create: `web/app/api/pipeline/jobs/history/route.ts`
- Create: `web/app/api/pipeline/jobs/retry/route.ts`
- Create: `web/app/api/pipeline/status/route.ts`

- [ ] **Step 1: Port job history** — from `pipeline_routes.py:703-777`. Paginated list with optional status/type filters. Uses LEFT JOIN to `tracks` for enriched data (title, artist, artwork_url, album).

- [ ] **Step 2: Port retry jobs** — from `pipeline_routes.py:401-477`. Reset failed/done jobs to pending. Two modes: explicit job_ids list, or filter by status/type.

- [ ] **Step 3: Port pipeline status** — from `pipeline_routes.py:780-810`. Returns pending/running counts + agent list.

- [ ] **Step 4: Test each route with curl**

- [ ] **Step 5: Commit**

```bash
git add web/app/api/pipeline/
git commit -m "feat: port pipeline history, retry, and status route handlers"
```

---

## Chunk 3: Catalog + Agent Routes (Phase 2b)

### Task 16: Catalog — list tracks (GET /api/catalog/tracks)

**Files:**
- Create: `web/app/api/catalog/tracks/route.ts`

Port from `catalog_routes.py:572-632`. Paginated, filterable track list with `already_owned` lateral join.

- [ ] **Step 1: Create route handler**

Key logic: pagination (page, per_page), optional status filter, optional search (ILIKE on title/artist), optional id filter. The `already_owned` lateral join checks if another track with same spotify_uri has status `available`. This may need raw SQL or an RPC function.

- [ ] **Step 2: Test with curl**

- [ ] **Step 3: Commit**

```bash
git add web/app/api/catalog/tracks/route.ts
git commit -m "feat: port GET /api/catalog/tracks route handler"
```

---

### Task 17: Catalog — single track, bulk delete, reset

**Files:**
- Create: `web/app/api/catalog/tracks/[id]/route.ts`
- Create: `web/app/api/catalog/tracks/bulk/route.ts`
- Create: `web/app/api/catalog/tracks/[id]/reset/route.ts`

- [ ] **Step 1: Port single track** — from `catalog_routes.py:635-649`. Simple SELECT by id + user_id.

- [ ] **Step 2: Port bulk delete** — from `catalog_routes.py:918-950`. DELETE candidates owned by user. Return `{ deleted: N }`.

- [ ] **Step 3: Port track reset** — from `catalog_routes.py:953-991`. Reset failed → candidate, create new download job.

- [ ] **Step 4: Test each route**

- [ ] **Step 5: Commit**

```bash
git add "web/app/api/catalog/tracks/"
git commit -m "feat: port catalog track detail, bulk delete, and reset route handlers"
```

---

### Task 18: Catalog — stats and CSV import

**Files:**
- Create: `web/app/api/catalog/stats/route.ts`
- Create: `web/app/api/catalog/import/csv/route.ts`

- [ ] **Step 1: Port catalog stats** — from `catalog_routes.py:652-684`. Aggregate counts by status + processing flags. Uses FILTER (WHERE ...) clauses — may need raw SQL or RPC.

- [ ] **Step 2: Port CSV import** — from `catalog_routes.py:687-735`. Parse multipart form data, extract CSV file, validate (4MB limit, .csv extension), parse with the Exportify parser logic, insert tracks + create jobs.

Note: The Python `parse_csv_rows()` from `djtoolkit/importers/exportify.py` needs to be reimplemented in TypeScript. The implementer should read that file to understand the CSV column mapping. Key columns: Track URI, Track Name, Artist Name(s), Album Name, Duration (ms), Added At, etc.

- [ ] **Step 3: Test CSV import with curl**

```bash
curl -X POST -F "file=@test.csv" -H "Authorization: Bearer <jwt>" \
  http://localhost:3000/api/catalog/import/csv
```

- [ ] **Step 4: Commit**

```bash
git add web/app/api/catalog/stats/route.ts web/app/api/catalog/import/csv/route.ts
git commit -m "feat: port catalog stats and CSV import route handlers"
```

---

### Task 19: Agent management routes

**Files:**
- Create: `web/app/api/agents/route.ts`
- Create: `web/app/api/agents/register/route.ts`
- Create: `web/app/api/agents/heartbeat/route.ts`
- Create: `web/app/api/agents/[id]/route.ts`

- [ ] **Step 1: Port list agents** — from `auth_routes.py:131-154`. GET, return all agents for user.

- [ ] **Step 2: Port register agent** — from `auth_routes.py:57-90`. Generate `djt_` key with bcrypt hash, insert into agents table, return plain key once.

```typescript
import bcrypt from "bcryptjs";
import crypto from "crypto";

function createAgentKey(): { plain: string; hash: string; prefix: string } {
  const plain = "djt_" + crypto.randomBytes(20).toString("hex");
  const hash = bcrypt.hashSync(plain, 10);
  const prefix = plain.slice(4, 12);
  return { plain, hash, prefix };
}
```

- [ ] **Step 3: Port heartbeat** — from `auth_routes.py:93-128`. Update `last_seen_at`, optionally update capabilities/version/active_jobs. Must require agent key auth (not JWT).

- [ ] **Step 4: Port delete agent** — from `auth_routes.py:157-183`. DELETE by id + user_id.

- [ ] **Step 5: Test each route with curl**

- [ ] **Step 6: Commit**

```bash
git add web/app/api/agents/
git commit -m "feat: port agent management route handlers (register, heartbeat, list, delete)"
```

---

### Task 20: Spotify OAuth routes

**Files:**
- Create: `web/app/api/auth/spotify/connect/route.ts`
- Create: `web/app/api/auth/spotify/callback/route.ts`
- Create: `web/app/api/auth/spotify/disconnect/route.ts`

- [ ] **Step 1: Port connect** — from `spotify_auth_routes.py:98-127`. Verify JWT from query param, create state in `oauth_states` table (NOT in-memory), redirect to Spotify authorize URL.

- [ ] **Step 2: Port callback** — from `spotify_auth_routes.py:130-202`. Look up + delete state from `oauth_states` table, exchange code for tokens, encrypt with Fernet, upsert into users table, redirect to frontend.

- [ ] **Step 3: Port disconnect** — from `spotify_auth_routes.py:205-220`. Clear spotify tokens from users table.

- [ ] **Step 4: Test OAuth flow manually in browser**

- [ ] **Step 5: Commit**

```bash
git add web/app/api/auth/spotify/
git commit -m "feat: port Spotify OAuth routes with DB-backed state store"
```

---

### Task 21: Spotify import + playlists + artwork backfill

**Files:**
- Create: `web/app/api/catalog/import/spotify/route.ts`
- Create: `web/app/api/catalog/import/spotify/playlists/route.ts`
- Create: `web/app/api/catalog/backfill-artwork/route.ts`

- [ ] **Step 1: Port playlist listing** — from `catalog_routes.py:794-836`. Paginate Spotify `/me/playlists`, return formatted list. Uses Fernet to decrypt stored access token.

- [ ] **Step 2: Port Spotify import** — from `catalog_routes.py:743-791`. Paginate playlist items from Spotify API, map to track schema, insert + create jobs. Note 10s timeout risk: for playlists > 500 tracks, consider returning after first batch and letting frontend paginate.

- [ ] **Step 3: Port artwork backfill** — from `catalog_routes.py:1005-1066`. Batch fetch from Spotify `/v1/tracks` (50 IDs per request). Process one batch per invocation to stay within 10s timeout: accept `offset` query param, return `{ updated, total_missing, next_offset }`.

- [ ] **Step 4: Test with Spotify-connected account**

- [ ] **Step 5: Commit**

```bash
git add web/app/api/catalog/import/spotify/ web/app/api/catalog/backfill-artwork/route.ts
git commit -m "feat: port Spotify import, playlists, and artwork backfill route handlers"
```

---

## Chunk 4: Real-Time, TrackID, Cutover (Phase 3-5)

### Task 22: Replace SSE with Supabase Realtime

**Files:**
- Modify: `web/app/(app)/pipeline/page.tsx`
- Modify: `web/app/(app)/catalog/page.tsx` (optional — add track change subscription)

- [ ] **Step 1: Update pipeline page — remove EventSource, add Realtime**

Replace the SSE `useEffect` block in `pipeline/page.tsx` with:

```typescript
useEffect(() => {
  const supabase = createClient();

  const channel = supabase
    .channel("pipeline-jobs")
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "pipeline_jobs",
        filter: `user_id=eq.${userId}`,
      },
      (payload) => {
        const { eventType, new: newRow } = payload;
        setEvents((prev) => [
          `${new Date().toLocaleTimeString()} — ${eventType}: ${newRow?.job_type ?? "unknown"} ${newRow?.status ?? ""}`,
          ...prev.slice(0, 49),
        ]);
        scheduleRefresh();
      }
    )
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
  };
}, [userId]);
```

The implementer needs to ensure `userId` is available (from the Supabase session, already fetched in the component).

- [ ] **Step 2: Remove the `API_URL` constant** that was only used for SSE.

- [ ] **Step 3: Test — trigger a job from the agent, verify pipeline page updates in real-time**

- [ ] **Step 4: Commit**

```bash
git add web/app/(app)/pipeline/page.tsx
git commit -m "feat: replace SSE EventSource with Supabase Realtime subscriptions"
```

---

### Task 23: TrackID import routes + Supabase Edge Function

**Files:**
- Create: `web/app/api/catalog/import/trackid/route.ts`
- Create: `web/app/api/catalog/import/trackid/[jobId]/status/route.ts`
- Create: `supabase/functions/trackid-poll/index.ts`

- [ ] **Step 1: Port TrackID import route** — from `catalog_routes.py:843-901`. Validate URL, check cache (`trackid_url_cache` table), create `trackid_import_jobs` row, invoke Supabase Edge Function.

```typescript
// Key difference from Python: instead of BackgroundTasks, invoke Edge Function
const supabase = createServiceClient();
const { error } = await supabase.functions.invoke("trackid-poll", {
  body: { job_id: localJobId, url: normalizedUrl, user_id: user.userId, queue_jobs: queueJobs },
});
```

- [ ] **Step 2: Port TrackID status route** — from `catalog_routes.py:904-915`. Simple SELECT from `trackid_import_jobs`.

- [ ] **Step 3: Create Supabase Edge Function**

Port `_run_trackid_background` from `catalog_routes.py:143-276` to Deno/TypeScript.

```typescript
// supabase/functions/trackid-poll/index.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

serve(async (req) => {
  const { job_id, url, user_id, queue_jobs } = await req.json();

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // 1. Submit to TrackID.dev
  // 2. Poll with 7s intervals (up to 120s to stay within 150s Edge Function limit)
  // 3. If not done after 120s, re-invoke self (relay pattern)
  // 4. On completion: filter/dedupe tracks, save to cache, insert tracks

  // Implementer: port the full logic from catalog_routes.py:163-276
  // Key differences:
  // - Use fetch() instead of httpx
  // - Use supabase client instead of asyncpg pool
  // - Add relay pattern: if elapsed > 120s, invoke self with trackid_job_id

  return new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json" },
  });
});
```

- [ ] **Step 4: Deploy Edge Function**

```bash
supabase functions deploy trackid-poll
```

- [ ] **Step 5: Test end-to-end with a YouTube URL**

- [ ] **Step 6: Commit**

```bash
git add web/app/api/catalog/import/trackid/ supabase/functions/trackid-poll/
git commit -m "feat: port TrackID import with Supabase Edge Function for long-polling"
```

---

### Task 24: End-to-end verification

- [ ] **Step 1: Deploy to Vercel preview**

Push branch to GitHub. Vercel auto-deploys a preview URL.

- [ ] **Step 2: Configure Vercel environment variables**

In Vercel Dashboard → Settings → Environment Variables, add all server-side vars from `.env.local.example` (Task 1, Step 4).

- [ ] **Step 3: Test full flow on preview URL**

1. Sign up / log in
2. Connect Spotify
3. Import a playlist (or upload CSV)
4. Verify tracks appear in catalog
5. Queue downloads (bulk create jobs)
6. Point local agent at preview URL, verify it can claim + complete jobs
7. Verify pipeline page shows real-time updates via Supabase Realtime
8. Test TrackID import with a YouTube URL

- [ ] **Step 4: Verify agent response format compatibility**

Run the local agent against the Vercel preview URL. Check:
- Job fetch returns same JSON shape
- Batch claim returns same JSON shape
- Job result PUT accepts same request body
- Heartbeat returns 204

If any response format differs (e.g., FastAPI returns `422` with `{"detail": [...]}` for validation errors, but Next.js returns differently), adjust the route handlers to match.

- [ ] **Step 5: Document any issues found**

---

### Task 25: DNS cutover

- [ ] **Step 1: Point djtoolkit.com DNS to Vercel**

In your DNS provider, update the A/CNAME records to point to Vercel:
- Add `CNAME djtoolkit.com → cname.vercel-dns.com`
- Or follow Vercel's custom domain setup in Dashboard → Settings → Domains

- [ ] **Step 2: Update Spotify OAuth callback URL**

In Spotify Developer Dashboard, update the redirect URI to `https://djtoolkit.com/api/auth/spotify/callback`.

Update `SPOTIFY_CALLBACK_URL` in Vercel env vars.

- [ ] **Step 3: Verify production works**

Repeat the test flow from Task 24 Step 3 on the production domain.

- [ ] **Step 4: Decommission Hetzner VPS**

Once verified, shut down the Hetzner VPS. Keep it running for 24-48h as a rollback safety net before deleting.

---

### Task 26: Cleanup — delete infrastructure files

**Files to delete:**
- `docker-compose.yml`
- `Dockerfile`
- `web/Dockerfile`
- `nginx/djtoolkit.conf`
- `deploy/setup.sh`
- `.github/workflows/deploy.yml`

**Files to modify:**
- `.github/workflows/ci.yml` — remove the Docker build steps, keep Python tests and web lint/build
- `CLAUDE.md` — update to reflect Vercel deployment

- [ ] **Step 1: Delete infrastructure files**

```bash
rm docker-compose.yml Dockerfile web/Dockerfile nginx/djtoolkit.conf deploy/setup.sh .github/workflows/deploy.yml
rmdir nginx/ deploy/ 2>/dev/null || true
```

- [ ] **Step 2: Update CI workflow**

Remove Docker image build/push jobs from `ci.yml`. Keep `test-api` (Python) and `test-web` (lint + build) jobs.

- [ ] **Step 3: Update CLAUDE.md**

Update the deployment section to reflect Vercel. Remove Docker/Nginx/Hetzner references. Add Vercel deployment commands.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: remove Hetzner infrastructure files, update CI for Vercel"
```

---

### Task 27: Cleanup — delete FastAPI backend files

**Files to delete:**
- `djtoolkit/api/app.py`
- `djtoolkit/api/catalog_routes.py`
- `djtoolkit/api/pipeline_routes.py`
- `djtoolkit/api/spotify_auth_routes.py`
- `djtoolkit/api/auth_routes.py`
- `djtoolkit/api/auth.py`
- `djtoolkit/api/audit.py`
- `djtoolkit/api/rate_limit.py`
- `djtoolkit/db/postgres.py`

- [ ] **Step 1: Delete Python API files**

```bash
rm djtoolkit/api/app.py djtoolkit/api/catalog_routes.py djtoolkit/api/pipeline_routes.py
rm djtoolkit/api/spotify_auth_routes.py djtoolkit/api/auth_routes.py
rm djtoolkit/api/auth.py djtoolkit/api/audit.py djtoolkit/api/rate_limit.py
rm djtoolkit/db/postgres.py
```

- [ ] **Step 2: Verify local agent still works**

```bash
poetry run pytest
make download  # test with a candidate track
```

The local agent uses `djtoolkit/db/database.py` (SQLite), not `postgres.py`. Deleting `postgres.py` should not affect the agent.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "chore: remove FastAPI backend — API now runs as Vercel route handlers"
```
