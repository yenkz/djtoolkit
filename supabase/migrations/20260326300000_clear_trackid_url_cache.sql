-- Clear trackid_url_cache so stale results cached at the old 0.7 confidence
-- threshold are re-fetched with the new 0.3 threshold.
TRUNCATE trackid_url_cache;
