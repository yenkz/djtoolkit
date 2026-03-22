-- Add preview_url column for Spotify 30-second preview URLs
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS preview_url TEXT;
