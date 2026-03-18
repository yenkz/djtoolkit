# Unified Track Model, DJ Software Import/Export & SQLite Migration

**Date:** 2026-03-17
**Status:** Draft

---

## 1. Overview

Build a foundation for DJ library interoperability: a rich Python domain model (`Track`, `CuePoint`, `BeatGridMarker`), import/export adapters for Traktor NML and Rekordbox XML, a FastAPI service on Hetzner for server-side parsing, web UI for upload/download, and full migration of remaining Python modules from SQLite to Supabase.

This is the prerequisite for future features: Camelot harmonic mixing engine, set planner, and next-track suggestions.

---

## 2. Unified Track Model

### 2.1 Dataclass Hierarchy

```python
# djtoolkit/models/track.py

from dataclasses import dataclass, field
from enum import Enum
from typing import Optional

class CueType(Enum):
    CUE = "cue"
    LOOP = "loop"
    GRID = "grid"
    FADE_IN = "fade_in"
    FADE_OUT = "fade_out"
    LOAD = "load"

@dataclass
class CuePoint:
    name: str = ""
    position_ms: float = 0.0
    type: CueType = CueType.CUE
    hotcue_index: int = -1          # -1 = memory cue, 0-7 = hot cue
    loop_end_ms: float = 0.0       # only for LOOP type
    color: tuple[int, int, int] | None = None  # RGB

@dataclass
class BeatGridMarker:
    position_ms: float = 0.0
    bpm: float = 0.0
    beats_per_bar: int = 4
    beat_number: int = 1            # 1-4 within bar

@dataclass
class Track:
    # Identity
    title: str = ""
    artist: str = ""
    artists: list[str] = field(default_factory=list)
    album: str = ""
    file_path: str | None = None    # nullable for metadata-only imports

    # Musical properties
    bpm: float = 0.0
    key: str = ""                   # normalized: "C minor", "Ab major"
    camelot: str = ""               # stored: "5A", "4B"
    energy: float = 0.0             # 0.0-1.0
    danceability: float = 0.0       # 0.0-1.0

    # Metadata
    genres: str = ""                # maps to DB `genres` column (pipe-separated)
    label: str = ""
    year: int | None = None
    duration_ms: int = 0
    isrc: str | None = None
    comments: str = ""
    rating: int = 0                 # 0-5
    play_count: int = 0

    # DJ data (stored as JSONB in DB)
    cue_points: list[CuePoint] = field(default_factory=list)
    beatgrid: list[BeatGridMarker] = field(default_factory=list)

    # Source tracking
    source: str = ""                # "traktor", "rekordbox", "exportify", "folder", "trackid"
    source_id: str | None = None    # original ID in source system

    # Spotify audio features (preserved for existing data)
    spotify_uri: str | None = None
    loudness: float | None = None
    speechiness: float | None = None
    acousticness: float | None = None
    instrumentalness: float | None = None
    liveness: float | None = None
    valence: float | None = None
    tempo: float | None = None

    # Serialization
    def to_db_row(self) -> dict:
        """Serialize for Supabase upsert.
        - Flat fields map 1:1 to column names (e.g. title → title)
        - `artists` list → pipe-separated TEXT (matching existing DB convention)
        - `cue_points` → JSONB list of dicts, CueType serialized as .value string
        - `beatgrid` → JSONB list of dicts
        - `color` tuple → dict {"r": int, "g": int, "b": int} or null
        - None/default values included as null (Supabase handles defaults)
        - `key` maps to DB column `key_normalized`
        - `camelot` computed from `key` via key_to_camelot() if not already set
        """
        ...

    @classmethod
    def from_db_row(cls, row: dict) -> "Track":
        """Deserialize from Supabase query result.
        - `key_normalized` DB column → Track.key
        - Existing integer `key` column (Spotify pitch class) → converted to
          normalized string via SPOTIFY_KEY_MAP if `key_normalized` is null
        - `cue_points` JSONB → list[CuePoint], CueType.value string → enum
        - `beatgrid` JSONB → list[BeatGridMarker]
        - `artists` pipe-separated TEXT → list[str]
        - Missing/null JSONB fields → empty lists
        """
        ...

    # Accessors
    def hot_cues(self) -> list[CuePoint]:
        return [c for c in self.cue_points if c.hotcue_index >= 0 and c.type == CueType.CUE]

    def memory_cues(self) -> list[CuePoint]:
        return [c for c in self.cue_points if c.hotcue_index == -1 and c.type == CueType.CUE]

    def loops(self) -> list[CuePoint]:
        return [c for c in self.cue_points if c.type == CueType.LOOP]
```

### 2.2 Key Normalization

`key` is always stored as `"{Note} {major|minor}"` (e.g. `"C minor"`, `"Ab major"`). Each parser converts from its source format:

- Traktor: integer 0-23 via `TRAKTOR_KEY_MAP`
- Rekordbox: string like `"Cm"` → `"C minor"`, `"Ab"` → `"Ab major"`
- Spotify: already provides key + mode integers

`camelot` is stored in the DB (not computed) for efficient queries like `WHERE camelot IN (...)`.

### 2.3 Camelot Module

```python
# djtoolkit/models/camelot.py

KEY_TO_CAMELOT: dict[str, str]       # "Ab minor" → "1A", "B major" → "1B", ...
CAMELOT_TO_KEY: dict[str, str]       # reverse
TRAKTOR_KEY_MAP: dict[int, str]      # 0 → "C major", 12 → "C minor", ...

def normalize_key(raw: str, source: str) -> str:
    """Convert any key format to normalized 'Note scale' string."""

def key_to_camelot(key: str) -> str:
    """Convert normalized key to Camelot code."""

def get_compatible_keys(camelot: str) -> dict[str, list[str]]:
    """Return perfect, harmonic, and energy_boost compatible codes."""
```

---

## 3. Database Schema Changes

New columns added to the existing `tracks` table via Supabase migration:

| Column | Type | Notes |
|--------|------|-------|
| `cue_points` | `JSONB` | Array of cue point objects |
| `beatgrid` | `JSONB` | Array of beatgrid marker objects |
| `key_normalized` | `TEXT` | "C minor", "Ab major" — canonical format |
| `camelot` | `TEXT` | "5A", "4B" — stored for indexed queries |
| `rating` | `INTEGER` | 0-5, from DJ software |
| `play_count` | `INTEGER` | From DJ software collection |
| `comments` | `TEXT` | User comments from DJ software |
| `source_id` | `TEXT` | Original ID in source system |
| `file_size` | `INTEGER` | Bytes |
| `sample_rate` | `INTEGER` | e.g. 44100 |
| `bitrate` | `INTEGER` | e.g. 320000 |

Existing columns that map directly: `title`, `artist`, `artists`, `album`, `year`, `duration_ms`, `genres`, `record_label`, `isrc`, `spotify_uri`, `local_path`, `source`, `energy`, `danceability`, `loudness`, `tempo`, and all Spotify audio features.

**`key` column handling:** The existing `key` column stores Spotify's integer pitch class (0-11). It is **preserved as-is** for backward compatibility. The new `key_normalized` TEXT column stores the canonical string form ("C minor", "Ab major"). `Track.from_db_row()` reads `key_normalized` first; if null, falls back to converting the integer `key` + `mode` columns via `SPOTIFY_KEY_MAP`. A one-time backfill migration populates `key_normalized` and `camelot` for all existing tracks that have integer `key` values.

`source` values expand from `'exportify' | 'folder' | 'trackid'` to also include `'traktor' | 'rekordbox'`.

Migration: `ALTER TABLE tracks ADD COLUMN ... DEFAULT NULL` for each new column, plus a backfill query to populate `key_normalized` and `camelot` from existing integer `key` + `mode` values. Non-breaking — all new columns are nullable.

---

## 4. Import/Export Adapters

### 4.1 Directory Structure

```
djtoolkit/
├── models/
│   ├── __init__.py
│   ├── track.py              # Track, CuePoint, BeatGridMarker, CueType
│   └── camelot.py            # KEY_TO_CAMELOT, normalize_key, get_compatible_keys
├── adapters/
│   ├── __init__.py
│   ├── base.py               # ImportAdapter, ExportAdapter ABCs
│   ├── traktor.py            # TraktorImporter, TraktorExporter
│   ├── rekordbox.py          # RekordboxImporter, RekordboxExporter
│   └── supabase.py           # SupabaseAdapter (Track ↔ DB)
```

### 4.2 Adapter Interfaces

```python
# adapters/base.py

class ImportAdapter(ABC):
    @abstractmethod
    def parse(self, file_data: bytes) -> ImportResult: ...

class ExportAdapter(ABC):
    @abstractmethod
    def export(self, tracks: list[Track]) -> bytes: ...

@dataclass
class ImportResult:
    tracks: list[Track]
    playlists: dict[str, list[str]]   # playlist_name → list of source_ids
    warnings: list[str]               # non-fatal issues
    stats: dict[str, int]             # {total, imported, skipped, warnings}
```

### 4.3 Traktor Adapter

**TraktorImporter:**
- Parses NML with `xml.etree.ElementTree` (stdlib, no new dependency)
- Converts `MUSICAL_KEY VALUE` integers → `key_normalized` via `TRAKTOR_KEY_MAP`
- `CUE_V2 START` stays in ms (model uses ms natively)
- Reconstructs file paths: `LOCATION DIR` + `FILE`, replacing `/:` → `/`
- Extracts playlist tree from `PLAYLISTS` node

**TraktorExporter:**
- Generates valid NML XML from `list[Track]`
- Converts `key_normalized` → `MUSICAL_KEY VALUE` integer
- Writes `CUE_V2` elements from `cue_points` list
- Generates playlist structure

### 4.4 Rekordbox Adapter

**RekordboxImporter:**
- Parses Rekordbox XML with `xml.etree.ElementTree`
- Converts `POSITION_MARK Start` from seconds → ms (`* 1000`)
- Normalizes `Tonality` strings: `"Cm"` → `"C minor"`
- Multiple `TEMPO` entries → picks dominant BPM for `bpm`, stores full grid in `beatgrid`
- Maps `TrackID` references in playlists

**RekordboxExporter:**
- Generates valid Rekordbox XML from `list[Track]`
- Converts cue positions ms → seconds (`/ 1000`)
- Assigns sequential `TrackID` values
- Writes playlist tree with `TRACK Key` references

### 4.5 Supabase Adapter

The `SupabaseAdapter` is the **sole data access layer** for Track objects. It wraps `supabase-py` and handles all serialization between `Track` dataclasses and the DB. The `db/supabase_client.py` module provides only the client factory (`get_client()`); all query logic lives in `SupabaseAdapter`.

```python
# adapters/supabase.py

class SupabaseAdapter:
    def __init__(self, client: supabase.Client): ...

    # ── Used by import/export service ──
    def save_tracks(self, tracks: list[Track], user_id: str) -> dict:
        """Upsert tracks to Supabase. Deduplicates by source_id."""

    def load_tracks(self, user_id: str, filters: dict | None = None) -> list[Track]:
        """Query tracks, deserialize JSONB fields into nested dataclasses."""

    # ── Used by migrated CLI/agent modules ──
    def query_available_unfingerprinted(self, user_id: str) -> list[Track]:
        """WHERE acquisition_status='available' AND fingerprinted=0"""

    def query_available_unenriched_audio(self, user_id: str) -> list[Track]:
        """WHERE acquisition_status='available' AND enriched_audio=0"""

    def query_available_unenriched_spotify(self, user_id: str, force: bool = False) -> list[Track]:
        """WHERE acquisition_status='available' AND (enriched_spotify=0 OR force)"""

    def query_ready_for_library(self, user_id: str) -> list[Track]:
        """WHERE acquisition_status='available' AND metadata_written=1 AND in_library=0"""

    def query_missing_cover_art(self, user_id: str) -> list[Track]:
        """WHERE acquisition_status='available' AND cover_art_written=0"""

    def update_track(self, track_id: int, updates: dict) -> None:
        """Update specific columns for a single track."""

    def mark_fingerprinted(self, track_id: int, fingerprint_data: dict) -> None: ...
    def mark_metadata_written(self, track_id: int, source: str) -> None: ...
    def mark_cover_art_written(self, track_id: int) -> None: ...
    def mark_enriched_spotify(self, track_id: int) -> None: ...
    def mark_enriched_audio(self, track_id: int, audio_features: dict) -> None: ...
    def mark_in_library(self, track_id: int, new_path: str) -> None: ...
    def mark_duplicate(self, track_id: int) -> None: ...
```

Each migrated module calls the appropriate named query method instead of building PostgREST queries directly. This keeps query patterns centralized and testable.

Deduplication on import: tracks matched by `source_id` (Traktor file path or Rekordbox TrackID). Re-importing the same collection updates existing tracks.

---

## 5. Hetzner FastAPI Service

### 5.1 Architecture

```
Vercel (Next.js)                    Hetzner CX23
┌──────────────────┐               ┌─────────────────────────┐
│  Web UI           │               │  Caddy (reverse proxy)  │
│  ┌──────────────┐ │    HTTPS      │  ┌───────────────────┐  │
│  │ API Routes   │─┼──────────────►│  │  FastAPI service   │  │
│  │ /api/import  │ │               │  │  - POST /parse     │  │
│  │ /api/export  │ │               │  │  - GET /export/:f  │  │
│  └──────────────┘ │               │  │  - GET /health     │  │
│                    │               │  └────────┬──────────┘  │
│  Supabase Auth ◄──┼───JWT────────►│           │              │
│                    │               │           ▼              │
└──────────────────┘               │  supabase-py → Supabase  │
         │                          └─────────────────────────┘
         ▼
┌──────────────────┐
│  Supabase (PG)   │
└──────────────────┘
```

### 5.2 Service Structure

```
djtoolkit/
├── service/
│   ├── __init__.py
│   ├── app.py                     # FastAPI app factory
│   ├── auth.py                    # JWT verification against Supabase
│   ├── routes/
│   │   ├── __init__.py
│   │   ├── import_collection.py   # POST /parse
│   │   ├── export_collection.py   # GET /export/{format}
│   │   └── health.py              # GET /health
│   └── config.py                  # Service config (env vars)
```

### 5.3 Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/parse` | Upload collection file (multipart/form-data) → parse → upsert to Supabase → return stats |
| `GET` | `/export/{format}` | `format` = `traktor`, `rekordbox`, or `csv`. Optional `genre` query param. Returns file download. |
| `GET` | `/health` | Service health + Supabase connectivity |

**POST /parse details:**
- Auto-detects format from XML root element (`<NML>` vs `<DJ_PLAYLISTS>`)
- Returns: `{ tracks_imported, tracks_updated, tracks_skipped, playlists_found, warnings }`
- Partial failures: logs warnings and continues — never fails the whole import over one bad entry

**GET /export/{format} details:**
- Returns `Content-Disposition: attachment` with appropriate filename
- Streams response for large collections

### 5.4 Auth

Vercel passes the user's Supabase JWT in the `Authorization` header. FastAPI verifies it using `pyjwt` against the Supabase JWT secret before processing any request.

### 5.5 Deployment

**DNS:** A record `api` → Hetzner CX23 IP, added in Vercel DNS settings (GoDaddy domain, Vercel nameservers).

**Caddy** (auto TLS via Let's Encrypt):
```
api.djtoolkit.net {
    reverse_proxy localhost:8000
}
```

**Docker Compose:**
```yaml
services:
  api:
    image: ghcr.io/<user>/djtoolkit-api:latest
    ports:
      - "8000:8000"
    env_file: .env
    restart: unless-stopped
```

**Dependencies (minimal):**
- `fastapi`, `uvicorn` — HTTP
- `supabase-py` — DB client
- `python-multipart` — file uploads
- `pyjwt` — JWT verification
- No new XML libs — stdlib `xml.etree.ElementTree`

---

## 6. CI/CD — Docker + GitHub Actions

### 6.1 Workflow

Triggered on push to `master` (or `deploy/api` tag):

1. Build Docker image from `Dockerfile` in repo root (or `service/` subdirectory)
2. Push to `ghcr.io/<user>/djtoolkit-api:latest`
3. SSH into Hetzner CX23
4. Run `docker pull ghcr.io/<user>/djtoolkit-api:latest && docker compose up -d`

### 6.2 Dockerfile

```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY pyproject.toml poetry.lock ./
RUN pip install poetry && poetry install --only main --no-root
COPY djtoolkit/ djtoolkit/
CMD ["uvicorn", "djtoolkit.service.app:create_app", "--host", "0.0.0.0", "--port", "8000"]
```

### 6.3 GitHub Secrets

- `HETZNER_SSH_KEY` — private key for SSH access
- `HETZNER_HOST` — CX23 IP address

---

## 7. Web UI

### 7.1 Import Page — Grouped Sources

The existing Import page (`/import`) gains two section headers to organize sources:

**"Discovery" section:**
- Spotify (existing)
- CSV File (existing)
- YouTube TrackID (existing)

**"DJ Software" section:**
- **Traktor** — SourceCard with drop zone for `collection.nml`, LCD stats after parsing (tracks, cue points, playlists)
- **Rekordbox** — SourceCard with drop zone for `database.xml`, LCD stats after parsing
- **Serato** — SourceCard, grayed out, "COMING SOON" badge

Section headers use the existing monospace uppercase label pattern (`font-family: Space Mono; font-size: 10px; letter-spacing: 2px; color: var(--hw-text-muted)`).

Upload flow: file dropped → forwarded to Hetzner `POST /parse` → LCD stats populate from response → user proceeds to Step 2 (Review) with imported tracks.

### 7.2 Export Page — New Nav Item

New sidebar entry: **Export** (Upload icon rotated, between Catalog and Pipeline).

Page layout:
1. **LCD stat row:** Total tracks, With key, Cue points
2. **"Export format" section:** Checkable format cards:
   - Rekordbox XML — "Import via File → Import Collection from XML"
   - Traktor NML — "Place in Traktor's collection folder or import manually"
   - CSV — "Spreadsheet-compatible export of track metadata"
   - Serato — grayed out, "COMING SOON" badge
3. **"Include" filter:** Genre pills (All Tracks, Techno, House, etc.) + Filter button
4. **Export button:** `EXPORT {N} TRACKS` → calls Hetzner `GET /export/{format}` → browser downloads file

---

## 8. SQLite → Supabase Migration

### 8.1 Current State

**Already on Supabase (Next.js API routes):**
- `importers/exportify.py` logic → `/api/catalog/import/csv` (TypeScript)
- `importers/trackid.py` logic → `/api/catalog/import/trackid` (TypeScript)
- Spotify import → `/api/catalog/import/spotify` (TypeScript)

**Agent jobs — stateless compute only (no DB writes):**
- `downloader/aioslsk_client.py` — returns file path to cloud API

**Agent jobs — need Supabase writes:**
- `fingerprint/chromaprint.py` — writes fingerprint data, marks duplicates, sets `fingerprinted=1`
- `metadata/writer.py` — writes `metadata_written=1`, `metadata_source`
- `coverart/art.py` — writes `cover_art_written=1`

**CLI-only modules still on SQLite:**
- `enrichment/spotify.py` — sets `enriched_spotify=1` + metadata fields
- `enrichment/audio_analysis.py` — sets `enriched_audio=1` + audio features
- `library/mover.py` — sets `in_library=1`, updates `local_path`
- `importers/folder.py` — inserts tracks with `acquisition_status='available'`

### 8.2 New Supabase Client

```python
# djtoolkit/db/supabase_client.py

def get_client(cfg: Config) -> supabase.Client:
    """Singleton Supabase client factory. Auth via service role key or agent API key."""
```

This module provides only the client factory. All query logic lives in `SupabaseAdapter` (Section 4.5).

### 8.3 Migration Strategy

Each module's `sqlite3.connect()` + raw SQL is replaced with calls to `SupabaseAdapter` methods. For example:

- `chromaprint.py`: `cursor.execute("SELECT ... WHERE acquisition_status='available' AND fingerprinted=0")` → `adapter.query_available_unfingerprinted(user_id)`
- `writer.py`: `cursor.execute("UPDATE tracks SET metadata_written=1 ...")` → `adapter.mark_metadata_written(track_id, source)`

Each module receives a `SupabaseAdapter` instance (injected via the CLI entry point or agent job runner) instead of creating its own DB connection.

### 8.4 Cleanup

After all modules are migrated:

- Delete `djtoolkit/db/database.py` and `djtoolkit/db/schema.sql`
- Delete `djtoolkit/importers/exportify.py` — CSV import fully handled by `/api/catalog/import/csv` (TypeScript). CLI `djtoolkit import csv` command retired.
- Delete `djtoolkit/importers/trackid.py` — TrackID import fully handled by `/api/catalog/import/trackid` (TypeScript). CLI `djtoolkit import trackid` command retired. Both CLI commands were already non-functional without the SQLite DB; the web UI is the sole interface for these flows.
- Remove `make setup`, `make migrate-db`, `make wipe-db` from Makefile

---

## 9. Phasing

### Phase 1a — Data Model & Adapters

1. `models/track.py` — Track, CuePoint, BeatGridMarker dataclasses
2. `models/camelot.py` — key mappings, normalization, compatibility engine
3. `adapters/base.py` — ImportAdapter, ExportAdapter ABCs
4. `adapters/traktor.py` — TraktorImporter, TraktorExporter
5. `adapters/rekordbox.py` — RekordboxImporter, RekordboxExporter
6. `adapters/supabase.py` — SupabaseAdapter
7. `db/supabase_client.py` — Supabase client factory
8. Supabase migration — new columns on `tracks` + backfill `key_normalized`/`camelot`
9. Unit tests: parsers, key normalization, round-trip import/export

### Phase 1b — Hetzner Service & Infrastructure

1. `service/` — FastAPI app, routes, auth, config
2. Dockerfile + docker-compose.yml
3. GitHub Actions workflow for CI/CD
4. DNS: `api.djtoolkit.net` A record → Hetzner
5. Caddy + Docker setup on Hetzner

### Phase 1c — Web UI

1. Import page: grouped sections ("Discovery" + "DJ Software") + Traktor/Rekordbox upload
2. Export page: new nav item + full page with format selection, genre filter, download

### Phase 2 — SQLite Migration

1. Migrate `fingerprint/chromaprint.py` to Supabase
2. Migrate `metadata/writer.py` to Supabase
3. Migrate `coverart/art.py` to Supabase
4. Migrate `enrichment/spotify.py` to Supabase
5. Migrate `enrichment/audio_analysis.py` to Supabase
6. Migrate `library/mover.py` to Supabase
7. Migrate `importers/folder.py` to Supabase
8. Update all CLI entry points in `__main__.py`

### Phase 3 — Cleanup

1. Delete `db/database.py` and `db/schema.sql`
2. Delete `importers/exportify.py` and `importers/trackid.py`
3. Remove SQLite-related Makefile targets
4. Update CLAUDE.md and ARCHITECTURE.md

---

## 10. Not In Scope

- Camelot compatibility engine (`get_compatible_keys`, `suggest_next_track`) — future iteration
- Set planner / energy curve planner — future iteration
- Playlist persistence in Supabase (playlists are parsed and returned in stats but not stored)
- Serato / VirtualDJ / Engine DJ import/export
- Audio file upload / association with imported tracks
- Refactoring existing importers (Exportify, folder, TrackID) to use the Unified Track Model
- Streaming service imports (Deezer, Apple Music, Beatport)

---

## 11. Format Conversion Reference

### 11.1 Key Conversion Mappings

**Traktor MUSICAL_KEY integer → normalized key:**

| Int | Key | Int | Key |
|-----|-----|-----|-----|
| 0 | C major | 12 | C minor |
| 1 | Db major | 13 | Db minor |
| 2 | D major | 14 | D minor |
| 3 | Eb major | 15 | Eb minor |
| 4 | E major | 16 | E minor |
| 5 | F major | 17 | F minor |
| 6 | F# major | 18 | F# minor |
| 7 | G major | 19 | G minor |
| 8 | Ab major | 20 | Ab minor |
| 9 | A major | 21 | A minor |
| 10 | Bb major | 22 | Bb minor |
| 11 | B major | 23 | B minor |

**Rekordbox Tonality → normalized key:** Strip trailing `m` for minor, append ` minor` or ` major`. Examples: `"Cm"` → `"C minor"`, `"Ab"` → `"Ab major"`, `"F#m"` → `"F# minor"`.

**Spotify key + mode → normalized key:** `key` is 0-11 pitch class (same as Traktor major row), `mode` is 1=major, 0=minor. Combine: `PITCH_NAMES[key] + (" major" if mode==1 else " minor")`.

### 11.2 Field Conversion Table

| Data Point | Traktor NML | Rekordbox XML | Conversion |
|---|---|---|---|
| BPM | `<TEMPO BPM="128.00"/>` | `AverageBpm="128.00"` | Direct |
| Key | `<MUSICAL_KEY VALUE="11"/>` | `Tonality="B"` | Integer → string (see 11.1) |
| Cue position | `CUE_V2 START="1234.56"` (ms) | `POSITION_MARK Start="1.234"` (sec) | ÷1000 or ×1000 |
| Hot cue index | `CUE_V2 HOTCUE="0"` | `POSITION_MARK Num="0"` | Direct (0-7) |
| Memory cue | `CUE_V2 HOTCUE="-1"` | `POSITION_MARK Num="-1"` | Direct |
| Loop | `TYPE="5"` + `LEN="8000"` (ms) | `Type="4"` + `End="..."` (sec) | LEN ms → End = Start + LEN/1000 |
| Cue type | `TYPE` (0=cue, 4=grid, 5=loop) | `Type` (0=cue, 4=loop) | Map + filter grid cues |
| File path | `DIR` + `FILE` with `/:` sep | `Location` with `file://` | Reconstruct / URL-decode |
| Playlist ref | `PRIMARYKEY KEY="path"` | `TRACK Key="TrackID"` | Path-based → ID-based |

### 11.3 Critical Gotchas

1. **Traktor uses milliseconds, Rekordbox uses seconds** for cue positions — most common conversion bug
2. **Traktor only supports a single global BPM**. Rekordbox supports dynamic beatgrids with multiple TEMPO entries. When exporting to Traktor, pick the dominant BPM.
3. **Rekordbox memory cues vs hot cues:** Same `POSITION_MARK` element, differentiated only by `Num` attribute (-1 vs 0-7)
4. **File path encoding:** Traktor uses `/:` as separator and stores volume + relative path. Rekordbox uses `file://localhost/` + URL-encoded absolute path.
5. **Rekordbox XML import quirk:** RB doesn't merge — if a track exists, imported changes are ignored. Users must delete first, then re-import.
6. **BeatGridMarker.beat_number** defaults to 1 for Rekordbox imports (Rekordbox `TEMPO` elements don't encode beat position within bar; Traktor does via grid cues)

### 11.4 Spotify Audio Features

The `Track` dataclass preserves Spotify audio features (`energy`, `danceability`, `loudness`, `speechiness`, etc.) as optional fields. These values come from Spotify's API and are stored as-is (REAL values). Tracks imported from Traktor/Rekordbox will have these fields as `None`. Existing tracks with `source='trackid'` retain their values as historical data even though the Python importer is retired — the web UI now handles TrackID imports.
