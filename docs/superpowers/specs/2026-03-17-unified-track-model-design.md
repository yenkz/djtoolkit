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
    genre: str = ""
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
        """Serialize for Supabase upsert. JSONB fields serialized to dicts."""
        ...

    @classmethod
    def from_db_row(cls, row: dict) -> "Track":
        """Deserialize from Supabase query result."""
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

Existing columns that map directly: `title`, `artist`, `artists`, `album`, `year`, `duration_ms`, `genres`, `record_label`, `isrc`, `spotify_uri`, `local_path`, `source`, `energy`, `danceability`, `loudness`, `tempo`, `key`, and all Spotify audio features.

`source` values expand from `'exportify' | 'folder' | 'trackid'` to also include `'traktor' | 'rekordbox'`.

Migration: `ALTER TABLE tracks ADD COLUMN ... DEFAULT NULL` for each new column. Non-breaking — all nullable.

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

```python
# adapters/supabase.py

class SupabaseAdapter:
    def __init__(self, client: supabase.Client): ...

    def save_tracks(self, tracks: list[Track], user_id: str) -> dict:
        """Upsert tracks to Supabase. Deduplicates by source_id."""

    def load_tracks(self, user_id: str, filters: dict | None = None) -> list[Track]:
        """Query tracks, deserialize JSONB fields into nested dataclasses."""
```

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

Triggered on push to `main` (or `deploy/api` tag):

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

def query_tracks(client, filters: dict) -> list[dict]: ...
def upsert_tracks(client, rows: list[dict]) -> None: ...
def update_track(client, track_id: int, updates: dict) -> None: ...
```

### 8.3 Migration Strategy

Each module's `sqlite3.connect()` + raw SQL is replaced with `supabase.table("tracks").select/upsert/update` calls. The query patterns change from raw SQL to PostgREST builder syntax.

### 8.4 Cleanup

After all modules are migrated:
- Delete `djtoolkit/db/database.py`
- Delete `djtoolkit/db/schema.sql`
- Delete `djtoolkit/importers/exportify.py` (replaced by TypeScript)
- Delete `djtoolkit/importers/trackid.py` (replaced by TypeScript)
- Remove `make setup`, `make migrate-db`, `make wipe-db` from Makefile

---

## 9. Phasing

### Phase 1 — Foundation (new code, Supabase from day one)

1. `models/track.py` — Track, CuePoint, BeatGridMarker dataclasses
2. `models/camelot.py` — key mappings, normalization, compatibility engine
3. `adapters/base.py` — ImportAdapter, ExportAdapter ABCs
4. `adapters/traktor.py` — TraktorImporter, TraktorExporter
5. `adapters/rekordbox.py` — RekordboxImporter, RekordboxExporter
6. `adapters/supabase.py` — SupabaseAdapter
7. `db/supabase_client.py` — Supabase client factory
8. Supabase migration — new columns on `tracks`
9. `service/` — FastAPI app, routes, auth, config
10. Dockerfile + docker-compose.yml
11. GitHub Actions workflow for CI/CD
12. DNS: `api.djtoolkit.net` A record → Hetzner
13. Caddy + systemd setup on Hetzner
14. Web UI: Import page grouped sections + Traktor/Rekordbox upload
15. Web UI: Export page (new nav item + full page)
16. Unit tests: parsers, key normalization, round-trip import/export

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

## 11. Technical Reference

The technical reference document (`docs/technical-reference.md`) contains:
- Complete Traktor NML and Rekordbox XML format specifications
- Field-by-field conversion mapping table
- Python library references (`traktor-nml-utils`, `pyrekordbox`)
- Full Camelot wheel mapping (24 keys)
- Complete `get_compatible_keys` algorithm
- Energy curve planner algorithm
- Key gotchas (ms vs seconds, single vs dynamic BPM, file path encoding)

This document should be consulted during implementation for format details and edge cases.
