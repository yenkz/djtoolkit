-- Add 'paused' to the acquisition_status CHECK constraint
ALTER TABLE tracks DROP CONSTRAINT IF EXISTS tracks_acquisition_status_check;
ALTER TABLE tracks ADD CONSTRAINT tracks_acquisition_status_check CHECK (
    acquisition_status IN (
        'candidate', 'searching', 'found', 'not_found', 'queued',
        'downloading', 'available', 'failed', 'duplicate', 'paused'
    )
);
