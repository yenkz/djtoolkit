-- Add DJ-specific columns to tracks table
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS cue_points JSONB DEFAULT '[]';
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS beatgrid JSONB DEFAULT '[]';
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS key_normalized TEXT;
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS camelot TEXT;
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS rating INTEGER DEFAULT 0;
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS play_count INTEGER DEFAULT 0;
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS comments TEXT;
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS source_id TEXT;
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS file_size INTEGER;
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS sample_rate INTEGER;
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS bitrate INTEGER;

-- Unique constraint for source_id deduplication on import (upsert on_conflict target)
CREATE UNIQUE INDEX IF NOT EXISTS idx_tracks_source_id_user ON tracks (source_id, user_id);

-- Index for Camelot-based harmonic queries
CREATE INDEX IF NOT EXISTS idx_tracks_camelot ON tracks (camelot);

-- Backfill key_normalized from Spotify integer key + mode columns
UPDATE tracks
SET key_normalized = CASE
    WHEN mode = 1 THEN
        CASE key
            WHEN 0 THEN 'C major' WHEN 1 THEN 'Db major' WHEN 2 THEN 'D major'
            WHEN 3 THEN 'Eb major' WHEN 4 THEN 'E major' WHEN 5 THEN 'F major'
            WHEN 6 THEN 'F# major' WHEN 7 THEN 'G major' WHEN 8 THEN 'Ab major'
            WHEN 9 THEN 'A major' WHEN 10 THEN 'Bb major' WHEN 11 THEN 'B major'
        END
    WHEN mode = 0 THEN
        CASE key
            WHEN 0 THEN 'C minor' WHEN 1 THEN 'Db minor' WHEN 2 THEN 'D minor'
            WHEN 3 THEN 'Eb minor' WHEN 4 THEN 'E minor' WHEN 5 THEN 'F minor'
            WHEN 6 THEN 'F# minor' WHEN 7 THEN 'G minor' WHEN 8 THEN 'Ab minor'
            WHEN 9 THEN 'A minor' WHEN 10 THEN 'Bb minor' WHEN 11 THEN 'B minor'
        END
    END
WHERE key IS NOT NULL AND key_normalized IS NULL;

-- Backfill camelot from key_normalized
UPDATE tracks
SET camelot = CASE key_normalized
    WHEN 'Ab minor' THEN '1A' WHEN 'Eb minor' THEN '2A' WHEN 'Bb minor' THEN '3A'
    WHEN 'F minor' THEN '4A' WHEN 'C minor' THEN '5A' WHEN 'G minor' THEN '6A'
    WHEN 'D minor' THEN '7A' WHEN 'A minor' THEN '8A' WHEN 'E minor' THEN '9A'
    WHEN 'B minor' THEN '10A' WHEN 'F# minor' THEN '11A' WHEN 'Db minor' THEN '12A'
    WHEN 'B major' THEN '1B' WHEN 'F# major' THEN '2B' WHEN 'Db major' THEN '3B'
    WHEN 'Ab major' THEN '4B' WHEN 'Eb major' THEN '5B' WHEN 'Bb major' THEN '6B'
    WHEN 'F major' THEN '7B' WHEN 'C major' THEN '8B' WHEN 'G major' THEN '9B'
    WHEN 'D major' THEN '10B' WHEN 'A major' THEN '11B' WHEN 'E major' THEN '12B'
    END
WHERE key_normalized IS NOT NULL AND camelot IS NULL;
