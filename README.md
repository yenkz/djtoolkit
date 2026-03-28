# djtoolkit

[![CI](https://github.com/yenkz/djtoolkit/actions/workflows/ci.yml/badge.svg)](https://github.com/yenkz/djtoolkit/actions/workflows/ci.yml)

A full-stack tool for managing a DJ music library — download, tag, deduplicate, and organize tracks automatically.

djtoolkit uses [aioslsk](https://github.com/JurgenR/aioslsk) to download from Soulseek directly (embedded Python client, no external service), matches tracks from Spotify playlists, enriches metadata, fingerprints for deduplication, and moves finalized files into a clean library folder.

The system has two modes:
- **CLI** — run pipeline steps directly via `make` commands, backed by Supabase (PostgreSQL)
- **Web** — Next.js frontend deployed on Vercel with Supabase (PostgreSQL + Auth), plus a local agent daemon that processes jobs in the background

---

## Prerequisites

### CLI (Python backend)

| Requirement | Notes |
| --- | --- |
| **macOS** (recommended) | Tested on macOS with Apple Silicon. Linux works. Windows untested. |
| **[Homebrew](https://brew.sh)** | macOS package manager — install it first |
| **Python 3.11+** | `brew install python` |
| **[Poetry](https://python-poetry.org)** | `brew install poetry` |
| **Soulseek account** | Free account at [slsknet.org](http://www.slsknet.org) — needed for downloading |
| **Chromaprint** (`fpcalc`) | `brew install chromaprint` — needed for fingerprinting |
| **Supabase project** | PostgreSQL + Auth — set `SUPABASE_PROJECT_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `DJTOOLKIT_USER_ID` in `.env` |
| **Soulseek credentials** | Username in `djtoolkit.toml [soulseek]`, password in `.env` as `SOULSEEK_PASSWORD` |

### Web frontend (optional)

| Requirement | Notes |
| --- | --- |
| **Node.js 20+** | `brew install node` |
| **npm** | Comes with Node.js |
| **Supabase project** | Auth + PostgreSQL — configure in `web/.env.local` |

### API keys (optional but recommended)

| Key | Used for | How to get |
| --- | --- | --- |
| **AcoustID** | Fingerprint → MusicBrainz lookup (deduplication) | Free at [acoustid.org/login](https://acoustid.org/login) |
| **Spotify Client ID + Secret** | Spotify metadata enrichment + cover art | Create an app at [developer.spotify.com](https://developer.spotify.com/documentation/web-api/concepts/apps) |
| **Last.fm API key** | `lastfm` cover art source | Free at [last.fm/api/account/create](https://www.last.fm/api/account/create) |

These go in `.env` (see `.env.example`). The three default cover art sources — Cover Art Archive, iTunes, and Deezer — require no API keys.

---

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/youruser/djtoolkit.git
cd djtoolkit
make install

# 2. Configure
make init          # copies djtoolkit.toml.example → djtoolkit.toml and .env.example → .env
                   # edit djtoolkit.toml — set your paths (downloads_dir, library_dir, etc.)
                   # edit .env — fill in API keys (AcoustID, Spotify, Last.fm as needed)

# 3. Add your Soulseek credentials
                   # edit djtoolkit.toml → set username under [soulseek]
                   # edit .env → set SOULSEEK_PASSWORD

# 4. Run the pipeline (Flow 1 — from Exportify CSV)
make import-csv CSV=~/Downloads/my_playlist.csv
make download
make fingerprint
make apply-metadata
make move-to-library
```

That's it — your tracks are tagged and in `~/Music/DJ/library`.

---

## Flows

### Flow 1 — Exportify CSV → Downloaded + Tagged

Import a playlist exported from [Exportify](https://exportify.net), download each track via Soulseek, fingerprint to remove duplicates, write clean tags, and move to your library.

```text
import-csv → download → fingerprint → apply-metadata → move-to-library
```

See [docs/flows.md](docs/flows.md#flow-1) for a full step-by-step walkthrough.

### Flow 2 — Folder → Enriched + Organized

Scan a local folder of already-downloaded audio files, enrich metadata from an Exportify CSV or audio analysis, write tags, and move to the library.

```text
import-folder → metadata apply --source → move-to-library
```

See [docs/flows.md](docs/flows.md#flow-2) for details.

---

## Web UI

The web frontend is a Next.js app in `web/` with Supabase Auth, deployed to Vercel. API route handlers live in `web/app/api/`.

```bash
cd web && npm install && npm run dev   # Next.js at http://localhost:3000
```

Pages: import, catalog, pipeline, agents, settings.

---

## Local Agent

The agent is a desktop app (Tauri) that runs in the system tray and manages a background daemon on your machine. The daemon polls the cloud API for jobs (download, fingerprint, metadata, cover art) and executes them locally.

### Installing the desktop app

#### macOS

1. Download the `.dmg` from the [latest release](../../releases/latest)
2. Open the `.dmg` and drag **djtoolkit** to your Applications folder
3. On first launch macOS will block the app because it is not from a verified developer:
   - Open **System Settings → Privacy & Security**
   - Scroll down to the blocked app notice and click **Open Anyway**
   - Click **Open** in the confirmation dialog
4. The app will appear in the menu bar. Follow the setup wizard to sign in and enter your Soulseek credentials.

> **Why does macOS block it?**
> The app is ad-hoc signed (no paid Apple Developer certificate). It is safe to open — just follow the "Open Anyway" steps above instead of running any terminal command.

#### Windows

1. Download the `.msi` from the [latest release](../../releases/latest)
2. Run the installer — Windows may show a SmartScreen warning, click **More info → Run anyway**
3. The app will appear in the system tray. Follow the setup wizard.

### Running the agent manually (CLI)

```bash
djtoolkit agent start      # start the background daemon
djtoolkit agent stop       # stop the daemon
djtoolkit agent status     # check daemon status
```

On macOS the daemon can also be installed as a launchd service to auto-start on login.

---

## Key Commands

```bash
make import-csv CSV=path/to.csv     # import Exportify playlist
make download                        # download via Soulseek
make fingerprint                     # deduplicate with Chromaprint
make apply-metadata                  # write tags + normalize filenames
make move-to-library                 # move tagged files into library_dir (requires metadata_written=1)
make move-to-library MODE=imported   # move all available tracks (skips metadata_written check)

make import-folder DIR=path/         # scan existing folder (Flow 2)
make import-trackid URL=https://...  # identify track from YouTube URL
djtoolkit metadata apply --source spotify --csv path/to.csv  # enrich DB + write tags in one step
djtoolkit metadata apply --source audio-analysis             # BPM / key / loudness via librosa
make enrich ARGS='--spotify x.csv'   # enrich DB only (no file writes)
make fetch-cover-art                 # fetch + embed cover art

poetry run djtoolkit db status        # track counts + processing flags
poetry run djtoolkit db reset-downloading  # reset stuck downloads → candidate
poetry run djtoolkit db purge-failed       # delete all failed tracks
```

See [docs/flows.md](docs/flows.md) for the full pipeline reference.

---

## Project Structure

```text
djtoolkit/
├── djtoolkit/
│   ├── __main__.py             # Typer CLI entry point
│   ├── config.py               # loads djtoolkit.toml via tomllib + dotenv loader
│   ├── adapters/
│   │   ├── base.py             # abstract adapter interface
│   │   ├── supabase.py         # SupabaseAdapter — sole data access layer
│   │   ├── traktor.py          # Traktor NML import/export
│   │   └── rekordbox.py        # Rekordbox XML import/export
│   ├── models/
│   │   ├── track.py            # Track dataclass (to_db_row / from_db_row)
│   │   └── camelot.py          # Camelot wheel key conversion
│   ├── agent/                  # local agent daemon (job polling + execution)
│   │   ├── daemon.py           # async event loop
│   │   ├── runner.py           # job dispatcher
│   │   ├── executor.py         # job executor
│   │   ├── client.py           # HTTP client for cloud API
│   │   ├── keychain.py         # credential storage
│   │   ├── launchd.py          # macOS launchd integration
│   │   └── jobs/               # download, fingerprint, metadata, cover_art
│   ├── db/
│   │   ├── supabase_client.py  # get_client() — reads env vars, returns supabase.Client
│   │   ├── pg_schema.sql       # PostgreSQL schema reference
│   │   └── rls.sql             # Row-Level Security policies
│   ├── importers/
│   │   ├── exportify.py        # Flow 1: Exportify CSV → candidate tracks
│   │   ├── folder.py           # Flow 2: scan audio files → available tracks
│   │   └── trackid.py          # Flow 3: YouTube mix → identified tracks
│   ├── downloader/
│   │   └── aioslsk_client.py   # embedded Soulseek client
│   ├── fingerprint/
│   │   └── chromaprint.py      # fpcalc wrapper + AcoustID lookup
│   ├── metadata/
│   │   └── writer.py           # mutagen tag writer + filename normalizer
│   ├── enrichment/
│   │   ├── spotify.py          # Exportify CSV metadata enrichment
│   │   └── audio_analysis.py   # librosa BPM/key/loudness
│   ├── coverart/
│   │   └── art.py              # cover art fetcher + embedder
│   ├── library/
│   │   └── mover.py            # move tagged files to library_dir
│   └── utils/
│       └── search_string.py    # Soulseek search query builder
├── web/                        # Next.js frontend (deployed to Vercel)
│   ├── app/                    # App Router (TypeScript)
│   │   ├── api/                # API route handlers
│   │   ├── login/              # login page
│   │   ├── auth/callback/      # OAuth callback
│   │   └── (app)/              # authenticated pages
│   │       ├── import/         # import flows
│   │       ├── catalog/        # library browse
│   │       ├── pipeline/       # pipeline status
│   │       ├── agents/         # agent management
│   │       └── settings/       # settings
│   ├── components/             # React components
│   └── lib/                    # Supabase client + utilities
├── supabase/                   # Supabase project config + migrations
├── tests/
├── packaging/                  # PyInstaller config (macOS + Windows)
├── Makefile
└── pyproject.toml
```

---

## Configuration

Copy `djtoolkit.toml.example` to `djtoolkit.toml` and edit it. Secrets (`SOULSEEK_PASSWORD`, `ACOUSTID_API_KEY`) go in `.env`.

See [docs/configuration.md](docs/configuration.md) for a full reference.

---

## Deployment

- **Web**: Auto-deployed to Vercel on push to master
- **Database**: Supabase (hosted PostgreSQL + Auth + Realtime)
- **Agent**: Runs locally on your machine, polls Supabase for jobs

---

## Documentation

| Doc | Contents |
| --- | --- |
| [docs/flows.md](docs/flows.md) | Pipeline walkthroughs (Flow 1, 2 & 3) |
| [docs/configuration.md](docs/configuration.md) | Full `djtoolkit.toml` reference |
| [ARCHITECTURE.md](ARCHITECTURE.md) | System design & component overview |

---

## License

Personal project — not yet licensed for public distribution.
