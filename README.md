# djtoolkit

[![CI](https://github.com/yenkz/djtoolkit/actions/workflows/ci.yml/badge.svg)](https://github.com/yenkz/djtoolkit/actions/workflows/ci.yml)

A personal CLI tool for managing a DJ music library — download, tag, deduplicate, and organize tracks automatically.

djtoolkit uses [aioslsk](https://github.com/JurgenR/aioslsk) to download from Soulseek directly (embedded Python client, no external service), matches tracks from Spotify/Exportify playlists, enriches metadata, fingerprints for deduplication, and moves finalized files into a clean library folder. The SQLite database is the single source of truth for all track state.

---

## Prerequisites

| Requirement | Notes |
| --- | --- |
| **macOS** (recommended) | Tested on macOS with Apple Silicon. Linux works. Windows untested. |
| **[Homebrew](https://brew.sh)** | macOS package manager — install it first |
| **Python 3.11+** | `brew install python` |
| **[Poetry](https://python-poetry.org)** | `brew install poetry` |
| **Soulseek account** | Free account at [slsknet.org](http://www.slsknet.org) — needed for downloading |
| **Chromaprint** (`fpcalc`) | `brew install chromaprint` — needed for fingerprinting |
| **Git** | `brew install git` |
| **[VSCode](https://code.visualstudio.com)** (recommended) | With the Python extension |
| **Soulseek credentials** | Username in `djtoolkit.toml [soulseek]`, password in `.env` as `SOULSEEK_PASSWORD` |

### API keys (optional but recommended)

Please note, so far only Spotify App for Developers is in use, ignore the others.

| Key | Used for | How to get |
| --- | --- | --- |
| **AcoustID** | Fingerprint → MusicBrainz lookup (deduplication) | Free at [acoustid.org/login](https://acoustid.org/login) |
| **Spotify Client ID + Secret** | `spotify` cover art source | Create an app at [developer.spotify.com](https://developer.spotify.com/documentation/web-api/concepts/apps) |
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

# 4. Initialize the database
make setup

# 5. Run the pipeline (Flow 1 — from Exportify CSV)
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

```bash
make ui    # starts FastAPI + UI at http://localhost:8000
```

A single-page dashboard for monitoring pipeline status and triggering operations. No build step, no Node.js.

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
djtoolkit metadata apply --source spotify --csv path/to.csv  # enrich DB + write tags in one step
djtoolkit metadata apply --source audio-analysis             # BPM / key / loudness via librosa
make enrich ARGS='--spotify x.csv'   # enrich DB only (no file writes)

make check-db                        # integrity check
make migrate-db                      # apply schema migrations to existing DB
```

See [docs/flows.md](docs/flows.md) for the full pipeline reference.

---

## Configuration

Copy `djtoolkit.toml.example` to `djtoolkit.toml` and edit it. Secrets (`SOULSEEK_PASSWORD`, `ACOUSTID_API_KEY`) go in `.env`.

See [docs/configuration.md](docs/configuration.md) for a full reference.

---

## Documentation

| Doc | Contents |
| --- | --- |
| [docs/flows.md](docs/flows.md) | Pipeline walkthroughs (Flow 1 & 2) |
| [docs/configuration.md](docs/configuration.md) | Full `djtoolkit.toml` reference |
| [docs/database.md](docs/database.md) | Schema, track lifecycle, processing flags |
| [docs/api.md](docs/api.md) | REST API & web UI endpoints |
| [ARCHITECTURE.md](ARCHITECTURE.md) | System design & component overview |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to contribute |

---

## License

Personal project — not yet licensed for public distribution.
