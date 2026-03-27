-- Add 'analysis_complete' notification type for per-track audio analysis feedback.

-- 1. Extend the CHECK constraint to allow the new type
ALTER TABLE push_notifications DROP CONSTRAINT push_notifications_type_check;
ALTER TABLE push_notifications ADD CONSTRAINT push_notifications_type_check
    CHECK (type IN ('batch_complete', 'track_failed', 'track_downloaded', 'analysis_complete'));

-- 2. Inject analysis_complete notification into the chain trigger.
--    When audio_analysis succeeds, insert a notification with track details.
--    This is done by replacing the audio_analysis WHEN block in the trigger.
CREATE OR REPLACE FUNCTION chain_pipeline_job()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_track     RECORD;
    v_result    JSONB;
    v_payload   JSONB;
    v_ca_settings JSONB;
    _active_count INTEGER;
    _done_count   INTEGER;
    _failed_count INTEGER;
BEGIN
    -- Only act on status transitions to 'done' or 'failed'
    IF NEW.status NOT IN ('done', 'failed') THEN
        RETURN NEW;
    END IF;

    -- Load the track
    SELECT * INTO v_track FROM tracks WHERE id = NEW.track_id;
    IF NOT FOUND THEN
        RETURN NEW;
    END IF;

    v_result := COALESCE(NEW.result, '{}'::JSONB);

    -- ── SUCCESS ────────────────────────────────────────────────────────────
    IF NEW.status = 'done' THEN

        CASE NEW.job_type

        -- ── DOWNLOAD ────────────────────────────────────────────────────
        WHEN 'download' THEN
            UPDATE tracks SET
                acquisition_status = 'available',
                local_path = COALESCE(v_result ->> 'local_path', local_path)
            WHERE id = NEW.track_id AND user_id = NEW.user_id;
            -- Refresh v_track after update
            SELECT * INTO v_track FROM tracks WHERE id = NEW.track_id;

            IF _is_step_enabled(NEW.user_id, 'fingerprint') THEN
                PERFORM _insert_next_job(
                    NEW.user_id, NEW.track_id, 'fingerprint',
                    jsonb_build_object('local_path', v_track.local_path)
                );
            ELSE
                -- Fingerprint disabled — skip to cover art or metadata
                IF v_track.source != 'exportify' THEN
                    PERFORM _insert_next_job(
                        NEW.user_id, NEW.track_id, 'spotify_lookup',
                        jsonb_build_object(
                            'artist', COALESCE(v_track.artist, ''),
                            'title', COALESCE(v_track.title, ''),
                            'duration_ms', COALESCE(v_track.duration_ms, 0)
                        )
                    );
                ELSE
                    v_payload := _build_metadata_payload(NEW.track_id);
                    IF v_payload IS NOT NULL THEN
                        PERFORM _insert_next_job(NEW.user_id, NEW.track_id, 'metadata', v_payload);
                    END IF;
                END IF;
            END IF;

        -- ── FINGERPRINT ─────────────────────────────────────────────────
        WHEN 'fingerprint' THEN
            -- Insert fingerprint record
            INSERT INTO fingerprints (chromaprint, acoustid, duration_sec, track_id)
            VALUES (
                v_result ->> 'fingerprint',
                v_result ->> 'acoustid',
                (v_result ->> 'duration')::REAL,
                NEW.track_id
            )
            ON CONFLICT (track_id) DO UPDATE SET
                chromaprint  = EXCLUDED.chromaprint,
                acoustid     = EXCLUDED.acoustid,
                duration_sec = EXCLUDED.duration_sec;

            -- Check duplicate
            IF (v_result ->> 'is_duplicate')::BOOLEAN IS TRUE THEN
                UPDATE tracks SET
                    acquisition_status = 'duplicate',
                    fingerprinted = TRUE
                WHERE id = NEW.track_id AND user_id = NEW.user_id;
                RETURN NEW;  -- Stop chain
            END IF;

            UPDATE tracks SET fingerprinted = TRUE
            WHERE id = NEW.track_id AND user_id = NEW.user_id;

            IF v_track.source = 'exportify' THEN
                -- Exportify tracks: cover art → metadata
                IF _is_step_enabled(NEW.user_id, 'cover_art') THEN
                    v_payload := jsonb_build_object(
                        'local_path', v_track.local_path,
                        'artist', COALESCE(v_track.artist, ''),
                        'album', COALESCE(v_track.album, ''),
                        'title', COALESCE(v_track.title, ''),
                        'spotify_uri', COALESCE(v_track.spotify_uri, '')
                    );
                    v_ca_settings := _get_coverart_settings(NEW.user_id);
                    IF v_ca_settings IS NOT NULL THEN
                        v_payload := v_payload || jsonb_build_object('settings', v_ca_settings);
                    END IF;
                    PERFORM _insert_next_job(NEW.user_id, NEW.track_id, 'cover_art', v_payload);
                ELSE
                    v_payload := _build_metadata_payload(NEW.track_id);
                    IF v_payload IS NOT NULL THEN
                        PERFORM _insert_next_job(NEW.user_id, NEW.track_id, 'metadata', v_payload);
                    END IF;
                END IF;
            ELSE
                -- Non-exportify: spotify_lookup first
                PERFORM _insert_next_job(
                    NEW.user_id, NEW.track_id, 'spotify_lookup',
                    jsonb_build_object(
                        'artist', COALESCE(v_track.artist, ''),
                        'title', COALESCE(v_track.title, ''),
                        'duration_ms', COALESCE(v_track.duration_ms, 0),
                        'spotify_uri', COALESCE(v_track.spotify_uri, '')
                    )
                );
            END IF;

        -- ── SPOTIFY LOOKUP ──────────────────────────────────────────────
        WHEN 'spotify_lookup' THEN
            IF (v_result ->> 'matched')::BOOLEAN IS NOT FALSE THEN
                UPDATE tracks SET
                    enriched_spotify = TRUE,
                    album        = COALESCE(v_result ->> 'album',        album),
                    release_date = COALESCE(v_result ->> 'release_date', release_date),
                    year         = COALESCE((v_result ->> 'year')::INT,  year),
                    genres       = COALESCE(v_result ->> 'genres',       genres),
                    record_label = COALESCE(v_result ->> 'record_label', record_label),
                    spotify_uri  = COALESCE(v_result ->> 'spotify_uri',  spotify_uri),
                    artwork_url  = COALESCE(v_result ->> 'artwork_url',  artwork_url),
                    preview_url  = COALESCE(v_result ->> 'preview_url',  preview_url),
                    isrc         = COALESCE(v_result ->> 'isrc',         isrc),
                    popularity   = COALESCE((v_result ->> 'popularity')::INT, popularity)
                WHERE id = NEW.track_id AND user_id = NEW.user_id;
                -- Refresh after update
                SELECT * INTO v_track FROM tracks WHERE id = NEW.track_id;
            END IF;

            IF v_track.source != 'exportify' THEN
                IF _is_step_enabled(NEW.user_id, 'cover_art') THEN
                    v_payload := jsonb_build_object(
                        'local_path', v_track.local_path,
                        'artist', COALESCE(v_track.artist, ''),
                        'album', COALESCE(v_track.album, ''),
                        'title', COALESCE(v_track.title, ''),
                        'spotify_uri', COALESCE(v_track.spotify_uri, '')
                    );
                    v_ca_settings := _get_coverart_settings(NEW.user_id);
                    IF v_ca_settings IS NOT NULL THEN
                        v_payload := v_payload || jsonb_build_object('settings', v_ca_settings);
                    END IF;
                    PERFORM _insert_next_job(NEW.user_id, NEW.track_id, 'cover_art', v_payload);
                ELSE
                    IF _is_step_enabled(NEW.user_id, 'audio_analysis') THEN
                        PERFORM _insert_next_job(
                            NEW.user_id, NEW.track_id, 'audio_analysis',
                            jsonb_build_object(
                                'track_id', NEW.track_id,
                                'local_path', v_track.local_path
                            )
                        );
                    ELSE
                        v_payload := _build_metadata_payload(NEW.track_id);
                        IF v_payload IS NOT NULL THEN
                            PERFORM _insert_next_job(NEW.user_id, NEW.track_id, 'metadata', v_payload);
                        END IF;
                    END IF;
                END IF;
            END IF;

        -- ── COVER ART ───────────────────────────────────────────────────
        WHEN 'cover_art' THEN
            UPDATE tracks SET
                cover_art_written = COALESCE((v_result ->> 'cover_art_written')::BOOLEAN, cover_art_written),
                spotify_uri = COALESCE(v_result ->> 'spotify_uri', spotify_uri)
            WHERE id = NEW.track_id AND user_id = NEW.user_id;

            IF v_track.local_path IS NULL THEN
                RETURN NEW;
            END IF;

            IF v_track.source != 'exportify' THEN
                -- Non-exportify: try audio_analysis, else metadata
                IF _is_step_enabled(NEW.user_id, 'audio_analysis') THEN
                    PERFORM _insert_next_job(
                        NEW.user_id, NEW.track_id, 'audio_analysis',
                        jsonb_build_object(
                            'track_id', NEW.track_id,
                            'local_path', v_track.local_path
                        )
                    );
                ELSE
                    v_payload := _build_metadata_payload(NEW.track_id);
                    IF v_payload IS NOT NULL THEN
                        PERFORM _insert_next_job(NEW.user_id, NEW.track_id, 'metadata', v_payload);
                    END IF;
                END IF;
            ELSE
                -- Exportify: straight to metadata
                v_payload := _build_metadata_payload(NEW.track_id);
                IF v_payload IS NOT NULL THEN
                    PERFORM _insert_next_job(NEW.user_id, NEW.track_id, 'metadata', v_payload);
                END IF;
            END IF;

        -- ── AUDIO ANALYSIS ───────────────────────────────────────────────
        WHEN 'audio_analysis' THEN
            UPDATE tracks SET
                enriched_audio = TRUE,
                tempo       = COALESCE((v_result ->> 'tempo')::REAL,       tempo),
                key         = COALESCE((v_result ->> 'key')::INT,          key),
                mode        = COALESCE((v_result ->> 'mode')::INT,         mode),
                danceability = COALESCE((v_result ->> 'danceability')::REAL, danceability),
                energy      = COALESCE((v_result ->> 'energy')::REAL,      energy),
                loudness    = COALESCE((v_result ->> 'loudness')::REAL,    loudness)
            WHERE id = NEW.track_id AND user_id = NEW.user_id;

            -- Notify: analysis complete for this track
            INSERT INTO push_notifications (user_id, type, title, body, url, data)
            VALUES (
                NEW.user_id,
                'analysis_complete',
                'Analysis complete',
                COALESCE(v_track.artist, '') || ' – ' || COALESCE(v_track.title, '') ||
                    ' — BPM: ' || COALESCE((v_result ->> 'tempo')::TEXT, '?') ||
                    ', Key: ' || COALESCE((v_result ->> 'key')::TEXT, '?'),
                '/catalog',
                jsonb_build_object(
                    'track_id', NEW.track_id,
                    'title', v_track.title,
                    'artist', v_track.artist,
                    'tempo', v_result ->> 'tempo',
                    'key', v_result ->> 'key',
                    'energy', v_result ->> 'energy'
                )
            );

            -- Always queue metadata after audio analysis
            v_payload := _build_metadata_payload(NEW.track_id);
            IF v_payload IS NOT NULL THEN
                PERFORM _insert_next_job(NEW.user_id, NEW.track_id, 'metadata', v_payload);
            END IF;

        -- ── METADATA ─────────────────────────────────────────────────────
        WHEN 'metadata' THEN
            UPDATE tracks SET
                metadata_written = TRUE,
                local_path = COALESCE(v_result ->> 'local_path', local_path)
            WHERE id = NEW.track_id AND user_id = NEW.user_id;

        ELSE
            -- Unknown job type — no-op
            NULL;
        END CASE;

    -- ── FAILURE ──────────────────────────────────────────────────────────
    ELSIF NEW.status = 'failed' THEN

        CASE NEW.job_type

        WHEN 'download' THEN
            IF NEW.retry_count < 3 THEN
                -- Re-queue with incremented retry count
                INSERT INTO pipeline_jobs (
                    id, user_id, track_id, job_type, status,
                    payload, retry_count
                ) VALUES (
                    gen_random_uuid(), NEW.user_id, NEW.track_id, 'download',
                    'pending', NEW.payload, NEW.retry_count + 1
                );
            ELSE
                -- Max retries reached — mark track as failed
                UPDATE tracks SET acquisition_status = 'failed'
                WHERE id = NEW.track_id
                  AND user_id = NEW.user_id
                  AND acquisition_status IN ('candidate', 'downloading');
            END IF;

        WHEN 'audio_analysis' THEN
            -- Audio analysis failed — still queue metadata so pipeline doesn't stall
            v_payload := _build_metadata_payload(NEW.track_id);
            IF v_payload IS NOT NULL THEN
                PERFORM _insert_next_job(NEW.user_id, NEW.track_id, 'metadata', v_payload);
            END IF;

        ELSE
            NULL;
        END CASE;

        -- Track-failed notification for download failures
        IF NEW.job_type = 'download' AND NEW.retry_count >= 3 THEN
            INSERT INTO push_notifications (user_id, type, title, body, url, data)
            VALUES (
                NEW.user_id,
                'track_failed',
                'Download failed',
                COALESCE(v_track.artist, '') || ' – ' || COALESCE(v_track.title, ''),
                '/pipeline',
                jsonb_build_object('track_id', NEW.track_id, 'error', NEW.error)
            );
        END IF;

    END IF;

    -- Batch complete notification: fire when no active jobs remain for this user
    SELECT count(*) INTO _active_count
    FROM pipeline_jobs
    WHERE user_id = NEW.user_id
      AND status IN ('pending', 'claimed', 'running');

    IF _active_count = 0 THEN
        -- Count results from the last 24 hours for the summary
        SELECT
            count(*) FILTER (WHERE status = 'done'),
            count(*) FILTER (WHERE status = 'failed')
        INTO _done_count, _failed_count
        FROM pipeline_jobs
        WHERE user_id = NEW.user_id
          AND completed_at > NOW() - INTERVAL '24 hours';

        INSERT INTO push_notifications (user_id, type, title, body, url, data)
        VALUES (
            NEW.user_id,
            'batch_complete',
            'Pipeline complete',
            _done_count || ' tracks processed (' ||
                _done_count || ' succeeded, ' || _failed_count || ' failed)',
            '/pipeline',
            jsonb_build_object('done', _done_count, 'failed', _failed_count)
        );
    END IF;

    RETURN NEW;
END;
$$;
