-- Migration: Reduce Disk IO from high-frequency cron and missing index.
--
-- 1. Slow the stale-job sweeper from every 1 minute to every 5 minutes.
--    The sweeper only catches jobs that have been claimed for >5 minutes with no
--    completion, so checking every 5 minutes has no functional difference — a
--    stuck job that's been idle for 5m will be caught at the 5-10m mark instead
--    of the 5-6m mark.
--
-- 2. Add a partial index on pipeline_jobs(claimed_at) WHERE status = 'claimed'.
--    Both UPDATE statements in the sweeper filter on (status = 'claimed' AND
--    claimed_at < NOW() - INTERVAL '5 minutes') — without this index PostgreSQL
--    scans the entire table.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Slow sweeper to every 5 minutes
-- ─────────────────────────────────────────────────────────────────────────────
SELECT cron.unschedule('sweep-stale-jobs');

SELECT cron.schedule(
    'sweep-stale-jobs',
    '*/5 * * * *',
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

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Partial index on claimed_at for sweeper queries
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_pipeline_jobs_claimed_stale
ON pipeline_jobs (claimed_at)
WHERE status = 'claimed';
