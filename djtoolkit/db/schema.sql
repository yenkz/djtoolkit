-- djtoolkit database schema

CREATE TABLE IF NOT EXISTS tracks (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    acquisition_status TEXT    NOT NULL DEFAULT 'candidate',
                                        -- candidate | downloading | available | failed | duplicate
    source             TEXT    NOT NULL, -- 'exportify' | 'folder'

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
    spotify_uri      TEXT UNIQUE,        -- spotify:track:XXX
    popularity       INTEGER,
    explicit         INTEGER DEFAULT 0,  -- 0/1 boolean
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

    -- Toolkit fields
    search_string    TEXT,
    local_path       TEXT,
    slskd_job_id     TEXT,
    fingerprint_id   INTEGER REFERENCES fingerprints(id),

    -- Processing flags (independent — set when each step completes, 0=pending 1=done)
    fingerprinted    INTEGER NOT NULL DEFAULT 0,
    enriched_spotify INTEGER NOT NULL DEFAULT 0,
    enriched_audio   INTEGER NOT NULL DEFAULT 0,
    metadata_written INTEGER NOT NULL DEFAULT 0,
    normalized       INTEGER NOT NULL DEFAULT 0,
    in_library       INTEGER NOT NULL DEFAULT 0,

    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Auto-update updated_at on any row change
CREATE TRIGGER IF NOT EXISTS tracks_updated_at
AFTER UPDATE ON tracks
BEGIN
    UPDATE tracks SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

CREATE INDEX IF NOT EXISTS idx_tracks_acquisition_status ON tracks(acquisition_status);
CREATE INDEX IF NOT EXISTS idx_tracks_spotify_uri        ON tracks(spotify_uri);
CREATE INDEX IF NOT EXISTS idx_tracks_local_path         ON tracks(local_path);

-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS fingerprints (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id    INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    fingerprint TEXT,                           -- raw Chromaprint string
    acoustid    TEXT,                           -- AcoustID lookup result
    duration    REAL,                           -- actual audio duration in seconds
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_fingerprints_track_id ON fingerprints(track_id);
CREATE INDEX IF NOT EXISTS idx_fingerprints_acoustid  ON fingerprints(acoustid);

-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS track_embeddings (
    track_id   INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
    model      TEXT    NOT NULL,       -- e.g. 'msd-musicnn-1'
    embedding  BLOB    NOT NULL,       -- float32 numpy array as raw bytes
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
