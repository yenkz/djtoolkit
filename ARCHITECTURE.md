# Architecture — djtoolkit

djtoolkit is a Python CLI and cloud service for managing a DJ music library. It ingests tracks from multiple sources (Exportify CSV, Spotify playlists, local folders, TrackID.dev), downloads missing files via Soulseek, deduplicates by audio fingerprint, enriches metadata, and writes clean tags to disk.

The system has two deployment modes:
- **Local CLI** — SQLite is the single source of truth (`djtoolkit.db`), every pipeline step is re-entrant
- **Cloud + Agent** — Postgres (Supabase) holds per-user track state, a local agent daemon polls for jobs and executes pipeline steps on the user's machine

---

## Component Map

```
┌─────────────────────────────────────────────────────────────────────┐
│  Input Sources                                                       │
│                                                                      │
│  Exportify CSV ──► importers/exportify.py ─────────────────────┐    │
│  Local folder  ──► importers/folder.py  ───────────────────────┤    │
│  Spotify API   ──► api/catalog_routes.py (import/spotify)  ───┤    │
│  TrackID.dev   ──► api/catalog_routes.py (import/trackid)  ───┤    │
└────────────────────────────────────────────────────────────────│────┘
                                                                 │
                                                                 ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Database                                                             │
│  Local: SQLite (djtoolkit.db)  │  Cloud: Postgres (Supabase, per-user)│
│  ┌──────────┐  ┌──────────────┐  ┌──────────────────────────┐       │
│  │  tracks  │  │ fingerprints │  │    track_embeddings       │       │
│  └──────────┘  └──────────────┘  └──────────────────────────┘       │
│  ┌───────────────┐                                                   │
│  │ trackid_jobs  │  (TrackID.dev polling state)                      │
│  └───────────────┘                                                   │
└──────────────────────────────────────────────────────────────────────┘
      ▲  │                    ▲                       ▲
      │  │                    │                       │
      │  ▼                    │                       │
      │  downloader/aioslsk_client.py ──► Soulseek     │
      │                        (embedded client)        │
      │                                                │
      ├── fingerprint/chromaprint.py ──► fpcalc       │
      │                          └──► AcoustID API    │
      │                                                │
      ├── enrichment/spotify.py (Exportify CSV)        │
      │                                                │
      ├── enrichment/audio_analysis.py ───────────────┘
      │       librosa + pyloudnorm
      │       essentia-tensorflow (optional)
      │
      ├── coverart/art.py ──► CoverArtArchive / iTunes / Deezer / Spotify / Last.fm
      │
      ├── metadata/writer.py ──► audio files on disk
      │
      └── library/mover.py ──► library_dir

┌─────────────────────────────────────────────────────────────────────┐
│  API + UI                                                            │
│  api/app.py                          ◄── FastAPI, port 8000          │
│  ├── api/auth_routes.py              ◄── Agent registration/mgmt     │
│  ├── api/spotify_auth_routes.py      ◄── Spotify OAuth 2.0 flow      │
│  ├── api/catalog_routes.py           ◄── Track CRUD, imports          │
│  └── api/pipeline_routes.py          ◄── Job queue, results, SSE      │
│  web/                                ◄── Next.js frontend             │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│  Local Agent  (agent/)                                               │
│  daemon.py ──► poll cloud for jobs ──► executor.py ──► job handlers  │
│  keychain.py (system credential store)                               │
│  launchd.py  (macOS LaunchAgent installer)                           │
│  state.py    (orphaned job recovery via JSON)                        │
└─────────────────────────────────────────────────────────────────────┘
```

---

## The Three Flows

### Flow 1 — Exportify CSV → Downloaded + Tagged (Local CLI)

For tracks you want to find on Soulseek and download, using the local CLI.

```
make import-csv CSV=…
  └─ importers/exportify.py
       Parses Exportify CSV, inserts rows
       acquisition_status = 'candidate'

make download
  └─ downloader/aioslsk_client.py
       For each 'candidate': search Soulseek → score results → download best match
       Sets: 'candidate' → 'downloading' → 'available'  (or 'failed')

make fingerprint
  └─ fingerprint/chromaprint.py
       For each 'available' AND fingerprinted=0: run fpcalc
       On unique:    fingerprinted = 1
       On duplicate: fingerprinted = 1, acquisition_status = 'duplicate'

make fetch-cover-art
  └─ coverart/art.py
       For each 'available' AND cover_art_written=0: fetch art, embed into file
       Sets: cover_art_written = 1

make apply-metadata
  └─ metadata/writer.py
       For each 'available' AND metadata_written=0
       Writes ID3/FLAC/M4A tags from DB, normalizes filename to 'Artist - Title.ext'
       Sets: metadata_written = 1

make move-to-library
  └─ library/mover.py
       For each 'available' AND metadata_written=1 AND in_library=0
       Checks fingerprint against in-library tracks (exact Chromaprint match → duplicate)
       Moves file to library_dir, updates local_path
       Sets: in_library = 1
```

### Flow 2 — Local Folder → DB (Local CLI)

For tracks you already have on disk (rips, purchases, existing library).

```
make import-folder DIR=…
  └─ importers/folder.py
       Scans recursively for audio files
       Reads existing tags with mutagen, fingerprints each file
       Skips fingerprint duplicates already in DB
       acquisition_status = 'available', fingerprinted = 1 (if fpcalc succeeded)

make enrich ARGS='--spotify path/to/export.csv'
  └─ enrichment/spotify.py
       For each 'available' AND enriched_spotify=0
       Matches against Exportify CSV by URI (exact) or artist+title (fuzzy)
       Fills NULL metadata columns only — never overwrites existing data
       Sets: enriched_spotify = 1

make enrich ARGS='--audio-analysis'
  └─ enrichment/audio_analysis.py
       For each 'available' AND enriched_audio=0
       Phase 1+2 (optional): MusicNN embeddings → genre + vocal/instrumental classifiers
       Phase 3 (always):     librosa BPM, Krumhansl-Schmuckler key, pyloudnorm LUFS
       Sets: enriched_audio = 1, tempo, key, mode, danceability, loudness
```

### Flow 3 — Cloud Import → Agent Pipeline

For tracks imported via the web UI (CSV upload, Spotify playlist, or TrackID.dev).

```
User imports tracks via web UI
  └─ api/catalog_routes.py
       POST /import/csv       — parse Exportify CSV
       POST /import/spotify   — fetch Spotify playlist items via OAuth
       POST /import/trackid   — submit YouTube URL to TrackID.dev, poll for results
       → Inserts tracks (acquisition_status = 'candidate')
       → Creates pipeline_job (job_type = 'download') for each track

Agent daemon polls for jobs
  └─ agent/daemon.py → agent/executor.py
       download    → search Soulseek, download best match
                     Cloud sets: available, auto-queues fingerprint
       fingerprint → run fpcalc, AcoustID lookup, dupe detection
                     Cloud sets: fingerprinted=1, auto-queues cover_art
       cover_art   → fetch + embed artwork
                     Cloud sets: cover_art_written=1, auto-queues metadata
       metadata    → write tags, normalize filename
                     Cloud sets: metadata_written=1
```

Each job's success automatically queues the next step in the chain: `download → fingerprint → cover_art → metadata`.

---

## Database Design

### Tables

**`tracks`** — one row per track, regardless of state. The central table.

**`fingerprints`** — Chromaprint fingerprint + AcoustID lookup result, linked to `tracks.id`.

**`track_embeddings`** — MusicNN float32 embedding vectors stored as BLOBs, linked to `tracks.id`. Only populated when essentia-tensorflow models are configured.

**`trackid_jobs`** — TrackID.dev polling state. Tracks YouTube URL → job ID → completion status and import counts.

### `acquisition_status` — where the file is in the acquisition lifecycle

| Value | Meaning |
|---|---|
| `candidate` | Waiting to be downloaded |
| `downloading` | Soulseek download in progress |
| `available` | File exists on disk (downloaded or imported) |
| `failed` | Download failed — resettable to `candidate` |
| `duplicate` | Fingerprint matches an existing track — skip all processing |

### Processing flags — what pipeline steps have been applied

Seven independent `INTEGER 0/1` columns. Each module queries `flag = 0` to find its work and sets `flag = 1` on success. Re-running any step is always safe.

| Flag | Set by | When |
|---|---|---|
| `fingerprinted` | `fingerprint/chromaprint.py` | fpcalc completed (unique or duplicate) |
| `enriched_spotify` | `enrichment/spotify.py` | CSV match attempted |
| `enriched_audio` | `enrichment/audio_analysis.py` | Audio analysis completed |
| `metadata_written` | `metadata/writer.py` | Tags written + filename normalized |
| `cover_art_written` | `coverart/art.py` | Cover art fetched + embedded into file |
| `in_library` | `library/mover.py` | File moved to `library_dir` |
| `normalized` | *(future)* | Loudness normalization applied |

### Lifecycle diagram

```
Flow 1/3:  candidate ──► downloading ──► available ──► [processing flags]
                                      └──► failed   (resettable → candidate)
                       ──────────────────► duplicate (fingerprint match)

Flow 2:    available (on insert) ──► [processing flags]

Cloud auto-queue chain:  download → fingerprint → cover_art → metadata
```

---

## Agent System

The agent is a background daemon that runs on the user's local machine, executing pipeline jobs on behalf of the cloud service. It bridges the gap between cloud-hosted track state and local resources (Soulseek network, disk storage, audio analysis tools).

### Components

| Module | Responsibility |
|---|---|
| `agent/daemon.py` | Main event loop: heartbeat, job polling, concurrent execution, graceful shutdown |
| `agent/executor.py` | Dispatches jobs to type-specific handlers (download, fingerprint, cover_art, metadata) |
| `agent/client.py` | HTTP client for cloud API with exponential backoff |
| `agent/keychain.py` | System credential store via `keyring` (macOS Keychain, Windows Credential Locker) |
| `agent/launchd.py` | macOS LaunchAgent installer (plist generation, launchctl management) |
| `agent/state.py` | Orphaned job recovery — saves job state as JSON, re-reports on restart |
| `agent/local_db.py` | SQLite idempotency table for job deduplication |
| `agent/jobs/` | Job handlers: `download.py`, `fingerprint.py`, `cover_art.py`, `metadata.py` |

### Workflow

1. **Startup** — load credentials from keychain, detect capabilities (aioslsk, fpcalc, librosa, essentia), send heartbeat
2. **Poll loop** — fetch up to N pending jobs from cloud, claim each atomically (409 if already taken), spawn async execution
3. **Execute** — save state locally, run handler, report result to cloud (which auto-queues the next job)
4. **Recovery** — on restart, re-report any orphaned completed/failed jobs from local JSON state

### Security

- Agent API keys: `djt_` prefix, bcrypt-hashed, prefix-indexed for lookup
- Soulseek credentials and AcoustID key stored in system keychain, never in config files
- Agent never sends plaintext credentials to cloud after initial registration

---

## API & UI

FastAPI (`api/app.py`) runs on port 8000 (`make api`). The Next.js frontend in `web/` communicates with it via REST.

### Route Modules

| Module | Responsibility |
|---|---|
| `api/auth.py` | Dual auth: JWT (ES256/HS256) for users, bcrypt API keys for agents |
| `api/auth_routes.py` | Agent CRUD: register, heartbeat, list, revoke |
| `api/spotify_auth_routes.py` | Spotify OAuth 2.0 flow: connect, callback, disconnect. Tokens Fernet-encrypted at rest |
| `api/catalog_routes.py` | Track listing (paginated, RLS-scoped), imports (CSV, Spotify, TrackID.dev), bulk operations |
| `api/pipeline_routes.py` | Job queue: poll, claim (FOR UPDATE SKIP LOCKED), report results. SSE stream for real-time updates. Stale job recovery (60s sweep) |
| `api/rate_limit.py` | Per-user rate limiting via slowapi (JWT sub or agent key prefix) |
| `api/audit.py` | Fire-and-forget audit logging to Postgres |

### Cloud Security

- **Row-Level Security**: All catalog queries scoped by `user_id`; Postgres RLS policies enforce isolation
- **Job atomicity**: `FOR UPDATE SKIP LOCKED` prevents concurrent claims
- **Audit trail**: All sensitive actions logged (imports, agent registration, track resets)
- **Input validation**: CSV file type + extension checks, bulk operation size limits (1000 max), TrackID confidence threshold (0.7)

---

## Module Reference

| Module | Responsibility |
|---|---|
| `importers/exportify.py` | Parse Exportify CSV → insert tracks as `candidate` |
| `importers/folder.py` | Scan folder → fingerprint → insert as `available` |
| `downloader/aioslsk_client.py` | Search Soulseek, score results, download best match |
| `fingerprint/chromaprint.py` | Run fpcalc, AcoustID lookup, dupe detection |
| `enrichment/spotify.py` | Fill NULL metadata from Exportify CSV |
| `enrichment/audio_analysis.py` | BPM/key/loudness via librosa; genre via essentia (optional) |
| `coverart/art.py` | Fetch cover art (CoverArtArchive, iTunes, Deezer, Spotify, Last.fm) + embed into file |
| `metadata/writer.py` | Write tags to file, normalize filename |
| `library/mover.py` | Move tagged files to `library_dir`, dupe-check against in-library fingerprints |
| `agent/daemon.py` | Background agent daemon: heartbeat, poll, execute pipeline jobs |
| `agent/executor.py` | Dispatch jobs to handlers (download, fingerprint, cover_art, metadata) |
| `agent/keychain.py` | System credential store (keyring) |
| `agent/launchd.py` | macOS LaunchAgent installer |
| `db/database.py` | `connect()`, `setup()`, `migrate()`, `wipe()` |
| `config.py` | Load `djtoolkit.toml` into typed dataclasses |
| `utils/search_string.py` | Build Soulseek query from artist + title |
| `api/app.py` | FastAPI app, CORS, lifespan, mount routers |
| `api/catalog_routes.py` | Track CRUD, CSV/Spotify/TrackID imports |
| `api/pipeline_routes.py` | Job queue, results, SSE events |
| `api/auth_routes.py` | Agent registration and management |
| `api/spotify_auth_routes.py` | Spotify OAuth 2.0 connect/disconnect |

---

## Configuration

`djtoolkit.toml` (TOML, Python 3.11+ stdlib `tomllib`) is loaded by `config.py` into a tree of dataclasses. Every key has a default — the file is optional, and a missing file or missing key always falls back to the dataclass default without crashing.

```
Config
├── DbConfig          [db]            — DB file path
├── PathsConfig       [paths]         — downloads_dir, inbox_dir, library_dir, scan_dir
├── SoulseekConfig    [soulseek]      — username, password, timeouts
├── MatchingConfig    [matching]      — fuzzy score thresholds, duration tolerance
├── FingerprintConfig [fingerprint]   — AcoustID key, fpcalc path, enabled flag
├── LoudnormConfig    [loudnorm]      — EBU R128 target LUFS/TP/LRA
├── CoverArtConfig    [cover_art]     — force re-embed, skip flags
└── AudioAnalysisConfig [audio_analysis] — model paths, genre top-N, threshold
```

---

## External Dependencies

| Dependency | Role | Notes |
|---|---|---|
| **aioslsk** | Soulseek download client | Embedded Python client; runs inside djtoolkit process |
| **fpcalc** (Chromaprint) | Audio fingerprinting | CLI binary; auto-detected on `PATH` or set via config |
| **AcoustID API** | Fingerprint → MusicBrainz recording ID | Optional; free key at acoustid.org |
| **librosa** | BPM, chroma/key, danceability | Cross-platform; works on Python 3.14 / Apple Silicon / Windows |
| **pyloudnorm** | EBU R128 integrated loudness (LUFS) | Cross-platform; matches Spotify's loudness scale |
| **essentia-tensorflow** | MusicNN embeddings, Discogs genre, vocal/instrumental | Optional; Linux/macOS x86_64 only, Python ≤3.11 |
| **mutagen** | Read/write audio tags (ID3, FLAC, M4A) | |
| **thefuzz** | Fuzzy string matching for Soulseek result scoring | |
| **httpx** | Async HTTP client (agent ↔ cloud, Spotify OAuth) | |
| **keyring** | System credential store (agent keys, Soulseek creds) | macOS Keychain, Windows Credential Locker, Linux Secret Service |
| **cryptography** (Fernet) | Encrypt Spotify tokens at rest | |
| **slowapi** | Rate limiting | Per-user via JWT sub or agent key prefix |

---

## Design Principles

**DB as single source of truth.** No in-memory state survives a restart. Every pipeline step reads what it needs from the DB and writes its results back. Crashing mid-step leaves the flag at 0 — re-running picks up where it left off.

**Idempotent pipeline steps.** Each module queries `flag = 0` (or `acquisition_status = 'candidate'`) to find unprocessed work. Running `make fingerprint` twice is safe — already-fingerprinted tracks are skipped.

**Independent processing flags.** The seven flags are not a linear state machine. A folder-imported track can be `enriched_audio=1` without ever being `metadata_written=1`. Each step only cares about its own flag and `acquisition_status`.

**Auto-queue chain (cloud).** In the cloud flow, each job's success automatically creates the next job: `download → fingerprint → cover_art → metadata`. The agent just polls and executes — the cloud orchestrates the pipeline.

**Lazy imports.** `aioslsk` and `essentia` are imported inside the functions that use them, not at module level. The FastAPI server and CLI start correctly even if these optional packages aren't installed — errors surface only when the relevant command is actually invoked.

**Cross-platform paths.** `pathlib.Path` is used throughout. No hardcoded `/` or `\` separators.

**Config with safe defaults.** Every config key has a dataclass default. `djtoolkit.toml` is optional — useful for running in CI or a clean environment without needing a config file present.
