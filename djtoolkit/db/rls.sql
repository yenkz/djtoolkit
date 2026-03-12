-- djtoolkit Row-Level Security policies
-- Run after pg_schema.sql via Supabase SQL editor.
--
-- Strategy: every API request sets `app.current_user_id` (transaction-local)
-- via SET LOCAL; RLS policies filter on that value.
-- The users table is accessed only via service_role key (bypasses RLS).

-- ─────────────────────────────────────────────────────────────────────────────
-- Role grants  (Supabase built-in roles: anon, authenticated, service_role)
-- ─────────────────────────────────────────────────────────────────────────────
GRANT USAGE ON SCHEMA public TO anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON tracks         TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON fingerprints   TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON pipeline_jobs  TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON agents         TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON track_embeddings TO authenticated;

GRANT USAGE ON SEQUENCE tracks_id_seq        TO authenticated;
GRANT USAGE ON SEQUENCE fingerprints_id_seq  TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- tracks
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE tracks ENABLE ROW LEVEL SECURITY;

CREATE POLICY tracks_isolation ON tracks
    USING (user_id = current_setting('app.current_user_id', true)::UUID)
    WITH CHECK (user_id = current_setting('app.current_user_id', true)::UUID);

-- ─────────────────────────────────────────────────────────────────────────────
-- fingerprints
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE fingerprints ENABLE ROW LEVEL SECURITY;

CREATE POLICY fingerprints_isolation ON fingerprints
    USING (user_id = current_setting('app.current_user_id', true)::UUID)
    WITH CHECK (user_id = current_setting('app.current_user_id', true)::UUID);

-- ─────────────────────────────────────────────────────────────────────────────
-- pipeline_jobs
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE pipeline_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY pipeline_jobs_isolation ON pipeline_jobs
    USING (user_id = current_setting('app.current_user_id', true)::UUID)
    WITH CHECK (user_id = current_setting('app.current_user_id', true)::UUID);

-- ─────────────────────────────────────────────────────────────────────────────
-- agents
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE agents ENABLE ROW LEVEL SECURITY;

CREATE POLICY agents_isolation ON agents
    USING (user_id = current_setting('app.current_user_id', true)::UUID)
    WITH CHECK (user_id = current_setting('app.current_user_id', true)::UUID);

-- ─────────────────────────────────────────────────────────────────────────────
-- track_embeddings  (scoped through the FK to tracks; no direct user_id needed,
-- but we add a policy via JOIN for defence-in-depth)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE track_embeddings ENABLE ROW LEVEL SECURITY;

CREATE POLICY track_embeddings_isolation ON track_embeddings
    USING (
        EXISTS (
            SELECT 1 FROM tracks t
            WHERE t.id = track_embeddings.track_id
              AND t.user_id = current_setting('app.current_user_id', true)::UUID
        )
    );

-- ─────────────────────────────────────────────────────────────────────────────
-- users table — service_role only; no RLS policy
-- (The postgres/service_role connection bypasses RLS automatically)
-- ─────────────────────────────────────────────────────────────────────────────
-- No ENABLE ROW LEVEL SECURITY on users intentionally:
-- all user-table access goes through the service_role key in API middleware.
