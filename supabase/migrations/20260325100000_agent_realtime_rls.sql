-- Migration: Add Supabase Realtime support for agents.
--
-- Agents need to subscribe to pipeline_jobs changes via Supabase Realtime.
-- This requires:
-- 1. A supabase_uid column on agents (links to the machine auth user)
-- 2. An RLS SELECT policy that lets machine users see their owner's jobs

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Add supabase_uid column to agents
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE agents ADD COLUMN IF NOT EXISTS supabase_uid UUID;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. RLS: allow agent machine users to SELECT pipeline_jobs of their owner
--
-- The existing pipeline_jobs_isolation policy uses current_setting('app.current_user_id')
-- which is only set by the service role middleware. For Realtime connections
-- (which authenticate via Supabase Auth JWT), that GUC is NULL, so the existing
-- policy returns no rows. This additive SELECT policy handles the auth.uid() path.
--
-- Multiple policies on the same table/operation are OR'd — a row is visible if
-- ANY policy returns true.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE POLICY pipeline_jobs_agent_realtime ON pipeline_jobs
    FOR SELECT TO authenticated
    USING (
        user_id = auth.uid()
        OR user_id = (
            SELECT a.user_id FROM agents a
            WHERE a.supabase_uid = auth.uid()
            LIMIT 1
        )
    );
