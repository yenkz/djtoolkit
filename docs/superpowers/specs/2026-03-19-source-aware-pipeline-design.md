# Source-Aware Pipeline Chain Design

**Date:** 2026-03-19
**Status:** Approved

---

## Problem

Tracks imported via Exportify CSV arrive with full Spotify metadata (title, artist, album, genres, release_date, record_label, etc.). The pipeline downloads the file, fingerprints it, fetches cover art, and writes the metadata to file tags.

Tracks from other sources (TrackID YouTube imports, future sources) arrive with only title + artist. The pipeline downloads the file but has no metadata to write — the DB fields are empty. These tracks need a Spotify lookup to fill metadata, local audio analysis for BPM/key/energy/danceability/loudness, and cover art from Spotify.

## Solution

Branch the pipeline chain after `fingerprint` based on `track.source`:

```text
                            ┌─ source = "exportify" ──→ cover_art → metadata
download → fingerprint ─────┤
                            └─ source ≠ "exportify" ──→ spotify_lookup → cover_art → audio_analysis → metadata
```

Two new job types: `spotify_lookup` and `audio_analysis`.

---

## 1. Pipeline Chain Branching (`job-result.ts`)

### Fingerprint case — branch on source

After fingerprint completes (and the track is not a duplicate), fetch `track.source` from the DB alongside existing fields. Branch:

- `source === "exportify"` → queue `cover_art` (existing behavior, unchanged)
- `source !== "exportify"` → queue `spotify_lookup`

### New case: `spotify_lookup`

Agent reports result on success:
```json
{
  "spotify_uri": "spotify:track:XXX",
  "album": "Album Name",
  "release_date": "2024-01-15",
  "year": 2024,
  "genres": "house, deep house",
  "record_label": "Label Name",
  "popularity": 65,
  "explicit": false,
  "isrc": "USRC12345678",
  "duration_ms": 360000
}
```

Agent reports result on no match (treated as success, not failure):
```json
{
  "matched": false
}
```

Engine action:

1. If `result.matched !== false`: write all non-null fields to `tracks` table, set `enriched_spotify = true`
2. Queue `cover_art` job **always** (even on no-match). Fetch `spotify_uri` from DB at queue time — will be null if lookup found nothing, and cover art falls back to CoverArtArchive/iTunes/Deezer.
3. Include `spotify_uri` in `cover_art` payload (see Section 3 for details)

### New case: `audio_analysis`

Agent reports result:
```json
{
  "tempo": 124.5,
  "key": 7,
  "mode": 1,
  "danceability": 0.82,
  "energy": 0.71,
  "loudness": -8.3
}
```

Engine action (on success):

1. Write features to `tracks` table — keys map directly to columns: `tempo`, `key`, `mode`, `danceability`, `energy`, `loudness`
2. Set `enriched_audio = true`
3. Queue `metadata` job (fetches full track state from DB for payload, same pattern as current `cover_art → metadata` handoff)

Engine action (on failure): queue `metadata` anyway so the pipeline doesn't stall.

### Cover art case — branch on source

After `cover_art` completes, the engine fetches `track.source` from the DB and branches:

- `source === "exportify"` → queue `metadata` (existing behavior)
- `source !== "exportify"` → queue `audio_analysis` (payload: `{ track_id, local_path }`)

### Failure-continues-chain behavior

The result route (`pipeline/jobs/[id]/result/route.ts`) currently only calls `applyJobResult` on `status === "done"`. For `audio_analysis` failures, we need to also queue the next step. Add a new handler in the failure path: if `job.job_type === "audio_analysis"` and `status === "failed"`, still queue `metadata` so the pipeline completes with whatever metadata is available.

### Metadata case — no change

The metadata writer reads whatever is in DB and writes to file tags. By the time it runs, both exportify and non-exportify tracks have full metadata from their respective enrichment paths.

### `metadata_source` logic

Existing logic in `job-result.ts` already handles this:
- `enriched_spotify = true` → `metadata_source = "spotify"`
- Only `enriched_audio = true` → `metadata_source = "audio-analysis"`
- Non-exportify tracks will have both flags set; `"spotify"` takes precedence (identity metadata came from Spotify lookup).

---

## 2. New Module: `djtoolkit/enrichment/spotify_lookup.py`

Single-track Spotify metadata lookup using `spotipy` (Client Credentials flow).

### Function: `lookup_track(artist, title, duration_ms=None, client_id, client_secret) -> dict | None`

1. **Search**: `sp.search(q='artist:"{artist}" track:"{title}"', type="track", limit=5)`
2. **Score**: Fuzzy match artist+title with `thefuzz` (same pattern as `enrichment/spotify.py`). Filter by `duration_ms` tolerance if available.
3. **Extract metadata** from best match:
   - From `/tracks/{id}` response: `spotify_uri`, `album` name, `release_date`, `popularity`, `explicit`, `isrc`, `duration_ms`
   - From `sp.album(album_id)`: `record_label`
   - From `sp.artist(artist_id)`: `genres`
4. **Derive** `year` from `release_date`
5. **Return** dict of fields, or `None` if no match above threshold

### API calls per track: 3

`search` + `album` + `artist` — well within Spotify rate limits for pipeline processing.

### Dependencies

- `spotipy` — already installed (used by `coverart/art.py`)
- `thefuzz` — already installed (used by `enrichment/spotify.py`)

### Config

Uses existing `SPOTIFY_CLIENT_ID` + `SPOTIFY_CLIENT_SECRET` from `.env` (same credentials as cover art Spotify source).

---

## 3. Cover Art — Payload and Agent Executor Fixes

After `spotify_lookup` runs for non-exportify tracks, the `spotify_uri` is in the DB. The existing `_source_spotify()` in `art.py` already does exact URI-based album art lookup. No changes to `art.py` itself.

### Payload: include `spotify_uri`

Both the `fingerprint` case (for exportify tracks) and the `spotify_lookup` case (for non-exportify tracks) must include `spotify_uri` when queuing the `cover_art` job. Fetch it from the DB alongside `local_path, artist, album, title`.

### Agent executor: pass `spotify_uri` and Spotify credentials

**Bug fix (pre-existing):** `execute_cover_art` in `djtoolkit/agent/executor.py` currently calls `_fetch_art(artist, album, title, sources)` without passing the `spotify_uri`, `spotify_client_id`, or `spotify_client_secret` kwargs. This means the Spotify cover art source is silently skipped for all tracks.

Fix: read `spotify_uri` from the payload and pass Spotify credentials from `cfg.cover_art`:

```python
art_bytes = await loop.run_in_executor(
    None, _fetch_art,
    artist, album, title, sources,
    # kwargs via functools.partial or a wrapper
    spotify_uri=payload.get("spotify_uri"),
    spotify_client_id=ca.spotify_client_id,
    spotify_client_secret=ca.spotify_client_secret,
    lastfm_api_key=ca.lastfm_api_key,
)
```

---

## 4. Audio Analysis — Extract Single-Track Function

### Current state

`audio_analysis.py` has a `run()` function that iterates over all unenriched tracks. The fast-features section (lines 214-259) processes one track at a time.

### Change

Extract `analyze_single(path: Path) -> dict` as a standalone public function with lazy imports (librosa, pyloudnorm). This allows the agent handler to call it without going through `run()`:

```python
def analyze_single(path: Path) -> dict:
    """Run fast audio features on a single file. Returns feature dict.

    Handles its own imports (librosa, pyloudnorm) so it can be called
    independently of run().
    """
    import librosa
    # ... same analysis code as current loop body ...
    return {
        "tempo": bpm,       # float — maps to tracks.tempo
        "key": key_int,     # int 0-11 — maps to tracks.key
        "mode": mode,       # int 0/1 — maps to tracks.mode
        "danceability": dance,  # float 0-1 — maps to tracks.danceability
        "energy": nrg,      # float 0-1 — maps to tracks.energy
        "loudness": loudness,   # float LUFS — maps to tracks.loudness
    }
```

The existing `run()` function calls `analyze_single()` internally (no behavior change). The agent handler also calls `analyze_single()` for pipeline jobs.

### Column mapping for `job-result.ts`

The `audio_analysis` case in `job-result.ts` writes the result dict directly to the `tracks` table — the keys in the result match the column names exactly (`tempo`, `key`, `mode`, `danceability`, `energy`, `loudness`).

### Energy feature

Already implemented (previous conversation) — `_energy(y, sr)` combines RMS loudness (50%), spectral centroid (25%), and onset density (25%).

---

## 5. Retry & Downstream Map

Update `DOWNSTREAM` in `retry/route.ts`:

```typescript
const DOWNSTREAM: Record<string, string[]> = {
  download:       ["fingerprint", "spotify_lookup", "cover_art", "audio_analysis", "metadata"],
  fingerprint:    ["spotify_lookup", "cover_art", "audio_analysis", "metadata"],
  spotify_lookup: ["cover_art", "audio_analysis", "metadata"],
  cover_art:      ["audio_analysis", "metadata"],
  audio_analysis: ["metadata"],
};
```

This is a superset — retrying a `download` cancels all downstream regardless of source. Safe because `hasActiveJob()` prevents duplicates when re-chaining.

---

## 6. UI — Job Type LED Colors

The existing `LED_COLORS` defines four colors: `green`, `red`, `blue`, `orange`. New job types must use these existing colors (no new color definitions needed).

Add to `tokens.ts`:

```typescript
export const JOB_TYPE_LED = {
  download: "blue",
  fingerprint: "green",
  spotify_lookup: "green",
  audio_analysis: "orange",
  cover_art: "blue",
  metadata: "orange",
  tag: "orange",  // legacy alias
} as const;
```

Rationale: `spotify_lookup` and `fingerprint` are both "enrichment" steps (green); `cover_art` and `download` are both "fetch" steps (blue); `audio_analysis` and `metadata` are both "processing" steps (orange).

---

## 7. Files Changed

| File | Change |
| --- | --- |
| `web/lib/api-server/job-result.ts` | Branch after fingerprint on `track.source`; branch after cover_art on `track.source`; add `spotify_lookup` and `audio_analysis` cases; include `spotify_uri` in cover_art payload |
| `web/app/api/pipeline/jobs/retry/route.ts` | Update `DOWNSTREAM` map |
| `web/lib/design-system/tokens.ts` | Add LED colors for new job types |
| `djtoolkit/enrichment/spotify_lookup.py` | **New** — spotipy search + metadata extraction |
| `djtoolkit/enrichment/audio_analysis.py` | Extract `analyze_single()` for single-track use; energy feature (done) |
| `djtoolkit/agent/executor.py` | Add `execute_spotify_lookup` and `execute_audio_analysis` handlers; fix `execute_cover_art` to pass `spotify_uri` + Spotify credentials to `_fetch_art` |
| `djtoolkit/agent/jobs/spotify_lookup.py` | **New** — agent job wrapper calling `spotify_lookup.lookup_track()` |
| `djtoolkit/agent/jobs/audio_analysis.py` | **New** — agent job wrapper calling `audio_analysis.analyze_single()` |

### No changes needed

- `djtoolkit/coverart/art.py` — existing Spotify source works once URI is in DB
- `djtoolkit/metadata/writer.py` — reads whatever is in DB, no source awareness needed
- `djtoolkit/importers/exportify.py` — already stores full metadata on import
- `djtoolkit/adapters/supabase.py` — existing `update_track()` and `mark_enriched_*` methods suffice

---

## 8. Agent Handler

The Python agent needs handlers for two new job types:

### `spotify_lookup` handler

1. Read `SPOTIFY_CLIENT_ID` + `SPOTIFY_CLIENT_SECRET` from config
2. Call `spotify_lookup.lookup_track(artist, title, duration_ms, client_id, client_secret)`
3. If match found: report result dict (with all metadata fields)
4. If no match or no credentials: report `{ "matched": false }` as success — the engine continues the chain

### `audio_analysis` handler

1. Call `audio_analysis.analyze_single(Path(local_path))`
2. Report result dict to API

### `cover_art` handler (fix)

1. Read `spotify_uri` from payload (new field)
2. Pass `spotify_uri`, `spotify_client_id`, `spotify_client_secret`, `lastfm_api_key` as kwargs to `_fetch_art`

All handlers follow the existing claim → execute → report pattern used by download/fingerprint/metadata handlers.

---

## 9. Edge Cases

- **Spotify lookup finds no match**: Agent reports `{ "matched": false }` as a successful result (status `"done"`). The engine skips DB writes but still queues `cover_art` (without URI). Cover art falls back to CoverArtArchive/iTunes/Deezer. Audio analysis and metadata still run with whatever data is available.
- **Spotify credentials not configured**: Agent reports `{ "matched": false }` immediately. Same flow as no-match above.
- **Track already has `spotify_uri`** (e.g., TrackID import matched a Spotify track): `spotify_lookup` can skip the search and go straight to `sp.track(uri)` for metadata extraction.
- **Audio analysis fails** (corrupt file, librosa error): Report job as `failed`. The `job-result.ts` engine should still queue `metadata` on `audio_analysis` failure so the pipeline doesn't stall — metadata writes whatever is available in DB.
- **`_fetch_art` Spotify source silently skipped (pre-existing bug)**: Fixed by passing `spotify_uri` and Spotify credentials from payload/config in `execute_cover_art`. See Section 3.
