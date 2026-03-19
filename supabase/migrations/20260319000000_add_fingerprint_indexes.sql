-- Hash index for fingerprint dedup lookups (fingerprint strings are too long for B-tree)
CREATE INDEX IF NOT EXISTS idx_fingerprints_fingerprint ON fingerprints USING hash (fingerprint);

-- Index for user-scoped fingerprint queries
CREATE INDEX IF NOT EXISTS idx_fingerprints_user_id ON fingerprints (user_id);

-- Index for library duplicate check (mover.py)
CREATE INDEX IF NOT EXISTS idx_fingerprints_track_id ON fingerprints (track_id);
