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
