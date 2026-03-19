-- djtoolkit PostgreSQL schema (multi-tenant / cloud)
-- Run once via Supabase SQL editor (Settings → SQL Editor)
-- SQLite schema (schema.sql) remains for the local agent.

-- ─────────────────────────────────────────────────────────────────────────────
-- Platform users  (id mirrors auth.users.id from Supabase Auth)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
    id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email                     TEXT UNIQUE NOT NULL,
    -- Spotify OAuth tokens (Fernet-encrypted at rest)
    spotify_access_token      TEXT,
    spotify_refresh_token     TEXT,
    spotify_token_expires_at  TIMESTAMPTZ,
    spotify_user_id           TEXT,
    created_at                TIMESTAMPTZ DEFAULT NOW(),
    updated_at                TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Registered local agents  (one per machine per user)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agents (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    api_key_hash    TEXT NOT NULL,       -- bcrypt hash; key shown to user once as djt_xxx
    api_key_prefix  VARCHAR(8),          -- first 8 chars after djt_ for indexed lookup (non-secret)
    machine_name    TEXT,                -- e.g. "MacBook Pro"
    last_seen_at    TIMESTAMPTZ,
    capabilities    TEXT[],              -- ['aioslsk', 'fpcalc', 'librosa', 'essentia']
    version         TEXT,                -- agent software version, reported via heartbeat
    active_jobs     INTEGER DEFAULT 0,   -- number of jobs currently in progress, reported via heartbeat
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agents_user_id ON agents(user_id);
CREATE INDEX IF NOT EXISTS idx_agents_key_prefix ON agents(api_key_prefix);

-- ─────────────────────────────────────────────────────────────────────────────
-- Fingerprints  (one per audio file, per user)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fingerprints (
    id          BIGSERIAL PRIMARY KEY,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    track_id    BIGINT,                  -- FK set after tracks insert; NOT NULL enforced by app
    fingerprint TEXT,                    -- raw Chromaprint string
    acoustid    TEXT,                    -- AcoustID lookup result
    duration    REAL,                    -- actual audio duration in seconds
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fingerprints_user_id  ON fingerprints(user_id);
CREATE INDEX IF NOT EXISTS idx_fingerprints_track_id ON fingerprints(track_id);
CREATE INDEX IF NOT EXISTS idx_fingerprints_acoustid  ON fingerprints(acoustid);

-- ─────────────────────────────────────────────────────────────────────────────
-- Tracks  (every track in any state, scoped per user)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tracks (
    id                 BIGSERIAL PRIMARY KEY,
    user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    acquisition_status TEXT NOT NULL DEFAULT 'candidate',
                                         -- candidate | searching | found | not_found | queued | downloading | available | failed | duplicate
    source             TEXT NOT NULL,    -- 'exportify' | 'folder' | 'spotify'

    -- Core metadata
    title            TEXT,
    artist           TEXT,               -- primary artist (first in list)
    artists          TEXT,               -- all artists, pipe-separated
    album            TEXT,
    year             INTEGER,
    release_date     TEXT,
    duration_ms      INTEGER,
    isrc             TEXT,
    genres           TEXT,               -- comma-separated
    record_label     TEXT,

    -- Spotify identifiers
    spotify_uri      TEXT,               -- spotify:track:XXX  (unique per user — see constraint below)
    popularity       INTEGER,
    explicit         BOOLEAN DEFAULT FALSE,
    added_by         TEXT,
    added_at         TEXT,

    -- Spotify audio features (preserved from Exportify CSV)
    danceability     REAL,
    energy           REAL,
    key              INTEGER,
    loudness         REAL,
    mode             INTEGER,
    speechiness      REAL,
    acousticness     REAL,
    instrumentalness REAL,
    liveness         REAL,
    valence          REAL,
    tempo            REAL,
    time_signature   INTEGER,

    -- Artwork
    artwork_url      TEXT,               -- album art thumbnail URL (from Spotify)

    -- Toolkit fields
    search_string         TEXT,
    search_results_count  INTEGER DEFAULT NULL,
    local_path       TEXT,               -- reported by agent; machine-local path
    download_job_id  TEXT,
    fingerprint_id   BIGINT REFERENCES fingerprints(id),

    -- Processing flags (0=pending, 1=done — each set independently)
    fingerprinted         BOOLEAN NOT NULL DEFAULT FALSE,
    enriched_spotify      BOOLEAN NOT NULL DEFAULT FALSE,
    enriched_audio        BOOLEAN NOT NULL DEFAULT FALSE,
    metadata_written      BOOLEAN NOT NULL DEFAULT FALSE,
    normalized            BOOLEAN NOT NULL DEFAULT FALSE,
    cover_art_written     BOOLEAN NOT NULL DEFAULT FALSE,
    cover_art_embedded_at TIMESTAMPTZ,
    in_library            BOOLEAN NOT NULL DEFAULT FALSE,
    metadata_source       TEXT,          -- last enrichment source written to file: 'spotify' | 'audio-analysis'

    created_at       TIMESTAMPTZ DEFAULT NOW(),
    updated_at       TIMESTAMPTZ DEFAULT NOW(),

    -- Per-user spotify_uri uniqueness (NULL values are excluded from unique constraints in PG)
    CONSTRAINT tracks_user_spotify_uri_key UNIQUE (user_id, spotify_uri),
    CONSTRAINT tracks_acquisition_status_check CHECK (
        acquisition_status IN (
            'candidate', 'searching', 'found', 'not_found', 'queued',
            'downloading', 'available', 'failed', 'duplicate', 'paused'
        )
    )
);

CREATE INDEX IF NOT EXISTS idx_tracks_user_id            ON tracks(user_id);
CREATE INDEX IF NOT EXISTS idx_tracks_acquisition_status ON tracks(user_id, acquisition_status);
CREATE INDEX IF NOT EXISTS idx_tracks_spotify_uri        ON tracks(user_id, spotify_uri);
CREATE INDEX IF NOT EXISTS idx_tracks_local_path         ON tracks(local_path);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION _set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

CREATE TRIGGER tracks_updated_at
BEFORE UPDATE ON tracks
FOR EACH ROW EXECUTE FUNCTION _set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- Pipeline jobs  (cloud creates, local agent claims and executes)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pipeline_jobs (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    agent_id     UUID REFERENCES agents(id),    -- NULL = any agent for this user
    track_id     BIGINT REFERENCES tracks(id) ON DELETE CASCADE,
    job_type     TEXT NOT NULL,                 -- 'download' | 'fingerprint' | 'metadata' | 'cover_art'
    status       TEXT NOT NULL DEFAULT 'pending',
    priority     INTEGER DEFAULT 0,
    payload      JSONB,                         -- job params: search_string, metadata_source, etc.
    result       JSONB,                         -- agent result: local_path, fingerprint, audio features
    error        TEXT,
    retry_count  INTEGER NOT NULL DEFAULT 0,
    claimed_at   TIMESTAMPTZ,
    started_at   TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at   TIMESTAMPTZ DEFAULT NOW(),

    CONSTRAINT pipeline_jobs_status_check CHECK (
        status IN ('pending','claimed','running','done','failed')
    )
);

CREATE INDEX IF NOT EXISTS idx_pipeline_jobs_user_status
    ON pipeline_jobs(user_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_pipeline_jobs_agent_status
    ON pipeline_jobs(agent_id, status);

-- ─────────────────────────────────────────────────────────────────────────────
-- TrackID import jobs  (async YouTube → track identification)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trackid_import_jobs (
    id          TEXT PRIMARY KEY,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    youtube_url TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'queued',
    progress    INTEGER NOT NULL DEFAULT 0,
    step        TEXT,
    error       TEXT,
    result      JSONB,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW(),

    CONSTRAINT trackid_import_jobs_status_check CHECK (
        status IN ('queued','running','done','failed')
    )
);

CREATE INDEX IF NOT EXISTS idx_trackid_import_jobs_user
    ON trackid_import_jobs(user_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- TrackID URL cache  (avoid re-identifying the same URL)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trackid_url_cache (
    youtube_url  TEXT PRIMARY KEY,
    tracks       JSONB NOT NULL,
    track_count  INTEGER NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Audit logs  (fire-and-forget, written by service role, read-only per user)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_logs (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES auth.users(id),
    action      TEXT NOT NULL,
    resource_type TEXT,
    resource_id TEXT,
    details     JSONB,
    ip_address  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_user    ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- Track embeddings  (optional ML embeddings; isolated via track_id FK)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS track_embeddings (
    track_id   BIGINT PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
    model      TEXT    NOT NULL,                -- e.g. 'msd-musicnn-1'
    embedding  BYTEA   NOT NULL,                -- float32 numpy array as raw bytes
    created_at TIMESTAMPTZ DEFAULT NOW()
);
