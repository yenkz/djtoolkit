# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

**djtoolkit** is a Python CLI + background agent for managing a DJ music library. It downloads music from Soulseek via [aioslsk](https://github.com/JurgenR/aioslsk) (embedded Python client, no external service required), enriches tracks with metadata, deduplicates using audio fingerprinting (Chromaprint/AcoustID), and writes clean metadata to files. A background **agent daemon** polls Supabase for pipeline jobs and executes them locally. **Supabase (PostgreSQL) is the single source of truth** for all track state — SQLite has been fully removed.

---

## Commands

```bash
# Setup
make install                      # poetry install
make init                         # copy example config files (djtoolkit.toml, .env)

# Required env vars in .env:
#   SUPABASE_PROJECT_URL, SUPABASE_SERVICE_ROLE_KEY, DJTOOLKIT_USER_ID (Supabase Auth UUID)

# Flow 1 — Exportify CSV → Downloaded + Tagged
make import-csv CSV=path/to.csv   # import Exportify CSV → DB (acquisition_status: candidate)
make download                     # send candidate tracks to Soulseek, poll until done
make fingerprint                  # run Chromaprint on available files, mark duplicates
make apply-metadata               # write DB metadata to audio files, normalize filenames
make move-to-library              # move tagged files into library_dir (requires metadata_written=1)
make move-to-library MODE=imported  # move all available tracks, skip metadata_written requirement

# Flow 2 — Folder → DB
make import-folder DIR=path/      # scan folder, fingerprint, skip dupes, insert as 'available'
djtoolkit metadata apply --source spotify --csv path/to.csv  # enrich DB + write tags in one step
djtoolkit metadata apply --source audio-analysis             # BPM/key/loudness via librosa
make enrich ARGS='--spotify path/to.csv'   # enrich DB only (no file writes)
make enrich ARGS='--audio-analysis'        # run BPM/key/loudness analysis (DB only)
make enrich ARGS='--spotify-api'           # enrich via Spotify Web API (needs spotify_uri, no CSV)

# Flow 3 — YouTube DJ mix → Identified tracks
make import-trackid URL=https://youtube.com/watch?v=XXX  # identify tracks via TrackID.dev

# DJ software import
djtoolkit import traktor --nml path/to/collection.nml    # import Traktor NML collection
djtoolkit import rekordbox --xml path/to/rekordbox.xml    # import Rekordbox XML collection

# Cover art
make fetch-cover-art                          # fetch + embed cover art for tracks missing artwork
poetry run djtoolkit coverart fetch -v        # same, with debug logs (source attempts, search results)
poetry run djtoolkit coverart verify          # check cover_art_written tracks actually have art in file
poetry run djtoolkit coverart verify --fix    # reset flag for tracks missing embedded art, then re-fetch
poetry run djtoolkit coverart list            # show tracks with embedded cover art
poetry run djtoolkit coverart list --since 7  # show tracks embedded in the last 7 days

# DB utilities (Supabase-backed)
poetry run djtoolkit db status          # track counts by acquisition_status + processing flags
poetry run djtoolkit db reset-downloading  # reset stuck 'downloading' tracks → candidate
poetry run djtoolkit db purge-failed       # delete all 'failed' tracks
poetry run djtoolkit db reconcile          # reconcile disk files with DB state

# Agent (background daemon)
djtoolkit agent configure          # interactive credential setup (stores in OS keychain)
djtoolkit agent install            # install as launchd service (macOS) or Windows service
djtoolkit agent uninstall          # remove daemon service
djtoolkit agent start / stop       # start or stop the daemon
djtoolkit agent status             # check daemon status
djtoolkit agent logs               # view daemon logs
djtoolkit agent run                # run jobs locally (manual/testing, no daemon)
djtoolkit setup                    # launch Setup Assistant GUI (macOS/Windows) or terminal wizard

# Not yet implemented (stubs)
# make normalize                  # ReplayGain/EBU R128 loudness normalization
# make playlist                   # generate M3U playlists grouped by genre/style
# make dedup                      # remove duplicate tracks

# Dev
poetry run pytest                 # run all tests
poetry run pytest tests/test_X.py # run single test file
cd web && npm run dev             # start Next.js dev server (API routes + UI)
make lint                         # py_compile check on all Python files
```

---

## Project Structure

```text
djtoolkit/
├── djtoolkit/
│   ├── __init__.py
│   ├── __main__.py             # Typer CLI entry point
│   ├── config.py               # loads djtoolkit.toml via tomllib
│   ├── db/
│   │   ├── supabase_client.py  # get_client() — reads env vars, returns supabase.Client
│   │   ├── pg_schema.sql       # PostgreSQL schema reference (applied via Supabase migrations)
│   │   └── rls.sql             # Row-Level Security policies
│   ├── adapters/
│   │   ├── base.py             # abstract adapter interface
│   │   ├── supabase.py         # SupabaseAdapter — sole data access layer for CLI
│   │   ├── traktor.py          # Traktor NML adapter (import/export)
│   │   └── rekordbox.py        # Rekordbox XML adapter (import/export)
│   ├── models/
│   │   ├── track.py            # Track dataclass (to_db_row / from_db_row)
│   │   └── camelot.py          # Camelot wheel key conversion
│   ├── importers/
│   │   ├── exportify.py        # Flow 1: parse Exportify CSV → tracks (candidate)
│   │   ├── folder.py           # Flow 2: scan audio files in a directory (available)
│   │   └── trackid.py          # Flow 3: YouTube mix → TrackID.dev API → tracks (candidate)
│   ├── downloader/
│   │   └── aioslsk_client.py   # embedded Soulseek client + search/download loop
│   ├── fingerprint/
│   │   └── chromaprint.py      # fpcalc wrapper, AcoustID lookup, dupe detection
│   ├── metadata/
│   │   └── writer.py           # mutagen tag writer, filename normalizer
│   ├── enrichment/
│   │   ├── spotify.py          # enrich from Exportify CSV (fills NULL metadata)
│   │   ├── spotify_lookup.py   # single-track Spotify Web API lookup (by spotify_uri)
│   │   └── audio_analysis.py   # librosa BPM/key/loudness + optional essentia-tensorflow genre
│   ├── coverart/
│   │   └── art.py              # cover art fetcher (CoverArtArchive, iTunes, Deezer, Spotify, Last.fm) + mutagen embedder
│   ├── library/
│   │   └── mover.py            # move tagged files to library_dir, set in_library=1
│   ├── agent/                  # background daemon — polls Supabase for pipeline jobs
│   │   ├── daemon.py           # Realtime job polling, heartbeat loop, signal handling
│   │   ├── executor.py         # multi-threaded job executor with status reporting
│   │   ├── runner.py           # orchestrates job chains
│   │   ├── client.py           # agent API client
│   │   ├── state.py            # agent local state management
│   │   ├── keychain.py         # OS credential store (macOS Keychain / Windows Credential Manager)
│   │   ├── launchd.py          # macOS launchd service management
│   │   ├── windows_service.py  # Windows service integration
│   │   ├── local_db.py         # SQLite local cache for agent state
│   │   ├── paths.py            # platform-specific paths (~/.djtoolkit/)
│   │   ├── platform.py         # platform detection helpers
│   │   └── jobs/               # one module per pipeline job type
│   │       ├── download.py
│   │       ├── fingerprint.py
│   │       ├── metadata.py
│   │       ├── audio_analysis.py
│   │       ├── cover_art.py
│   │       └── spotify_lookup.py
│   ├── service/                # FastAPI service (Hetzner-hosted, collection import/export)
│   │   ├── app.py              # FastAPI application factory
│   │   ├── auth.py             # authentication middleware
│   │   ├── config.py           # service configuration
│   │   └── routes/             # health, import_collection, export_collection
│   └── utils/
│       └── search_string.py    # build Soulseek search query from track metadata
├── web/                        # Next.js app (Vercel) — UI + API routes
├── setup-assistant/            # macOS Setup Assistant (Xcode/SwiftUI)
├── setup-assistant-windows/    # Windows Setup Assistant (.NET/WinUI 3)
├── legacy/
│   └── spotify_oauth/          # deprecated OAuth-based Spotify import — DO NOT USE
├── tests/
├── Makefile
└── pyproject.toml
```

---

> All config keys with defaults and comments are in `djtoolkit.toml.example`. Secrets go in `.env` (see `.env.example`).

---

## Database Schema

### `tracks` — every track in any state

Key columns:

| column | type | notes |
| --- | --- | --- |
| acquisition_status | TEXT | `candidate`, `downloading`, `available`, `failed`, `duplicate` |
| source | TEXT | `exportify`, `folder`, `trackid`, `traktor`, `rekordbox` |
| spotify_uri | TEXT UNIQUE | `spotify:track:XXX` |
| title, artist, album | TEXT | primary metadata |
| artists | TEXT | all artists, pipe-separated (raw from CSV: semicolons) |
| year, release_date, duration_ms, isrc, genres, record_label | | Spotify metadata |
| search_string | TEXT | Soulseek search query |
| local_path | TEXT | absolute path on disk after download |
| fingerprint_id | INTEGER FK | → fingerprints.id |
| fingerprinted | INTEGER 0/1 | set by `chromaprint.py` |
| enriched_spotify | INTEGER 0/1 | set by `enrichment/spotify.py` |
| enriched_audio | INTEGER 0/1 | set by `enrichment/audio_analysis.py` |
| metadata_written | INTEGER 0/1 | set by `metadata/writer.py` |
| metadata_source | TEXT | last source written to file: `spotify` or `audio-analysis` |
| normalized | INTEGER 0/1 | reserved for loudness normalization |
| cover_art_written | INTEGER 0/1 | set by `coverart/art.py` — art embedded into file |
| in_library | INTEGER 0/1 | set by `library/mover.py` — file moved to `library_dir` |

> Schema lives in `supabase/migrations/`. See `djtoolkit/db/pg_schema.sql` for reference. All tracks are scoped by `user_id` (UUID FK → auth.users) with Row-Level Security. Boolean flags are native `BOOLEAN`, not integer 0/1.

---

## Track Lifecycle

`acquisition_status` tracks where a track is in the acquisition pipeline:

```text
[exportify import]   → candidate → downloading → available
                                               ↘ failed
                                → duplicate  (fingerprint match — set by chromaprint)

[folder import]      → available  (file already on disk)

[trackid import]     → candidate  (identified from YouTube mix via TrackID.dev)

[traktor/rekordbox]  → available  (imported from DJ software collection)
```

Processing flags are **independent** — each is set to 1 when that pipeline step completes, regardless of the others:

| Flag | Set by | When |
| --- | --- | --- |
| `fingerprinted` | `chromaprint.py` | fpcalc run (1 = done, including duplicates) |
| `enriched_spotify` | `enrichment/spotify.py` | matched against Exportify CSV |
| `enriched_audio` | `enrichment/audio_analysis.py` | BPM/key/loudness analyzed |
| `metadata_written` | `metadata/writer.py` | tags written to file |
| `normalized` | (future) | loudness normalization applied |
| `cover_art_written` | `coverart/art.py` | cover art embedded into file |
| `in_library` | `library/mover.py` | file moved to `library_dir` |

Each module queries only its relevant `acquisition_status` + flag combination — read the module source for exact `WHERE` clauses.

---

## Cover Art Pipeline

**Module:** `djtoolkit/coverart/art.py`

### Sources

Tried in order as configured in `[cover_art] sources` (space-separated):

| Source | Auth | Lookup method |
| --- | --- | --- |
| `spotify` | `SPOTIFY_CLIENT_ID` + `SPOTIFY_CLIENT_SECRET` in `.env` | Uses `spotify_uri` if available; otherwise searches Spotify by artist+title (curated via `search_string` cleaning). Discovered URIs are persisted back to the DB. |
| `coverart` | None | Cover Art Archive (MusicBrainz) — release-group by artist+album, falls back to recording search by artist+title |
| `itunes` | None | iTunes Search API — album-based |
| `deezer` | None | Deezer Search API — track-title-based, good for singles |
| `lastfm` | `LASTFM_API_KEY` | Last.fm `album.getinfo` — album-based |

### Search strategy

Each source is tried with two passes:

1. **Cleaned artist + cleaned album** — strips blog prefixes, track numbers, promo suffixes
2. **First artist only** — handles compound strings like `"A & B feat. C"` → `"A"`

For Spotify search (when no `spotify_uri`), the query uses `search_string.py` cleaning: strips `feat./ft./vs.`, removes parentheticals from artist, takes primary artist (first before `;`), keeps remix info in title.

### Embedding

Supported formats: `.flac` (PICTURE block), `.mp3` (ID3 APIC frame), `.m4a/.aac` (MP4 `covr` atom). Unsupported formats (`.wav`, `.aiff`, `.ogg`) are skipped.

### DB query

`coverart fetch` processes tracks matching:

```sql
SELECT * FROM tracks
WHERE user_id = :uid
  AND acquisition_status = 'available'
  AND cover_art_written = false;
```

Files that already have embedded art (checked via mutagen) are skipped and marked `cover_art_written = true` in the DB.

### Config

```toml
[cover_art]
sources        = "spotify coverart itunes deezer"  # tried in order
force          = false    # re-embed even if art already present
skip_embed     = false    # dry-run: fetch only, don't write to files
minwidth       = 300      # reject images narrower than this (px)
maxwidth       = 2000     # resize wider images (requires Pillow)
quality        = 90       # JPEG quality after resize
lastfm_api_key = ""       # or set LASTFM_API_KEY in .env
```

### CLI commands

```bash
djtoolkit coverart fetch          # fetch + embed art for tracks with cover_art_written=false
djtoolkit coverart fetch -v       # with debug logs (source attempts, search results, failures)
djtoolkit coverart verify         # check that cover_art_written=true tracks actually have art in file
djtoolkit coverart verify --fix   # reset flag for liars, then run fetch to re-process
djtoolkit coverart list           # show tracks with embedded cover art
djtoolkit coverart list --since 7 # embedded in the last 7 days
```

---

## Agent Daemon

**Module:** `djtoolkit/agent/`

The agent is a background service that polls Supabase Realtime for `pipeline_jobs` and executes them locally. It runs as a macOS launchd service or Windows service.

### Architecture

- **`daemon.py`** — main loop: subscribes to Supabase Realtime channel, claims jobs atomically, dispatches to executor, sends heartbeats
- **`executor.py`** — thread pool that runs job modules concurrently (capped by `max_concurrent_jobs`)
- **`runner.py`** — orchestrates job chains (download → fingerprint → cover_art → metadata)
- **`jobs/`** — one module per job type: `download`, `fingerprint`, `metadata`, `audio_analysis`, `cover_art`, `spotify_lookup`

### Credentials

Agent credentials are stored in the OS keychain via `keychain.py` (macOS Keychain / Windows Credential Manager). `djtoolkit agent configure` runs an interactive wizard; `configure-headless` accepts JSON on stdin (used by the Setup Assistants).

### Pipeline Jobs

The `pipeline_jobs` table drives the agent:

| column | notes |
| --- | --- |
| `track_id` | FK → tracks.id |
| `job_type` | `download`, `fingerprint`, `cover_art`, `metadata`, `audio_analysis`, `spotify_lookup` |
| `status` | `pending`, `running`, `completed`, `failed`, `paused` |
| `claimed_by` | agent ID (UUID) — atomic claim via Supabase RPC |
| `result` | JSON — error messages, stats |

Dedup: `idx_pipeline_jobs_active_per_track` unique partial index prevents duplicate active jobs. Stale job sweeper runs via Supabase cron, capped at 3 retries before marking failed.

### Agent Config

```toml
[agent]
cloud_url           = "https://app.djtoolkit.net"
poll_interval_sec   = 5
max_concurrent_jobs = 3
max_download_batch  = 10
local_db_path       = ""   # default: ~/.djtoolkit/agent.db
```

---

## CI/CD

Workflows in `.github/workflows/`:

| Workflow | Purpose |
| --- | --- |
| `ci-web.yml` | Next.js lint + build |
| `ci-api.yml` | FastAPI service CI |
| `ci-agents.yml` | Build Setup Assistants (macOS Xcode + Windows MSBuild) |
| `ci-tauri-agent.yml` | Tauri agent app CI |
| `deploy-api.yml` | Deploy FastAPI service |
| `release-macos.yml` | macOS installer release |
| `release-windows.yml` | Windows installer release |
| `release-tauri-agent.yml` | Tauri agent release |

---

## Key Implementation Notes

**`search_string` logic** (`utils/search_string.py`): take first artist (before `;`), strip `feat.`/`ft.`/`vs.` and `()`, keep remix info in title, normalize to lowercase with no special chars. Format: `"{artist} {title}"`.

**Download flow** (`downloader/aioslsk_client.py`):

1. Broadcast search query via aioslsk, collect results for `search_timeout_sec`
2. Score results with fuzzy matching (`thefuzz`) against title + artist, filtered by `duration_tolerance_ms` and `min_score`
3. Enqueue download from the peer with the best-scoring result
4. Wait for `TransferState.COMPLETED` or a terminal failure state

**Audio analysis** (`enrichment/audio_analysis.py`):

- Primary (cross-platform): `librosa` for BPM/key/danceability + `pyloudnorm` for EBU R128 LUFS
- Optional (Linux/macOS x86_64, Python ≤3.11): `essentia-tensorflow` for MusicNN embeddings → Discogs genre + vocal/instrumental classifiers
- Key algorithm: Krumhansl-Schmuckler on chroma_cqt

**Spotify enrichment** has two modes:

- `enrichment/spotify.py` — bulk CSV-based: matches tracks against an Exportify CSV, fills NULL metadata columns
- `enrichment/spotify_lookup.py` — API-based: single-track lookup via Spotify Web API using `spotify_uri` (no CSV needed, used by agent jobs and `enrich --spotify-api`)

**TrackID import** (`importers/trackid.py`): submits a YouTube URL to TrackID.dev API, polls for results, filters by confidence threshold, inserts identified tracks as candidates. Config in `[trackid]`:

```toml
[trackid]
confidence_threshold = 0.7
poll_interval_sec    = 5
poll_timeout_sec     = 300
```

**Service layer** (`service/`): FastAPI app hosted on Hetzner, provides collection import/export endpoints for Traktor/Rekordbox. Separate from the Next.js web UI. Deployed via `deploy-api.yml`.

**UI + API**: Next.js app in `web/`, deployed to Vercel. API route handlers in `web/app/api/` cover catalog, pipeline, agents, auth, settings. Backend state lives in Supabase (PostgreSQL + Auth + Realtime).

**Legacy**: `legacy/spotify_oauth/` contains the old rate-unlimited, deprecated-endpoint Spotify OAuth import. Never import from it in new code.

**Cross-platform**: use `pathlib.Path` everywhere. Never hardcode path separators.

**Data access pattern**: All CLI modules access Supabase through `SupabaseAdapter` (in `djtoolkit/adapters/supabase.py`). The `_adapter()` helper in `__main__.py` loads `.env`, creates the client, and returns the adapter. Every command also needs `_user_id()` which reads `DJTOOLKIT_USER_ID` from env. Never import `supabase_client` directly in modules — always pass the adapter.

**Schema migrations**: Use `supabase/migrations/` with `supabase db push` or the Supabase MCP `apply_migration` tool. Never modify the schema via raw SQL on production.

**Environment**: CLI requires three env vars: `SUPABASE_PROJECT_URL` (with fallback to `SUPABASE_URL`), `SUPABASE_SERVICE_ROLE_KEY`, `DJTOOLKIT_USER_ID`. The dotenv loader in `config.py` overwrites empty env vars with `.env` values.
