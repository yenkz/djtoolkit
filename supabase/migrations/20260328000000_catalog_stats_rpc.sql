-- Single-query catalog stats RPC — replaces 12+ individual count queries.
CREATE OR REPLACE FUNCTION catalog_stats(p_user_id UUID)
RETURNS JSON
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT json_build_object(
    'total', count(*),
    'candidate',       count(*) FILTER (WHERE acquisition_status = 'candidate'),
    'downloading',     count(*) FILTER (WHERE acquisition_status = 'downloading'),
    'available',       count(*) FILTER (WHERE acquisition_status = 'available'),
    'failed',          count(*) FILTER (WHERE acquisition_status = 'failed'),
    'duplicate',       count(*) FILTER (WHERE acquisition_status = 'duplicate'),
    'fingerprinted',   count(*) FILTER (WHERE fingerprinted = TRUE),
    'enriched_spotify', count(*) FILTER (WHERE enriched_spotify = TRUE),
    'enriched_audio',  count(*) FILTER (WHERE enriched_audio = TRUE),
    'metadata_written', count(*) FILTER (WHERE metadata_written = TRUE),
    'cover_art_written', count(*) FILTER (WHERE cover_art_written = TRUE),
    'in_library',      count(*) FILTER (WHERE in_library = TRUE)
  )
  FROM tracks
  WHERE user_id = p_user_id;
$$;
