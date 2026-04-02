# Recommendation Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a context-aware track recommendation engine with an interactive similarity graph, enabling DJs to explore their library through venue/mood lenses and export DJ-ready playlists.

**Architecture:** Two-phase hybrid algorithm — profile matching for seed generation, cosine similarity for expansion — running as a Python FastAPI service on Hetzner. Web UI in Next.js with react-force-graph for the interactive similarity graph. Data stored in Supabase.

**Tech Stack:** Python (numpy, scipy, FastAPI), Next.js 16, React 19, react-force-graph, Supabase PostgreSQL, Tailwind CSS

**Spec:** `docs/superpowers/specs/2026-04-02-recommendation-engine-design.md`

---

## File Structure

### New Files — Python (Recommendation Engine)

| File | Responsibility |
|---|---|
| `djtoolkit/recommend/__init__.py` | Package init |
| `djtoolkit/recommend/profiles.py` | Profile merging, lineup modifiers, context profile construction |
| `djtoolkit/recommend/scoring.py` | Feature normalization, profile fit, cosine similarity, harmonic score, genre overlap |
| `djtoolkit/recommend/engine.py` | Seed generation, expansion, refinement, energy arc ordering, similarity edges |
| `djtoolkit/recommend/models.py` | Pydantic request/response schemas for API |
| `djtoolkit/service/routes/recommend.py` | FastAPI route handlers for /api/recommend/* |
| `djtoolkit/service/routes/venues.py` | FastAPI route handlers for /api/venues and /api/mood-presets |
| `djtoolkit/adapters/m3u.py` | M3U playlist exporter |
| `tests/test_recommend_profiles.py` | Tests for profile merging and lineup modifiers |
| `tests/test_recommend_scoring.py` | Tests for scoring functions |
| `tests/test_recommend_engine.py` | Tests for the recommendation engine |
| `tests/test_m3u_exporter.py` | Tests for M3U exporter |
| `tests/test_playlist_export.py` | Tests for Traktor/Rekordbox playlist sections |

### New Files — Web (Next.js)

| File | Responsibility |
|---|---|
| `web/app/(app)/recommend/page.tsx` | Main recommendation wizard page |
| `web/components/recommend/EntryScreen.tsx` | Two-card entry: By Venue / By Vibe & Mood |
| `web/components/recommend/VenueBrowser.tsx` | Searchable venue list with country filters |
| `web/components/recommend/VenueDetail.tsx` | Venue card + pre-filled profile + lineup selector |
| `web/components/recommend/MoodSelector.tsx` | Mood preset grid + lineup selector |
| `web/components/recommend/SeedList.tsx` | Draggable seed track list with like/reorder |
| `web/components/recommend/SimilarityGraph.tsx` | react-force-graph wrapper with artwork/clean modes |
| `web/components/recommend/ResultsList.tsx` | Track list with energy arc bar |
| `web/components/recommend/ExportDialog.tsx` | Playlist name + format selector + download |
| `web/components/recommend/EnergyArc.tsx` | Energy arc visualization bar |
| `web/app/api/recommend/seeds/route.ts` | Proxy to FastAPI /api/recommend/seeds |
| `web/app/api/recommend/expand/route.ts` | Proxy to FastAPI /api/recommend/expand |
| `web/app/api/recommend/refine/route.ts` | Proxy to FastAPI /api/recommend/refine |
| `web/app/api/recommend/export/route.ts` | Proxy to FastAPI /api/recommend/export |
| `web/app/api/recommend/sessions/route.ts` | Proxy to FastAPI /api/recommend/sessions |
| `web/app/api/venues/route.ts` | Proxy or direct Supabase query for venues |
| `web/app/api/venues/[id]/route.ts` | Single venue detail |
| `web/app/api/mood-presets/route.ts` | All mood presets |

### Modified Files

| File | Change |
|---|---|
| `djtoolkit/service/app.py` | Register recommend + venues routers |
| `djtoolkit/adapters/traktor.py` | Add `export_with_playlists()` method |
| `djtoolkit/adapters/rekordbox.py` | Add `export_with_playlists()` method |
| `djtoolkit/adapters/base.py` | Add `Playlist` dataclass and updated interface |
| `web/lib/api.ts` | Add recommendation API client functions + types |
| `web/components/sidebar.tsx` | Add "Recommend" navigation item |
| `web/package.json` | Add react-force-graph-2d dependency |
| `supabase/migrations/` | New migration for venues, mood_presets, etc. |

---

## Task 1: Database Schema Migration

**Files:**
- Create: `supabase/migrations/20260402210000_recommendation_engine.sql`
- Reference: `djtoolkit/db/pg_schema.sql`, `djtoolkit/db/rls.sql`

- [ ] **Step 1: Write the migration SQL**

```sql
-- venues: curated club/venue profiles (public, no RLS)
CREATE TABLE venues (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    type            TEXT NOT NULL CHECK (type IN ('club','stadium','bar','rooftop','warehouse','festival')),
    city            TEXT NOT NULL,
    country         TEXT NOT NULL,
    address         TEXT,
    capacity        INT,
    sqm             INT,
    genres          TEXT[] DEFAULT '{}',
    mood_tags       TEXT[] DEFAULT '{}',
    dj_cabin_style  TEXT,
    photo_url       TEXT,
    website_url     TEXT,
    google_maps_url TEXT,
    google_rating   FLOAT,
    target_profile  JSONB NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- mood_presets: mood/vibe profiles (public, no RLS)
CREATE TABLE mood_presets (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    category        TEXT NOT NULL CHECK (category IN ('beach','pool_party','nightclub','day_party','coffee_rave','afterhours')),
    target_profile  JSONB NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- recommendation_sessions: user exploration state
CREATE TABLE recommendation_sessions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    venue_id        UUID REFERENCES venues(id) ON DELETE SET NULL,
    mood_preset_id  UUID REFERENCES mood_presets(id) ON DELETE SET NULL,
    lineup_position TEXT NOT NULL CHECK (lineup_position IN ('warmup','middle','headliner')),
    context_profile JSONB NOT NULL,
    seed_feedback   JSONB DEFAULT '[]',
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- playlists: saved playlists from recommendations or manual
CREATE TABLE playlists (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    session_id      UUID REFERENCES recommendation_sessions(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- playlist_tracks: ordered track membership
CREATE TABLE playlist_tracks (
    playlist_id     UUID NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    track_id        BIGINT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    position        INT NOT NULL,
    PRIMARY KEY (playlist_id, track_id)
);

-- Indexes
CREATE INDEX idx_venues_country ON venues(country);
CREATE INDEX idx_mood_presets_category ON mood_presets(category);
CREATE INDEX idx_recommendation_sessions_user ON recommendation_sessions(user_id);
CREATE INDEX idx_playlists_user ON playlists(user_id);
CREATE INDEX idx_playlist_tracks_playlist ON playlist_tracks(playlist_id);

-- RLS for user-scoped tables
ALTER TABLE recommendation_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY recommendation_sessions_isolation ON recommendation_sessions
    USING (user_id = current_setting('app.current_user_id', true)::UUID)
    WITH CHECK (user_id = current_setting('app.current_user_id', true)::UUID);

ALTER TABLE playlists ENABLE ROW LEVEL SECURITY;
CREATE POLICY playlists_isolation ON playlists
    USING (user_id = current_setting('app.current_user_id', true)::UUID)
    WITH CHECK (user_id = current_setting('app.current_user_id', true)::UUID);

ALTER TABLE playlist_tracks ENABLE ROW LEVEL SECURITY;
CREATE POLICY playlist_tracks_isolation ON playlist_tracks
    USING (
        EXISTS (
            SELECT 1 FROM playlists p
            WHERE p.id = playlist_tracks.playlist_id
              AND p.user_id = current_setting('app.current_user_id', true)::UUID
        )
    );

-- Grants
GRANT SELECT ON venues TO authenticated;
GRANT SELECT ON mood_presets TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON recommendation_sessions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON playlists TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON playlist_tracks TO authenticated;
```

- [ ] **Step 2: Apply the migration**

Run via Supabase MCP `apply_migration` tool or:
```bash
supabase db push
```

- [ ] **Step 3: Seed initial venue data (Spain + Argentina)**

Create `supabase/migrations/20260402210001_seed_venues.sql`:

```sql
INSERT INTO venues (name, type, city, country, address, capacity, sqm, genres, mood_tags, dj_cabin_style, google_rating, target_profile) VALUES
-- Spain
('Razzmatazz', 'club', 'Barcelona', 'Spain', 'Carrer dels Almogàvers, 122', 3000, 5000, '{"techno","house","indie"}', '{"dark","energetic","underground"}', 'elevated booth', 4.3,
 '{"bpm":[125,140],"energy":[0.65,0.95],"danceability":[0.7,0.9]}'),
('Pacha Barcelona', 'club', 'Barcelona', 'Spain', 'Passeig Marítim de la Barceloneta, 38', 2500, 3000, '{"house","tech house","disco"}', '{"glamorous","upbeat","party"}', 'elevated booth', 4.1,
 '{"bpm":[120,132],"energy":[0.6,0.85],"danceability":[0.75,0.95]}'),
('Input', 'club', 'Barcelona', 'Spain', 'Av. Francesc Ferrer i Guàrdia, 13', 800, 1200, '{"techno","minimal","ambient"}', '{"dark","intimate","underground"}', 'floor level', 4.4,
 '{"bpm":[128,145],"energy":[0.7,0.95],"danceability":[0.65,0.85]}'),
('Fabrik', 'club', 'Madrid', 'Spain', 'Avda. de la Industria, 82', 4000, 8000, '{"techno","hard techno","trance"}', '{"industrial","intense","peak-time"}', 'elevated booth', 4.2,
 '{"bpm":[135,150],"energy":[0.8,1.0],"danceability":[0.7,0.9]}'),
('Mondo Disko', 'club', 'Madrid', 'Spain', 'C. de Alcalá, 20', 600, 800, '{"house","disco","nu-disco"}', '{"warm","groovy","intimate"}', 'floor level', 4.0,
 '{"bpm":[118,128],"energy":[0.5,0.75],"danceability":[0.8,0.95]}'),
('Florida 135', 'club', 'Fraga', 'Spain', 'Ctra. de Huesca, km 135', 5000, 10000, '{"techno","trance","hard dance"}', '{"massive","euphoric","peak-time"}', 'elevated booth', 4.3,
 '{"bpm":[135,150],"energy":[0.85,1.0],"danceability":[0.7,0.9]}'),
('Amnesia Ibiza', 'club', 'Ibiza', 'Spain', 'Carretera Ibiza a San Antonio, km 5', 5000, 6000, '{"house","techno","trance"}', '{"euphoric","legendary","peak-time"}', 'elevated booth', 4.5,
 '{"bpm":[125,140],"energy":[0.7,0.95],"danceability":[0.75,0.95]}'),
('DC-10', 'club', 'Ibiza', 'Spain', 'Ctra. de las Salinas, km 1', 1500, 2500, '{"techno","minimal","house"}', '{"raw","daytime","underground"}', 'floor level', 4.6,
 '{"bpm":[125,140],"energy":[0.6,0.9],"danceability":[0.7,0.9]}'),
-- Argentina
('Crobar', 'club', 'Buenos Aires', 'Argentina', 'Av. Paseo Colón 168', 1500, 2000, '{"techno","progressive","house"}', '{"dark","underground","intense"}', 'elevated booth', 4.1,
 '{"bpm":[125,140],"energy":[0.7,0.95],"danceability":[0.7,0.9]}'),
('Bahrein', 'club', 'Buenos Aires', 'Argentina', 'Lavalle 345', 1200, 1800, '{"techno","tech house","progressive"}', '{"underground","dark","industrial"}', 'elevated booth', 4.0,
 '{"bpm":[126,142],"energy":[0.7,0.95],"danceability":[0.65,0.85]}'),
('Mandarine Park', 'festival', 'Buenos Aires', 'Argentina', 'Costanera Norte', 10000, 30000, '{"techno","house","trance","progressive"}', '{"massive","outdoor","euphoric"}', 'elevated booth', 4.2,
 '{"bpm":[125,145],"energy":[0.7,1.0],"danceability":[0.7,0.95]}'),
('Club Araoz', 'club', 'Buenos Aires', 'Argentina', 'Araoz 2424', 500, 600, '{"house","deep house","disco"}', '{"intimate","warm","groovy"}', 'floor level', 4.3,
 '{"bpm":[118,128],"energy":[0.4,0.7],"danceability":[0.75,0.95]}');
```

- [ ] **Step 4: Seed mood presets**

Append to the same migration file:

```sql
INSERT INTO mood_presets (name, category, target_profile) VALUES
('Beach Sunset', 'beach', '{"bpm":[110,125],"energy":[0.3,0.6],"danceability":[0.6,0.8]}'),
('Beach Party', 'beach', '{"bpm":[118,130],"energy":[0.5,0.8],"danceability":[0.7,0.9]}'),
('Pool Party', 'pool_party', '{"bpm":[115,128],"energy":[0.5,0.75],"danceability":[0.75,0.95]}'),
('Pool Lounge', 'pool_party', '{"bpm":[105,120],"energy":[0.3,0.55],"danceability":[0.6,0.8]}'),
('Dark Nightclub', 'nightclub', '{"bpm":[128,145],"energy":[0.7,0.95],"danceability":[0.65,0.85]}'),
('Funky Nightclub', 'nightclub', '{"bpm":[120,132],"energy":[0.6,0.85],"danceability":[0.8,0.95]}'),
('Day Party', 'day_party', '{"bpm":[118,130],"energy":[0.5,0.8],"danceability":[0.7,0.9]}'),
('Rooftop Day', 'day_party', '{"bpm":[112,125],"energy":[0.4,0.65],"danceability":[0.65,0.85]}'),
('Coffee Rave', 'coffee_rave', '{"bpm":[130,145],"energy":[0.6,0.85],"danceability":[0.7,0.9]}'),
('Morning Rave', 'coffee_rave', '{"bpm":[125,138],"energy":[0.55,0.8],"danceability":[0.7,0.9]}'),
('Afterhours Deep', 'afterhours', '{"bpm":[120,132],"energy":[0.3,0.6],"danceability":[0.6,0.8]}'),
('Afterhours Hypnotic', 'afterhours', '{"bpm":[128,140],"energy":[0.5,0.75],"danceability":[0.6,0.8]}');
```

- [ ] **Step 5: Apply seed migration and commit**

```bash
supabase db push
git add supabase/migrations/20260402210000_recommendation_engine.sql \
        supabase/migrations/20260402210001_seed_venues.sql
git commit -m "feat(db): add recommendation engine schema + seed venues/moods"
```

---

## Task 2: Recommendation Engine — Profile Merging

**Files:**
- Create: `djtoolkit/recommend/__init__.py`
- Create: `djtoolkit/recommend/profiles.py`
- Create: `tests/test_recommend_profiles.py`

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_recommend_profiles.py
import pytest
from djtoolkit.recommend.profiles import (
    merge_profiles,
    apply_lineup_modifier,
    build_context_profile,
    LINEUP_MODIFIERS,
)


class TestLineupModifiers:
    def test_warmup_energy_multiplier(self):
        assert LINEUP_MODIFIERS["warmup"]["energy_multiplier"] == 0.6

    def test_headliner_energy_multiplier(self):
        assert LINEUP_MODIFIERS["headliner"]["energy_multiplier"] == 1.1

    def test_middle_energy_multiplier(self):
        assert LINEUP_MODIFIERS["middle"]["energy_multiplier"] == 0.85


class TestMergeProfiles:
    def test_single_profile(self):
        venue = {"bpm": [126, 140], "energy": [0.7, 0.95]}
        result = merge_profiles(venue, None)
        assert result == {"bpm": [126, 140], "energy": [0.7, 0.95]}

    def test_single_mood_profile(self):
        mood = {"bpm": [110, 125], "energy": [0.3, 0.6]}
        result = merge_profiles(None, mood)
        assert result == {"bpm": [110, 125], "energy": [0.3, 0.6]}

    def test_overlapping_ranges_intersect(self):
        venue = {"bpm": [120, 140], "energy": [0.6, 0.9]}
        mood = {"bpm": [125, 135], "energy": [0.5, 0.8]}
        result = merge_profiles(venue, mood)
        assert result["bpm"] == [125, 135]  # intersection
        assert result["energy"] == [0.6, 0.8]  # intersection

    def test_non_overlapping_ranges_use_midpoint(self):
        venue = {"bpm": [126, 140]}
        mood = {"bpm": [110, 125]}
        result = merge_profiles(venue, mood)
        # midpoint between 125 and 126 is 125.5, ±5 window
        assert result["bpm"] == [120.5, 130.5]

    def test_genres_union(self):
        venue = {"bpm": [120, 140], "genres": ["techno", "house"]}
        mood = {"bpm": [125, 135], "genres": ["house", "minimal"]}
        result = merge_profiles(venue, mood)
        assert set(result["genres"]) == {"techno", "house", "minimal"}

    def test_both_none_raises(self):
        with pytest.raises(ValueError, match="At least one profile"):
            merge_profiles(None, None)


class TestApplyLineupModifier:
    def test_warmup_scales_energy_down(self):
        profile = {"bpm": [125, 140], "energy": [0.6, 0.9]}
        result = apply_lineup_modifier(profile, "warmup")
        assert result["energy"] == [pytest.approx(0.36), pytest.approx(0.54)]

    def test_warmup_biases_bpm_lower(self):
        profile = {"bpm": [125, 140]}
        result = apply_lineup_modifier(profile, "warmup")
        assert result["bpm"][0] < 125  # shifted lower
        assert result["bpm"][1] < 140

    def test_headliner_scales_energy_up(self):
        profile = {"bpm": [125, 140], "energy": [0.6, 0.9]}
        result = apply_lineup_modifier(profile, "headliner")
        assert result["energy"][0] > 0.6
        # energy capped at 1.0
        assert result["energy"][1] <= 1.0

    def test_headliner_biases_bpm_upper(self):
        profile = {"bpm": [125, 140]}
        result = apply_lineup_modifier(profile, "headliner")
        assert result["bpm"][0] > 125
        assert result["bpm"][1] > 140

    def test_middle_moderate(self):
        profile = {"bpm": [125, 140], "energy": [0.6, 0.9]}
        result = apply_lineup_modifier(profile, "middle")
        assert result["energy"] == [pytest.approx(0.51), pytest.approx(0.765)]

    def test_preserves_non_numeric_fields(self):
        profile = {"bpm": [125, 140], "genres": ["techno"]}
        result = apply_lineup_modifier(profile, "warmup")
        assert result["genres"] == ["techno"]


class TestBuildContextProfile:
    def test_venue_only_with_lineup(self):
        venue_profile = {"bpm": [126, 140], "energy": [0.7, 0.95]}
        result = build_context_profile(venue_profile, None, "middle")
        assert "bpm" in result
        assert "energy" in result

    def test_mood_only_with_lineup(self):
        mood_profile = {"bpm": [110, 125], "energy": [0.3, 0.6]}
        result = build_context_profile(None, mood_profile, "warmup")
        assert "bpm" in result
        assert "energy" in result
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
uv run pytest tests/test_recommend_profiles.py -v
```
Expected: FAIL — `ModuleNotFoundError: No module named 'djtoolkit.recommend'`

- [ ] **Step 3: Implement profiles module**

```python
# djtoolkit/recommend/__init__.py
```

```python
# djtoolkit/recommend/profiles.py
"""Profile merging and lineup modifiers for the recommendation engine."""

from __future__ import annotations

LINEUP_MODIFIERS: dict[str, dict] = {
    "warmup": {"energy_multiplier": 0.6, "bpm_shift": -5},
    "middle": {"energy_multiplier": 0.85, "bpm_shift": 0},
    "headliner": {"energy_multiplier": 1.1, "bpm_shift": 5},
}

_RANGE_FEATURES = {"bpm", "energy", "danceability", "loudness"}


def merge_profiles(
    venue_profile: dict | None,
    mood_profile: dict | None,
) -> dict:
    """Merge venue and mood target profiles.

    Numeric ranges are intersected if overlapping, otherwise midpoint ±5.
    List fields (genres, mood_tags) are unioned.
    """
    if venue_profile is None and mood_profile is None:
        raise ValueError("At least one profile (venue or mood) is required")

    if venue_profile is None:
        return dict(mood_profile)
    if mood_profile is None:
        return dict(venue_profile)

    merged: dict = {}
    all_keys = set(venue_profile) | set(mood_profile)

    for key in all_keys:
        v = venue_profile.get(key)
        m = mood_profile.get(key)

        if v is None:
            merged[key] = m
        elif m is None:
            merged[key] = v
        elif key in _RANGE_FEATURES and isinstance(v, list) and isinstance(m, list):
            merged[key] = _merge_ranges(v, m)
        elif isinstance(v, list) and isinstance(m, list):
            # List fields like genres — union
            merged[key] = list(set(v) | set(m))
        else:
            merged[key] = v  # venue takes precedence for non-range scalars

    return merged


def _merge_ranges(a: list[float], b: list[float]) -> list[float]:
    """Intersect two [min, max] ranges. If non-overlapping, use midpoint ±5."""
    lo = max(a[0], b[0])
    hi = min(a[1], b[1])
    if lo <= hi:
        return [lo, hi]
    # Non-overlapping: midpoint between the gap
    midpoint = (min(a[1], b[1]) + max(a[0], b[0])) / 2
    return [midpoint - 5, midpoint + 5]


def apply_lineup_modifier(profile: dict, lineup_position: str) -> dict:
    """Apply lineup position modifier to a target profile."""
    mod = LINEUP_MODIFIERS[lineup_position]
    result = dict(profile)

    if "energy" in result:
        lo, hi = result["energy"]
        mult = mod["energy_multiplier"]
        result["energy"] = [
            min(max(lo * mult, 0.0), 1.0),
            min(max(hi * mult, 0.0), 1.0),
        ]

    if "bpm" in result:
        shift = mod["bpm_shift"]
        lo, hi = result["bpm"]
        result["bpm"] = [lo + shift, hi + shift]

    if "danceability" in result:
        lo, hi = result["danceability"]
        mult = mod["energy_multiplier"]
        result["danceability"] = [
            min(max(lo * mult, 0.0), 1.0),
            min(max(hi * mult, 0.0), 1.0),
        ]

    return result


def build_context_profile(
    venue_profile: dict | None,
    mood_profile: dict | None,
    lineup_position: str,
) -> dict:
    """Merge profiles and apply lineup modifier. Returns the final context profile."""
    merged = merge_profiles(venue_profile, mood_profile)
    return apply_lineup_modifier(merged, lineup_position)
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
uv run pytest tests/test_recommend_profiles.py -v
```
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add djtoolkit/recommend/__init__.py djtoolkit/recommend/profiles.py tests/test_recommend_profiles.py
git commit -m "feat(recommend): add profile merging and lineup modifiers"
```

---

## Task 3: Recommendation Engine — Scoring Functions

**Files:**
- Create: `djtoolkit/recommend/scoring.py`
- Create: `tests/test_recommend_scoring.py`

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_recommend_scoring.py
import pytest
import numpy as np
from djtoolkit.recommend.scoring import (
    normalize_features,
    profile_fit_score,
    cosine_similarity,
    harmonic_score,
    genre_overlap,
    expansion_score,
)


class TestNormalizeFeatures:
    def test_bpm_normalization(self):
        result = normalize_features({"tempo": 130.0, "energy": 0.7, "danceability": 0.8, "loudness": -10.0})
        assert result[0] == pytest.approx((130 - 60) / 140)

    def test_energy_passthrough(self):
        result = normalize_features({"tempo": 130.0, "energy": 0.7, "danceability": 0.8, "loudness": -10.0})
        assert result[1] == pytest.approx(0.7)

    def test_loudness_normalization(self):
        result = normalize_features({"tempo": 130.0, "energy": 0.7, "danceability": 0.8, "loudness": -10.0})
        assert result[3] == pytest.approx((-10 + 30) / 30)

    def test_missing_features_default_to_midpoint(self):
        result = normalize_features({"tempo": None, "energy": None, "danceability": None, "loudness": None})
        assert result[0] == pytest.approx(0.5)  # midpoint


class TestProfileFitScore:
    def test_within_range_is_1(self):
        track = {"tempo": 130.0, "energy": 0.8}
        profile = {"bpm": [125, 135], "energy": [0.7, 0.9]}
        assert profile_fit_score(track, profile) == pytest.approx(1.0)

    def test_outside_range_decays(self):
        track = {"tempo": 145.0, "energy": 0.8}
        profile = {"bpm": [125, 135], "energy": [0.7, 0.9]}
        score = profile_fit_score(track, profile)
        assert 0.0 < score < 1.0

    def test_far_outside_range_is_low(self):
        track = {"tempo": 200.0, "energy": 0.1}
        profile = {"bpm": [125, 135], "energy": [0.7, 0.9]}
        score = profile_fit_score(track, profile)
        assert score < 0.3


class TestCosineSimilarity:
    def test_identical_vectors(self):
        a = np.array([0.5, 0.7, 0.8, 0.6])
        assert cosine_similarity(a, a) == pytest.approx(1.0)

    def test_orthogonal_vectors(self):
        a = np.array([1.0, 0.0, 0.0, 0.0])
        b = np.array([0.0, 1.0, 0.0, 0.0])
        assert cosine_similarity(a, b) == pytest.approx(0.0)

    def test_similar_vectors_high_score(self):
        a = np.array([0.5, 0.7, 0.8, 0.6])
        b = np.array([0.52, 0.68, 0.82, 0.58])
        assert cosine_similarity(a, b) > 0.99


class TestHarmonicScore:
    def test_same_key(self):
        assert harmonic_score("8B", "8B") == 1.0

    def test_adjacent_number(self):
        assert harmonic_score("8B", "7B") == 0.8

    def test_adjacent_letter(self):
        assert harmonic_score("8A", "8B") == 0.8

    def test_two_steps(self):
        assert harmonic_score("8B", "6B") == 0.4

    def test_incompatible(self):
        assert harmonic_score("8B", "3A") == 0.0

    def test_empty_camelot(self):
        assert harmonic_score("", "8B") == 0.5  # neutral


class TestGenreOverlap:
    def test_full_overlap(self):
        assert genre_overlap("techno, house", ["techno", "house"]) == pytest.approx(1.0)

    def test_partial_overlap(self):
        assert genre_overlap("techno, minimal", ["techno", "house"]) == pytest.approx(0.5)

    def test_no_overlap(self):
        assert genre_overlap("ambient, classical", ["techno", "house"]) == pytest.approx(0.0)

    def test_empty_track_genres(self):
        assert genre_overlap("", ["techno"]) == pytest.approx(0.0)

    def test_empty_seed_genres(self):
        assert genre_overlap("techno", []) == pytest.approx(0.0)


class TestExpansionScore:
    def test_returns_float_between_0_and_1(self):
        track_vector = np.array([0.5, 0.7, 0.8, 0.6])
        centroid = np.array([0.5, 0.7, 0.8, 0.6])
        track = {"tempo": 130.0, "energy": 0.8, "genres": "techno", "camelot": "8B"}
        profile = {"bpm": [125, 135], "energy": [0.7, 0.9]}
        score = expansion_score(
            track_vector=track_vector,
            centroid=centroid,
            track=track,
            context_profile=profile,
            seed_genres=["techno"],
            prev_camelot="8A",
        )
        assert 0.0 <= score <= 1.5  # can exceed 1 before normalization
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
uv run pytest tests/test_recommend_scoring.py -v
```
Expected: FAIL — `ModuleNotFoundError`

- [ ] **Step 3: Implement scoring module**

```python
# djtoolkit/recommend/scoring.py
"""Scoring functions for the recommendation engine."""

from __future__ import annotations

import numpy as np

# Feature order for vectors: [bpm_norm, energy, danceability, loudness_norm]
FEATURE_KEYS = ["tempo", "energy", "danceability", "loudness"]
_BPM_MIN, _BPM_RANGE = 60.0, 140.0
_LUFS_MIN, _LUFS_RANGE = -30.0, 30.0


def normalize_features(track: dict) -> np.ndarray:
    """Convert track features to a normalized [0,1] vector.

    Feature order: [bpm_norm, energy, danceability, loudness_norm].
    Missing/None values default to 0.5 (midpoint).
    """
    bpm = track.get("tempo")
    energy = track.get("energy")
    dance = track.get("danceability")
    loud = track.get("loudness")

    return np.array([
        np.clip((bpm - _BPM_MIN) / _BPM_RANGE, 0, 1) if bpm is not None else 0.5,
        energy if energy is not None else 0.5,
        dance if dance is not None else 0.5,
        np.clip((loud - _LUFS_MIN) / _LUFS_RANGE, 0, 1) if loud is not None else 0.5,
    ], dtype=np.float64)


def profile_fit_score(track: dict, profile: dict) -> float:
    """Score how well a track's features fit within a target profile's ranges.

    Returns 1.0 if all features are within range, decays linearly outside.
    """
    feature_map = {"bpm": "tempo", "energy": "energy", "danceability": "danceability", "loudness": "loudness"}
    scores = []

    for profile_key, track_key in feature_map.items():
        if profile_key not in profile:
            continue
        lo, hi = profile[profile_key]
        val = track.get(track_key)
        if val is None:
            scores.append(0.5)
            continue
        if lo <= val <= hi:
            scores.append(1.0)
        else:
            rng = hi - lo
            if rng == 0:
                rng = 1.0
            dist = min(abs(val - lo), abs(val - hi)) / rng
            scores.append(max(0.0, 1.0 - dist))

    return float(np.mean(scores)) if scores else 0.5


def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    """Cosine similarity between two vectors. Returns 0 if either is zero."""
    norm_a = np.linalg.norm(a)
    norm_b = np.linalg.norm(b)
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return float(np.dot(a, b) / (norm_a * norm_b))


def harmonic_score(camelot_a: str, camelot_b: str) -> float:
    """Score harmonic compatibility between two Camelot keys.

    1.0 = same key, 0.8 = adjacent, 0.4 = two steps, 0.0 = incompatible.
    """
    if not camelot_a or not camelot_b:
        return 0.5  # neutral if key unknown

    if camelot_a == camelot_b:
        return 1.0

    num_a, letter_a = _parse_camelot(camelot_a)
    num_b, letter_b = _parse_camelot(camelot_b)

    if num_a is None or num_b is None:
        return 0.5

    # Adjacent: same number different letter, or ±1 same letter
    same_num_diff_letter = num_a == num_b and letter_a != letter_b
    adjacent_num_same_letter = letter_a == letter_b and _camelot_distance(num_a, num_b) == 1

    if same_num_diff_letter or adjacent_num_same_letter:
        return 0.8

    # Two steps away
    if letter_a == letter_b and _camelot_distance(num_a, num_b) == 2:
        return 0.4

    return 0.0


def genre_overlap(track_genres: str, seed_genres: list[str]) -> float:
    """Score genre overlap between a track and seed genre list."""
    if not track_genres or not seed_genres:
        return 0.0
    track_set = {g.strip().lower() for g in track_genres.split(",") if g.strip()}
    seed_set = {g.lower() for g in seed_genres}
    if not seed_set:
        return 0.0
    return len(track_set & seed_set) / len(seed_set)


def expansion_score(
    track_vector: np.ndarray,
    centroid: np.ndarray,
    track: dict,
    context_profile: dict,
    seed_genres: list[str],
    prev_camelot: str,
) -> float:
    """Compute the full expansion score for a candidate track.

    score = 0.40 * cosine_sim + 0.25 * profile_fit + 0.20 * harmonic + 0.15 * genre
    """
    cos_sim = cosine_similarity(track_vector, centroid)
    pfit = profile_fit_score(track, context_profile)
    harm = harmonic_score(track.get("camelot", ""), prev_camelot)
    genre = genre_overlap(track.get("genres", ""), seed_genres)

    return 0.40 * cos_sim + 0.25 * pfit + 0.20 * harm + 0.15 * genre


def _parse_camelot(code: str) -> tuple[int | None, str]:
    """Parse '8B' into (8, 'B')."""
    if not code:
        return None, ""
    letter = code[-1].upper()
    try:
        num = int(code[:-1])
        return num, letter
    except ValueError:
        return None, ""


def _camelot_distance(a: int, b: int) -> int:
    """Circular distance on the Camelot wheel (1-12)."""
    diff = abs(a - b)
    return min(diff, 12 - diff)
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
uv run pytest tests/test_recommend_scoring.py -v
```
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add djtoolkit/recommend/scoring.py tests/test_recommend_scoring.py
git commit -m "feat(recommend): add scoring functions — profile fit, cosine sim, harmonic, genre overlap"
```

---

## Task 4: Recommendation Engine — Core Engine

**Files:**
- Create: `djtoolkit/recommend/engine.py`
- Create: `tests/test_recommend_engine.py`

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_recommend_engine.py
import pytest
import numpy as np
from djtoolkit.recommend.engine import RecommendationEngine


def _make_track(id: int, tempo: float, energy: float, dance: float,
                loudness: float, camelot: str, genres: str, enriched: bool = True) -> dict:
    return {
        "id": id, "tempo": tempo, "energy": energy, "danceability": dance,
        "loudness": loudness, "camelot": camelot, "genres": genres,
        "enriched_audio": enriched, "title": f"Track {id}", "artist": f"Artist {id}",
    }


@pytest.fixture
def library():
    return [
        _make_track(1, 128.0, 0.75, 0.80, -8.0, "8B", "techno, minimal"),
        _make_track(2, 130.0, 0.82, 0.78, -7.0, "9A", "techno"),
        _make_track(3, 124.0, 0.60, 0.85, -10.0, "7B", "house, deep house"),
        _make_track(4, 132.0, 0.90, 0.70, -6.0, "8A", "techno, industrial"),
        _make_track(5, 126.0, 0.55, 0.82, -12.0, "6B", "house"),
        _make_track(6, 140.0, 0.95, 0.65, -5.0, "10A", "hard techno"),
        _make_track(7, 120.0, 0.40, 0.90, -14.0, "5A", "deep house"),
        _make_track(8, 135.0, 0.88, 0.72, -6.5, "9B", "techno"),
        _make_track(9, 122.0, 0.50, 0.88, -11.0, "6A", "house, disco"),
        _make_track(10, 128.0, 0.70, 0.80, -9.0, "8B", "minimal"),
        _make_track(11, 130.0, 0.65, 0.75, -10.0, "7A", "progressive"),
        _make_track(12, 125.0, 0.45, 0.85, -13.0, "5B", "deep house"),
        # Unanalyzed track
        _make_track(99, 0.0, 0.0, 0.0, 0.0, "", "", enriched=False),
    ]


@pytest.fixture
def engine():
    return RecommendationEngine()


class TestGenerateSeeds:
    def test_returns_up_to_10_seeds(self, engine, library):
        profile = {"bpm": [125, 135], "energy": [0.6, 0.9], "genres": ["techno"]}
        seeds = engine.generate_seeds(library, profile)
        assert len(seeds) <= 10

    def test_excludes_unanalyzed(self, engine, library):
        profile = {"bpm": [125, 135], "energy": [0.6, 0.9]}
        seeds = engine.generate_seeds(library, profile)
        seed_ids = [s["id"] for s in seeds]
        assert 99 not in seed_ids

    def test_returns_unanalyzed_count(self, engine, library):
        profile = {"bpm": [125, 135], "energy": [0.6, 0.9]}
        seeds, unanalyzed = engine.generate_seeds(library, profile, return_unanalyzed_count=True)
        assert unanalyzed == 1

    def test_best_matches_score_highest(self, engine, library):
        profile = {"bpm": [127, 132], "energy": [0.7, 0.85], "genres": ["techno"]}
        seeds = engine.generate_seeds(library, profile)
        # Track 1 (128 bpm, 0.75 energy, techno) should be top
        assert seeds[0]["id"] == 1


class TestExpand:
    def test_returns_up_to_100_tracks(self, engine, library):
        profile = {"bpm": [125, 135], "energy": [0.6, 0.9]}
        feedback = [
            {"track_id": 1, "liked": True, "position": 1},
            {"track_id": 2, "liked": True, "position": 2},
            {"track_id": 3, "liked": False, "position": 3},
        ]
        result = engine.expand(library, profile, feedback)
        assert len(result["tracks"]) <= 100

    def test_excludes_disliked_seeds(self, engine, library):
        profile = {"bpm": [125, 135], "energy": [0.6, 0.9]}
        feedback = [
            {"track_id": 1, "liked": True, "position": 1},
            {"track_id": 3, "liked": False, "position": 2},
        ]
        result = engine.expand(library, profile, feedback)
        track_ids = [t["id"] for t in result["tracks"]]
        assert 3 not in track_ids

    def test_returns_similarity_edges(self, engine, library):
        profile = {"bpm": [125, 135], "energy": [0.6, 0.9]}
        feedback = [{"track_id": 1, "liked": True, "position": 1}]
        result = engine.expand(library, profile, feedback)
        assert "similarity_edges" in result
        for edge in result["similarity_edges"]:
            assert "source" in edge
            assert "target" in edge
            assert "weight" in edge


class TestEnergyArcOrdering:
    def test_warmup_ascending(self, engine):
        tracks = [
            {"id": 1, "energy": 0.8},
            {"id": 2, "energy": 0.3},
            {"id": 3, "energy": 0.5},
        ]
        ordered = engine.order_by_energy_arc(tracks, "warmup")
        energies = [t["energy"] for t in ordered]
        assert energies == sorted(energies)

    def test_headliner_peaks_in_middle(self, engine):
        tracks = [
            {"id": i, "energy": e}
            for i, e in enumerate([0.3, 0.5, 0.7, 0.9, 0.8, 0.6, 0.4])
        ]
        ordered = engine.order_by_energy_arc(tracks, "headliner")
        energies = [t["energy"] for t in ordered]
        peak_idx = energies.index(max(energies))
        # Peak should be roughly in the middle-to-upper portion
        assert len(energies) // 3 <= peak_idx <= 2 * len(energies) // 3 + 1
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
uv run pytest tests/test_recommend_engine.py -v
```
Expected: FAIL — `ImportError`

- [ ] **Step 3: Implement the engine**

```python
# djtoolkit/recommend/engine.py
"""Core recommendation engine — seed generation, expansion, refinement."""

from __future__ import annotations

import numpy as np
from djtoolkit.recommend.scoring import (
    normalize_features,
    profile_fit_score,
    cosine_similarity,
    expansion_score,
    genre_overlap,
)


class RecommendationEngine:
    """Two-phase recommendation engine: profile matching → seed similarity."""

    def __init__(self, similarity_threshold: float = 0.5):
        self._similarity_threshold = similarity_threshold

    def generate_seeds(
        self,
        library: list[dict],
        context_profile: dict,
        max_seeds: int = 10,
        return_unanalyzed_count: bool = False,
    ) -> list[dict] | tuple[list[dict], int]:
        """Phase 1: Score all tracks against context profile, return top N as seeds."""
        analyzed = [t for t in library if t.get("enriched_audio", False)]
        unanalyzed_count = len(library) - len(analyzed)

        profile_genres = context_profile.get("genres", [])

        scored: list[tuple[float, dict]] = []
        for track in analyzed:
            fit = profile_fit_score(track, context_profile)
            genre = genre_overlap(track.get("genres", ""), profile_genres) if profile_genres else 0.0
            score = 0.6 * fit + 0.4 * genre
            scored.append((score, track))

        scored.sort(key=lambda x: x[0], reverse=True)
        seeds = [t for _, t in scored[:max_seeds]]

        if return_unanalyzed_count:
            return seeds, unanalyzed_count
        return seeds

    def expand(
        self,
        library: list[dict],
        context_profile: dict,
        seed_feedback: list[dict],
        max_results: int = 100,
    ) -> dict:
        """Phase 2: Expand from liked seeds using similarity + context scoring."""
        liked = [f for f in seed_feedback if f.get("liked", False)]
        disliked_ids = {f["track_id"] for f in seed_feedback if not f.get("liked", True)}
        seed_ids = {f["track_id"] for f in seed_feedback}

        if not liked:
            return {"tracks": [], "similarity_edges": [], "energy_arc": "build"}

        # Build weighted centroid from liked seeds
        analyzed = [t for t in library if t.get("enriched_audio", False)]
        track_map = {t["id"]: t for t in analyzed}

        centroid, seed_genres = self._build_centroid(liked, track_map)

        # Score all candidates
        candidates = [
            t for t in analyzed
            if t["id"] not in disliked_ids and t["id"] not in seed_ids
        ]

        # Get first liked seed's camelot for harmonic scoring
        first_liked_track = track_map.get(liked[0]["track_id"], {})
        first_camelot = first_liked_track.get("camelot", "")

        scored: list[tuple[float, dict]] = []
        for track in candidates:
            vec = normalize_features(track)
            score = expansion_score(
                track_vector=vec,
                centroid=centroid,
                track=track,
                context_profile=context_profile,
                seed_genres=seed_genres,
                prev_camelot=first_camelot,
            )
            scored.append((score, track))

        scored.sort(key=lambda x: x[0], reverse=True)
        result_tracks = [t for _, t in scored[:max_results]]

        # Compute similarity edges
        edges = self._compute_similarity_edges(result_tracks)

        return {
            "tracks": result_tracks,
            "similarity_edges": edges,
            "energy_arc": "build",
        }

    def refine(
        self,
        library: list[dict],
        context_profile: dict,
        original_feedback: list[dict],
        new_feedback: list[dict],
    ) -> dict:
        """Iterative refinement: merge new feedback with original, re-expand."""
        # New liked tracks become seeds with lower weight
        merged = list(original_feedback)
        for fb in new_feedback:
            fb_copy = dict(fb)
            # Position set high = lower weight in centroid calculation
            fb_copy["position"] = len(merged) + 1
            merged.append(fb_copy)
        return self.expand(library, context_profile, merged)

    def order_by_energy_arc(self, tracks: list[dict], lineup_position: str) -> list[dict]:
        """Reorder tracks to create a natural energy progression."""
        if not tracks:
            return tracks

        sorted_by_energy = sorted(tracks, key=lambda t: t.get("energy", 0.5))

        if lineup_position == "warmup":
            return sorted_by_energy  # ascending

        if lineup_position == "middle":
            return sorted_by_energy  # ascending (gradual build)

        # Headliner: build → peak → cool down
        n = len(sorted_by_energy)
        peak_point = int(n * 0.6)  # peak at ~60%
        build = sorted_by_energy[:peak_point]
        cooldown = list(reversed(sorted_by_energy[peak_point:]))
        return build + cooldown

    def _build_centroid(
        self, liked: list[dict], track_map: dict[int, dict]
    ) -> tuple[np.ndarray, list[str]]:
        """Build weighted centroid from liked seed tracks."""
        vectors: list[np.ndarray] = []
        weights: list[float] = []
        all_genres: list[str] = []
        num_liked = len(liked)

        for fb in liked:
            track = track_map.get(fb["track_id"])
            if track is None:
                continue
            vec = normalize_features(track)
            weight = num_liked - fb.get("position", num_liked) + 1
            vectors.append(vec)
            weights.append(max(weight, 0.5))

            if track.get("genres"):
                for g in track["genres"].split(","):
                    g = g.strip().lower()
                    if g and g not in all_genres:
                        all_genres.append(g)

        if not vectors:
            return np.array([0.5, 0.5, 0.5, 0.5]), []

        weights_arr = np.array(weights)
        weights_arr = weights_arr / weights_arr.sum()
        centroid = np.average(vectors, axis=0, weights=weights_arr)

        return centroid, all_genres

    def _compute_similarity_edges(self, tracks: list[dict]) -> list[dict]:
        """Compute pairwise similarity edges above threshold."""
        if len(tracks) < 2:
            return []

        vectors = [normalize_features(t) for t in tracks]
        edges = []

        for i in range(len(tracks)):
            for j in range(i + 1, len(tracks)):
                sim = cosine_similarity(vectors[i], vectors[j])
                if sim >= self._similarity_threshold:
                    edges.append({
                        "source": tracks[i]["id"],
                        "target": tracks[j]["id"],
                        "weight": round(sim, 3),
                    })

        return edges
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
uv run pytest tests/test_recommend_engine.py -v
```
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add djtoolkit/recommend/engine.py tests/test_recommend_engine.py
git commit -m "feat(recommend): add core engine — seeds, expansion, energy arc, similarity edges"
```

---

## Task 5: Pydantic Models + FastAPI Routes

**Files:**
- Create: `djtoolkit/recommend/models.py`
- Create: `djtoolkit/service/routes/recommend.py`
- Create: `djtoolkit/service/routes/venues.py`
- Modify: `djtoolkit/service/app.py`

- [ ] **Step 1: Write Pydantic models**

```python
# djtoolkit/recommend/models.py
"""Pydantic request/response models for the recommendation API."""

from __future__ import annotations

from pydantic import BaseModel


class SeedRequest(BaseModel):
    venue_id: str | None = None
    mood_preset_id: str | None = None
    lineup_position: str  # warmup | middle | headliner


class SeedFeedbackItem(BaseModel):
    track_id: int
    liked: bool
    position: int


class ExpandRequest(BaseModel):
    session_id: str
    seed_feedback: list[SeedFeedbackItem]


class FeedbackItem(BaseModel):
    track_id: int
    liked: bool


class RefineRequest(BaseModel):
    session_id: str
    feedback: list[FeedbackItem]


class ExportRequest(BaseModel):
    session_id: str
    format: str  # m3u | traktor | rekordbox | csv
    playlist_name: str | None = None


class SimilarityEdge(BaseModel):
    source: int
    target: int
    weight: float


class SeedResponse(BaseModel):
    session_id: str
    context_profile: dict
    seeds: list[dict]
    unanalyzed_count: int


class ExpandResponse(BaseModel):
    tracks: list[dict]
    energy_arc: str
    similarity_edges: list[SimilarityEdge]
```

- [ ] **Step 2: Write venues route handler**

```python
# djtoolkit/service/routes/venues.py
"""API routes for venues and mood presets."""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from djtoolkit.db.supabase_client import get_client
from djtoolkit.service.auth import get_current_user

router = APIRouter()


@router.get("/venues")
async def list_venues(
    country: Optional[str] = None,
    user_id: str = Depends(get_current_user),
):
    client = get_client()
    query = client.table("venues").select("*").order("name")
    if country:
        query = query.ilike("country", country)
    result = query.execute()
    return result.data


@router.get("/venues/{venue_id}")
async def get_venue(
    venue_id: str,
    user_id: str = Depends(get_current_user),
):
    client = get_client()
    result = client.table("venues").select("*").eq("id", venue_id).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Venue not found")
    return result.data[0]


@router.get("/mood-presets")
async def list_mood_presets(
    user_id: str = Depends(get_current_user),
):
    client = get_client()
    result = client.table("mood_presets").select("*").order("category").order("name").execute()
    return result.data
```

- [ ] **Step 3: Write recommend route handler**

```python
# djtoolkit/service/routes/recommend.py
"""API routes for the recommendation engine."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response

from djtoolkit.db.supabase_client import get_client
from djtoolkit.recommend.engine import RecommendationEngine
from djtoolkit.recommend.models import (
    SeedRequest,
    ExpandRequest,
    RefineRequest,
    ExportRequest,
    SeedResponse,
    ExpandResponse,
)
from djtoolkit.recommend.profiles import build_context_profile
from djtoolkit.service.auth import get_current_user

router = APIRouter()
_engine = RecommendationEngine()


def _load_analyzed_library(user_id: str) -> list[dict]:
    """Load all user tracks with relevant feature columns."""
    client = get_client()
    result = (
        client.table("tracks")
        .select("id,title,artist,album,tempo,energy,danceability,loudness,"
                "camelot,key_normalized,genres,enriched_audio,spotify_uri,"
                "cover_art_written,local_path,duration_ms")
        .eq("user_id", user_id)
        .eq("acquisition_status", "available")
        .execute()
    )
    return result.data


@router.post("/recommend/seeds", response_model=SeedResponse)
async def generate_seeds(
    body: SeedRequest,
    user_id: str = Depends(get_current_user),
):
    client = get_client()

    venue_profile = None
    if body.venue_id:
        res = client.table("venues").select("target_profile,genres").eq("id", body.venue_id).execute()
        if not res.data:
            raise HTTPException(status_code=404, detail="Venue not found")
        venue_profile = res.data[0]["target_profile"]
        if res.data[0].get("genres"):
            venue_profile["genres"] = res.data[0]["genres"]

    mood_profile = None
    if body.mood_preset_id:
        res = client.table("mood_presets").select("target_profile").eq("id", body.mood_preset_id).execute()
        if not res.data:
            raise HTTPException(status_code=404, detail="Mood preset not found")
        mood_profile = res.data[0]["target_profile"]

    if not venue_profile and not mood_profile:
        raise HTTPException(status_code=400, detail="Provide venue_id or mood_preset_id")

    context_profile = build_context_profile(venue_profile, mood_profile, body.lineup_position)
    library = _load_analyzed_library(user_id)
    seeds, unanalyzed_count = _engine.generate_seeds(
        library, context_profile, return_unanalyzed_count=True
    )

    # Create session
    session_id = str(uuid.uuid4())
    client.table("recommendation_sessions").insert({
        "id": session_id,
        "user_id": user_id,
        "venue_id": body.venue_id,
        "mood_preset_id": body.mood_preset_id,
        "lineup_position": body.lineup_position,
        "context_profile": context_profile,
    }).execute()

    return SeedResponse(
        session_id=session_id,
        context_profile=context_profile,
        seeds=seeds,
        unanalyzed_count=unanalyzed_count,
    )


@router.post("/recommend/expand", response_model=ExpandResponse)
async def expand_seeds(
    body: ExpandRequest,
    user_id: str = Depends(get_current_user),
):
    client = get_client()

    # Load session
    res = client.table("recommendation_sessions").select("*").eq("id", body.session_id).eq("user_id", user_id).execute()
    if not res.data:
        raise HTTPException(status_code=404, detail="Session not found")
    session = res.data[0]

    # Save feedback to session
    feedback_dicts = [f.model_dump() for f in body.seed_feedback]
    client.table("recommendation_sessions").update({
        "seed_feedback": feedback_dicts
    }).eq("id", body.session_id).execute()

    library = _load_analyzed_library(user_id)
    result = _engine.expand(
        library,
        session["context_profile"],
        feedback_dicts,
    )

    # Order by energy arc
    result["tracks"] = _engine.order_by_energy_arc(
        result["tracks"], session["lineup_position"]
    )

    return ExpandResponse(**result)


@router.post("/recommend/refine", response_model=ExpandResponse)
async def refine_results(
    body: RefineRequest,
    user_id: str = Depends(get_current_user),
):
    client = get_client()

    res = client.table("recommendation_sessions").select("*").eq("id", body.session_id).eq("user_id", user_id).execute()
    if not res.data:
        raise HTTPException(status_code=404, detail="Session not found")
    session = res.data[0]

    library = _load_analyzed_library(user_id)
    original_feedback = session.get("seed_feedback", [])
    new_feedback = [f.model_dump() for f in body.feedback]

    result = _engine.refine(
        library,
        session["context_profile"],
        original_feedback,
        new_feedback,
    )

    result["tracks"] = _engine.order_by_energy_arc(
        result["tracks"], session["lineup_position"]
    )

    return ExpandResponse(**result)


@router.get("/recommend/sessions")
async def list_sessions(
    user_id: str = Depends(get_current_user),
):
    client = get_client()
    result = (
        client.table("recommendation_sessions")
        .select("id,venue_id,mood_preset_id,lineup_position,created_at")
        .eq("user_id", user_id)
        .order("created_at", desc=True)
        .limit(20)
        .execute()
    )
    return result.data


@router.post("/recommend/export")
async def export_playlist(
    body: ExportRequest,
    user_id: str = Depends(get_current_user),
):
    from djtoolkit.adapters.supabase import SupabaseAdapter
    from djtoolkit.adapters.traktor import TraktorExporter
    from djtoolkit.adapters.rekordbox import RekordboxExporter
    from djtoolkit.adapters.m3u import M3UExporter
    from djtoolkit.models.track import Track

    client = get_client()

    if body.format not in ("m3u", "traktor", "rekordbox", "csv"):
        raise HTTPException(status_code=400, detail="Invalid format")

    # Load session to get track list
    res = client.table("recommendation_sessions").select("*").eq("id", body.session_id).eq("user_id", user_id).execute()
    if not res.data:
        raise HTTPException(status_code=404, detail="Session not found")

    # Get recommended track IDs from the last expansion
    # For now, re-run expansion to get track list
    session = res.data[0]
    feedback = session.get("seed_feedback", [])
    if not feedback:
        raise HTTPException(status_code=400, detail="No seed feedback — run expand first")

    library = _load_analyzed_library(user_id)
    result = _engine.expand(library, session["context_profile"], feedback)
    result["tracks"] = _engine.order_by_energy_arc(result["tracks"], session["lineup_position"])

    # Convert dicts to Track objects
    adapter = SupabaseAdapter(client)
    track_ids = [t["id"] for t in result["tracks"]]
    full_rows = client.table("tracks").select("*").in_("id", track_ids).execute()
    tracks = [Track.from_db_row(row) for row in full_rows.data]

    # Reorder tracks to match recommendation order
    track_by_id = {t._id: t for t in tracks}
    ordered_tracks = [track_by_id[tid] for tid in track_ids if tid in track_by_id]

    playlist_name = body.playlist_name or f"Recommendation — {session['lineup_position']}"

    # Save playlist
    playlist_id = str(uuid.uuid4())
    client.table("playlists").insert({
        "id": playlist_id,
        "user_id": user_id,
        "name": playlist_name,
        "session_id": body.session_id,
    }).execute()

    playlist_track_rows = [
        {"playlist_id": playlist_id, "track_id": t._id, "position": i}
        for i, t in enumerate(ordered_tracks) if t._id
    ]
    if playlist_track_rows:
        client.table("playlist_tracks").insert(playlist_track_rows).execute()

    # Export
    if body.format == "traktor":
        data = TraktorExporter().export_with_playlists(ordered_tracks, [(playlist_name, ordered_tracks)])
        return Response(content=data, media_type="application/xml; charset=utf-8",
                        headers={"Content-Disposition": f"attachment; filename={playlist_name}.nml"})
    elif body.format == "rekordbox":
        data = RekordboxExporter().export_with_playlists(ordered_tracks, [(playlist_name, ordered_tracks)])
        return Response(content=data, media_type="application/xml; charset=utf-8",
                        headers={"Content-Disposition": f"attachment; filename={playlist_name}.xml"})
    elif body.format == "m3u":
        data = M3UExporter().export(ordered_tracks, playlist_name)
        return Response(content=data, media_type="audio/x-mpegurl; charset=utf-8",
                        headers={"Content-Disposition": f"attachment; filename={playlist_name}.m3u"})
    else:  # csv
        import csv
        import io
        buf = io.StringIO()
        writer = csv.DictWriter(buf, fieldnames=["position", "playlist_name", "title", "artist", "album", "bpm", "key", "camelot", "genres", "energy", "danceability"])
        writer.writeheader()
        for i, t in enumerate(ordered_tracks):
            writer.writerow({
                "position": i + 1, "playlist_name": playlist_name,
                "title": t.title, "artist": t.artist, "album": t.album,
                "bpm": t.bpm, "key": t.key, "camelot": t.camelot,
                "genres": t.genres, "energy": t.energy, "danceability": t.danceability,
            })
        return Response(content=buf.getvalue(), media_type="text/csv; charset=utf-8",
                        headers={"Content-Disposition": f"attachment; filename={playlist_name}.csv"})
```

- [ ] **Step 4: Register routers in app.py**

Add to `djtoolkit/service/app.py` inside `create_app()`:

```python
from djtoolkit.service.routes.recommend import router as recommend_router
from djtoolkit.service.routes.venues import router as venues_router

app.include_router(recommend_router, tags=["recommend"])
app.include_router(venues_router, tags=["venues"])
```

- [ ] **Step 5: Commit**

```bash
git add djtoolkit/recommend/models.py djtoolkit/service/routes/recommend.py \
        djtoolkit/service/routes/venues.py djtoolkit/service/app.py
git commit -m "feat(api): add recommendation and venues API routes"
```

---

## Task 6: M3U Exporter + Playlist Export Extensions

**Files:**
- Create: `djtoolkit/adapters/m3u.py`
- Create: `tests/test_m3u_exporter.py`
- Create: `tests/test_playlist_export.py`
- Modify: `djtoolkit/adapters/traktor.py`
- Modify: `djtoolkit/adapters/rekordbox.py`

- [ ] **Step 1: Write M3U exporter tests**

```python
# tests/test_m3u_exporter.py
from djtoolkit.adapters.m3u import M3UExporter
from djtoolkit.models.track import Track


def test_m3u_header():
    tracks = [Track(title="Test", artist="Artist", duration_ms=300000, file_path="/music/test.flac")]
    data = M3UExporter().export(tracks, "My Playlist")
    text = data.decode("utf-8")
    assert text.startswith("#EXTM3U\n")
    assert "#PLAYLIST:My Playlist" in text


def test_m3u_track_entries():
    tracks = [
        Track(title="Domino", artist="Oxia", duration_ms=398000, file_path="/music/Oxia - Domino.flac"),
        Track(title="Singularity", artist="Stephan Bodzin", duration_ms=421000, file_path="/music/Bodzin.flac"),
    ]
    data = M3UExporter().export(tracks, "Test")
    text = data.decode("utf-8")
    assert "#EXTINF:398,Oxia - Domino" in text
    assert "/music/Oxia - Domino.flac" in text
    assert "#EXTINF:421,Stephan Bodzin - Singularity" in text


def test_m3u_skips_tracks_without_path():
    tracks = [
        Track(title="Has Path", artist="A", duration_ms=300000, file_path="/music/a.flac"),
        Track(title="No Path", artist="B", duration_ms=300000, file_path=None),
    ]
    data = M3UExporter().export(tracks, "Test")
    text = data.decode("utf-8")
    assert "Has Path" in text
    assert "No Path" not in text
```

- [ ] **Step 2: Implement M3U exporter**

```python
# djtoolkit/adapters/m3u.py
"""M3U playlist exporter."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from djtoolkit.models.track import Track


class M3UExporter:
    """Export tracks as an extended M3U playlist."""

    def export(self, tracks: list[Track], playlist_name: str) -> bytes:
        lines = ["#EXTM3U", f"#PLAYLIST:{playlist_name}"]

        for track in tracks:
            if not track.file_path:
                continue
            duration_sec = track.duration_ms // 1000 if track.duration_ms else 0
            display = f"{track.artist} - {track.title}" if track.artist else track.title
            lines.append(f"#EXTINF:{duration_sec},{display}")
            lines.append(track.file_path)

        lines.append("")  # trailing newline
        return "\n".join(lines).encode("utf-8")
```

- [ ] **Step 3: Run M3U tests**

```bash
uv run pytest tests/test_m3u_exporter.py -v
```
Expected: All PASS

- [ ] **Step 4: Write Traktor/Rekordbox playlist export tests**

```python
# tests/test_playlist_export.py
import xml.etree.ElementTree as ET
from djtoolkit.adapters.traktor import TraktorExporter
from djtoolkit.adapters.rekordbox import RekordboxExporter
from djtoolkit.models.track import Track


def _sample_tracks():
    return [
        Track(title="Domino", artist="Oxia", bpm=128.0, file_path="/music/Oxia - Domino.flac"),
        Track(title="Singularity", artist="Stephan Bodzin", bpm=124.0, file_path="/music/Bodzin.flac"),
    ]


class TestTraktorPlaylistExport:
    def test_export_with_playlists_has_playlists_node(self):
        tracks = _sample_tracks()
        playlists = [("My Set", tracks)]
        data = TraktorExporter().export_with_playlists(tracks, playlists)
        root = ET.fromstring(data)
        pl_node = root.find("PLAYLISTS")
        assert pl_node is not None

    def test_playlist_contains_entries(self):
        tracks = _sample_tracks()
        playlists = [("My Set", tracks)]
        data = TraktorExporter().export_with_playlists(tracks, playlists)
        root = ET.fromstring(data)
        playlist = root.find(".//PLAYLIST")
        assert playlist is not None
        assert int(playlist.get("ENTRIES", "0")) == 2

    def test_plain_export_unchanged(self):
        tracks = _sample_tracks()
        data = TraktorExporter().export(tracks)
        root = ET.fromstring(data)
        assert root.find("PLAYLISTS") is None


class TestRekordboxPlaylistExport:
    def test_export_with_playlists_has_playlists_node(self):
        tracks = _sample_tracks()
        playlists = [("My Set", tracks)]
        data = RekordboxExporter().export_with_playlists(tracks, playlists)
        root = ET.fromstring(data)
        pl_node = root.find("PLAYLISTS")
        assert pl_node is not None

    def test_playlist_contains_track_refs(self):
        tracks = _sample_tracks()
        playlists = [("My Set", tracks)]
        data = RekordboxExporter().export_with_playlists(tracks, playlists)
        root = ET.fromstring(data)
        track_refs = root.findall(".//PLAYLISTS//TRACK")
        assert len(track_refs) == 2

    def test_plain_export_unchanged(self):
        tracks = _sample_tracks()
        data = RekordboxExporter().export(tracks)
        root = ET.fromstring(data)
        assert root.find("PLAYLISTS") is None
```

- [ ] **Step 5: Add `export_with_playlists` to TraktorExporter**

Add this method to `djtoolkit/adapters/traktor.py` in the `TraktorExporter` class:

```python
def export_with_playlists(
    self, tracks: list[Track], playlists: list[tuple[str, list[Track]]]
) -> bytes:
    """Export tracks with playlist structure."""
    import uuid as _uuid

    root = self._build_collection(tracks)

    playlists_node = ET.SubElement(root, "PLAYLISTS")
    root_folder = ET.SubElement(playlists_node, "NODE", TYPE="FOLDER", NAME="$ROOT")
    subnodes = ET.SubElement(root_folder, "SUBNODES", COUNT=str(len(playlists)))

    for name, pl_tracks in playlists:
        pl_node = ET.SubElement(subnodes, "NODE", TYPE="PLAYLIST", NAME=name)
        playlist = ET.SubElement(pl_node, "PLAYLIST",
                                 ENTRIES=str(len(pl_tracks)),
                                 TYPE="LIST",
                                 UUID=str(_uuid.uuid4()))
        for t in pl_tracks:
            entry = ET.SubElement(playlist, "ENTRY")
            key = self._track_key(t)
            ET.SubElement(entry, "PRIMARYKEY", TYPE="TRACK", KEY=key)

    return self._to_bytes(root)
```

This requires refactoring `export()` to extract `_build_collection()`, `_track_key()`, and `_to_bytes()` helper methods. The existing `export()` method delegates to `_build_collection()` + `_to_bytes()` without playlists.

- [ ] **Step 6: Add `export_with_playlists` to RekordboxExporter**

Add this method to `djtoolkit/adapters/rekordbox.py` in the `RekordboxExporter` class:

```python
def export_with_playlists(
    self, tracks: list[Track], playlists: list[tuple[str, list[Track]]]
) -> bytes:
    """Export tracks with playlist structure."""
    root = self._build_collection(tracks)

    # Build track ID lookup
    collection = root.find("COLLECTION")
    track_key_map: dict[str, str] = {}
    if collection is not None:
        for track_el in collection.findall("TRACK"):
            tid = track_el.get("TrackID", "")
            name = track_el.get("Name", "")
            artist = track_el.get("Artist", "")
            track_key_map[f"{artist}|{name}"] = tid

    playlists_node = ET.SubElement(root, "PLAYLISTS")
    root_node = ET.SubElement(playlists_node, "NODE", Type="0", Name="ROOT",
                              Count=str(len(playlists)))

    for name, pl_tracks in playlists:
        pl_node = ET.SubElement(root_node, "NODE", Name=name, Type="1",
                                KeyType="0", Entries=str(len(pl_tracks)))
        for t in pl_tracks:
            key = track_key_map.get(f"{t.artist}|{t.title}", "")
            ET.SubElement(pl_node, "TRACK", Key=key)

    return self._to_bytes(root)
```

Same refactoring pattern: extract `_build_collection()` and `_to_bytes()`.

- [ ] **Step 7: Run all export tests**

```bash
uv run pytest tests/test_m3u_exporter.py tests/test_playlist_export.py -v
```
Expected: All PASS

- [ ] **Step 8: Commit**

```bash
git add djtoolkit/adapters/m3u.py djtoolkit/adapters/traktor.py \
        djtoolkit/adapters/rekordbox.py tests/test_m3u_exporter.py \
        tests/test_playlist_export.py
git commit -m "feat(export): add M3U exporter + playlist sections for Traktor/Rekordbox"
```

---

## Task 7: Web UI — API Client + Types + Navigation

**Files:**
- Modify: `web/lib/api.ts`
- Modify: `web/components/sidebar.tsx`
- Modify: `web/package.json`

- [ ] **Step 1: Add recommendation types and API functions to `web/lib/api.ts`**

Append these types and functions:

```typescript
// --- Recommendation Engine Types ---

export interface Venue {
  id: string;
  name: string;
  type: string;
  city: string;
  country: string;
  address: string | null;
  capacity: number | null;
  sqm: number | null;
  genres: string[];
  mood_tags: string[];
  dj_cabin_style: string | null;
  photo_url: string | null;
  website_url: string | null;
  google_maps_url: string | null;
  google_rating: number | null;
  target_profile: Record<string, unknown>;
}

export interface MoodPreset {
  id: string;
  name: string;
  category: string;
  target_profile: Record<string, unknown>;
}

export interface SimilarityEdge {
  source: number;
  target: number;
  weight: number;
}

export interface SeedResponse {
  session_id: string;
  context_profile: Record<string, unknown>;
  seeds: Track[];
  unanalyzed_count: number;
}

export interface ExpandResponse {
  tracks: Track[];
  energy_arc: string;
  similarity_edges: SimilarityEdge[];
}

export interface SeedFeedback {
  track_id: number;
  liked: boolean;
  position: number;
}

// --- Recommendation Engine API ---

export async function fetchVenues(country?: string): Promise<Venue[]> {
  const qs = country ? `?country=${encodeURIComponent(country)}` : "";
  const res = await apiClient(`/venues${qs}`);
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

export async function fetchVenue(id: string): Promise<Venue> {
  const res = await apiClient(`/venues/${id}`);
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

export async function fetchMoodPresets(): Promise<MoodPreset[]> {
  const res = await apiClient("/mood-presets");
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

export async function generateSeeds(params: {
  venue_id?: string;
  mood_preset_id?: string;
  lineup_position: string;
}): Promise<SeedResponse> {
  const res = await apiClient("/recommend/seeds", {
    method: "POST",
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

export async function expandSeeds(
  session_id: string,
  seed_feedback: SeedFeedback[],
): Promise<ExpandResponse> {
  const res = await apiClient("/recommend/expand", {
    method: "POST",
    body: JSON.stringify({ session_id, seed_feedback }),
  });
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

export async function refineResults(
  session_id: string,
  feedback: { track_id: number; liked: boolean }[],
): Promise<ExpandResponse> {
  const res = await apiClient("/recommend/refine", {
    method: "POST",
    body: JSON.stringify({ session_id, feedback }),
  });
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

export async function exportPlaylist(
  session_id: string,
  format: string,
  playlist_name?: string,
): Promise<Blob> {
  const res = await apiClient("/recommend/export", {
    method: "POST",
    body: JSON.stringify({ session_id, format, playlist_name }),
  });
  if (!res.ok) throw new Error(await extractError(res));
  return res.blob();
}
```

- [ ] **Step 2: Add Recommend nav item to sidebar**

In `web/components/sidebar.tsx`, add a new navigation entry after the existing items. Find the nav items array/list and add:

```tsx
{ href: "/recommend", label: "Recommend", icon: <Sparkles size={18} /> }
```

Import `Sparkles` from `lucide-react`.

- [ ] **Step 3: Install react-force-graph-2d**

```bash
cd web && npm install react-force-graph-2d
```

- [ ] **Step 4: Commit**

```bash
git add web/lib/api.ts web/components/sidebar.tsx web/package.json web/package-lock.json
git commit -m "feat(web): add recommendation API client, types, and nav item"
```

---

## Task 8: Web UI — API Route Proxies

**Files:**
- Create: `web/app/api/venues/route.ts`
- Create: `web/app/api/venues/[id]/route.ts`
- Create: `web/app/api/mood-presets/route.ts`
- Create: `web/app/api/recommend/seeds/route.ts`
- Create: `web/app/api/recommend/expand/route.ts`
- Create: `web/app/api/recommend/refine/route.ts`
- Create: `web/app/api/recommend/export/route.ts`
- Create: `web/app/api/recommend/sessions/route.ts`

These API routes can either proxy to the Hetzner FastAPI service or query Supabase directly. For venues/mood-presets (simple reads), query Supabase directly. For recommendation endpoints, proxy to FastAPI.

- [ ] **Step 1: Create venues route (direct Supabase)**

```typescript
// web/app/api/venues/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";
import { rateLimit, limiters } from "@/lib/api-server/rate-limit";
import { createServiceClient } from "@/lib/supabase/service";

export async function GET(request: NextRequest) {
  const rl = await rateLimit(request, limiters.read);
  if (rl) return rl;
  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  const { searchParams } = request.nextUrl;
  const country = searchParams.get("country");

  const supabase = createServiceClient();
  let query = supabase.from("venues").select("*").order("name");
  if (country) query = query.ilike("country", country);

  const { data, error } = await query;
  if (error) return NextResponse.json({ detail: error.message }, { status: 500 });
  return NextResponse.json(data);
}
```

- [ ] **Step 2: Create venue detail route**

```typescript
// web/app/api/venues/[id]/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";
import { createServiceClient } from "@/lib/supabase/service";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  const { id } = await params;
  const supabase = createServiceClient();
  const { data, error } = await supabase.from("venues").select("*").eq("id", id).single();
  if (error || !data) return NextResponse.json({ detail: "Venue not found" }, { status: 404 });
  return NextResponse.json(data);
}
```

- [ ] **Step 3: Create mood-presets route**

```typescript
// web/app/api/mood-presets/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";
import { createServiceClient } from "@/lib/supabase/service";

export async function GET(request: NextRequest) {
  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("mood_presets")
    .select("*")
    .order("category")
    .order("name");

  if (error) return NextResponse.json({ detail: error.message }, { status: 500 });
  return NextResponse.json(data);
}
```

- [ ] **Step 4: Create recommendation proxy routes**

All recommendation routes proxy to the Hetzner FastAPI service at `DJTOOLKIT_API_URL`:

```typescript
// web/app/api/recommend/seeds/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";
import { rateLimit, limiters } from "@/lib/api-server/rate-limit";

const API_URL = process.env.DJTOOLKIT_API_URL || "https://app.djtoolkit.net";

export async function POST(request: NextRequest) {
  const rl = await rateLimit(request, limiters.write);
  if (rl) return rl;
  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  const body = await request.json();
  const res = await fetch(`${API_URL}/recommend/seeds`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: request.headers.get("Authorization") || "",
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
```

Create identical proxy routes for:
- `web/app/api/recommend/expand/route.ts` → `POST ${API_URL}/recommend/expand`
- `web/app/api/recommend/refine/route.ts` → `POST ${API_URL}/recommend/refine`
- `web/app/api/recommend/export/route.ts` → `POST ${API_URL}/recommend/export` (return blob)
- `web/app/api/recommend/sessions/route.ts` → `GET ${API_URL}/recommend/sessions`

Each follows the same pattern: auth check, proxy request with Authorization header, return response.

- [ ] **Step 5: Commit**

```bash
git add web/app/api/venues/ web/app/api/mood-presets/ web/app/api/recommend/
git commit -m "feat(web): add API route proxies for venues, moods, and recommendation"
```

---

## Task 9: Web UI — Recommend Page + Entry Screen

**Files:**
- Create: `web/app/(app)/recommend/page.tsx`
- Create: `web/components/recommend/EntryScreen.tsx`

- [ ] **Step 1: Create the EntryScreen component**

```tsx
// web/components/recommend/EntryScreen.tsx
"use client";

import { MapPin, Sliders } from "lucide-react";
import { HARDWARE, LED_COLORS, FONTS } from "@/lib/design-system/tokens";

interface EntryScreenProps {
  onSelectVenue: () => void;
  onSelectMood: () => void;
}

export default function EntryScreen({ onSelectVenue, onSelectMood }: EntryScreenProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 24, paddingTop: 80 }}>
      <div style={{ textAlign: "center" }}>
        <h1 style={{ color: HARDWARE.text, fontFamily: FONTS.sans, fontSize: 24, fontWeight: 600, margin: 0 }}>
          Build Your Set
        </h1>
        <p style={{ color: HARDWARE.textDim, fontSize: 14, marginTop: 4 }}>
          Choose how you want to explore your library
        </p>
      </div>
      <div style={{ display: "flex", gap: 16 }}>
        <button
          onClick={onSelectVenue}
          style={{
            background: HARDWARE.panel, border: `2px solid ${LED_COLORS.blue.mid}`,
            borderRadius: 12, padding: 24, width: 280, cursor: "pointer", textAlign: "left",
          }}
        >
          <MapPin size={28} color={LED_COLORS.blue.on} />
          <div style={{ color: HARDWARE.text, fontSize: 16, fontWeight: 600, marginTop: 8 }}>By Venue</div>
          <p style={{ color: HARDWARE.textDim, fontSize: 13, marginTop: 6 }}>
            Pick a club — we'll pre-fill the vibe, genres, and energy based on the venue profile
          </p>
          <div style={{ color: LED_COLORS.blue.on, fontSize: 12, marginTop: 12 }}>
            Spain &middot; Argentina &middot; more coming
          </div>
        </button>
        <button
          onClick={onSelectMood}
          style={{
            background: HARDWARE.panel, border: `2px solid ${LED_COLORS.orange.mid}`,
            borderRadius: 12, padding: 24, width: 280, cursor: "pointer", textAlign: "left",
          }}
        >
          <Sliders size={28} color={LED_COLORS.orange.on} />
          <div style={{ color: HARDWARE.text, fontSize: 16, fontWeight: 600, marginTop: 8 }}>By Vibe &amp; Mood</div>
          <p style={{ color: HARDWARE.textDim, fontSize: 13, marginTop: 6 }}>
            Custom selection — pick mood, energy, genres, and lineup position yourself
          </p>
          <div style={{ color: LED_COLORS.orange.on, fontSize: 12, marginTop: 12 }}>
            Beach &middot; Pool Party &middot; Night Club &middot; Coffee Rave...
          </div>
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create the main page with step management**

```tsx
// web/app/(app)/recommend/page.tsx
"use client";

import { useState, useCallback } from "react";
import { toast } from "sonner";
import EntryScreen from "@/components/recommend/EntryScreen";
import type { Track, SeedResponse, ExpandResponse, SeedFeedback } from "@/lib/api";

type Step = "entry" | "venue" | "mood" | "seeds" | "results";

export default function RecommendPage() {
  const [step, setStep] = useState<Step>("entry");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [seedResponse, setSeedResponse] = useState<SeedResponse | null>(null);
  const [expandResponse, setExpandResponse] = useState<ExpandResponse | null>(null);

  const handleBack = useCallback(() => {
    if (step === "venue" || step === "mood") setStep("entry");
    else if (step === "seeds") setStep(seedResponse ? "venue" : "mood");
    else if (step === "results") setStep("seeds");
  }, [step, seedResponse]);

  return (
    <div className="flex-1 overflow-auto p-6">
      {step !== "entry" && (
        <button
          onClick={handleBack}
          style={{ color: "var(--hw-text-dim)", fontSize: 13, marginBottom: 16, cursor: "pointer", background: "none", border: "none" }}
        >
          &larr; Back
        </button>
      )}

      {step === "entry" && (
        <EntryScreen
          onSelectVenue={() => setStep("venue")}
          onSelectMood={() => setStep("mood")}
        />
      )}

      {step === "venue" && <div>Venue Browser — Task 10</div>}
      {step === "mood" && <div>Mood Selector — Task 10</div>}
      {step === "seeds" && <div>Seed Selection — Task 11</div>}
      {step === "results" && <div>Results + Graph — Task 12</div>}
    </div>
  );
}
```

- [ ] **Step 3: Verify the page renders**

```bash
cd web && npm run dev
```

Open `http://localhost:3000/recommend` — verify the two entry cards render with correct styling.

- [ ] **Step 4: Commit**

```bash
git add web/app/\(app\)/recommend/page.tsx web/components/recommend/EntryScreen.tsx
git commit -m "feat(web): add /recommend page with entry screen"
```

---

## Task 10: Web UI — Venue Browser + Mood Selector

**Files:**
- Create: `web/components/recommend/VenueBrowser.tsx`
- Create: `web/components/recommend/VenueDetail.tsx`
- Create: `web/components/recommend/MoodSelector.tsx`
- Modify: `web/app/(app)/recommend/page.tsx`

- [ ] **Step 1: Create VenueBrowser component**

A searchable, country-filtered list of venues. On venue click, transitions to VenueDetail.

```tsx
// web/components/recommend/VenueBrowser.tsx
"use client";

import { useState, useEffect, useCallback } from "react";
import { Search, Star } from "lucide-react";
import { fetchVenues, type Venue } from "@/lib/api";
import { HARDWARE, LED_COLORS, FONTS } from "@/lib/design-system/tokens";
import { toast } from "sonner";

interface VenueBrowserProps {
  onSelectVenue: (venue: Venue) => void;
}

const COUNTRIES = ["Spain", "Argentina"];

export default function VenueBrowser({ onSelectVenue }: VenueBrowserProps) {
  const [venues, setVenues] = useState<Venue[]>([]);
  const [search, setSearch] = useState("");
  const [country, setCountry] = useState<string>(COUNTRIES[0]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchVenues(country);
      setVenues(data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load venues");
    } finally {
      setLoading(false);
    }
  }, [country]);

  useEffect(() => { load(); }, [load]);

  const filtered = venues.filter(v =>
    !search || v.name.toLowerCase().includes(search.toLowerCase()) ||
    v.city.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div style={{ maxWidth: 600, margin: "0 auto" }}>
      <h2 style={{ color: HARDWARE.text, fontFamily: FONTS.sans, fontSize: 18, marginBottom: 12 }}>
        Select a Venue
      </h2>
      <input
        type="text"
        placeholder="Search venues..."
        value={search}
        onChange={e => setSearch(e.target.value)}
        style={{
          width: "100%", padding: "8px 12px", borderRadius: 8,
          background: HARDWARE.surface, border: `1px solid ${HARDWARE.border}`,
          color: HARDWARE.text, fontSize: 13, marginBottom: 8,
        }}
      />
      <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
        {COUNTRIES.map(c => (
          <button key={c} onClick={() => setCountry(c)} style={{
            padding: "3px 12px", borderRadius: 12, fontSize: 12, cursor: "pointer",
            background: country === c ? LED_COLORS.blue.mid : HARDWARE.raised,
            color: country === c ? "#fff" : HARDWARE.textDim,
            border: "none",
          }}>
            {c}
          </button>
        ))}
      </div>
      {loading ? (
        <p style={{ color: HARDWARE.textDim }}>Loading...</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {filtered.map(v => (
            <button key={v.id} onClick={() => onSelectVenue(v)} style={{
              display: "flex", gap: 12, alignItems: "center", padding: 12,
              background: HARDWARE.surface, border: `1px solid ${HARDWARE.border}`,
              borderRadius: 8, cursor: "pointer", textAlign: "left", width: "100%",
            }}>
              {v.photo_url ? (
                <img src={v.photo_url} alt="" style={{ width: 48, height: 48, borderRadius: 6, objectFit: "cover" }} />
              ) : (
                <div style={{ width: 48, height: 48, borderRadius: 6, background: HARDWARE.raised, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: HARDWARE.textDim }}>
                  {v.type.slice(0, 3).toUpperCase()}
                </div>
              )}
              <div style={{ flex: 1 }}>
                <div style={{ color: HARDWARE.text, fontSize: 14, fontWeight: 600 }}>{v.name}</div>
                <div style={{ color: HARDWARE.textDim, fontSize: 12 }}>
                  {v.city} &middot; {v.type} &middot; {v.capacity ? `${v.capacity} cap` : ""}
                </div>
                <div style={{ display: "flex", gap: 4, marginTop: 4, flexWrap: "wrap" }}>
                  {v.genres?.slice(0, 3).map(g => (
                    <span key={g} style={{
                      background: "rgba(126,255,126,0.1)", color: LED_COLORS.green.on,
                      padding: "1px 6px", borderRadius: 4, fontSize: 10,
                    }}>
                      {g}
                    </span>
                  ))}
                </div>
              </div>
              {v.google_rating && (
                <div style={{ display: "flex", alignItems: "center", gap: 2, color: "#fbbf24", fontSize: 12 }}>
                  <Star size={12} fill="#fbbf24" /> {v.google_rating}
                </div>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Create VenueDetail component**

Shows the selected venue's full profile and lets user pick lineup position, then generate seeds.

```tsx
// web/components/recommend/VenueDetail.tsx
"use client";

import { useState } from "react";
import { Star, ExternalLink } from "lucide-react";
import type { Venue } from "@/lib/api";
import { HARDWARE, LED_COLORS, FONTS } from "@/lib/design-system/tokens";

interface VenueDetailProps {
  venue: Venue;
  onGenerateSeeds: (lineup: string) => void;
  loading: boolean;
}

const LINEUP_OPTIONS = [
  { value: "warmup", label: "Warm-up" },
  { value: "middle", label: "Middle" },
  { value: "headliner", label: "Headliner" },
];

export default function VenueDetail({ venue, onGenerateSeeds, loading }: VenueDetailProps) {
  const [lineup, setLineup] = useState("middle");

  const profile = venue.target_profile as Record<string, number[]>;

  return (
    <div style={{ maxWidth: 500, margin: "0 auto" }}>
      <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
        {venue.photo_url ? (
          <img src={venue.photo_url} alt="" style={{ width: 80, height: 80, borderRadius: 8, objectFit: "cover" }} />
        ) : (
          <div style={{ width: 80, height: 80, borderRadius: 8, background: HARDWARE.raised }} />
        )}
        <div>
          <h2 style={{ color: HARDWARE.text, fontFamily: FONTS.sans, fontSize: 18, margin: 0 }}>{venue.name}</h2>
          {venue.address && <div style={{ color: HARDWARE.textDim, fontSize: 12 }}>{venue.address}</div>}
          <div style={{ color: HARDWARE.textDim, fontSize: 12 }}>{venue.city}, {venue.country}</div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4 }}>
            {venue.google_rating && (
              <span style={{ color: "#fbbf24", fontSize: 12, display: "flex", alignItems: "center", gap: 2 }}>
                <Star size={12} fill="#fbbf24" /> {venue.google_rating}
              </span>
            )}
            <span style={{ color: HARDWARE.textDim, fontSize: 12 }}>
              {venue.type} &middot; {venue.capacity ? `${venue.capacity} ppl` : ""} {venue.sqm ? `&middot; ${venue.sqm} m²` : ""}
            </span>
          </div>
        </div>
      </div>

      <div style={{ borderTop: `1px solid ${HARDWARE.border}`, paddingTop: 12, marginBottom: 16 }}>
        <div style={{ color: LED_COLORS.blue.on, fontSize: 11, textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>
          Pre-filled from venue
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: 12 }}>
          {venue.genres?.length > 0 && (
            <div><span style={{ color: HARDWARE.textDim }}>Genres:</span> <span style={{ color: HARDWARE.text }}>{venue.genres.join(", ")}</span></div>
          )}
          {profile.bpm && (
            <div><span style={{ color: HARDWARE.textDim }}>BPM:</span> <span style={{ color: HARDWARE.text }}>{profile.bpm[0]} – {profile.bpm[1]}</span></div>
          )}
          {profile.energy && (
            <div><span style={{ color: HARDWARE.textDim }}>Energy:</span> <span style={{ color: HARDWARE.text }}>{profile.energy[0]} – {profile.energy[1]}</span></div>
          )}
          {venue.mood_tags?.length > 0 && (
            <div><span style={{ color: HARDWARE.textDim }}>Mood:</span> <span style={{ color: HARDWARE.text }}>{venue.mood_tags.join(", ")}</span></div>
          )}
        </div>
      </div>

      <div style={{ borderTop: `1px solid ${HARDWARE.border}`, paddingTop: 12 }}>
        <div style={{ color: LED_COLORS.orange.on, fontSize: 11, textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>
          Your lineup position
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {LINEUP_OPTIONS.map(opt => (
            <button key={opt.value} onClick={() => setLineup(opt.value)} style={{
              flex: 1, padding: "8px 16px", borderRadius: 8, textAlign: "center", cursor: "pointer",
              background: HARDWARE.surface,
              border: lineup === opt.value ? `2px solid ${LED_COLORS.blue.on}` : `1px solid ${HARDWARE.border}`,
              color: lineup === opt.value ? LED_COLORS.blue.on : HARDWARE.text,
              fontSize: 13,
            }}>
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <button
        onClick={() => onGenerateSeeds(lineup)}
        disabled={loading}
        style={{
          width: "100%", marginTop: 16, padding: "10px 0", borderRadius: 8,
          background: LED_COLORS.blue.on, color: "#fff", fontSize: 14, fontWeight: 600,
          border: "none", cursor: loading ? "wait" : "pointer",
          opacity: loading ? 0.6 : 1,
        }}
      >
        {loading ? "Generating..." : "Generate Seeds \u2192"}
      </button>
    </div>
  );
}
```

- [ ] **Step 3: Create MoodSelector component**

```tsx
// web/components/recommend/MoodSelector.tsx
"use client";

import { useState, useEffect, useCallback } from "react";
import { fetchMoodPresets, type MoodPreset } from "@/lib/api";
import { HARDWARE, LED_COLORS, FONTS } from "@/lib/design-system/tokens";
import { toast } from "sonner";

interface MoodSelectorProps {
  onGenerateSeeds: (moodPresetId: string, lineup: string) => void;
  loading: boolean;
}

const CATEGORY_LABELS: Record<string, string> = {
  beach: "Beach", pool_party: "Pool Party", nightclub: "Nightclub",
  day_party: "Day Party", coffee_rave: "Coffee Rave", afterhours: "Afterhours",
};

const LINEUP_OPTIONS = [
  { value: "warmup", label: "Warm-up" },
  { value: "middle", label: "Middle" },
  { value: "headliner", label: "Headliner" },
];

export default function MoodSelector({ onGenerateSeeds, loading }: MoodSelectorProps) {
  const [presets, setPresets] = useState<MoodPreset[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [lineup, setLineup] = useState("middle");

  const load = useCallback(async () => {
    try {
      const data = await fetchMoodPresets();
      setPresets(data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load moods");
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const grouped = presets.reduce<Record<string, MoodPreset[]>>((acc, p) => {
    (acc[p.category] ??= []).push(p);
    return acc;
  }, {});

  return (
    <div style={{ maxWidth: 500, margin: "0 auto" }}>
      <h2 style={{ color: HARDWARE.text, fontFamily: FONTS.sans, fontSize: 18, marginBottom: 16 }}>
        Select a Mood
      </h2>
      {Object.entries(grouped).map(([cat, items]) => (
        <div key={cat} style={{ marginBottom: 16 }}>
          <div style={{ color: HARDWARE.textDim, fontSize: 11, textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>
            {CATEGORY_LABELS[cat] || cat}
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {items.map(p => (
              <button key={p.id} onClick={() => setSelected(p.id)} style={{
                padding: "8px 16px", borderRadius: 8, cursor: "pointer",
                background: selected === p.id ? LED_COLORS.orange.mid : HARDWARE.surface,
                border: selected === p.id ? `2px solid ${LED_COLORS.orange.on}` : `1px solid ${HARDWARE.border}`,
                color: selected === p.id ? "#fff" : HARDWARE.text,
                fontSize: 13,
              }}>
                {p.name}
              </button>
            ))}
          </div>
        </div>
      ))}

      <div style={{ borderTop: `1px solid ${HARDWARE.border}`, paddingTop: 12, marginTop: 8 }}>
        <div style={{ color: LED_COLORS.orange.on, fontSize: 11, textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>
          Lineup position
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {LINEUP_OPTIONS.map(opt => (
            <button key={opt.value} onClick={() => setLineup(opt.value)} style={{
              flex: 1, padding: "8px 16px", borderRadius: 8, textAlign: "center", cursor: "pointer",
              background: HARDWARE.surface,
              border: lineup === opt.value ? `2px solid ${LED_COLORS.blue.on}` : `1px solid ${HARDWARE.border}`,
              color: lineup === opt.value ? LED_COLORS.blue.on : HARDWARE.text,
              fontSize: 13,
            }}>
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <button
        onClick={() => selected && onGenerateSeeds(selected, lineup)}
        disabled={!selected || loading}
        style={{
          width: "100%", marginTop: 16, padding: "10px 0", borderRadius: 8,
          background: selected ? LED_COLORS.blue.on : HARDWARE.raised,
          color: "#fff", fontSize: 14, fontWeight: 600,
          border: "none", cursor: !selected || loading ? "default" : "pointer",
          opacity: !selected || loading ? 0.5 : 1,
        }}
      >
        {loading ? "Generating..." : "Generate Seeds \u2192"}
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Wire components into the page**

Update `web/app/(app)/recommend/page.tsx` to replace the placeholder `div`s for venue/mood steps with the real components, calling `generateSeeds()` from the API and transitioning to the seeds step on success. The page manages `selectedVenue`, `seedResponse`, `expandResponse` state and passes callbacks down.

- [ ] **Step 5: Commit**

```bash
git add web/components/recommend/VenueBrowser.tsx web/components/recommend/VenueDetail.tsx \
        web/components/recommend/MoodSelector.tsx web/app/\(app\)/recommend/page.tsx
git commit -m "feat(web): add venue browser, venue detail, and mood selector components"
```

---

## Task 11: Web UI — Seed Selection with Drag-and-Drop

**Files:**
- Create: `web/components/recommend/SeedList.tsx`
- Modify: `web/app/(app)/recommend/page.tsx`

- [ ] **Step 1: Create SeedList component**

Uses HTML5 drag-and-drop for reordering. Each row has: drag handle, position, cover art, track info, play preview, like toggle.

```tsx
// web/components/recommend/SeedList.tsx
"use client";

import { useState, useCallback } from "react";
import { GripVertical, Heart, Play, Pause, AlertTriangle } from "lucide-react";
import { usePreviewPlayer } from "@/lib/preview-player-context";
import type { Track } from "@/lib/api";
import { HARDWARE, LED_COLORS, FONTS } from "@/lib/design-system/tokens";

interface SeedListProps {
  seeds: Track[];
  unanalyzedCount: number;
  onExpand: (feedback: { track_id: number; liked: boolean; position: number }[]) => void;
  onRegenerate: () => void;
  loading: boolean;
}

export default function SeedList({ seeds, unanalyzedCount, onExpand, onRegenerate, loading }: SeedListProps) {
  const [items, setItems] = useState(() => seeds.map((s, i) => ({ ...s, liked: true, position: i })));
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const { currentTrackId, isPlaying, play, playUrl, pause } = usePreviewPlayer();

  const toggleLike = useCallback((id: number) => {
    setItems(prev => prev.map(item => item.id === id ? { ...item, liked: !item.liked } : item));
  }, []);

  const handleDragStart = (idx: number) => setDragIdx(idx);

  const handleDrop = (dropIdx: number) => {
    if (dragIdx === null || dragIdx === dropIdx) return;
    setItems(prev => {
      const next = [...prev];
      const [moved] = next.splice(dragIdx, 1);
      next.splice(dropIdx, 0, moved);
      return next;
    });
    setDragIdx(null);
  };

  const handleExpand = () => {
    const feedback = items.map((item, i) => ({
      track_id: item.id,
      liked: item.liked,
      position: i + 1,
    }));
    onExpand(feedback);
  };

  const togglePlay = (track: Track) => {
    if (currentTrackId === track.id && isPlaying) {
      pause();
    } else if (track.spotify_uri) {
      play(track.id, track.spotify_uri);
    } else if (track.preview_url) {
      playUrl(track.id, track.preview_url, { title: track.title, artist: track.artist });
    }
  };

  return (
    <div style={{ maxWidth: 600, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h2 style={{ color: HARDWARE.text, fontFamily: FONTS.sans, fontSize: 18, margin: 0 }}>
          Your Seeds
        </h2>
        {unanalyzedCount > 0 && (
          <div style={{
            display: "flex", alignItems: "center", gap: 4, fontSize: 12,
            color: LED_COLORS.orange.on, background: "rgba(255,224,126,0.1)",
            padding: "4px 10px", borderRadius: 6,
          }}>
            <AlertTriangle size={14} /> {unanalyzedCount} tracks not analyzed
          </div>
        )}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {items.map((item, idx) => (
          <div
            key={item.id}
            draggable
            onDragStart={() => handleDragStart(idx)}
            onDragOver={e => e.preventDefault()}
            onDrop={() => handleDrop(idx)}
            style={{
              display: "flex", alignItems: "center", gap: 10, padding: "8px 12px",
              background: item.liked ? "rgba(126,255,126,0.05)" : HARDWARE.surface,
              border: `1px solid ${item.liked ? "rgba(126,255,126,0.2)" : HARDWARE.border}`,
              borderRadius: 8, opacity: item.liked ? 1 : 0.5,
            }}
          >
            <GripVertical size={16} style={{ color: HARDWARE.textDim, cursor: "grab" }} />
            <span style={{ color: HARDWARE.textDim, fontSize: 12, width: 20, textAlign: "center" }}>{idx + 1}</span>
            <div style={{ width: 36, height: 36, borderRadius: 4, background: HARDWARE.raised, overflow: "hidden" }}>
              {item.artwork_url && <img src={item.artwork_url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ color: HARDWARE.text, fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {item.artist} — {item.title}
              </div>
              <div style={{ color: HARDWARE.textDim, fontSize: 11 }}>
                {item.tempo ? Math.round(item.tempo) : "?"} BPM &middot; {item.key_normalized || "?"} &middot; E {item.energy?.toFixed(2) || "?"}
              </div>
            </div>
            <button onClick={() => togglePlay(item)} style={{ background: "none", border: "none", cursor: "pointer", padding: 4 }}>
              {currentTrackId === item.id && isPlaying
                ? <Pause size={16} color={LED_COLORS.green.on} />
                : <Play size={16} color={HARDWARE.text} />
              }
            </button>
            <button onClick={() => toggleLike(item.id)} style={{ background: "none", border: "none", cursor: "pointer", padding: 4 }}>
              <Heart size={18} color={item.liked ? LED_COLORS.green.on : HARDWARE.textDim} fill={item.liked ? LED_COLORS.green.on : "none"} />
            </button>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 14, justifyContent: "flex-end" }}>
        <button onClick={onRegenerate} style={{
          padding: "8px 16px", borderRadius: 8, cursor: "pointer",
          background: HARDWARE.raised, color: HARDWARE.textDim, border: "none", fontSize: 13,
        }}>
          Regenerate
        </button>
        <button onClick={handleExpand} disabled={loading} style={{
          padding: "8px 16px", borderRadius: 8, cursor: loading ? "wait" : "pointer",
          background: LED_COLORS.blue.on, color: "#fff", border: "none", fontSize: 13, fontWeight: 600,
          opacity: loading ? 0.6 : 1,
        }}>
          {loading ? "Expanding..." : "Expand to 100 \u2192"}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire SeedList into the page**

Update the `seeds` step in `recommend/page.tsx` to render `<SeedList>` with the `seedResponse` data and callbacks.

- [ ] **Step 3: Test drag-and-drop and like toggle in browser**

```bash
cd web && npm run dev
```

Navigate through the full flow: entry → venue → seed list. Verify drag reorder works, like/unlike toggles, and preview plays.

- [ ] **Step 4: Commit**

```bash
git add web/components/recommend/SeedList.tsx web/app/\(app\)/recommend/page.tsx
git commit -m "feat(web): add seed selection with drag-and-drop reorder and like toggle"
```

---

## Task 12: Web UI — Similarity Graph

**Files:**
- Create: `web/components/recommend/SimilarityGraph.tsx`
- Create: `web/components/recommend/EnergyArc.tsx`
- Create: `web/components/recommend/ResultsList.tsx`
- Modify: `web/app/(app)/recommend/page.tsx`

- [ ] **Step 1: Create EnergyArc visualization**

```tsx
// web/components/recommend/EnergyArc.tsx
"use client";

import type { Track } from "@/lib/api";
import { HARDWARE, LED_COLORS } from "@/lib/design-system/tokens";

interface EnergyArcProps {
  tracks: Track[];
}

export default function EnergyArc({ tracks }: EnergyArcProps) {
  if (!tracks.length) return null;

  const maxEnergy = Math.max(...tracks.map(t => t.energy ?? 0), 0.01);

  return (
    <div style={{
      background: HARDWARE.groove, borderRadius: 6, padding: "8px 12px",
      height: 44, display: "flex", alignItems: "flex-end", gap: 1,
    }}>
      {tracks.map((t, i) => {
        const pct = ((t.energy ?? 0) / maxEnergy) * 100;
        const hue = 210 + (pct / 100) * 30; // blue gradient
        return (
          <div key={t.id ?? i} style={{
            flex: 1, height: `${pct}%`, minHeight: 2,
            background: `hsl(${hue}, 70%, ${40 + pct * 0.3}%)`,
            borderRadius: "2px 2px 0 0",
          }} />
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Create SimilarityGraph component**

```tsx
// web/components/recommend/SimilarityGraph.tsx
"use client";

import { useRef, useCallback, useState, useEffect } from "react";
import { Heart, HeartOff, Eye, EyeOff } from "lucide-react";
import { usePreviewPlayer } from "@/lib/preview-player-context";
import type { Track, SimilarityEdge } from "@/lib/api";
import { HARDWARE, LED_COLORS, FONTS } from "@/lib/design-system/tokens";

interface SimilarityGraphProps {
  tracks: Track[];
  edges: SimilarityEdge[];
  seedIds: Set<number>;
  onLike: (trackId: number) => void;
  onDislike: (trackId: number) => void;
}

interface GraphNode {
  id: number;
  name: string;
  artist: string;
  bpm: number;
  camelot: string;
  energy: number;
  artworkUrl?: string;
  isSeed: boolean;
  val: number;
}

interface GraphLink {
  source: number;
  target: number;
  weight: number;
}

export default function SimilarityGraph({ tracks, edges, seedIds, onLike, onDislike }: SimilarityGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [ForceGraph, setForceGraph] = useState<any>(null);
  const [artworkMode, setArtworkMode] = useState(true);
  const [hovered, setHovered] = useState<number | null>(null);
  const { play, playUrl, pause, currentTrackId, isPlaying } = usePreviewPlayer();

  // Dynamic import react-force-graph-2d (client-only)
  useEffect(() => {
    import("react-force-graph-2d").then(mod => setForceGraph(() => mod.default));
  }, []);

  const nodes: GraphNode[] = tracks.map(t => ({
    id: t.id,
    name: t.title,
    artist: t.artist,
    bpm: Math.round(t.tempo ?? 0),
    camelot: t.key_normalized ?? "",
    energy: t.energy ?? 0,
    artworkUrl: t.artwork_url ?? undefined,
    isSeed: seedIds.has(t.id),
    val: seedIds.has(t.id) ? 3 : 1 + (t.energy ?? 0.5),
  }));

  const links: GraphLink[] = edges.map(e => ({
    source: e.source,
    target: e.target,
    weight: e.weight,
  }));

  const handleNodeClick = useCallback((node: GraphNode) => {
    const track = tracks.find(t => t.id === node.id);
    if (!track) return;
    if (currentTrackId === track.id && isPlaying) {
      pause();
    } else if (track.spotify_uri) {
      play(track.id, track.spotify_uri);
    } else if (track.preview_url) {
      playUrl(track.id, track.preview_url, { title: track.title, artist: track.artist });
    }
  }, [tracks, currentTrackId, isPlaying, play, playUrl, pause]);

  const nodeCanvasObject = useCallback((node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
    const size = (node.val ?? 1) * 6;
    const x = node.x ?? 0;
    const y = node.y ?? 0;

    // Seed glow
    if (node.isSeed) {
      ctx.beginPath();
      ctx.arc(x, y, size + 4, 0, 2 * Math.PI);
      ctx.fillStyle = "rgba(59, 130, 246, 0.3)";
      ctx.fill();
    }

    // Node circle
    ctx.beginPath();
    ctx.arc(x, y, size, 0, 2 * Math.PI);
    ctx.fillStyle = node.isSeed ? "#1e40af" : HARDWARE.surface;
    ctx.fill();
    ctx.strokeStyle = node.isSeed ? LED_COLORS.blue.on : LED_COLORS.blue.mid;
    ctx.lineWidth = node.isSeed ? 2 : 1;
    ctx.stroke();

    // Label (if zoomed enough)
    if (globalScale > 1.5) {
      ctx.font = `${Math.max(8, 10 / globalScale)}px ${FONTS.sans}`;
      ctx.textAlign = "center";
      ctx.fillStyle = HARDWARE.text;
      ctx.fillText(node.artist ?? "", x, y + size + 10);
    }
  }, []);

  if (!ForceGraph) return <div style={{ color: HARDWARE.textDim, padding: 20 }}>Loading graph...</div>;

  return (
    <div ref={containerRef} style={{ position: "relative", width: "100%", height: 500 }}>
      <div style={{
        position: "absolute", top: 8, right: 8, zIndex: 10,
        display: "flex", flexDirection: "column", gap: 4,
      }}>
        <button onClick={() => setArtworkMode(!artworkMode)} style={{
          background: "rgba(10,10,20,0.85)", padding: "4px 10px", borderRadius: 6,
          fontSize: 10, color: "#fff", border: "none", cursor: "pointer",
          display: "flex", alignItems: "center", gap: 4,
        }}>
          {artworkMode ? <EyeOff size={12} /> : <Eye size={12} />}
          {artworkMode ? "Clean" : "Artwork"}
        </button>
      </div>

      <ForceGraph
        graphData={{ nodes, links }}
        nodeCanvasObject={nodeCanvasObject}
        linkColor={() => "rgba(59,130,246,0.2)"}
        linkWidth={(link: any) => (link.weight ?? 0.5) * 2}
        onNodeClick={handleNodeClick}
        onNodeHover={(node: any) => setHovered(node?.id ?? null)}
        nodeLabel={(node: any) =>
          `${node.artist} — ${node.name}\n${node.bpm} BPM · ${node.camelot} · E ${node.energy.toFixed(2)}`
        }
        width={containerRef.current?.clientWidth ?? 700}
        height={500}
        backgroundColor={HARDWARE.groove}
        cooldownTime={3000}
      />
    </div>
  );
}
```

- [ ] **Step 3: Create ResultsList component**

A track list shown below the graph with like/dislike and "Re-run with feedback" button.

```tsx
// web/components/recommend/ResultsList.tsx
"use client";

import { useState } from "react";
import { Heart, HeartOff, Play, Pause, RefreshCw, Download } from "lucide-react";
import { usePreviewPlayer } from "@/lib/preview-player-context";
import type { Track } from "@/lib/api";
import EnergyArc from "./EnergyArc";
import { HARDWARE, LED_COLORS, FONTS } from "@/lib/design-system/tokens";

interface ResultsListProps {
  tracks: Track[];
  onRefine: (feedback: { track_id: number; liked: boolean }[]) => void;
  onExport: () => void;
  refining: boolean;
}

export default function ResultsList({ tracks, onRefine, onExport, refining }: ResultsListProps) {
  const [feedback, setFeedback] = useState<Record<number, boolean>>({});
  const { currentTrackId, isPlaying, play, playUrl, pause } = usePreviewPlayer();

  const toggleFeedback = (id: number, liked: boolean) => {
    setFeedback(prev => {
      if (prev[id] === liked) {
        const next = { ...prev };
        delete next[id];
        return next;
      }
      return { ...prev, [id]: liked };
    });
  };

  const handleRefine = () => {
    const fb = Object.entries(feedback).map(([id, liked]) => ({ track_id: Number(id), liked }));
    if (fb.length === 0) return;
    onRefine(fb);
  };

  const togglePlay = (track: Track) => {
    if (currentTrackId === track.id && isPlaying) pause();
    else if (track.spotify_uri) play(track.id, track.spotify_uri);
    else if (track.preview_url) playUrl(track.id, track.preview_url, { title: track.title, artist: track.artist });
  };

  const totalMs = tracks.reduce((sum, t) => sum + (t.duration_ms ?? 0), 0);
  const totalMin = Math.floor(totalMs / 60000);
  const totalHrs = Math.floor(totalMin / 60);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <span style={{ color: HARDWARE.text, fontSize: 14, fontWeight: 600 }}>
          {tracks.length} tracks &middot; {totalHrs}h {totalMin % 60}m
        </span>
        <div style={{ display: "flex", gap: 6 }}>
          {Object.keys(feedback).length > 0 && (
            <button onClick={handleRefine} disabled={refining} style={{
              display: "flex", alignItems: "center", gap: 4,
              padding: "4px 12px", borderRadius: 6, cursor: refining ? "wait" : "pointer",
              background: LED_COLORS.blue.mid, color: "#fff", border: "none", fontSize: 12,
            }}>
              <RefreshCw size={12} /> {refining ? "Refining..." : "Re-run with feedback"}
            </button>
          )}
          <button onClick={onExport} style={{
            display: "flex", alignItems: "center", gap: 4,
            padding: "4px 12px", borderRadius: 6, cursor: "pointer",
            background: LED_COLORS.green.mid, color: "#fff", border: "none", fontSize: 12,
          }}>
            <Download size={12} /> Export Playlist
          </button>
        </div>
      </div>

      <EnergyArc tracks={tracks} />

      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: HARDWARE.textDim, padding: "2px 4px", marginBottom: 8 }}>
        <span>&larr; warm-up</span><span>peak &rarr;</span><span>cool-down &rarr;</span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {tracks.map((t, i) => (
          <div key={t.id} style={{
            display: "flex", alignItems: "center", gap: 8, padding: "5px 8px",
            background: HARDWARE.groove, borderRadius: 4, fontSize: 12,
          }}>
            <span style={{ color: HARDWARE.textDim, width: 24, textAlign: "right" }}>{i + 1}</span>
            <div style={{ flex: 1, color: HARDWARE.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {t.artist} — {t.title}
            </div>
            <span style={{ color: HARDWARE.textDim }}>{Math.round(t.tempo ?? 0)}</span>
            <span style={{ color: HARDWARE.textDim }}>{t.key_normalized || ""}</span>
            <span style={{ color: (t.energy ?? 0) > 0.7 ? LED_COLORS.orange.on : LED_COLORS.green.on }}>
              E {t.energy?.toFixed(2)}
            </span>
            <button onClick={() => togglePlay(t)} style={{ background: "none", border: "none", cursor: "pointer", padding: 2 }}>
              {currentTrackId === t.id && isPlaying
                ? <Pause size={14} color={LED_COLORS.green.on} />
                : <Play size={14} color={HARDWARE.textDim} />
              }
            </button>
            <button onClick={() => toggleFeedback(t.id, true)} style={{ background: "none", border: "none", cursor: "pointer", padding: 2 }}>
              <Heart size={14} color={feedback[t.id] === true ? LED_COLORS.green.on : HARDWARE.textDim}
                     fill={feedback[t.id] === true ? LED_COLORS.green.on : "none"} />
            </button>
            <button onClick={() => toggleFeedback(t.id, false)} style={{ background: "none", border: "none", cursor: "pointer", padding: 2 }}>
              <HeartOff size={14} color={feedback[t.id] === false ? LED_COLORS.red.on : HARDWARE.textDim} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Wire graph + results into the page**

Update the `results` step in `recommend/page.tsx` to render:
1. `<SimilarityGraph>` at the top
2. `<ResultsList>` below

Pass `expandResponse.tracks`, `expandResponse.similarity_edges`, seed IDs, and callbacks.

- [ ] **Step 5: Test the full flow in browser**

```bash
cd web && npm run dev
```

Navigate: Entry → Venue → Select venue → Pick lineup → Generate Seeds → Like/reorder → Expand → View graph + results list.

- [ ] **Step 6: Commit**

```bash
git add web/components/recommend/SimilarityGraph.tsx web/components/recommend/EnergyArc.tsx \
        web/components/recommend/ResultsList.tsx web/app/\(app\)/recommend/page.tsx
git commit -m "feat(web): add similarity graph, energy arc, and results list"
```

---

## Task 13: Web UI — Export Dialog

**Files:**
- Create: `web/components/recommend/ExportDialog.tsx`
- Modify: `web/app/(app)/recommend/page.tsx`

- [ ] **Step 1: Create ExportDialog component**

```tsx
// web/components/recommend/ExportDialog.tsx
"use client";

import { useState } from "react";
import { X, Download } from "lucide-react";
import { exportPlaylist } from "@/lib/api";
import { HARDWARE, LED_COLORS, FONTS } from "@/lib/design-system/tokens";
import { toast } from "sonner";

interface ExportDialogProps {
  sessionId: string;
  defaultName: string;
  onClose: () => void;
}

const FORMATS = [
  { value: "rekordbox", label: "Rekordbox XML", ext: ".xml" },
  { value: "traktor", label: "Traktor NML", ext: ".nml" },
  { value: "m3u", label: "M3U Playlist", ext: ".m3u" },
  { value: "csv", label: "CSV", ext: ".csv" },
];

export default function ExportDialog({ sessionId, defaultName, onClose }: ExportDialogProps) {
  const [name, setName] = useState(defaultName);
  const [format, setFormat] = useState("rekordbox");
  const [exporting, setExporting] = useState(false);

  const handleExport = async () => {
    setExporting(true);
    try {
      const blob = await exportPlaylist(sessionId, format, name);
      const ext = FORMATS.find(f => f.value === format)?.ext || "";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${name}${ext}`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("Playlist exported!");
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Export failed");
    } finally {
      setExporting(false);
    }
  };

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 50,
      display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      <div style={{
        background: HARDWARE.panel, border: `1px solid ${HARDWARE.border}`,
        borderRadius: 12, padding: 24, width: 400,
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <h3 style={{ color: HARDWARE.text, fontFamily: FONTS.sans, fontSize: 16, margin: 0 }}>Export Playlist</h3>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer" }}>
            <X size={18} color={HARDWARE.textDim} />
          </button>
        </div>

        <label style={{ color: HARDWARE.textDim, fontSize: 12, display: "block", marginBottom: 4 }}>Playlist Name</label>
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          style={{
            width: "100%", padding: "8px 12px", borderRadius: 8,
            background: HARDWARE.surface, border: `1px solid ${HARDWARE.border}`,
            color: HARDWARE.text, fontSize: 13, marginBottom: 16,
          }}
        />

        <label style={{ color: HARDWARE.textDim, fontSize: 12, display: "block", marginBottom: 8 }}>Format</label>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 16 }}>
          {FORMATS.map(f => (
            <button key={f.value} onClick={() => setFormat(f.value)} style={{
              display: "flex", alignItems: "center", gap: 8, padding: "8px 12px",
              borderRadius: 8, cursor: "pointer", textAlign: "left",
              background: format === f.value ? LED_COLORS.blue.mid : HARDWARE.surface,
              border: format === f.value ? `2px solid ${LED_COLORS.blue.on}` : `1px solid ${HARDWARE.border}`,
              color: format === f.value ? "#fff" : HARDWARE.text,
              fontSize: 13,
            }}>
              {f.label}
            </button>
          ))}
        </div>

        <button onClick={handleExport} disabled={exporting || !name} style={{
          width: "100%", padding: "10px 0", borderRadius: 8,
          background: LED_COLORS.green.on, color: "#000", fontSize: 14, fontWeight: 600,
          border: "none", cursor: exporting ? "wait" : "pointer",
          opacity: exporting ? 0.6 : 1,
          display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
        }}>
          <Download size={16} /> {exporting ? "Exporting..." : "Download"}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire ExportDialog into the results step**

In `recommend/page.tsx`, add `showExport` state. When `onExport` fires from `ResultsList`, set `showExport = true`. Render `<ExportDialog>` conditionally.

- [ ] **Step 3: Test full end-to-end flow**

```bash
cd web && npm run dev
```

Full flow: Entry → Venue → Seeds → Expand → View graph → Like/dislike → Re-run → Export → Download file.

- [ ] **Step 4: Commit**

```bash
git add web/components/recommend/ExportDialog.tsx web/app/\(app\)/recommend/page.tsx
git commit -m "feat(web): add export dialog with format selection and download"
```

---

## Task 14: Integration Testing + Final Polish

- [ ] **Step 1: Run all Python tests**

```bash
uv run pytest tests/test_recommend_profiles.py tests/test_recommend_scoring.py \
              tests/test_recommend_engine.py tests/test_m3u_exporter.py \
              tests/test_playlist_export.py -v
```
Expected: All PASS

- [ ] **Step 2: Run web lint + build**

```bash
cd web && npm run lint && npm run build
```
Expected: No errors

- [ ] **Step 3: Run Python lint**

```bash
make lint
```
Expected: PASS

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat(recommend): complete recommendation engine v1 — algorithm, API, graph UI, export"
```

---

## Deferred: Discovery (Spec §7)

The spec describes a discovery feature where Spotify Search API finds external tracks based on the context profile. These candidates are shown in a "Discover" section below the graph. Users can import them, and the agent pipeline analyzes them locally before they appear in the graph.

This is a separate sub-feature that depends on the full recommendation flow being complete. It should be implemented as a follow-up plan after this one is done:

- **New component:** `web/components/recommend/DiscoveryPanel.tsx`
- **New API route:** `POST /api/recommend/discover` — takes context profile, searches Spotify
- **Integration:** Below the similarity graph, shows candidate tracks with Spotify preview
- **Import flow:** "Add to library" button triggers existing import pipeline
