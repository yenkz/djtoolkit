-- Single-query pipeline status RPC — replaces 8 individual count queries.
CREATE OR REPLACE FUNCTION pipeline_status(p_user_id UUID)
RETURNS JSON
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT json_build_object(
    'candidate',   count(*) FILTER (WHERE acquisition_status = 'candidate'),
    'searching',   count(*) FILTER (WHERE acquisition_status = 'searching'),
    'found',       count(*) FILTER (WHERE acquisition_status = 'found'),
    'not_found',   count(*) FILTER (WHERE acquisition_status = 'not_found'),
    'queued',      count(*) FILTER (WHERE acquisition_status = 'queued'),
    'downloading', count(*) FILTER (WHERE acquisition_status = 'downloading'),
    'failed',      count(*) FILTER (WHERE acquisition_status = 'failed'),
    'paused',      count(*) FILTER (WHERE acquisition_status = 'paused')
  )
  FROM tracks
  WHERE user_id = p_user_id;
$$;
