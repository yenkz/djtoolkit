-- Migration: Fix RLS advisor lint on trackid_url_cache INSERT policy.
--
-- trackid_url_cache is a shared cache with no user_id column — any authenticated
-- user may read or insert. The previous WITH CHECK (true) is functionally correct
-- but flagged by the Supabase advisor (0013_rls_policy_always_true).
--
-- Replacing WITH CHECK (true) with WITH CHECK (auth.uid() IS NOT NULL) is
-- semantically identical for the 'authenticated' role (auth.uid() is always
-- non-null for authenticated users) while making the intent explicit.

DROP POLICY IF EXISTS trackid_url_cache_insert ON public.trackid_url_cache;

CREATE POLICY trackid_url_cache_insert ON public.trackid_url_cache
    FOR INSERT
    TO authenticated
    WITH CHECK (auth.uid() IS NOT NULL);
