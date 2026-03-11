# Database Reference

djtoolkit uses a single SQLite file (`djtoolkit.db` by default). The database is the single source of truth for all track state — every pipeline step reads from and writes to it.

---

## Tables

### `tracks`

Every track in any state lives here.

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER PK | Auto-incremented row ID |
| `acquisition_status` | TEXT | Pipeline stage — see lifecycle below |
| `source` | TEXT | `exportify` (Flow 1) or `folder` (Flow 2) |
| `title` | TEXT | Track title |
| `artist` | TEXT | Primary artist (first in list) |
| `artists` | TEXT | All artists, semicolon-separated (raw from Exportify) |
| `album` | TEXT | Album name |
| `year` | INTEGER | Derived from `release_date` |
| `release_date` | TEXT | Full release date string from Spotify |
| `duration_ms` | INTEGER | Track duration in milliseconds |
| `isrc` | TEXT | International Standard Recording Code |
| `genres` | TEXT | Comma-separated genre list |
| `record_label` | TEXT | Record label |
| `spotify_uri` | TEXT UNIQUE | `spotify:track:XXX` |
| `popularity` | INTEGER | Spotify popularity score (0–100) |
| `explicit` | INTEGER | 0/1 boolean |
| `added_by` | TEXT | Spotify user who added the track |
| `added_at` | TEXT | Date added to Spotify playlist |
| `danceability` | REAL | Spotify audio feature (0–1) |
| `energy` | REAL | Spotify audio feature (0–1) |
| `key` | INTEGER | Pitch class (0=C … 11=B), -1 if unknown |
| `loudness` | REAL | Overall loudness in dBFS |
| `mode` | INTEGER | 0=minor, 1=major |
| `speechiness` | REAL | Spoken-word presence (0–1) |
| `acousticness` | REAL | Acoustic confidence (0–1) |
| `instrumentalness` | REAL | Instrumental confidence (0–1) |
| `liveness` | REAL | Audience presence (0–1) |
| `valence` | REAL | Musical positiveness (0–1) |
| `tempo` | REAL | Estimated BPM |
| `time_signature` | INTEGER | Estimated beats per bar |
| `search_string` | TEXT | Soulseek query string |
| `local_path` | TEXT | Absolute path to file on disk |
| `download_job_id` | TEXT | Download job reference |
| `fingerprint_id` | INTEGER FK | → `fingerprints.id` |
| `fingerprinted` | INTEGER | 0/1 — set after fpcalc runs |
| `enriched_spotify` | INTEGER | 0/1 — set after Exportify enrichment |
| `enriched_audio` | INTEGER | 0/1 — set after librosa/essentia analysis |
| `metadata_written` | INTEGER | 0/1 — set after mutagen writes tags |
| `normalized` | INTEGER | 0/1 — reserved for loudness normalization |
| `in_library` | INTEGER | 0/1 — set after file moved to `library_dir` |
| `created_at` | DATETIME | Row creation timestamp |
| `updated_at` | DATETIME | Auto-updated on every change |

### `fingerprints`

Chromaprint data, one row per unique fingerprint.

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER PK | |
| `track_id` | INTEGER FK | → `tracks.id` (CASCADE delete) |
| `fingerprint` | TEXT | Raw Chromaprint fingerprint string |
| `acoustid` | TEXT | AcoustID recording ID (if looked up) |
| `duration` | REAL | Actual audio duration in seconds |
| `created_at` | DATETIME | |

### `track_embeddings`

Optional MusicNN embeddings (requires essentia-tensorflow).

| Column | Type | Description |
|---|---|---|
| `track_id` | INTEGER PK FK | → `tracks.id` |
| `model` | TEXT | Model name, e.g. `msd-musicnn-1` |
| `embedding` | BLOB | float32 numpy array as raw bytes |
| `created_at` | DATETIME | |

---

## Track Lifecycle

`acquisition_status` tracks where a track is in the acquisition pipeline.

```
[exportify import]  → candidate → downloading → available
                                              ↘ failed
                               → duplicate       (fingerprint match)

[folder import]     → available   (file already on disk, no download needed)
```

| Status | Meaning |
|---|---|
| `candidate` | Imported from CSV, waiting to be downloaded |
| `downloading` | Soulseek download in progress |
| `available` | File is on disk and ready for processing |
| `failed` | Download failed (can be reset to `candidate` via the UI) |
| `duplicate` | Audio fingerprint matched an existing track |

---

## Processing Flags

Processing flags are **independent booleans** set to `1` when that pipeline step completes. A track can have `fingerprinted=1` and `metadata_written=0` simultaneously — they don't depend on each other.

| Flag | Set by | Query filter |
|---|---|---|
| `fingerprinted` | `fingerprint/chromaprint.py` | `available AND fingerprinted=0` |
| `enriched_spotify` | `enrichment/spotify.py` | `available AND enriched_spotify=0` |
| `enriched_audio` | `enrichment/audio_analysis.py` | `available AND enriched_audio=0` |
| `metadata_written` | `metadata/writer.py` | `available AND metadata_written=0 AND source='exportify'` |
| `normalized` | (future) | `available AND normalized=0` |
| `in_library` | `library/mover.py` | `available AND metadata_written=1 AND in_library=0` |

---

## Schema Management

```bash
make setup       # fresh install — creates all tables from schema.sql
make migrate-db  # existing DB — adds missing columns idempotently (safe to re-run)
make check-db    # runs PRAGMA integrity_check
make wipe-db     # drops all tables and recreates (destructive — asks for confirmation)
```

Migration is handled by `ALTER TABLE ADD COLUMN` — safe to run multiple times. When you pull schema changes, always run `make migrate-db`.
