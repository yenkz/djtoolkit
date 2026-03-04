# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

**djtoolkit** is a Python CLI tool for managing a DJ music library. It downloads music via [slskd](https://github.com/slskd/slskd) (Soulseek client running in Docker locally), enriches tracks with metadata, deduplicates using audio fingerprinting (Chromaprint/AcoustID), and writes clean metadata to files. The **SQLite database is the single source of truth** for all track state.

---

## Commands

```bash
# Setup
make install                      # poetry install
make setup                        # initialize DB from schema
make migrate-db                   # migrate existing DB to current schema (idempotent)

# Flow 1 — Exportify CSV → Downloaded + Tagged
make import-csv CSV=path/to.csv   # import Exportify CSV → DB (acquisition_status: candidate)
make download                     # send candidate tracks to slskd, poll until done
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

# Cover art
make fetch-cover-art              # fetch + embed cover art for tracks missing artwork

# Utilities
make check-db                     # DB integrity check
make wipe-db                      # drop and recreate DB (destructive, asks confirmation)
make normalize                    # ReplayGain/EBU R128 loudness normalization
make playlist                     # generate M3U playlists grouped by genre/style

# Dev
make ui                           # start FastAPI + UI at http://localhost:8000
poetry run pytest                 # run all tests
poetry run pytest tests/test_X.py # run single test file
```

---

## Project Structure

```
djtoolkit/
├── djtoolkit/
│   ├── __init__.py
│   ├── __main__.py             # Typer CLI entry point
│   ├── config.py               # loads djtoolkit.toml via tomllib
│   ├── db/
│   │   ├── database.py         # sqlite3 connection, setup, migrate, wipe helpers
│   │   └── schema.sql          # CREATE TABLE statements
│   ├── importers/
│   │   ├── exportify.py        # Flow 1: parse Exportify CSV → tracks (candidate)
│   │   └── folder.py           # Flow 2: scan audio files in a directory (available)
│   ├── downloader/
│   │   └── slskd.py            # slskd REST API client + polling loop
│   ├── fingerprint/
│   │   └── chromaprint.py      # fpcalc wrapper, AcoustID lookup, dupe detection
│   ├── metadata/
│   │   └── writer.py           # mutagen tag writer, filename normalizer
│   ├── enrichment/
│   │   ├── spotify.py          # enrich from Exportify CSV (fills NULL metadata)
│   │   └── audio_analysis.py   # librosa BPM/key/loudness + optional essentia-tensorflow genre
│   ├── coverart/
│   │   └── art.py              # cover art fetcher (CoverArtArchive, iTunes, Deezer, Spotify, Last.fm) + mutagen embedder
│   ├── library/
│   │   └── mover.py            # move tagged files to library_dir, set in_library=1
│   ├── utils/
│   │   └── search_string.py    # build slskd search query from track metadata
│   └── api/
│       ├── app.py              # FastAPI app, mounts static UI
│       └── routes.py           # REST endpoints for the UI
├── ui/
│   └── index.html              # Single-page HTML5 + vanilla JS UI (no build step)
├── legacy/
│   └── spotify_oauth/          # deprecated OAuth-based Spotify import — DO NOT USE
├── tests/
├── Makefile
└── pyproject.toml
```

---

## Configuration (`djtoolkit.toml`)

All runtime configuration lives in a single TOML file. The config module reads it with `tomllib` (Python 3.11+ stdlib).

```toml
[db]
path = "djtoolkit.db"

[paths]
downloads_dir = "~/Soulseek/downloads/complete"
inbox_dir     = "~/Music/DJ/inbox"
library_dir   = "~/Music/DJ/library"
scan_dir      = ""                        # for import-folder

[slskd]
host             = "http://localhost:5030"
url_base         = "/api/v0"
api_key          = ""                     # optional, if slskd auth is enabled
search_timeout_ms = 90000
response_limit   = 100
file_limit       = 10000

[matching]
min_score          = 0.86                 # fuzzy title+artist match threshold
min_score_title    = 0.78
duration_tolerance_ms = 2000

[fingerprint]
acoustid_api_key    = ""
fpcalc_path         = ""                  # auto-detected if empty
duration_tolerance_sec = 5.0
enabled             = true

[loudnorm]
target_lufs = "-9"
target_tp   = "-1.0"
target_lra  = "9"

[cover_art]
force          = false
skip_embed     = false
sources        = "coverart itunes deezer"
                 # Available sources (space-separated, tried in order):
                 #   coverart — Cover Art Archive (MusicBrainz), free, no auth
                 #   itunes   — iTunes Search API, free, no auth (album-based)
                 #   deezer   — Deezer Search API, free, no auth (track-title-based, good for singles)
                 #   spotify  — direct lookup via spotify_uri, requires SPOTIFY_CLIENT_ID + SPOTIFY_CLIENT_SECRET in .env
                 #   lastfm   — Last.fm album art, requires LASTFM_API_KEY in .env or below
lastfm_api_key = ""      # or set LASTFM_API_KEY in .env
minwidth       = 800     # reject images narrower than this (px)
maxwidth       = 2000    # resize images wider than this (px, requires Pillow)
quality        = 90      # JPEG quality when re-encoding after resize

[audio_analysis]
models_dir           = "~/.djtoolkit/models"
musicnn_model        = ""   # optional: msd-musicnn-1.pb (essentia-tensorflow)
discogs_genre_model  = ""   # optional: genre_discogs400-discogs-musicnn-1.pb
discogs_genre_labels = ""   # optional: genre_discogs400-discogs-musicnn-1-labels.json
instrumental_model   = ""   # optional: voice_instrumental-audioset-musicnn-1.pb
genre_top_n          = 3
genre_threshold      = 0.1
```

---

## Database Schema

### `tracks` — every track in any state

Key columns:

| column | type | notes |
|---|---|---|
| acquisition_status | TEXT | `candidate`, `downloading`, `available`, `failed`, `duplicate` |
| source | TEXT | `exportify` or `folder` |
| spotify_uri | TEXT UNIQUE | `spotify:track:XXX` |
| title, artist, album | TEXT | primary metadata |
| artists | TEXT | all artists, pipe-separated (raw from CSV: semicolons) |
| year, release_date | | |
| duration_ms | INTEGER | |
| isrc | TEXT | |
| genres, record_label | TEXT | |
| danceability, energy, key, loudness, mode | REAL/INT | audio features |
| speechiness, acousticness, instrumentalness, liveness, valence | REAL | |
| tempo, time_signature | REAL/INT | |
| search_string | TEXT | built for slskd queries |
| local_path | TEXT | absolute path on disk after download |
| slskd_job_id | TEXT | slskd download job reference |
| fingerprint_id | INTEGER FK | → fingerprints.id |
| fingerprinted | INTEGER 0/1 | set by `chromaprint.py` |
| enriched_spotify | INTEGER 0/1 | set by `enrichment/spotify.py` |
| enriched_audio | INTEGER 0/1 | set by `enrichment/audio_analysis.py` |
| metadata_written | INTEGER 0/1 | set by `metadata/writer.py` |
| metadata_source | TEXT | last source written to file: `spotify` or `audio-analysis` |
| normalized | INTEGER 0/1 | reserved for loudness normalization |
| cover_art_written | INTEGER 0/1 | set by `coverart/art.py` — art embedded into file |
| cover_art_embedded_at | DATETIME | set only when art is *newly* embedded (NULL = pre-existing art or not yet processed) |
| in_library | INTEGER 0/1 | set by `library/mover.py` — file moved to `library_dir` |

### `fingerprints` — Chromaprint data

| column | type |
|---|---|
| track_id | INTEGER FK → tracks.id |
| fingerprint | TEXT |
| acoustid | TEXT |
| duration | REAL |

### `track_embeddings` — MusicNN embeddings (optional)

| column | type |
|---|---|
| track_id | INTEGER FK → tracks.id |
| model | TEXT |
| embedding | BLOB (float32 bytes) |

---

## Track Lifecycle

`acquisition_status` tracks where a track is in the acquisition pipeline:

```
[exportify import] → candidate → downloading → available
                                             ↘ failed
                              → duplicate  (fingerprint match — set by chromaprint)

[folder import]    → available  (file already on disk)
```

Processing flags are **independent** — each is set to 1 when that pipeline step completes, regardless of the others:

| Flag | Set by | When |
|---|---|---|
| `fingerprinted` | `chromaprint.py` | fpcalc run (1 = done, including duplicates) |
| `enriched_spotify` | `enrichment/spotify.py` | matched against Exportify CSV |
| `enriched_audio` | `enrichment/audio_analysis.py` | BPM/key/loudness analyzed |
| `metadata_written` | `metadata/writer.py` | tags written to file |
| `normalized` | (future) | loudness normalization applied |
| `cover_art_written` | `coverart/art.py` | cover art embedded into file |
| `in_library` | `library/mover.py` | file moved to `library_dir` |

**Query pattern** — each module reads only what it needs to process:

- `chromaprint.py`: `WHERE acquisition_status = 'available' AND fingerprinted = 0`
- `writer.py` (no `--source`): `WHERE acquisition_status = 'available' AND metadata_written = 0 AND local_path IS NOT NULL`
- `writer.py` (`--source spotify`): `WHERE id IN (matched_ids from CSV) AND local_path IS NOT NULL`; skips tracks where `metadata_written=1 AND metadata_source='spotify'`
- `writer.py` (`--source audio-analysis`): `WHERE acquisition_status = 'available' AND enriched_audio = 1 AND local_path IS NOT NULL`; skips tracks where `metadata_written=1 AND metadata_source='audio-analysis'`
- `spotify.py`: `WHERE acquisition_status = 'available' AND enriched_spotify = 0` (or all `available` when `force=True`)
- `audio_analysis.py`: `WHERE acquisition_status = 'available' AND enriched_audio = 0`
- `art.py` (default): `WHERE acquisition_status = 'available' AND local_path IS NOT NULL AND cover_art_written = 0`; skips files that already have embedded art
- `art.py` (`force=true`): `WHERE acquisition_status = 'available' AND local_path IS NOT NULL` (re-embeds all)
- `mover.py`: `WHERE acquisition_status = 'available' AND metadata_written = 1 AND in_library = 0`

---

## Key Implementation Notes

**`search_string` logic** (`utils/search_string.py`):
- Take first artist (before `;` in CSV)
- Strip `feat.`, `ft.`, `vs.` and content in `()` from artist
- Keep remix/version info in title (helps find the right file on Soulseek)
- Normalize: remove special chars except spaces, collapse whitespace
- Format: `"{artist} {title}"` — all lowercase

**slskd flow** (`downloader/slskd.py`):
1. `POST /api/v0/searches` with `search_string` → get search ID
2. Poll `GET /api/v0/searches/{id}` until `isComplete: true`
3. Score each result with fuzzy matching (`thefuzz`) against title + artist, within `duration_tolerance_ms`; filter by `min_score`
4. `POST /api/v0/transfers/downloads/{username}/{filename}` for best match
5. Poll `GET /api/v0/transfers/downloads` until `state: Completed` or `state: Errored`

**Audio analysis** (`enrichment/audio_analysis.py`):

- Primary (cross-platform): `librosa` for BPM/key/danceability + `pyloudnorm` for EBU R128 LUFS
- Optional (Linux/macOS x86_64, Python ≤3.11): `essentia-tensorflow` for MusicNN embeddings → Discogs genre + vocal/instrumental classifiers
- Key algorithm: Krumhansl-Schmuckler on chroma_cqt for key detection

**Exportify CSV columns** (exact header names):
`Track URI, Track Name, Album Name, Artist Name(s), Release Date, Duration (ms), Popularity, Explicit, Added By, Added At, Genres, Record Label, Danceability, Energy, Key, Loudness, Mode, Speechiness, Acousticness, Instrumentalness, Liveness, Valence, Tempo, Time Signature`

**UI**: Single HTML5 page (`ui/index.html`), served as static file by FastAPI. No build step, no Node.js. Vanilla JS only.

**Legacy**: `legacy/spotify_oauth/` contains the old rate-unlimited, deprecated-endpoint Spotify OAuth import. Never import from it in new code.

**Cross-platform**: use `pathlib.Path` everywhere. Never hardcode path separators.

**DB migration**: `database.py` exposes `migrate(db_path)` which uses `ALTER TABLE ADD COLUMN` (idempotent). Run `make migrate-db` when pulling schema changes. Fresh installs use `make setup` and get the current schema directly.
