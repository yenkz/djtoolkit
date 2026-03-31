-- The ON CONFLICT (track_id) in chain_pipeline_job() requires a unique
-- constraint on fingerprints.track_id. Only a non-unique btree index existed.
-- Deduplicate first (keep latest row per track_id), then add constraint.

DELETE FROM public.fingerprints f
WHERE EXISTS (
    SELECT 1 FROM public.fingerprints f2
    WHERE f2.track_id = f.track_id AND f2.id > f.id
);

DROP INDEX IF EXISTS public.idx_fingerprints_track_id;
ALTER TABLE public.fingerprints ADD CONSTRAINT uq_fingerprints_track_id UNIQUE (track_id);
