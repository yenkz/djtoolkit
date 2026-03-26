-- Migration: Atomic job claiming with FOR UPDATE SKIP LOCKED.
--
-- Replaces the two-step SELECT + UPDATE pattern in the API routes with
-- single atomic PostgreSQL functions that eliminate race conditions when
-- multiple agents claim jobs simultaneously.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Batch claim: claim up to N pending jobs of a given type for a user
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION claim_jobs_batch(
    p_user_id  UUID,
    p_job_type TEXT,
    p_agent_id UUID,
    p_limit    INT DEFAULT 50
)
RETURNS SETOF pipeline_jobs
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    RETURN QUERY
    UPDATE pipeline_jobs
    SET status     = 'claimed',
        claimed_at = NOW(),
        agent_id   = p_agent_id
    WHERE id IN (
        SELECT pj.id
        FROM pipeline_jobs pj
        WHERE pj.user_id  = p_user_id
          AND pj.status    = 'pending'
          AND pj.job_type  = p_job_type
        ORDER BY pj.priority DESC, pj.created_at ASC
        LIMIT p_limit
        FOR UPDATE SKIP LOCKED
    )
    RETURNING *;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Single claim: claim one specific job by ID
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION claim_job_by_id(
    p_job_id   UUID,
    p_user_id  UUID,
    p_agent_id UUID
)
RETURNS SETOF pipeline_jobs
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    RETURN QUERY
    UPDATE pipeline_jobs
    SET status     = 'claimed',
        claimed_at = NOW(),
        agent_id   = p_agent_id
    WHERE id IN (
        SELECT pj.id
        FROM pipeline_jobs pj
        WHERE pj.id      = p_job_id
          AND pj.user_id = p_user_id
          AND pj.status  = 'pending'
        FOR UPDATE SKIP LOCKED
    )
    RETURNING *;
END;
$$;
