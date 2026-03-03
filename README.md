# djtoolkit

A personal CLI tool for managing a DJ music library — download, tag, deduplicate, and organize tracks automatically.

djtoolkit connects to a local [slskd](https://github.com/slskd/slskd) instance (Soulseek over Docker), matches tracks from Spotify/Exportify playlists, enriches metadata, fingerprints for deduplication, and moves finalized files into a clean library folder. The SQLite database is the single source of truth for all track state.

---

## Prerequisites

| Requirement | Notes |
|---|---|
| **macOS** (recommended) | Tested on macOS with Apple Silicon. Linux works. Windows untested. |
| **[Homebrew](https://brew.sh)** | macOS package manager — install it first |
| **Python 3.11+** | `brew install python` |
| **[Poetry](https://python-poetry.org)** | `brew install poetry` |
| **[Docker Desktop](https://www.docker.com/products/docker-desktop/)** | Required to run slskd |
| **Chromaprint** (`fpcalc`) | `brew install chromaprint` — needed for fingerprinting |
| **Git** | `brew install git` |
| **[VSCode](https://code.visualstudio.com)** (recommended) | With the Python extension |

> **Soulseek account** — you need a free account at [slsknet.org](http://www.slsknet.org) to download via slskd.

---

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/youruser/djtoolkit.git
cd djtoolkit
make install

# 2. Configure
make init          # copies djtoolkit.toml.example → djtoolkit.toml and .env.example → .env
                   # edit djtoolkit.toml — set paths, slskd credentials, acoustid key

# 3. Start slskd (Soulseek client in Docker)
make slskd-up      # starts container at http://localhost:5030
                   # open the web UI, log in with your Soulseek account

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

```
import-csv → download → fingerprint → apply-metadata → move-to-library
```

See [docs/flows.md](docs/flows.md#flow-1) for a full step-by-step walkthrough.

### Flow 2 — Folder → Enriched + Organized

Scan a local folder of already-downloaded audio files, fingerprint them, optionally enrich metadata from an Exportify CSV or librosa audio analysis, then move to the library.

```
import-folder → enrich → fingerprint → apply-metadata → move-to-library
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
make download                        # download via slskd
make fingerprint                     # deduplicate with Chromaprint
make apply-metadata                  # write tags + normalize filenames
make move-to-library                 # move tagged files into library_dir

make import-folder DIR=path/         # scan existing folder (Flow 2)
make enrich ARGS='--spotify x.csv'   # enrich metadata from Exportify CSV
make enrich ARGS='--audio-analysis'  # BPM / key / loudness via librosa

make check-db                        # integrity check
make migrate-db                      # apply schema migrations to existing DB
```

See [docs/flows.md](docs/flows.md) for the full pipeline reference.

---

## Configuration

Copy `djtoolkit.toml.example` to `djtoolkit.toml` and edit it. Secrets (`SLSKD_API_KEY`, `ACOUSTID_API_KEY`) can also live in `.env`.

See [docs/configuration.md](docs/configuration.md) for a full reference.

---

## Documentation

| Doc | Contents |
|---|---|
| [docs/flows.md](docs/flows.md) | Pipeline walkthroughs (Flow 1 & 2) |
| [docs/configuration.md](docs/configuration.md) | Full `djtoolkit.toml` reference |
| [docs/database.md](docs/database.md) | Schema, track lifecycle, processing flags |
| [docs/api.md](docs/api.md) | REST API & web UI endpoints |
| [ARCHITECTURE.md](ARCHITECTURE.md) | System design & component overview |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to contribute |

---

## License

Personal project — not yet licensed for public distribution.
