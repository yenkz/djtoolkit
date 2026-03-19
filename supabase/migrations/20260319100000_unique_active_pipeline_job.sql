-- Prevent duplicate active jobs: only one pending/claimed/running job per track+type
CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_jobs_active_per_track
ON pipeline_jobs (track_id, job_type)
WHERE status IN ('pending', 'claimed', 'running');
