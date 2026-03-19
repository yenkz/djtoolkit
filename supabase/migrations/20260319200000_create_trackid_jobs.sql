-- TrackID.dev job cache (Flow 3)
CREATE TABLE IF NOT EXISTS trackid_jobs (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id),
    youtube_url TEXT NOT NULL,
    job_id TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    tracks_found INTEGER,
    tracks_imported INTEGER,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(user_id, youtube_url)
);

ALTER TABLE trackid_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage their own trackid_jobs"
ON trackid_jobs FOR ALL
USING (auth.uid() = user_id);
