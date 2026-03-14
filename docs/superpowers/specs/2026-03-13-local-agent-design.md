# Local Agent — Design Spec

## Context

djtoolkit has been converted from a CLI tool to a SaaS with a Next.js web app, FastAPI backend, and Supabase Postgres database running in the cloud. Users import tracks via the web UI (CSV, Spotify playlists, TrackID.dev), but the actual downloading happens on the Soulseek peer-to-peer network — which requires a local process running on the user's machine.

The local agent bridges the gap: the cloud queues jobs, the agent pulls and executes them locally, and reports results back. Files never leave the user's machine. The cloud is purely an orchestration and metadata layer.

---

## Architecture

### Cloud ↔ Agent Split

| Responsibility | Cloud (Hetzner + Supabase) | Local Agent (User's Mac) |
|---|---|---|
| Track import | CSV, Spotify, TrackID.dev | — |
| Job creation | Creates pipeline_jobs | — |
| Job execution | — | Poll → claim → execute → report |
| File storage | Metadata + fingerprints only | Audio files (downloads + library) |
| User auth | Supabase JWT | — |
| Agent auth | Stores bcrypt hash | Sends `djt_` API key |
| Real-time UI | SSE events | — |

### Data Flow

1. User imports tracks in web UI → creates `pipeline_jobs` (type: `download`)
2. Agent polls `GET /api/pipeline/jobs` → claims job via `POST /api/pipeline/jobs/{id}/claim`
3. Agent searches Soulseek via aioslsk, downloads file to `~/Music/djtoolkit/downloads/`
4. Agent reports result: `PUT /api/pipeline/jobs/{id}/result` → `{local_path, success}`
5. Cloud auto-queues next job in chain: `fingerprint` → `cover_art` → `metadata`
6. Agent executes each subsequent job, reports back. Files stay local. Only metadata syncs to cloud.

### Job Types

| Job Type | Executor | Input (payload) | Output (result) |
|---|---|---|---|
| `download` | aioslsk_client | track_id, search_string, artist, title, duration_ms | local_path |
| `fingerprint` | chromaprint (fpcalc) | track_id, local_path | fingerprint, acoustid, duration |
| `cover_art` | coverart/art.py | track_id, local_path, artist, album, title | cover_art_written (bool) |
| `metadata` | metadata/writer.py | track_id, local_path, metadata fields | local_path, metadata_written (bool) |

### Job Queue Mechanics

- **Claim**: `SELECT ... FOR UPDATE SKIP LOCKED` — atomic, no double-claims
- **Concurrency**: agent polls up to `max_concurrent_jobs` (default 2) jobs at a time
- **Stale recovery**: background sweeper resets unclaimed jobs after 5 minutes
- **Auto-chain**: `_apply_job_result()` in pipeline_routes.py auto-queues the next job type on success
- **Chain fix needed**: `cover_art` completion currently does NOT auto-queue `metadata`. Add metadata job creation in the `cover_art` case block of `_apply_job_result()`.
- **Retry policy**: add `retry_count` column to `pipeline_jobs`. On download failure, if `retry_count < 3`, re-queue as pending with exponential backoff (30s, 2min, 10min). Other job types fail permanently (no transient failures expected).

---

## Security Model

### Authentication Layers

**Layer 1 — User Auth (Web UI)**
- Supabase Auth → ES256 JWT
- Used by browser sessions only
- Can: import tracks, manage catalog, register/revoke agents

**Layer 2 — Agent Auth (Local Agent)**

- API key with `djt_` prefix + 20 random bytes (hex-encoded, 40 chars)
- Server stores bcrypt hash + a non-secret key prefix (first 8 chars after `djt_`) as an indexed lookup column. This avoids full-table bcrypt scans — the prefix narrows to one row, then bcrypt verifies.
- Sent as `Authorization: Bearer djt_xxx`

- Can: heartbeat, poll jobs, claim jobs, report results
- Cannot: access catalog, import tracks, manage agents

### Permission Matrix

| Endpoint | Web (JWT) | Agent (API Key) |
|---|---|---|
| `POST /agents/register` | ✅ | ❌ |
| `DELETE /agents/{id}` | ✅ | ❌ |
| `POST /agents/heartbeat` | ❌ | ✅ |
| `GET /pipeline/jobs` | ✅ | ✅ |
| `POST /pipeline/jobs/{id}/claim` | ❌ | ✅ |
| `PUT /pipeline/jobs/{id}/result` | ❌ | ✅ |
| `POST /catalog/import/*` | ✅ | ❌ |
| `GET /catalog/tracks` | ✅ | ❌ |

### Credential Storage (Local)

| Secret | Storage | Notes |
|---|---|---|
| Agent API key (`djt_xxx`) | macOS Keychain | service: `djtoolkit`, account: `agent-api-key` |
| Soulseek username | macOS Keychain | service: `djtoolkit`, account: `soulseek-username` |
| Soulseek password | macOS Keychain | service: `djtoolkit`, account: `soulseek-password` |
| AcoustID API key | macOS Keychain | service: `djtoolkit`, account: `acoustid-key` (optional) |
| Cloud URL, paths, settings | `~/.djtoolkit/config.toml` | Non-secret configuration only |

**Credential precedence:** In agent mode, `keychain.py` is the canonical source for all secrets. The existing `config.py` TOML/env paths for `api_key` and Soulseek credentials remain for CLI-only (non-agent) usage and CI/testing. Agent mode ignores TOML secret fields.

### Revocation Flow

1. User clicks "Remove Agent" in web UI → `DELETE /agents/{id}`
2. API key hash deleted from DB
3. Agent gets 401 on next poll → logs error, stops polling, exits gracefully
4. User runs `djtoolkit agent uninstall` locally to clean up LaunchAgent + Keychain entries

---

## Agent Lifecycle

### CLI Commands

```
djtoolkit agent configure --api-key djt_xxx
  → Prompts for Soulseek username/password
  → Stores all secrets in macOS Keychain
  → Creates ~/.djtoolkit/config.toml (cloud_url, download paths, poll interval)

djtoolkit agent install
  → Writes ~/Library/LaunchAgents/com.djtoolkit.agent.plist
  → Loads via launchctl → daemon starts immediately
  → KeepAlive: true (auto-restart on crash)

djtoolkit agent status
  → Shows: connected/disconnected, jobs in progress, last heartbeat, version

djtoolkit agent stop
  → launchctl unload (temporary stop, resumes on reboot)

djtoolkit agent start
  → launchctl load (resume after stop)

djtoolkit agent logs
  → Tails ~/Library/Logs/djtoolkit/agent.log

djtoolkit agent run
  → Starts the daemon loop directly (used by launchd, not typically run by users)
  → Reads config + Keychain, enters heartbeat + job poll loop

djtoolkit agent uninstall
  → Unloads LaunchAgent, removes plist
  → Removes Keychain entries
  → Optionally removes ~/.djtoolkit/ config
```

**Note:** launchd does not expand `~` in plist paths. The `launchd.py` plist generator must resolve the full home directory path (e.g., `/Users/username/Library/Logs/djtoolkit/agent.log`).

### Daemon Runtime

The agent daemon is a single-process async loop:

1. **Startup**: read config, load secrets from Keychain, validate API key via heartbeat
2. **Heartbeat loop** (every 30s): `POST /agents/heartbeat` with capabilities, version, active job count. (Requires adding `version` and `active_jobs` fields to `AgentHeartbeatRequest` and corresponding columns to the `agents` table.)
3. **Job poll loop** (every 30s, offset from heartbeat):
   - `GET /pipeline/jobs?limit={max_concurrent - active_count}`
   - For each job: `POST /pipeline/jobs/{id}/claim`
   - Spawn async task for each claimed job
4. **Job execution**: run the appropriate executor (download/fingerprint/cover_art/metadata)
5. **Result reporting**: `PUT /pipeline/jobs/{id}/result` with success/failure + payload
6. **Graceful shutdown**: on SIGTERM/SIGINT, finish active jobs (up to 30s timeout), then exit

### launchd Plist

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "...">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.djtoolkit.agent</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/djtoolkit</string>
        <string>agent</string>
        <string>run</string>
    </array>
    <key>KeepAlive</key>
    <true/>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/USERNAME/Library/Logs/djtoolkit/agent.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/USERNAME/Library/Logs/djtoolkit/agent.log</string>
    <key>ThrottleInterval</key>
    <integer>10</integer>
</dict>
</plist>
```

---

## Packaging & Distribution

### Package Contents

**Included (bundled by PyInstaller):**
- djtoolkit CLI binary (single executable)
- aioslsk (Soulseek P2P client)
- mutagen (audio tag writer)
- fpcalc (Chromaprint CLI tool)
- librosa (BPM/key analysis)
- httpx (HTTP client for API calls)
- keyring (macOS Keychain access)

**Excluded (server-side only):**
- FastAPI, uvicorn, starlette
- asyncpg (Postgres driver)
- essentia-tensorflow, torch
- Next.js web app, Supabase SDK

**Estimated binary size:** ~80-120MB uncompressed, ~40-60MB in .dmg

### Distribution Channels

**Primary — Homebrew Custom Tap**

Repository: `github.com/djtoolkit/homebrew-djtoolkit`

```
homebrew-djtoolkit/
├── Formula/
│   └── djtoolkit.rb       ← bottle-only formula (downloads pre-built binary)
├── .github/workflows/
│   └── publish.yml         ← triggered by djtoolkit release, updates SHA + version
└── README.md
```

Install: `brew tap djtoolkit/djtoolkit && brew install djtoolkit`

The formula uses bottles (pre-built binaries uploaded to GitHub Releases) for fast installation (<5s). The release CI builds bottles for both arm64 and x86_64, then updates the formula's bottle block.

Dependencies declared in formula: `depends_on "chromaprint"` (in case fpcalc needs updating independently).

**Fallback — Direct Download**

.dmg from GitHub Releases (existing `release.yml` pipeline) or djtoolkit.com/download page. Contains .pkg installer with postinstall script that prints setup instructions.

### Release Pipeline

The existing `release.yml` workflow handles most of this. Additions needed:

1. After building .pkg/.dmg, also produce a tarball for Homebrew bottles
2. Upload bottles to GitHub Releases alongside .dmg
3. Trigger `homebrew-djtoolkit` repo's `publish.yml` to update formula SHA/version
4. (Optional) codesign + notarize the binary if Apple Developer account is available

### Cost

| Item | Cost | Notes |
|---|---|---|
| Homebrew tap repo | $0 | Public GitHub repo |
| GitHub Actions (CI builds) | $0 | Free for public repos, ~10min/release |
| GitHub Releases (binary hosting) | $0 | ~120MB per release (2 archs) |
| Apple code signing | $99/yr | Optional but recommended to avoid Gatekeeper warnings |
| Apple notarization | $0 | Included with Developer Program |
| Cloud file storage | $0 | Files stay local |

**Total: $0–$99/yr** depending on whether Apple code signing is used.

---

## Target Platform

macOS only (arm64 + Intel x86_64) for initial release. Linux and Windows can be added later with additional PyInstaller targets and distribution channels (apt, scoop/chocolatey).

---

## Existing Infrastructure to Reuse

These files already exist and should be adapted, not rewritten:

| File | What exists | What to add/change |
|---|---|---|
| `djtoolkit/api/auth_routes.py` | Agent registration + heartbeat endpoints | Already complete |
| `djtoolkit/api/auth.py` | Dual-path auth (JWT + API key) | Already complete |
| `djtoolkit/api/pipeline_routes.py` | Job queue with claim/result | Already complete |
| `djtoolkit/downloader/aioslsk_client.py` | Full Soulseek download client | Adapt for agent context (read from job payload instead of DB query) |
| `djtoolkit/fingerprint/chromaprint.py` | fpcalc wrapper + AcoustID lookup | Adapt to return result dict instead of DB write |
| `djtoolkit/coverart/art.py` | Cover art fetch + embed | Adapt to return result dict |
| `djtoolkit/metadata/writer.py` | Mutagen tag writer | Adapt to return result dict |
| `packaging/macos/djtoolkit.spec` | PyInstaller spec | Refactor module-level asyncpg imports so it can be excluded from agent binary |
| `packaging/macos/build.sh` | .pkg/.dmg builder | Add bottle tarball output |
| `.github/workflows/release.yml` | macOS CI build | Add bottle upload + formula update trigger |
| `djtoolkit/config.py` | TOML config loader | Already has `[agent]` section with cloud_url, api_key, poll_interval |

### New files to create

| File | Purpose |
|---|---|
| `djtoolkit/agent/daemon.py` | Main async event loop: heartbeat + job poll + executor dispatch |
| `djtoolkit/agent/executor.py` | Job executor: routes job_type to the right module, handles errors |
| `djtoolkit/agent/keychain.py` | macOS Keychain read/write via `keyring` library |
| `djtoolkit/agent/launchd.py` | Generate plist, install/uninstall LaunchAgent |
| `djtoolkit/__main__.py` | Add `agent` subcommand group (configure, install, start, stop, status, logs, uninstall) |

---

## TLS & Certificates

No additional certificate infrastructure is required:
- The cloud API already terminates TLS via nginx + Let's Encrypt (auto-renewed, already configured in docker-compose)
- The agent is a standard HTTPS client — it trusts the server's Let's Encrypt cert via the macOS system CA store
- No mTLS needed — the `djt_` API key over HTTPS is sufficient authentication. Adding client certificates would add complexity with no meaningful security benefit for this threat model.

---

## Local State Recovery

The agent writes a JSON file per active job to `~/.djtoolkit/jobs/{job_id}.json` containing the result payload. This handles crash and network failure recovery:

1. **Before execution**: write `{job_id}.json` with `status: "claimed"` and job payload
2. **After execution**: update file with result payload (`status: "completed"` or `"failed"`)
3. **After result reported to cloud**: delete the file
4. **On startup**: scan for orphaned job files:
   - `status: "completed"` or `"failed"` → re-report result to cloud, then delete
   - `status: "claimed"` → job was interrupted mid-execution. Check if output file exists (for downloads). If yes, report success. If no, let the stale job sweeper reset it on the cloud side.

This is simpler than SQLite and sufficient for the recovery scenarios. No database migrations, no schema, just JSON files that exist only while a job is in flight.

---

## Failure Modes & Mitigations

| Failure | Impact | Mitigation |
|---|---|---|
| **Agent crashes mid-download** | File may be partially written, cloud job stuck as "claimed" | Stale job sweeper resets after 5min. Local state recovery re-reports on restart. Partial files cleaned up by the download executor. |
| **Network outage during result reporting** | Job completed locally but cloud doesn't know | Local state file preserves result. Agent retries reporting on next poll cycle. Exponential backoff on consecutive network failures (5s, 15s, 45s, cap at 5min). |
| **Cloud API down** | Agent can't poll or report | Agent logs warning, continues heartbeat attempts. Exponential backoff. No local work lost — jobs stay in local state files. |
| **Soulseek peer goes offline mid-transfer** | Download fails partway | aioslsk handles this — reports transfer failure. Agent reports job failure. Cloud retry policy re-queues (up to 3 attempts). |
| **Disk full** | Download or metadata write fails | Executor catches OSError, reports job failure with error message. Agent continues running for non-disk jobs (fingerprint results are metadata-only). |
| **API key revoked while agent running** | 401 on next poll/heartbeat | Agent logs "API key revoked", stops polling, exits with non-zero code. launchd will try to restart (ThrottleInterval: 10s), but repeated 401s should trigger a longer backoff or eventual stop. |
| **Multiple agents for same user** | Jobs could be split across agents | This is fine — `FOR UPDATE SKIP LOCKED` prevents double-claims. Each agent only processes jobs it successfully claimed. |
| **Agent version mismatch** | Old agent doesn't support new job types | Heartbeat reports version + capabilities. Cloud can filter job types based on agent capabilities. Unknown job types: agent reports failure with "unsupported_job_type". |
| **macOS sleep/wake** | Agent process suspended by OS | launchd handles this — process resumes on wake. Active Soulseek transfers may time out. Stale job sweeper + local state recovery handles the cleanup. |
| **Keychain locked (rare)** | Agent can't read secrets on startup | Startup fails with clear error message. User must unlock Keychain (usually automatic on login). |

---

## Known Limitations

- **SSE is in-process only**: the `_sse_queues` pub/sub in pipeline_routes.py is per-worker. If the FastAPI backend scales to multiple uvicorn workers, SSE events will break. Upgrade path: Redis pub/sub. Not blocking for MVP since we run 2 workers behind nginx.
- **No log rotation**: the launchd plist directs stdout/stderr to a single log file. Implement `RotatingFileHandler` in the daemon or configure `newsyslog` to prevent unbounded growth.
- **macOS only**: Linux/Windows agent support is deferred. The Keychain dependency (`keyring`) abstracts cross-platform, so the migration path is straightforward.

---

## Verification Plan

1. **Unit tests**: mock HTTP responses for heartbeat, job poll, claim, result reporting
2. **Integration test**: start agent against local FastAPI instance, import a track, verify job flows through download → fingerprint → cover_art → metadata
3. **Keychain test**: verify secrets are stored/retrieved correctly via `keyring`
4. **LaunchAgent test**: verify plist is valid XML, launchctl load/unload works
5. **Packaging test**: build PyInstaller binary, run `djtoolkit agent status` from the binary
6. **Homebrew test**: install from local tap, verify `djtoolkit agent configure` works
7. **End-to-end**: import CSV in web UI → agent picks up download → file appears locally → metadata synced to cloud
