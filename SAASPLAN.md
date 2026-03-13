# SaaS Multi-Tenant Architecture for djtoolkit

## Context

djtoolkit is currently a single-user CLI + local FastAPI tool with no auth, a single SQLite DB, and local dependencies (fpcalc binary, embedded aioslsk Soulseek client). The goal is to transform it into a SaaS platform where customers:
1. Connect their own Spotify accounts (OAuth) or upload Exportify CSVs
2. Get an isolated music catalog per account
3. Run a lightweight local macOS agent to handle downloads and file processing (since fpcalc, librosa, and the actual music files must stay local)

---

## System Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        CLOUD PLATFORM                               │
│                                                                     │
│  ┌─────────────┐   ┌──────────────────┐   ┌───────────────────┐   │
│  │  Web UI      │   │  Supabase Auth   │   │  Spotify OAuth    │   │
│  │ (Next.js 14) │   │ (email + Google) │   │  (per-user tokens)│   │
│  └─────────────┘   └──────────────────┘   └───────────────────┘   │
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
│  ┌────────────────────────────┐   ┌──────────────────────────┐    │
│  │  Supabase                  │   │  Supabase Storage        │    │
│  │  - PostgreSQL (catalog +   │   │  (CSV uploads,           │    │
│  │    user state, RLS)        │   │   bucket: imports)       │    │
│  │  - Auth (JWT, webhooks)    │   └──────────────────────────┘    │
│  └────────────────────────────┘                                    │
└─────────────────────────────────────────────────────────────────────┘
                                │
                     HTTPS REST (polling)
                                │
┌─────────────────────────────────────────────────────────────────────┐
│                    CUSTOMER'S macOS LAPTOP                          │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                  djtoolkit Local Agent                        │  │
│  │  - Authenticates with cloud API key (djt_xxx)                │  │
│  │  - Polls GET /pipeline/jobs every 30s                        │  │
│  │  - Claims and executes jobs locally:                         │  │
│  │      download    → aioslsk P2P → local file                  │  │
│  │      fingerprint → fpcalc → chromaprint hash                 │  │
│  │      metadata    → mutagen → writes tags to local file       │  │
│  │      cover_art   → fetches + embeds art locally              │  │
│  │  - Reports metadata results to cloud (no file upload)        │  │
│  │  - Maintains local SQLite mirror for idempotency             │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌──────────────────────────────┐  ┌──────────────────────────┐   │
│  │  ~/.djtoolkit/agent.db       │  │  ~/Music/DJ/             │   │
│  │  (in-progress job state)     │  │  (actual files)          │   │
│  └──────────────────────────────┘  └──────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

**Core principle**: Cloud owns the *catalog state* (metadata, pipeline status, user accounts). The customer's machine owns the *files* and *processing capabilities*. They stay in sync via a REST polling protocol.

---

## Soulseek Client: aioslsk

djtoolkit uses **[aioslsk](https://github.com/JurgenR/aioslsk)** — a pure Python asyncio library for the Soulseek protocol, embedded directly in the process.

| | aioslsk |
|---|---|
| Install | `pip install djtoolkit` |
| Runs as | Embedded in local agent process |
| Credentials | `djtoolkit.toml [soulseek]` |
| Progress tracking | Async events (push) |
| Python version | 3.10–3.14 |
| Latest release | v1.6.3 (Feb 2026) |
| License | **GPL-3.0** — see Security section |

```python
# aioslsk download pattern
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

The fuzzy matching/scoring logic in `aioslsk_client.py` (thefuzz, duration tolerance, format preference) applies to raw results from aioslsk.

---

## Multi-Tenant Database Schema (PostgreSQL)

### New Tables

```sql
-- Platform users (id mirrors auth.users.id from Supabase Auth)
CREATE TABLE users (
    id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email                     TEXT UNIQUE NOT NULL,
    -- Spotify OAuth tokens (Fernet-encrypted at rest)
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
    api_key_hash    TEXT NOT NULL,      -- bcrypt hash; key shown to user once as djt_xxx
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
-- users table: accessed via service_role key only — no RLS policy
```

API middleware sets `SET LOCAL app.current_user_id = '<jwt_sub>'` at the start of every request transaction.

---

## Authentication System

### 1. Platform Auth — Supabase Auth

Use **Supabase Auth** (already in stack):
- Email/password + social login (Google)
- JWT with `sub` claim = `user_id`
- Webhook (`user.created` event) → upsert into `users` table via service role key
- JWT secret from Supabase project settings → API → JWT Secret (`SUPABASE_JWT_SECRET`)

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
    → Encrypts tokens with Fernet (SPOTIFY_TOKEN_ENCRYPTION_KEY env var), stores in users table
    → UI can now call POST /catalog/import/spotify
```

**Token refresh**: Background job checks `spotify_token_expires_at`, refreshes 5 min before expiry. The platform uses a single Spotify app for all users (standard OAuth2 multi-user pattern).

### 3. Local Agent API Key

```
User generates agent key in web UI
    → Cloud creates agents row, returns API key ONCE: djt_<secrets.token_hex(20)>
    → Agent stores key in djtoolkit.toml [agent] or env DJTOOLKIT_AGENT_KEY
    → All agent requests: Authorization: Bearer djt_xxx
    → Cloud verifies: bcrypt.verify(key, agents.api_key_hash)
```

---

## Spotify Import Flow

```
POST /catalog/import/spotify
    Body: { playlist_id: "spotify:playlist:37i9dQZF1DX..." }

Cloud:
  1. Decrypt user's Spotify tokens (Fernet)
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
  2. Store in Supabase Storage bucket 'imports' at {user_id}/{uuid}.csv
  3. Parse CSV (parse_csv_rows(bytes) from exportify.py), insert tracks, create jobs
  4. Return: { imported, skipped_duplicates, jobs_created }
```

---

## Local Agent Design

### Installation (macOS)

Download the `.dmg` from GitHub releases, or:

```bash
pip install djtoolkit
djtoolkit agent configure \
    --cloud-url https://api.djtoolkit.com \
    --api-key <KEY_FROM_WEB_UI>

# Run as foreground process, or install as launchd service
djtoolkit agent start
```

A macOS `.pkg`/`.dmg` installer is built via PyInstaller + GitHub Actions. It bundles the `fpcalc` binary and all Python dependencies — no separate Python installation needed.

### Agent Config Extension (djtoolkit.toml)

```toml
[agent]
cloud_url           = "https://api.djtoolkit.com"
api_key             = ""    # env: DJTOOLKIT_AGENT_KEY
poll_interval_sec   = 30
max_concurrent_jobs = 2
local_db_path       = "~/.djtoolkit/agent.db"

[soulseek]
username     = ""         # Soulseek account credentials
password     = ""         # env: SOULSEEK_PASSWORD
download_dir = "~/Music/DJ/downloads"
```

### Agent Polling Loop

```python
# djtoolkit/agent/runner.py  (NEW)
async def run_agent(cfg):
    await client.heartbeat(detect_capabilities())
    sem = asyncio.Semaphore(cfg.agent.max_concurrent_jobs)

    while True:
        jobs = await client.fetch_jobs(limit=cfg.agent.max_concurrent_jobs)

        for job in jobs:
            if not await client.claim_job(job["id"]):
                continue   # another agent claimed it first
            asyncio.create_task(_run_job(sem, cfg, job))

        await asyncio.sleep(cfg.agent.poll_interval_sec)
```

### Job Execution (reuses existing modules)

```python
async def execute_job(cfg, job):
    match job["job_type"]:
        case "download":
            # djtoolkit/agent/jobs/download.py → aioslsk_client.py
            result = await run_download_job(cfg, job["payload"])
            # returns: { local_path, file_format, file_size }

        case "fingerprint":
            # djtoolkit/agent/jobs/fingerprint.py → chromaprint.py
            result = await run_fingerprint_job(cfg, job["payload"])
            # returns: { fingerprint, acoustid, duration, is_duplicate }

        case "metadata":
            # djtoolkit/agent/jobs/metadata.py → metadata/writer.py
            result = await run_metadata_job(cfg, job["payload"])
            # returns: { local_path (after rename), metadata_written: true }

        case "cover_art":
            # djtoolkit/agent/jobs/cover_art.py → coverart/art.py
            result = await run_cover_art_job(cfg, job["payload"])
            # returns: { cover_art_written: true, source_used: "itunes" }

    return result
```

### Local SQLite Mirror (`~/.djtoolkit/agent.db`)

Minimal schema — tracks in-progress jobs only:

- Idempotency: avoids re-claiming on agent restart
- `local_path` is machine-specific, reported back to cloud via REST (not stored globally)

---

## Cloud API Design

### Auth Middleware

```python
# Accepts both Supabase JWT (web UI) and opaque API key (local agent)
async def get_current_user(authorization: str = Header(...)) -> CurrentUser:
    token = authorization.removeprefix("Bearer ")
    if token.count(".") == 2:           # JWT has 3 dot-separated parts
        return await verify_jwt(token)  # jose.jwt.decode with SUPABASE_JWT_SECRET
    return await verify_agent_key(token)  # bcrypt.verify against agents table
```

### Route Structure

```
/auth/
  GET    /auth/spotify/connect             → redirect to Spotify authorize URL
  GET    /auth/spotify/callback            → OAuth callback, Fernet-encrypt, store tokens
  POST   /auth/spotify/disconnect          → null Spotify token fields

/catalog/
  GET    /catalog/tracks                   → paginated, filterable (RLS-scoped)
  GET    /catalog/tracks/{id}              → single track
  GET    /catalog/stats                    → counts by status + flags
  POST   /catalog/import/csv              → upload Exportify CSV (→ Supabase Storage)
  POST   /catalog/import/spotify          → import from connected Spotify playlist
  GET    /catalog/import/spotify/playlists → list user's Spotify playlists
  POST   /catalog/tracks/{id}/reset       → retry a failed track

/pipeline/
  GET    /pipeline/jobs                    → pending jobs for this user (agent polls)
  POST   /pipeline/jobs/{id}/claim         → agent atomically claims a job
  PUT    /pipeline/jobs/{id}/result        → agent reports result + updates track flags
  GET    /pipeline/status                  → queue depth + agent health
  GET    /pipeline/events                  → SSE stream for real-time UI updates

/agents/
  GET    /agents                           → list user's agents
  POST   /agents/register                  → register agent, returns API key ONCE
  POST   /agents/heartbeat                 → update last_seen_at + capabilities
  DELETE /agents/{id}                      → revoke agent

/admin/  (platform operator only)
  GET    /admin/users                      → user list
  GET    /admin/metrics                    → queue depth, agent activity
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
# Background task, runs every 60 seconds
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
| Auth | **Supabase Auth** | Already in stack; JWT, email+Google, webhooks |
| API | FastAPI (Python) | Extends existing codebase directly |
| Database | **Supabase PostgreSQL** | RLS, JSONB |
| Job Queue | DB-backed (`pipeline_jobs` table) | Durable, no extra infra; `FOR UPDATE SKIP LOCKED` |
| File Storage | **Supabase Storage** | CSV uploads in bucket `imports`; eliminates S3/R2 |
| Hosting | **Hetzner Cloud CX23** | 2 vCPU, 4GB RAM; Docker + Nginx; ~€4/mo |
| Local Agent | pip package + macOS .dmg | `pip install djtoolkit` or download installer |
| Soulseek client | aioslsk (embedded) | Pure Python, Python 3.10-3.14, v1.6.3, GPL-3 |
| Monitoring | Sentry + Posthog | Error tracking + usage analytics |

> **Hetzner note:** `hetzner.com/webhosting` (shared PHP/MySQL) is NOT suitable. Use [Hetzner Cloud](https://console.hetzner.cloud) CX23 VPS with Docker.

**Why DB-backed queue instead of Redis/Celery?** Downloads take minutes, volume is low (hundreds of jobs/day per user), and the queue needs durable state (jobs survive agent restarts). `FOR UPDATE SKIP LOCKED` covers all of this.

**Why Supabase Auth instead of Clerk/Auth0?** We're already using Supabase for the DB — sharing the same vendor simplifies JWT verification (same secret), reduces vendor count, and keeps RLS integration seamless.

---

## Web UI (Next.js 14)

Replace `ui/index.html` with a Next.js 14 App Router application:

- **Login page** — Supabase Auth UI (`@supabase/ssr`)
- **Catalog** — per-user track table with filter/pagination
- **Spotify Connect** — OAuth button, playlist browser, import progress
- **CSV Upload** — drag-and-drop, parse progress indicator
- **Pipeline dashboard** — active agent status, job queue depth, per-track pipeline state
- **Agent setup wizard** — 4-step: install → generate key → configure → start (polls for green checkmark)
- **Real-time updates** — `EventSource` on `GET /pipeline/events` SSE stream

---

## macOS Package

The local agent is distributed as a macOS `.dmg` containing a `.pkg` installer:

- Built with **PyInstaller** (standalone binary, no Python required on target machine)
- Bundles `fpcalc` binary (chromaprint) from Homebrew
- **GitHub Actions** release workflow: matrix build on `macos-14` (arm64) and `macos-13` (x86_64), triggered on git tags
- `postinstall` script creates `~/.djtoolkit/` and prints setup instructions
- **GPL-3 compliance**: keep djtoolkit agent open-source (SaaS platform is the commercial moat); GPL-3 notice in installer welcome screen

---

## Security Considerations

- **Spotify tokens**: Fernet-encrypted before storing in DB. Key from `SPOTIFY_TOKEN_ENCRYPTION_KEY` env var — never in DB.
- **Agent API keys**: `djt_<random 40 hex chars>`. Displayed to user once; only bcrypt hash stored. Rotation: generate new, revoke old.
- **Rate limiting**: Per-user limits on `/catalog/import/spotify` (Spotify quota) and `/pipeline/jobs` polling.
- **CSV uploads**: Validate MIME type + max 10MB; parse server-side only; store in private Supabase Storage bucket (no public URLs).
- **CORS**: Restrict web UI routes to `app.djtoolkit.com`; agent routes accept any origin but require API key.
- **Soulseek credentials**: Stored locally in `djtoolkit.toml [soulseek]` — never transmitted to cloud.
- **aioslsk GPL-3 license**: Keep the agent open-source. The SaaS catalog and UX are the commercial moat.

---

## Critical Files to Change

| File | Change |
|------|--------|
| `djtoolkit/db/pg_schema.sql` | **NEW** — PostgreSQL DDL with `users`, `agents`, `pipeline_jobs`; `user_id` on tracks/fingerprints |
| `djtoolkit/db/rls.sql` | **NEW** — RLS policies for all multi-tenant tables |
| `djtoolkit/db/postgres.py` | **NEW** — asyncpg pool, `execute()` with RLS context setter |
| `djtoolkit/api/auth.py` | **NEW** — dual-path auth: Supabase JWT + bcrypt agent key |
| `djtoolkit/api/catalog_routes.py` | **NEW** — catalog CRUD + CSV/Spotify import |
| `djtoolkit/api/pipeline_routes.py` | **NEW** — job queue claim/result + SSE stream |
| `djtoolkit/agent/runner.py` | **NEW** — polling loop + job dispatch |
| `djtoolkit/agent/client.py` | **NEW** — httpx wrapper for cloud API calls |
| `djtoolkit/agent/local_db.py` | **NEW** — local SQLite for job idempotency |
| `djtoolkit/agent/jobs/` | **NEW** — single-job adapters for download/fingerprint/metadata/cover_art |
| `packaging/macos/` | **NEW** — PyInstaller spec + pkgbuild + GitHub Actions release |
| `Dockerfile` + `docker-compose.yml` | **NEW** — container deployment for Hetzner Cloud |
| `djtoolkit/config.py` | Add `SupabaseConfig`, `AgentConfig` |
| `djtoolkit/api/app.py` | Add lifespan (pool init), CORS middleware, include all new routers |
| `djtoolkit/api/routes.py` | Add `Depends(get_current_user)`; scope queries by `user_id` |
| `djtoolkit/importers/exportify.py` | Extract `parse_csv_rows(data: bytes)` for cloud upload path |
| `djtoolkit/__main__.py` | Add `agent configure` and `agent start` CLI commands |

---

## Verification Checklist

1. **Tenant isolation**: Import same Spotify track as two different users; `GET /catalog/tracks` for user A must not return user B's rows.
2. **Spotify OAuth**: Full browser OAuth flow completes; tokens stored (encrypted); playlist import inserts tracks and creates jobs.
3. **CSV upload**: Upload Exportify CSV; tracks appear with `acquisition_status='candidate'`; `pipeline_jobs` rows created.
4. **Agent job flow**: Start local agent; it claims a download job; aioslsk downloads the file; agent reports `local_path` back to cloud; track flags updated.
5. **Stale job recovery**: Claim a job, kill the agent, wait 5 min; job resets to `pending`.
6. **Concurrent agents**: Two agents for the same user; verify `FOR UPDATE SKIP LOCKED` prevents double-claiming the same job.
7. **macOS installer**: Mount `.dmg`, install `.pkg`, run `djtoolkit agent start` — connects to cloud and claims a test job.
8. **Deploy**: Push to `master` → GitHub Actions deploys to Hetzner Cloud → `https://api.djtoolkit.com` responds correctly.
