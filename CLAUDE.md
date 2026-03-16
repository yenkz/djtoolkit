# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

**djtoolkit** is a Python CLI tool for managing a DJ music library. It downloads music from Soulseek via [aioslsk](https://github.com/JurgenR/aioslsk) (embedded Python client, no external service required), enriches tracks with metadata, deduplicates using audio fingerprinting (Chromaprint/AcoustID), and writes clean metadata to files. The **SQLite database is the single source of truth** for all track state.

---

## Commands

```bash
# Setup
make install                      # poetry install
make setup                        # initialize DB from schema
make migrate-db                   # migrate existing DB to current schema; drops legacy `status` column (idempotent)

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

# Cover art
make fetch-cover-art              # fetch + embed cover art for tracks missing artwork

# Utilities
make check-db                     # DB integrity check
make wipe-db                      # drop and recreate DB (destructive, asks confirmation)
make reconcile                    # scan downloads_dir, mark on-disk files as available
make normalize                    # ReplayGain/EBU R128 loudness normalization
make playlist                     # generate M3U playlists grouped by genre/style

# Dev
poetry run pytest                 # run all tests
poetry run pytest tests/test_X.py # run single test file
cd web && npm run dev             # start Next.js dev server (API routes + UI)
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
│   │   ├── database.py         # sqlite3 connection, setup, migrate, wipe helpers
│   │   └── schema.sql          # CREATE TABLE statements
│   ├── importers/
│   │   ├── exportify.py        # Flow 1: parse Exportify CSV → tracks (candidate)
│   │   └── folder.py           # Flow 2: scan audio files in a directory (available)
│   ├── downloader/
│   │   └── aioslsk_client.py   # embedded Soulseek client + search/download loop
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
│   └── utils/
│       └── search_string.py    # build Soulseek search query from track metadata
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
| source | TEXT | `exportify` or `folder` |
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

> See `djtoolkit/db/schema.sql` for full column list including audio features, `fingerprints`, and `track_embeddings` tables.

---

## Track Lifecycle

`acquisition_status` tracks where a track is in the acquisition pipeline:

```text
[exportify import] → candidate → downloading → available
                                             ↘ failed
                              → duplicate  (fingerprint match — set by chromaprint)

[folder import]    → available  (file already on disk)
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

**UI + API**: Next.js app in `web/`, deployed to Vercel. API route handlers in `web/app/api/` replace the former FastAPI backend. Backend state lives in Supabase (PostgreSQL + Auth + Realtime).

**Legacy**: `legacy/spotify_oauth/` contains the old rate-unlimited, deprecated-endpoint Spotify OAuth import. Never import from it in new code.

**Cross-platform**: use `pathlib.Path` everywhere. Never hardcode path separators.

**DB migration**: `database.py` exposes `migrate(db_path)` which uses `ALTER TABLE ADD COLUMN` (idempotent). Run `make migrate-db` when pulling schema changes. Fresh installs use `make setup` and get the current schema directly.
