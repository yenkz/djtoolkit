-- Migration: Add track_id index + retry-capped stale job sweeper.
--
-- 1. Plain index on pipeline_jobs.track_id for history queries and joins.
-- 2. Updated sweep-stale-jobs cron: jobs with retry_count >= 3 are marked
--    failed instead of being re-queued indefinitely.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Index on track_id
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_pipeline_jobs_track_id
ON pipeline_jobs (track_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Replace stale job sweeper with retry-capped version
-- ─────────────────────────────────────────────────────────────────────────────
SELECT cron.unschedule('sweep-stale-jobs');

SELECT cron.schedule(
    'sweep-stale-jobs',
    '* * * * *',
    $$
    -- Reset stale claimed jobs that still have retries left
    UPDATE pipeline_jobs
    SET status = 'pending', claimed_at = NULL, agent_id = NULL
    WHERE status = 'claimed'
      AND claimed_at < NOW() - INTERVAL '5 minutes'
      AND retry_count < 3;

    -- Mark stale claimed jobs that exhausted retries as failed
    UPDATE pipeline_jobs
    SET status = 'failed',
        error = 'Max retries exceeded (agent crashed repeatedly)',
        completed_at = NOW()
    WHERE status = 'claimed'
      AND claimed_at < NOW() - INTERVAL '5 minutes'
      AND retry_count >= 3;
    $$
);
