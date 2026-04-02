# Recommendation Engine — Design Spec

**Date:** 2026-04-02
**Status:** Draft
**Feature:** Context-aware track recommendation with interactive similarity graph and playlist export

---

## 1. Overview

A recommendation engine that helps DJs prepare for gigs by exploring their own music library through contextual lenses (venue, mood, lineup position). The system generates seed tracks based on context profiles, lets users refine selections through an interactive similarity graph, and exports DJ-ready playlists.

### Core Flow

```
Context Input → Seed Generation (5-10) → User Feedback (like + reorder)
  → Expansion (100 tracks) → Iterative Refinement → Playlist Export
```

### Key Decisions

- **Use case:** Pre-gig preparation only (not live/real-time)
- **Compute:** External ML service (Python on Hetzner FastAPI)
- **Features:** All locally computed via librosa — no dependency on Spotify audio features (deprecated Feb 2026)
- **Algorithm:** Two-phase hybrid — profile matching for seeds, seed similarity for expansion
- **Graph library:** react-force-graph (WebGL, React integration, handles DJ library sizes)
- **Scope:** Own library + external discovery (Spotify search → import → local analysis)
- **Unanalyzed tracks:** Partial results with warning (not gated)
- **Club data:** Curated by us in Supabase, starting with Spain and Argentina
- **Playlist export:** Rekordbox XML, Traktor NML, M3U, CSV — with playlist structure

---

## 2. Data Model

### 2.1 New Tables

#### `venues` — Curated club/venue profiles

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `name` | TEXT NOT NULL | e.g., "Razzmatazz" |
| `type` | TEXT NOT NULL | `club`, `stadium`, `bar`, `rooftop`, `warehouse`, `festival` |
| `city` | TEXT NOT NULL | e.g., "Barcelona" |
| `country` | TEXT NOT NULL | e.g., "Spain" |
| `address` | TEXT | Full street address |
| `capacity` | INT | Max people |
| `sqm` | INT | Floor area in square meters |
| `genres` | TEXT[] | `{"techno","house","minimal"}` |
| `mood_tags` | TEXT[] | `{"dark","industrial","peak-time"}` |
| `dj_cabin_style` | TEXT | e.g., "elevated booth", "floor level", "none" |
| `photo_url` | TEXT | URL to reference photo |
| `website_url` | TEXT | Venue website |
| `google_maps_url` | TEXT | Google Maps link |
| `google_rating` | FLOAT | e.g., 4.3 |
| `target_profile` | JSONB NOT NULL | `{"bpm":[126,140],"energy":[0.7,0.95],"danceability":[0.7,0.9]}` |
| `created_at` | TIMESTAMPTZ | |

No RLS — venues are global/public. Initial data: Spain + Argentina clubs.

#### `mood_presets` — Mood/vibe profiles

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `name` | TEXT NOT NULL | e.g., "Beach Sunset" |
| `category` | TEXT NOT NULL | `beach`, `pool_party`, `nightclub`, `day_party`, `coffee_rave`, `afterhours` |
| `target_profile` | JSONB NOT NULL | Same structure as venues |
| `created_at` | TIMESTAMPTZ | |

#### `lineup_modifiers` — Stored as application constants (not a table)

| Position | Energy Multiplier | BPM Bias | Notes |
|---|---|---|---|
| `warmup` | 0.6 | Lower end of range | Favor harmonic progression, gradual build |
| `middle` | 0.85 | Balanced | Standard set |
| `headliner` | 1.1 | Upper end of range | Peak energy, max danceability |

#### `recommendation_sessions` — Tracks user exploration state

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `user_id` | UUID FK | RLS-scoped |
| `venue_id` | UUID FK nullable | Selected venue |
| `mood_preset_id` | UUID FK nullable | Selected mood |
| `lineup_position` | TEXT | `warmup`, `middle`, `headliner` |
| `context_profile` | JSONB NOT NULL | Merged + modified profile |
| `seed_feedback` | JSONB | `[{"track_id": uuid, "liked": bool, "position": int}, ...]` |
| `created_at` | TIMESTAMPTZ | |

#### `playlists` — Saved playlists (from recommendations or manual)

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `user_id` | UUID FK | RLS-scoped |
| `name` | TEXT NOT NULL | Auto-generated: "Razzmatazz Warm-up — 2026-04-02", user can rename |
| `session_id` | UUID FK nullable | Links to recommendation_session |
| `created_at` | TIMESTAMPTZ | |

#### `playlist_tracks` — Ordered track membership

| Column | Type | Notes |
|---|---|---|
| `playlist_id` | UUID FK | |
| `track_id` | UUID FK | |
| `position` | INT NOT NULL | Ordering within playlist |
| PK | (`playlist_id`, `track_id`) | |

### 2.2 Feature Sources (Post-Spotify Deprecation)

All features used by the recommendation engine are computed locally via librosa/pyloudnorm (already implemented in `audio_analysis.py`):

| Feature | Source | DB Column | Range |
|---|---|---|---|
| BPM | librosa `beat_track` | `tempo` | 60–200 |
| Key | Krumhansl-Schmuckler on chroma | `key` (0–11), `key_normalized` | 12 keys |
| Mode | Krumhansl-Schmuckler | `mode` (0=minor, 1=major) | binary |
| Camelot | Derived from key+mode | `camelot` | e.g., "8B" |
| Energy | RMS + spectral centroid + onset density | `energy` | 0.0–1.0 |
| Danceability | Beat interval variance | `danceability` | 0.0–1.0 |
| Loudness | pyloudnorm EBU R128 | `loudness` | -30 to 0 LUFS |
| Genres | essentia Discogs400 (optional) or Spotify artist genres | `genres` | comma-separated |

**Optional (when essentia-tensorflow available):**
- MusicNN embeddings (stored in `track_embeddings` table)
- Instrumentalness classifier

---

## 3. Algorithm

### 3.1 Phase 1 — Seed Generation (Profile Matching)

The merged context profile defines target feature ranges. Each analyzed track is scored by how well its features fit.

**Profile merging:**

```python
context_profile = merge(venue.target_profile, mood.target_profile) * lineup_modifier
```

- If both venue and mood are selected, ranges are intersected (overlapping region). If ranges don't overlap (e.g., venue BPM [126,140] vs mood BPM [110,125]), use the midpoint between the two ranges as a ±5 window (e.g., [120,131]).
- Lineup modifier scales the energy range and biases BPM toward the appropriate end.

**Scoring per track:**

```python
feature_fit = average over each feature:
    if track.feature within profile range → 1.0
    if outside → linear decay by normalized distance from nearest boundary

genre_bonus = len(intersection(track.genres, profile.genres)) / len(profile.genres)

seed_score = 0.6 * feature_fit + 0.4 * genre_bonus
```

Top 10 by seed_score are presented as seeds.

### 3.2 Phase 2 — Expansion (Seed Similarity + Context)

After user likes and reorders seeds, a weighted centroid is computed.

**Feature normalization (0–1):**

| Feature | Normalization |
|---|---|
| BPM | `(bpm - 60) / 140` |
| Energy | already 0–1 |
| Danceability | already 0–1 |
| Loudness | `(lufs + 30) / 30` |
| Key | not normalized — handled separately via Camelot |

**Seed centroid:**

```python
track_vector = [bpm_norm, energy, danceability, loudness_norm]
seed_centroid = weighted_average(liked_seed_vectors)
    where weight = (num_liked_seeds - position + 1)  # top position = highest weight
```

**Expansion scoring:**

```python
score = 0.40 * cosine_similarity(track_vector, seed_centroid)
      + 0.25 * profile_fit(track, context_profile)
      + 0.20 * harmonic_score(track, playlist_so_far)
      + 0.15 * genre_overlap(track, seed_genres)
```

If MusicNN embeddings are available for both the track and seeds:

```python
score += 0.15 * embedding_cosine_similarity
# Other weights reduced proportionally to sum to 1.0
```

### 3.3 Harmonic Score (Camelot Wheel)

| Relationship | Score |
|---|---|
| Same key | 1.0 |
| Adjacent (e.g., 8A → 7A, 8A → 8B) | 0.8 |
| Two steps away | 0.4 |
| Incompatible | 0.0 |

Harmonic score is computed relative to the previously selected/ordered track in the playlist, encouraging smooth harmonic progressions.

### 3.4 Energy Arc Ordering

The top 100 results are reordered to create a natural set progression:

| Lineup Position | Arc Shape |
|---|---|
| Warmup | Ascending energy (low → medium) |
| Middle | Gradual build (medium → high) |
| Headliner | Build → peak → cool down |

### 3.5 Iterative Refinement

When the user likes/dislikes tracks from the 100 and re-runs:

1. Liked tracks are added to the seed pool (weight = 0.5 × original seed weight)
2. Disliked tracks are excluded from results
3. Centroid shifts with new data
4. Phase 2 re-runs with updated centroid → new top 100

### 3.6 Unanalyzed Track Handling

Tracks without audio analysis (`enriched_audio = false`) are excluded from scoring. The API returns `unanalyzed_count` so the UI can display:

> "47 tracks haven't been analyzed — results may be incomplete"

No gating — recommendations proceed with available data.

---

## 4. API Design (Hetzner FastAPI Service)

All endpoints live on the existing FastAPI service at `app.djtoolkit.net`. They read track features from Supabase — no audio file access needed.

### 4.1 Endpoints

```
POST /api/recommend/seeds
  Body: { venue_id?, mood_preset_id?, lineup_position, user_id }
  Returns: {
    session_id: uuid,
    context_profile: object,
    seeds: Track[10],
    unanalyzed_count: int
  }

POST /api/recommend/expand
  Body: { session_id, seed_feedback: [{track_id, liked, position}, ...] }
  Returns: {
    tracks: Track[100],
    energy_arc: "warmup" | "build" | "peak",
    similarity_edges: [{source, target, weight}, ...]  // for the graph
  }

POST /api/recommend/refine
  Body: { session_id, feedback: [{track_id, liked}, ...] }
  Returns: {
    tracks: Track[100],
    similarity_edges: [{source, target, weight}, ...]
  }

GET /api/recommend/sessions
  Query: user_id
  Returns: [{ id, venue_name?, mood_name?, lineup_position, created_at }, ...]

GET /api/venues?country=spain
  Returns: Venue[]

GET /api/venues/{id}
  Returns: Venue (full profile)

GET /api/mood-presets
  Returns: MoodPreset[] (grouped by category)

POST /api/recommend/export
  Body: { session_id, format: "m3u" | "traktor" | "rekordbox" | "csv", playlist_name? }
  Returns: Binary file with Content-Disposition header
```

### 4.2 Similarity Edges

The `/expand` and `/refine` endpoints return `similarity_edges` — precomputed pairwise similarity scores between recommended tracks. This powers the graph visualization without client-side similarity computation.

Each edge: `{ source: track_id, target: track_id, weight: float (0-1) }`

Only edges above a similarity threshold of 0.5 are returned to keep the graph readable (configurable via query param). Thresholding happens server-side. For 100 tracks, this typically yields 200-400 edges.

---

## 5. UX Design

### 5.1 New Page: `/recommend`

Added to the web app's main navigation alongside Catalog, Pipeline, Import, Export.

### 5.2 Entry Screen

Two cards:

1. **By Venue** — browse/search curated venues filtered by country. Selecting a venue pre-fills genres, BPM range, energy range, and mood from the venue's `target_profile`. User only picks lineup position.

2. **By Vibe & Mood** — custom parameter selection. User picks a mood preset (beach, pool party, nightclub, etc.) and lineup position. Can optionally adjust individual feature ranges.

### 5.3 Venue Browser

- Search bar + country filter pills (Spain, Argentina)
- Venue cards showing: photo, name, city, type, capacity, genre tags, Google rating
- Clicking a venue opens a detail view with full profile + pre-filled parameters
- Lineup position selector: Warm-up | Middle | Headliner
- "Generate Seeds" button

### 5.4 Seed Selection

- List of 10 tracks with drag handles for reordering
- Each row: position number, cover art thumbnail, artist — title, BPM, Camelot key, energy value
- Play button (triggers existing preview player)
- Like/unlike toggle (heart icon)
- Warning banner if unanalyzed tracks exist
- "Regenerate" button (re-runs Phase 1)
- "Expand to 100" button (triggers Phase 2 with feedback)

### 5.5 Similarity Graph (react-force-graph)

Interactive force-directed graph as the primary results view:

**Nodes:**
- Each node = one track
- **Artwork mode (default):** Circular-cropped cover art as node image. Fallback to colored circle with artist initials if no artwork.
- **Clean mode (toggle):** Plain colored circles. Better for seeing data relationships.
- Node size = relevance score
- Seed nodes have a glowing animated ring

**Edges:**
- Edge between tracks = similarity score above threshold
- Edge opacity/thickness = similarity strength
- Only significant edges shown (server-side thresholding)

**Reactive behaviors:**
- **Click node:** Glow + enlarge, connected edges brighten, unconnected nodes fade, preview plays automatically, tooltip shows BPM/key/energy/similarity
- **Like node:** Becomes a new seed (highlighted ring), graph re-simulates with smooth animation, similar tracks gravitate closer, new recommendations may appear
- **Dislike node:** Shrinks + fades toward periphery
- **Drag node:** Pins in place, connected tracks follow via spring physics, double-click to unpin
- **Re-run:** "Re-run with feedback" button sends likes/dislikes to `/refine`, graph updates smoothly

**Configurable controls (top-right):**
- View toggle: `Artwork | Clean`
- Node color by: Genre | Energy | Key | Source
- Node size by: Relevance | Popularity | Play count
- Edge display: Similarity | Harmonic compatibility | BPM proximity

**Cluster behavior:**
- Tracks naturally cluster by sonic similarity via force layout
- Genre labels float near cluster centers

### 5.6 Results List (Alternative View)

Below or beside the graph, a sortable track list:
- Position, cover art, artist — title, BPM, Camelot, energy
- Play/like/dislike per row
- Energy arc visualization bar at the top (build → peak → cool down)
- Total duration display

### 5.7 Export

- "Export Playlist" button
- Auto-generated name: "{Venue} {Lineup} — {Date}" (editable)
- Format selector: Rekordbox XML | Traktor NML | M3U | CSV
- Saves to `playlists` + `playlist_tracks` tables in Supabase
- Downloads file via blob

---

## 6. Playlist Export

### 6.1 New: Playlist Persistence

Recommendation sessions can be saved as named playlists. The `playlists` and `playlist_tracks` tables store the track list with ordering.

### 6.2 Format-Specific Changes

**Rekordbox XML:**
Add `<PLAYLISTS>` section after `<COLLECTION>`:
```xml
<PLAYLISTS>
  <NODE Type="0" Name="ROOT" Count="1">
    <NODE Name="Razzmatazz Warm-up" Type="1" KeyType="0" Entries="100">
      <TRACK Key="1"/>
      <TRACK Key="2"/>
      ...
    </NODE>
  </NODE>
</PLAYLISTS>
```
Track keys reference entries already in the `<COLLECTION>` section.

**Traktor NML:**
Add `<PLAYLISTS>` section:
```xml
<PLAYLISTS>
  <NODE TYPE="FOLDER" NAME="$ROOT">
    <SUBNODES COUNT="1">
      <NODE TYPE="PLAYLIST" NAME="Razzmatazz Warm-up">
        <PLAYLIST ENTRIES="100" TYPE="LIST" UUID="...">
          <ENTRY><PRIMARYKEY TYPE="TRACK" KEY="..."></ENTRY>
          ...
        </PLAYLIST>
      </NODE>
    </SUBNODES>
  </NODE>
</PLAYLISTS>
```

**M3U (new format):**
```
#EXTM3U
#PLAYLIST:Razzmatazz Warm-up
#EXTINF:398,Oxia - Domino
/Users/dj/Music/Oxia - Domino.flac
#EXTINF:421,Stephan Bodzin - Singularity
/Users/dj/Music/Stephan Bodzin - Singularity.flac
...
```

**CSV:**
Add `playlist_name` and `position` columns. Tracks ordered by position.

### 6.3 Export API

The `/api/recommend/export` endpoint:
1. Reads the session's track list from `playlist_tracks` (ordered by position)
2. Loads full Track objects from Supabase
3. Passes to the appropriate exporter (existing Traktor/Rekordbox adapters + new M3U + CSV)
4. Returns binary file download

Only tracks with `local_path` set are included in file-path-dependent formats (NML, XML, M3U). CSV includes all tracks regardless.

---

## 7. Discovery (External Tracks)

Since Spotify audio features are deprecated, discovery is async:

1. Context profile provides genre + artist keywords
2. Spotify Search API (still works) finds candidates by genre/artist
3. Candidates shown in a "Discover" section below the graph — metadata + preview only, no audio features
4. User clicks "Add to library" on interesting tracks
5. Agent job chain: download → fingerprint → audio_analysis
6. Once analyzed (features in Supabase), track appears in the graph with full scoring

Discovery candidates are **not** scored or placed in the graph until locally analyzed. They're shown as a separate list with Spotify preview playback.

---

## 8. Technology Stack

| Component | Technology |
|---|---|
| Recommendation API | Python FastAPI on Hetzner (existing service) |
| Scoring engine | numpy + scipy (cosine similarity, distance metrics) |
| Feature storage | Supabase PostgreSQL (existing tracks table) |
| Graph visualization | react-force-graph (WebGL, ~45KB) |
| Audio preview | Existing preview player (Spotify iFrame + HTML5 Audio) |
| Drag & drop | HTML5 drag or react-beautiful-dnd for seed reordering |
| Web UI | Next.js (existing web app) |
| Playlist export | Existing Traktor/Rekordbox adapters + new M3U adapter |

---

## 9. Out of Scope (V1)

- Live/real-time recommendations during a set
- Community-contributed venue profiles
- Collaborative filtering (user-to-user similarity)
- Audio-reactive graph visualization
- Valence/acousticness approximation (spectral-based)
- pgvector — not needed until library exceeds ~10K tracks
- Automatic playlist naming via LLM
- Serato export format
