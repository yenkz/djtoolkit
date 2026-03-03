# Architecture — djtoolkit

djtoolkit is a Python CLI for managing a DJ music library. It ingests tracks from two sources (Exportify CSV exports or local folders), downloads missing files via Soulseek, deduplicates by audio fingerprint, enriches metadata, and writes clean tags to disk. **SQLite is the single source of truth** — all pipeline state lives in `djtoolkit.db` and every step is re-entrant.

---

## Component Map

```
┌─────────────────────────────────────────────────────────────────┐
│  Input Sources                                                  │
│                                                                 │
│  Exportify CSV ──► importers/exportify.py ──────────────────┐  │
│  Local folder  ──► importers/folder.py  ────────────────────┤  │
└─────────────────────────────────────────────────────────────│──┘
                                                              │
                                                              ▼
┌──────────────────────────────────────────────────────────────────┐
│  SQLite DB  (djtoolkit.db)                                       │
│  ┌──────────┐  ┌──────────────┐  ┌──────────────────────────┐  │
│  │  tracks  │  │ fingerprints │  │    track_embeddings       │  │
│  └──────────┘  └──────────────┘  └──────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
      ▲  │                    ▲                       ▲
      │  │                    │                       │
      │  ▼                    │                       │
      │  downloader/slskd.py ──► slskd (Docker)       │
      │                        Soulseek network        │
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
      └── metadata/writer.py ──► audio files on disk

┌─────────────────────────────────┐
│  API & UI                       │
│  api/app.py + api/routes.py     │  ◄── FastAPI, port 8000
│  ui/index.html                  │  ◄── vanilla JS, no build step
└─────────────────────────────────┘
```

---

## The Two Flows

### Flow 1 — Exportify CSV → Downloaded + Tagged

For tracks you want to find on Soulseek and download.

```
make import-csv CSV=…
  └─ importers/exportify.py
       Parses Exportify CSV, inserts rows
       acquisition_status = 'candidate'

make download
  └─ downloader/slskd.py
       For each 'candidate': search slskd → score results → enqueue best match
       Sets: 'candidate' → 'downloading' → 'available'  (or 'failed')

make fingerprint
  └─ fingerprint/chromaprint.py
       For each 'available' AND fingerprinted=0: run fpcalc
       On unique:    fingerprinted = 1
       On duplicate: fingerprinted = 1, acquisition_status = 'duplicate'

make apply-metadata
  └─ metadata/writer.py
       For each 'available' AND metadata_written=0 AND source='exportify'
       Writes ID3/FLAC/M4A tags from DB, normalizes filename to 'Artist - Title.ext'
       Sets: metadata_written = 1
```

### Flow 2 — Local Folder → DB

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

---

## Database Design

### Tables

**`tracks`** — one row per track, regardless of state. The central table.

**`fingerprints`** — Chromaprint fingerprint + AcoustID lookup result, linked to `tracks.id`.

**`track_embeddings`** — MusicNN float32 embedding vectors stored as BLOBs, linked to `tracks.id`. Only populated when essentia-tensorflow models are configured.

### `acquisition_status` — where the file is in the acquisition lifecycle

| Value | Meaning |
|---|---|
| `candidate` | Waiting to be downloaded (Flow 1 only) |
| `downloading` | slskd transfer in progress |
| `available` | File exists on disk (downloaded or imported) |
| `failed` | Download failed — resettable to `candidate` |
| `duplicate` | Fingerprint matches an existing track — skip all processing |

### Processing flags — what pipeline steps have been applied

Five independent `INTEGER 0/1` columns. Each module queries `flag = 0` to find its work and sets `flag = 1` on success. Re-running any step is always safe.

| Flag | Set by | When |
|---|---|---|
| `fingerprinted` | `fingerprint/chromaprint.py` | fpcalc completed (unique or duplicate) |
| `enriched_spotify` | `enrichment/spotify.py` | CSV match attempted |
| `enriched_audio` | `enrichment/audio_analysis.py` | Audio analysis completed |
| `metadata_written` | `metadata/writer.py` | Tags written + filename normalized |
| `normalized` | *(future)* | Loudness normalization applied |

### Lifecycle diagram

```
Flow 1:  candidate ──► downloading ──► available ──► [processing flags]
                                   └──► failed   (resettable → candidate)
                    ──────────────────► duplicate (fingerprint match)

Flow 2:  available (on insert) ──► [processing flags]
```

---

## Module Reference

| Module | Responsibility | Key DB reads | Key DB writes |
|---|---|---|---|
| `importers/exportify.py` | Parse Exportify CSV → insert tracks | — | `tracks` INSERT (`candidate`) |
| `importers/folder.py` | Scan folder → fingerprint → insert | `fingerprints` (dupe check) | `tracks` INSERT (`available`), `fingerprints` |
| `downloader/slskd.py` | Search slskd, enqueue, poll transfers | `acquisition_status='candidate'` | `acquisition_status`, `local_path`, `slskd_job_id` |
| `fingerprint/chromaprint.py` | Run fpcalc, AcoustID lookup, dupe detection | `available AND fingerprinted=0` | `fingerprinted`, `acquisition_status`, `fingerprints` |
| `enrichment/spotify.py` | Fill NULL metadata from Exportify CSV | `available AND enriched_spotify=0` | metadata columns, `enriched_spotify=1` |
| `enrichment/audio_analysis.py` | BPM/key/loudness via librosa; genre via essentia (optional) | `available AND enriched_audio=0` | `tempo`, `key`, `mode`, `danceability`, `loudness`, `enriched_audio=1`, `track_embeddings` |
| `metadata/writer.py` | Write tags to file, normalize filename | `available AND metadata_written=0 AND source='exportify'` | `metadata_written=1`, `local_path` |
| `db/database.py` | `connect()`, `setup()`, `migrate()`, `wipe()` | — | — |
| `config.py` | Load `djtoolkit.toml` into typed dataclasses | — | — |
| `utils/search_string.py` | Build slskd query from artist + title | — | — |
| `api/routes.py` | REST endpoints for UI + pipeline triggering | `tracks`, `fingerprints` | `acquisition_status` (reset-failed) |
| `api/app.py` | Mount routes, serve `ui/index.html` | — | — |

---

## Configuration

`djtoolkit.toml` (TOML, Python 3.11+ stdlib `tomllib`) is loaded by `config.py` into a tree of dataclasses. Every key has a default — the file is optional, and a missing file or missing key always falls back to the dataclass default without crashing.

```
Config
├── DbConfig          [db]            — DB file path
├── PathsConfig       [paths]         — downloads_dir, inbox_dir, library_dir, scan_dir
├── SlskdConfig       [slskd]         — host, api_key, timeouts, limits
├── MatchingConfig    [matching]      — fuzzy score thresholds, duration tolerance
├── FingerprintConfig [fingerprint]   — AcoustID key, fpcalc path, enabled flag
├── LoudnormConfig    [loudnorm]      — EBU R128 target LUFS/TP/LRA
├── CoverArtConfig    [cover_art]     — force re-embed, skip flags
└── AudioAnalysisConfig [audio_analysis] — model paths, genre top-N, threshold
```

---

## API & UI

FastAPI (`api/app.py`) runs on port 8000 (`make ui`). It serves two things:

1. **REST API** (`api/routes.py`) — CRUD on tracks, pipeline triggers (download, fingerprint, metadata apply), slskd health check, DB integrity check. Pipeline steps run in FastAPI `BackgroundTasks` so the HTTP response returns immediately and progress appears in the log stream.

2. **Static UI** (`ui/index.html`) — A single HTML5 file with vanilla JS. No Node.js, no build step. Polls `/api/logs` for the in-memory log buffer (last 200 entries) and `/api/tracks/stats` for status counts.

---

## External Dependencies

| Dependency | Role | Notes |
|---|---|---|
| **slskd** | Soulseek download client | Runs in Docker at `localhost:5030`; REST API via `slskd_api` Python package (lazy imported) |
| **fpcalc** (Chromaprint) | Audio fingerprinting | CLI binary; auto-detected on `PATH` or set via config |
| **AcoustID API** | Fingerprint → MusicBrainz recording ID | Optional; free key at acoustid.org |
| **librosa** | BPM, chroma/key, danceability | Cross-platform; works on Python 3.14 / Apple Silicon / Windows |
| **pyloudnorm** | EBU R128 integrated loudness (LUFS) | Cross-platform; matches Spotify's loudness scale |
| **essentia-tensorflow** | MusicNN embeddings, Discogs genre, vocal/instrumental | Optional; Linux/macOS x86_64 only, Python ≤3.11 |
| **mutagen** | Read/write audio tags (ID3, FLAC, M4A) | |
| **thefuzz** | Fuzzy string matching for slskd result scoring | |
| **spotipy** / **httpx** | HTTP clients | |

---

## Design Principles

**DB as single source of truth.** No in-memory state survives a restart. Every pipeline step reads what it needs from the DB and writes its results back. Crashing mid-step leaves the flag at 0 — re-running picks up where it left off.

**Idempotent pipeline steps.** Each module queries `flag = 0` (or `acquisition_status = 'candidate'`) to find unprocessed work. Running `make fingerprint` twice is safe — already-fingerprinted tracks are skipped.

**Independent processing flags.** The five flags are not a linear state machine. A folder-imported track can be `enriched_audio=1` without ever being `metadata_written=1`. Each step only cares about its own flag and `acquisition_status`.

**Lazy imports.** `slskd_api` and `essentia` are imported inside the functions that use them, not at module level. The FastAPI server and CLI start correctly even if these optional packages aren't installed — errors surface only when the relevant command is actually invoked.

**Cross-platform paths.** `pathlib.Path` is used throughout. No hardcoded `/` or `\` separators.

**Config with safe defaults.** Every config key has a dataclass default. `djtoolkit.toml` is optional — useful for running in CI or a clean environment without needing a config file present.
