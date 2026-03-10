# SaaS Multi-Tenant Architecture for djtoolkit

## Context

djtoolkit is currently a single-user CLI + local FastAPI tool with no auth, a single SQLite DB, and hard dependencies on locally-running services (slskd Docker container, fpcalc binary). The goal is to transform it into a SaaS platform where customers:
1. Connect their own Spotify accounts (OAuth) or upload Exportify CSVs
2. Get an isolated music catalog per account
3. Run a lightweight local agent on their laptop/PC to handle downloads and file processing (since fpcalc, librosa, and the actual music files must stay local)

---

## System Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        CLOUD PLATFORM                               │
│                                                                     │
│  ┌─────────────┐   ┌──────────────┐   ┌───────────────────────┐   │
│  │  Web UI      │   │  Auth        │   │  Spotify OAuth        │   │
│  │ (React/Next) │   │ (Clerk/Auth0)│   │  (per-user tokens)    │   │
│  └─────────────┘   └──────────────┘   └───────────────────────┘   │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                   FastAPI Gateway                            │   │
│  │  POST /auth/spotify/connect                                  │   │
│  │  POST /catalog/import/csv      POST /catalog/import/spotify  │   │
│  │  GET  /catalog/tracks          GET  /catalog/stats           │   │
│  │  GET  /pipeline/jobs           POST /pipeline/jobs/{id}/claim│   │
│  │  PUT  /pipeline/jobs/{id}/result                             │   │
│  │  GET  /agents                  POST /agents/register         │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌────────────────┐  ┌──────────────┐  ┌──────────────────────┐   │
│  │  PostgreSQL     │  │  Redis       │  │  S3 / R2             │   │
│  │  (catalog +     │  │  (sessions,  │  │  (CSV uploads,       │   │
│  │   user state)   │  │   rate limit)│  │   cover art cache)   │   │
│  └────────────────┘  └──────────────┘  └──────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
                                │
                     HTTPS REST (polling)
                                │
┌─────────────────────────────────────────────────────────────────────┐
│                    CUSTOMER'S LAPTOP / PC                           │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                  djtoolkit Local Agent                        │  │
│  │  - Authenticates with cloud API key                          │  │
│  │  - Polls GET /pipeline/jobs every 30s                        │  │
│  │  - Claims and executes jobs locally:                         │  │
│  │      download    → aioslsk P2P → local file                  │  │
│  │      fingerprint → fpcalc → chromaprint hash                 │  │
│  │      metadata    → mutagen → writes tags to local file       │  │
│  │      cover_art   → fetches + embeds art locally              │  │
│  │  - Reports metadata results to cloud (no file upload)        │  │
│  │  - Maintains local SQLite mirror for offline resilience      │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌──────────────────────────────┐  ┌──────────────────────────┐   │
│  │  Local SQLite DB              │  │  ~/Music/DJ/             │   │
│  │  (subset of catalog)          │  │  (actual files)          │   │
│  └──────────────────────────────┘  └──────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

**Core principle**: Cloud owns the *catalog state* (metadata, pipeline status, user accounts). The customer's machine owns the *files* and *processing capabilities*. They stay in sync via a REST polling protocol.

---

## Soulseek Client: aioslsk (replaces slskd)

Current djtoolkit depends on a local slskd Docker container. For SaaS, this is replaced by **[aioslsk](https://github.com/JurgenR/aioslsk)** — a pure Python asyncio library for the Soulseek protocol.

| | slskd (current) | aioslsk (SaaS) |
|---|---|---|
| Install | Docker + docker-compose | `pip install djtoolkit` |
| Runs as | Separate Docker container | Embedded in local agent process |
| Credentials | slskd web UI / config | `djtoolkit.toml [soulseek]` |
| Progress tracking | Poll REST API every 2s | Async events (push) |
| Python version | N/A (Go binary) | 3.10–3.14 |
| Latest release | — | v1.6.3 (Feb 2026) |
| License | MIT | **GPL-3.0** — see Security section |

```python
# aioslsk download pattern (replaces slskd.py)
from aioslsk.client import SoulSeekClient
from aioslsk.commands import GlobalSearchCommand
from aioslsk.events import TransferStateChangedEvent
from aioslsk.transfer.model import TransferState

async def search_and_download(cfg, artist, title, duration_ms):
    async with SoulSeekClient(settings_from_cfg(cfg)) as client:
        await client.login()
        results = await client.execute(GlobalSearchCommand(f"{artist} {title}"))
        best = rank_results(results, artist, title, duration_ms)  # reuse existing scoring

        transfer = await client.transfers.download(best.username, best.filename)

        done = asyncio.Event()
        def on_state(event: TransferStateChangedEvent):
            if event.transfer is transfer and event.state in (
                TransferState.COMPLETE, TransferState.FAILED, TransferState.ABORTED
            ):
                done.set()

        client.events.register(TransferStateChangedEvent, on_state)
        await asyncio.wait_for(done.wait(), timeout=cfg.agent.download_timeout_sec)
        return transfer.local_path
```

The fuzzy matching/scoring logic in `slskd.py` (thefuzz, duration tolerance, format preference) carries over unchanged — aioslsk just delivers raw results to rank.

---

## Multi-Tenant Database Schema (PostgreSQL)

### New Tables

```sql
-- Platform users
CREATE TABLE users (
    id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email                     TEXT UNIQUE NOT NULL,
    -- Spotify OAuth tokens (encrypted at rest with AES-256)
    spotify_access_token      TEXT,
    spotify_refresh_token     TEXT,
    spotify_token_expires_at  TIMESTAMPTZ,
    spotify_user_id           TEXT,
    created_at                TIMESTAMPTZ DEFAULT NOW(),
    updated_at                TIMESTAMPTZ DEFAULT NOW()
);

-- Registered local agents (one per machine per user)
CREATE TABLE agents (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    api_key_hash    TEXT NOT NULL,      -- bcrypt hash; key shown to user once
    machine_name    TEXT,               -- e.g. "MacBook Pro"
    last_seen_at    TIMESTAMPTZ,
    capabilities    TEXT[],             -- ['aioslsk', 'fpcalc', 'librosa', 'essentia']
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Async job queue: cloud creates, local agent claims and executes
CREATE TABLE pipeline_jobs (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    agent_id     UUID REFERENCES agents(id),  -- NULL = any agent for this user
    track_id     BIGINT REFERENCES tracks(id) ON DELETE CASCADE,
    job_type     TEXT NOT NULL,   -- 'download' | 'fingerprint' | 'metadata' | 'cover_art'
    status       TEXT NOT NULL DEFAULT 'pending',
    priority     INT DEFAULT 0,
    payload      JSONB,           -- job params (search_string, metadata_source, etc.)
    result       JSONB,           -- local_path, fingerprint, audio features, etc.
    error        TEXT,
    claimed_at   TIMESTAMPTZ,
    started_at   TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    CHECK (status IN ('pending','claimed','running','done','failed'))
);
CREATE INDEX ON pipeline_jobs(user_id, status, created_at);
CREATE INDEX ON pipeline_jobs(agent_id, status);
```

### Modified Tables (add user_id)

```sql
-- tracks: add user_id, make dedup per-user
ALTER TABLE tracks ADD COLUMN user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE tracks DROP CONSTRAINT tracks_spotify_uri_key;
ALTER TABLE tracks ADD UNIQUE (user_id, spotify_uri);

-- fingerprints: add user_id
ALTER TABLE fingerprints ADD COLUMN user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE;

-- track_embeddings: no change needed (isolated via track_id FK)
```

### Row-Level Security (PostgreSQL RLS)

```sql
ALTER TABLE tracks ENABLE ROW LEVEL SECURITY;
CREATE POLICY tracks_isolation ON tracks
    USING (user_id = current_setting('app.current_user_id')::UUID);

-- Same pattern for fingerprints, pipeline_jobs, agents
```

API middleware sets `SET LOCAL app.current_user_id = '<jwt_sub>'` at the start of every request transaction.

---

## Authentication System

### 1. Platform Auth

Use **Clerk** (managed) or **Auth0**:
- Email/password + social login (Google)
- JWT with `sub` claim = `user_id`
- Webhook to create `users` row on first sign-in

### 2. Spotify OAuth2 (Per-User)

```
User clicks "Connect Spotify"
    → Cloud redirects to: https://accounts.spotify.com/authorize
        ?client_id=PLATFORM_SPOTIFY_CLIENT_ID
        &redirect_uri=https://app.djtoolkit.com/callback/spotify
        &scope=playlist-read-private,playlist-read-collaborative
        &state=<signed_jwt_with_user_id>
        &code_challenge=<PKCE>

Spotify redirects to callback with ?code=...
    → Cloud exchanges code for access_token + refresh_token
    → Encrypts tokens with AES-256, stores in users table
    → UI can now call POST /catalog/import/spotify
```

**Token refresh**: Background job checks `spotify_token_expires_at`, refreshes 5 min before expiry. The platform uses a single Spotify app for all users (standard OAuth2 multi-user pattern).

### 3. Local Agent API Key

```
User generates agent key in web UI
    → Cloud creates agents row, returns API key ONCE (plain text)
    → Agent stores key in ~/.djtoolkit/agent.env  (DJTOOLKIT_AGENT_KEY=xxx)
    → All agent requests: Authorization: Bearer <key>
    → Cloud verifies: bcrypt.verify(key, agents.api_key_hash)
```

---

## Spotify Import Flow

```
POST /catalog/import/spotify
    Body: { playlist_id: "spotify:playlist:37i9dQZF1DX..." }

Cloud:
  1. Decrypt user's Spotify tokens
  2. GET https://api.spotify.com/v1/playlists/{id}/tracks  (paginated)
  3. Map each track → tracks row (same fields as exportify.py)
  4. INSERT ON CONFLICT (user_id, spotify_uri) DO NOTHING
  5. Create pipeline_jobs: job_type='download' for each new candidate
  6. Return: { imported: 142, skipped_duplicates: 8, jobs_created: 134 }
```

Spotify API calls happen server-side with per-user tokens — no rate limit sharing between users.

---

## CSV Upload Flow

```
POST /catalog/import/csv  (multipart/form-data)
  1. Validate file (MIME type, max 10MB)
  2. Store in S3/R2 at users/{user_id}/imports/{uuid}.csv
  3. Async: parse CSV (reuse exportify.py logic), insert tracks, create jobs
  4. Return: { job_id }  (poll GET /pipeline/status for progress)
```

---

## Local Agent Design

### Installation

```bash
pip install djtoolkit        # no Docker required
djtoolkit agent configure \
    --cloud-url https://api.djtoolkit.com \
    --api-key <KEY_FROM_WEB_UI>

# Run as foreground process, or install as systemd/launchd service
djtoolkit agent start
```

### Agent Config Extension (djtoolkit.toml)

```toml
[agent]
cloud_url         = "https://api.djtoolkit.com"
api_key           = ""    # env: DJTOOLKIT_AGENT_KEY
poll_interval_sec = 30
max_concurrent_jobs = 2

[soulseek]
username     = ""         # Soulseek account credentials
password     = ""         # env: SOULSEEK_PASSWORD
download_dir = "~/Music/DJ/downloads"
```

### Agent Polling Loop

```python
# djtoolkit/agent/runner.py  (NEW)
async def run_agent(cfg):
    await register_or_heartbeat(cfg)      # POST /agents/heartbeat

    while True:
        jobs = await fetch_pending_jobs(cfg)   # GET /pipeline/jobs?status=pending&limit=5

        for job in jobs:
            claimed = await claim_job(cfg, job["id"])  # POST /pipeline/jobs/{id}/claim
            if not claimed:
                continue   # another agent claimed it first

            try:
                result = await execute_job(cfg, job)
                await report_result(cfg, job["id"], "done", result)
            except Exception as e:
                await report_result(cfg, job["id"], "failed", error=str(e))

        await asyncio.sleep(cfg.agent.poll_interval_sec)
```

### Job Execution (reuses existing modules)

```python
async def execute_job(cfg, job):
    match job["job_type"]:
        case "download":
            # djtoolkit/downloader/aioslsk_client.py  (NEW — replaces slskd.py)
            result = await run_download_job(cfg, job["payload"])
            # returns: { local_path, file_format, file_size }

        case "fingerprint":
            # djtoolkit/fingerprint/chromaprint.py  (unchanged)
            result = await run_fingerprint_job(cfg, job["payload"])
            # returns: { fingerprint, acoustid, duration, is_duplicate }

        case "metadata":
            # djtoolkit/metadata/writer.py  (unchanged)
            result = await run_metadata_job(cfg, job["payload"])
            # returns: { local_path (after rename), metadata_written: true }

        case "cover_art":
            # djtoolkit/coverart/art.py  (unchanged)
            result = await run_cover_art_job(cfg, job["payload"])
            # returns: { cover_art_written: true, source_used: "itunes" }

    return result
```

### Local SQLite Mirror

The agent maintains a local SQLite DB (same schema, subset of the user's tracks) for:
- Offline resilience: agent queues work when cloud is unreachable
- Idempotency: avoids re-processing after agent restart
- Local-only state: `local_path` is machine-specific, not global

Sync strategy: agent fetches work-needing tracks from cloud on startup; writes results back immediately after each job.

---

## Cloud API Design

### Auth Middleware

```python
# Accepts both JWT (web UI) and opaque API key (local agent)
async def get_current_user(authorization: str = Header(...)) -> User:
    if authorization.startswith("Bearer "):
        token = authorization[7:]
        if is_jwt(token):
            return verify_jwt(token)        # web UI user
        else:
            return verify_agent_key(token)  # local agent
    raise HTTPException(401)
```

### Route Structure

```
/auth/
  POST   /auth/spotify/connect              → initiate Spotify OAuth
  GET    /auth/spotify/callback             → OAuth callback, store tokens
  POST   /auth/spotify/disconnect           → revoke + delete tokens

/catalog/
  GET    /catalog/tracks                    → paginated, filterable (RLS-scoped)
  GET    /catalog/tracks/{id}               → single track
  GET    /catalog/stats                     → counts by status + flags
  POST   /catalog/import/csv               → upload Exportify CSV
  POST   /catalog/import/spotify           → import from connected Spotify playlist
  GET    /catalog/import/spotify/playlists → list user's Spotify playlists
  POST   /catalog/tracks/{id}/reset        → retry a failed track

/pipeline/
  GET    /pipeline/jobs                     → pending jobs for this user
  POST   /pipeline/jobs/{id}/claim          → agent atomically claims a job
  PUT    /pipeline/jobs/{id}/result         → agent reports result + metadata
  GET    /pipeline/status                   → queue depth + agent health
  GET    /pipeline/events                   → SSE stream for real-time UI updates

/agents/
  GET    /agents                            → list user's agents
  POST   /agents/register                   → register agent, returns API key once
  POST   /agents/heartbeat                  → update last_seen_at
  DELETE /agents/{id}                       → revoke agent

/admin/  (platform operator only)
  GET    /admin/users                       → user list
  GET    /admin/metrics                     → queue depth, agent activity
```

### Atomic Job Claim (FOR UPDATE SKIP LOCKED)

```sql
UPDATE pipeline_jobs
SET status = 'claimed', claimed_at = NOW(), agent_id = $1
WHERE id = (
    SELECT id FROM pipeline_jobs
    WHERE user_id = $2 AND status = 'pending'
    ORDER BY priority DESC, created_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1
)
RETURNING *;
```

### Stale Job Recovery

```python
# Background task, runs every 5 minutes
async def recover_stale_jobs():
    await db.execute("""
        UPDATE pipeline_jobs
        SET status = 'pending', claimed_at = NULL, agent_id = NULL
        WHERE status = 'claimed'
          AND claimed_at < NOW() - INTERVAL '5 minutes'
    """)
```

---

## Infrastructure Stack

| Layer | Service | Rationale |
|-------|---------|-----------|
| Auth | Clerk or Auth0 | Managed, JWT, social login, webhooks |
| API | FastAPI (Python) | Extends existing codebase directly |
| Database | PostgreSQL (Supabase or Railway) | Multi-tenant RLS, JSONB for job payloads |
| Job Queue | DB-backed (`pipeline_jobs` table) | Simple, durable; no extra infra needed at MVP scale |
| File Storage | Cloudflare R2 or AWS S3 | CSV uploads, optional cover art CDN |
| Cache / Rate limit | Redis (Upstash) | Session store, per-user rate limiting |
| Hosting | Railway or Render | Simple Python deployment |
| Local Agent | pip package | `pip install djtoolkit` — no Docker needed |
| Soulseek client | aioslsk (embedded) | Pure Python, Python 3.10-3.14, v1.6.3, GPL-3 |
| Monitoring | Sentry + Posthog | Error tracking + usage analytics |

**Why DB-backed queue instead of Redis/Celery?** Downloads take minutes, volume is low (hundreds of jobs/day per user), and the queue needs durable state (jobs survive agent restarts). `FOR UPDATE SKIP LOCKED` covers all of this. Upgrade to Celery only if horizontal API scaling demands it.

---

## Web UI Changes

Replace `ui/index.html` with a React + Next.js app (or keep vanilla JS for MVP), adding:

- **Login page** — Clerk/Auth0 hosted or embedded components
- **Spotify Connect** — OAuth button, playlist browser
- **CSV Upload** — drag-and-drop, parse progress indicator
- **Pipeline dashboard** — active agent status, job queue depth, per-track pipeline state
- **Agent setup wizard** — step-by-step: install → configure → start agent
- **Real-time updates** — SSE on `GET /pipeline/events` replaces manual refresh

---

## Migration Path for Existing Users

1. **Self-hosted mode preserved**: `djtoolkit serve` still works with `djtoolkit.toml` + local SQLite. SaaS is opt-in.

2. **Migrate to SaaS**:
   ```bash
   djtoolkit migrate-to-cloud \
       --cloud-url https://api.djtoolkit.com \
       --api-key <KEY>
   # Reads local SQLite → POSTs tracks to cloud catalog
   # Switches djtoolkit.toml to [agent] cloud mode
   ```

3. **local_path** becomes machine-specific — cloud stores it per-agent in `pipeline_jobs.result`, not globally on the track row.

---

## Security Considerations

- **Spotify tokens**: AES-256 encrypted before storing in DB. Use a KMS (AWS KMS or Cloudflare Workers Secrets) — never store the encryption key in the DB.
- **Agent API keys**: Displayed to user once; only bcrypt hash stored. Rotation: generate new key, revoke old.
- **Rate limiting**: Per-user limits on `/catalog/import/spotify` (Spotify quota) and `/pipeline/jobs` polling (prevent flooding).
- **CSV uploads**: Validate MIME type + max 10MB size; parse server-side only; store in private S3/R2 bucket (no public URLs).
- **CORS**: Restrict web UI routes to `app.djtoolkit.com`; agent routes accept any origin but require API key.
- **Soulseek credentials**: Stored locally in `djtoolkit.toml [soulseek]` on the customer's machine — never transmitted to cloud.
- **aioslsk GPL-3 license**: If the agent is shipped as a closed-source binary, GPL-3 requires source availability. Options: (a) keep the agent open-source (the SaaS catalog and UX are the moat), or (b) negotiate a commercial license with the author.

---

## Critical Files to Change

| File | Change |
|------|--------|
| `djtoolkit/db/schema.sql` | Add `user_id` to tracks/fingerprints; add `users`, `agents`, `pipeline_jobs` tables |
| `djtoolkit/db/database.py` | Add asyncpg/psycopg PostgreSQL support alongside SQLite |
| `djtoolkit/api/app.py` | Add auth middleware, per-request RLS context |
| `djtoolkit/api/routes.py` | Scope all queries by `user_id`; add catalog/pipeline/agent routes |
| `djtoolkit/config.py` | Add `[agent]` and `[soulseek]` config sections |
| `djtoolkit/__main__.py` | Add `agent start` and `migrate-to-cloud` CLI commands |
| `djtoolkit/agent/runner.py` | **NEW** — polling loop + job dispatch |
| `djtoolkit/agent/sync.py` | **NEW** — local SQLite ↔ cloud catalog sync |
| `djtoolkit/downloader/aioslsk_client.py` | **NEW** — replaces `slskd.py`; embedded aioslsk client |

---

## Verification Checklist

1. **Tenant isolation**: Import same Spotify track as two different users; `GET /catalog/tracks` for user A must not return user B's rows.
2. **Spotify OAuth**: Full browser OAuth flow completes; tokens stored; playlist import inserts tracks and creates jobs.
3. **CSV upload**: Upload Exportify CSV; tracks appear with `acquisition_status='candidate'`; `pipeline_jobs` rows created.
4. **Agent job flow**: Start local agent; it claims a download job; aioslsk downloads the file; agent reports `local_path` back to cloud.
5. **Stale job recovery**: Claim a job, kill the agent, wait 5 min; job resets to `pending`.
6. **Concurrent agents**: Two agents for the same user; verify `FOR UPDATE SKIP LOCKED` prevents double-claiming the same job.
