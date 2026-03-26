-- Migration: Web Push notifications infrastructure.
--
-- 1. push_subscriptions — stores Web Push endpoints (one user, many devices).
-- 2. push_notifications — outbound queue + in-app notification history.
-- 3. Extends chain_pipeline_job() with batch-complete and track-failed
--    notification inserts (appended after existing chaining logic).

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. push_subscriptions
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE push_subscriptions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint    TEXT NOT NULL UNIQUE,
    keys_p256dh TEXT NOT NULL,
    keys_auth   TEXT NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_push_subscriptions_user ON push_subscriptions(user_id);

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

-- Users can read, add, and remove their own subscriptions
CREATE POLICY push_subscriptions_select ON push_subscriptions
    FOR SELECT TO authenticated
    USING (user_id = current_setting('app.current_user_id', true)::UUID);

CREATE POLICY push_subscriptions_insert ON push_subscriptions
    FOR INSERT TO authenticated
    WITH CHECK (user_id = current_setting('app.current_user_id', true)::UUID);

CREATE POLICY push_subscriptions_delete ON push_subscriptions
    FOR DELETE TO authenticated
    USING (user_id = current_setting('app.current_user_id', true)::UUID);

GRANT SELECT, INSERT, DELETE ON push_subscriptions TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. push_notifications
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE push_notifications (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type        TEXT NOT NULL CHECK (type IN ('batch_complete', 'track_failed')),
    title       TEXT NOT NULL,
    body        TEXT NOT NULL,
    url         TEXT,
    data        JSONB,
    read        BOOLEAN DEFAULT FALSE,
    sent        BOOLEAN DEFAULT FALSE,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_push_notifications_user ON push_notifications(user_id, created_at DESC);
CREATE INDEX idx_push_notifications_unsent ON push_notifications(user_id) WHERE sent = FALSE;

ALTER TABLE push_notifications ENABLE ROW LEVEL SECURITY;

-- Users can read their own notifications
CREATE POLICY push_notifications_select ON push_notifications
    FOR SELECT TO authenticated
    USING (user_id = current_setting('app.current_user_id', true)::UUID);

-- Users can update only the read column on their own notifications
CREATE POLICY push_notifications_update ON push_notifications
    FOR UPDATE TO authenticated
    USING (user_id = current_setting('app.current_user_id', true)::UUID)
    WITH CHECK (user_id = current_setting('app.current_user_id', true)::UUID);

-- No INSERT policy for authenticated — inserts come from the trigger
-- (runs as SECURITY DEFINER / superuser) and service_role (bypasses RLS).

GRANT SELECT, UPDATE ON push_notifications TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Extend chain_pipeline_job() — full CREATE OR REPLACE
--    (adds notification logic after existing chaining; all prior logic intact)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION chain_pipeline_job()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_track       RECORD;
    v_fp_id       BIGINT;
    v_dupe_exists BOOLEAN;
    v_payload     JSONB;
    v_ca_settings JSONB;
    v_result      JSONB;
    -- Notification variables
    _active_count  INTEGER;
    _done_count    INTEGER;
    _failed_count  INTEGER;
    _track_title   TEXT;
    _track_artist  TEXT;
BEGIN
    v_result := COALESCE(NEW.result, '{}'::JSONB);

    -- ── SUCCESS ──────────────────────────────────────────────────────────
    IF NEW.status = 'done' THEN

        CASE NEW.job_type

        -- ── DOWNLOAD ─────────────────────────────────────────────────────
        WHEN 'download' THEN
            -- Update track to available
            IF v_result ->> 'local_path' IS NULL THEN
                RETURN NEW;
            END IF;

            UPDATE tracks SET
                acquisition_status = 'available',
                local_path = v_result ->> 'local_path'
            WHERE id = NEW.track_id AND user_id = NEW.user_id;

            -- Chain: fingerprint (if enabled) or skip ahead
            IF _is_step_enabled(NEW.user_id, 'fingerprint') THEN
                PERFORM _insert_next_job(
                    NEW.user_id, NEW.track_id, 'fingerprint',
                    jsonb_build_object(
                        'track_id', NEW.track_id,
                        'local_path', v_result ->> 'local_path'
                    )
                );
            ELSE
                -- Fingerprint disabled — branch by source
                SELECT source, local_path, artist, album, title,
                       spotify_uri, duration_ms
                INTO v_track
                FROM tracks WHERE id = NEW.track_id;

                IF v_track.local_path IS NOT NULL THEN
                    IF v_track.source = 'exportify' THEN
                        -- Exportify: try cover_art, else metadata
                        IF _is_step_enabled(NEW.user_id, 'cover_art') THEN
                            v_ca_settings := _get_coverart_settings(NEW.user_id);
                            v_payload := jsonb_build_object(
                                'track_id', NEW.track_id,
                                'local_path', v_track.local_path,
                                'artist', COALESCE(v_track.artist, ''),
                                'album', COALESCE(v_track.album, ''),
                                'title', COALESCE(v_track.title, ''),
                                'spotify_uri', v_track.spotify_uri
                            );
                            IF v_ca_settings != '{}'::JSONB THEN
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
                        -- Non-exportify: always spotify_lookup
                        PERFORM _insert_next_job(
                            NEW.user_id, NEW.track_id, 'spotify_lookup',
                            jsonb_build_object(
                                'track_id', NEW.track_id,
                                'artist', COALESCE(v_track.artist, ''),
                                'title', COALESCE(v_track.title, ''),
                                'duration_ms', v_track.duration_ms,
                                'spotify_uri', v_track.spotify_uri
                            )
                        );
                    END IF;
                END IF;
            END IF;

        -- ── FINGERPRINT ──────────────────────────────────────────────────
        WHEN 'fingerprint' THEN
            IF v_result ->> 'fingerprint' IS NULL THEN
                RETURN NEW;
            END IF;

            -- Insert fingerprint record
            INSERT INTO fingerprints (user_id, track_id, fingerprint, acoustid, duration)
            VALUES (
                NEW.user_id,
                NEW.track_id,
                v_result ->> 'fingerprint',
                v_result ->> 'acoustid',
                (v_result ->> 'duration')::REAL
            )
            RETURNING id INTO v_fp_id;

            -- Duplicate check: exact Chromaprint match against in_library tracks
            SELECT EXISTS (
                SELECT 1
                FROM fingerprints f
                JOIN tracks t ON t.id = f.track_id
                WHERE f.user_id = NEW.user_id
                  AND f.fingerprint = v_result ->> 'fingerprint'
                  AND f.id != v_fp_id
                  AND t.in_library = TRUE
            ) INTO v_dupe_exists;

            IF v_dupe_exists THEN
                UPDATE tracks SET
                    acquisition_status = 'duplicate',
                    fingerprinted = TRUE,
                    fingerprint_id = v_fp_id
                WHERE id = NEW.track_id;
                -- Pipeline stops for duplicates
                RETURN NEW;
            END IF;

            -- Not a duplicate — mark fingerprinted and chain next step
            UPDATE tracks SET
                fingerprinted = TRUE,
                fingerprint_id = v_fp_id
            WHERE id = NEW.track_id;

            SELECT source, local_path, artist, album, title,
                   spotify_uri, duration_ms
            INTO v_track
            FROM tracks WHERE id = NEW.track_id;

            IF v_track.local_path IS NULL THEN
                RETURN NEW;
            END IF;

            IF v_track.source = 'exportify' THEN
                -- Exportify: try cover_art, else metadata
                IF _is_step_enabled(NEW.user_id, 'cover_art') THEN
                    v_ca_settings := _get_coverart_settings(NEW.user_id);
                    v_payload := jsonb_build_object(
                        'track_id', NEW.track_id,
                        'local_path', v_track.local_path,
                        'artist', COALESCE(v_track.artist, ''),
                        'album', COALESCE(v_track.album, ''),
                        'title', COALESCE(v_track.title, ''),
                        'spotify_uri', v_track.spotify_uri
                    );
                    IF v_ca_settings != '{}'::JSONB THEN
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
                -- Non-exportify: always spotify_lookup
                PERFORM _insert_next_job(
                    NEW.user_id, NEW.track_id, 'spotify_lookup',
                    jsonb_build_object(
                        'track_id', NEW.track_id,
                        'artist', COALESCE(v_track.artist, ''),
                        'title', COALESCE(v_track.title, ''),
                        'duration_ms', v_track.duration_ms,
                        'spotify_uri', v_track.spotify_uri
                    )
                );
            END IF;

        -- ── SPOTIFY LOOKUP ───────────────────────────────────────────────
        WHEN 'spotify_lookup' THEN
            -- Write metadata to tracks (if match found)
            IF v_result ->> 'matched' IS DISTINCT FROM 'false' THEN
                UPDATE tracks SET
                    enriched_spotify = TRUE,
                    spotify_uri    = COALESCE(v_result ->> 'spotify_uri',    spotify_uri),
                    album          = COALESCE(v_result ->> 'album',          album),
                    release_date   = COALESCE(v_result ->> 'release_date',   release_date),
                    year           = COALESCE((v_result ->> 'year')::INT,    year),
                    genres         = COALESCE(v_result ->> 'genres',         genres),
                    record_label   = COALESCE(v_result ->> 'record_label',   record_label),
                    popularity     = COALESCE((v_result ->> 'popularity')::INT, popularity),
                    explicit       = COALESCE((v_result ->> 'explicit')::BOOLEAN, explicit),
                    isrc           = COALESCE(v_result ->> 'isrc',           isrc),
                    duration_ms    = COALESCE((v_result ->> 'duration_ms')::INT, duration_ms)
                WHERE id = NEW.track_id AND user_id = NEW.user_id;
            END IF;

            -- Always try to queue cover_art (even on no-match)
            SELECT local_path, artist, album, title, spotify_uri
            INTO v_track
            FROM tracks WHERE id = NEW.track_id;

            IF v_track.local_path IS NOT NULL THEN
                IF _is_step_enabled(NEW.user_id, 'cover_art') THEN
                    v_ca_settings := _get_coverart_settings(NEW.user_id);
                    v_payload := jsonb_build_object(
                        'track_id', NEW.track_id,
                        'local_path', v_track.local_path,
                        'artist', COALESCE(v_track.artist, ''),
                        'album', COALESCE(v_track.album, ''),
                        'title', COALESCE(v_track.title, ''),
                        'spotify_uri', v_track.spotify_uri
                    );
                    IF v_ca_settings != '{}'::JSONB THEN
                        v_payload := v_payload || jsonb_build_object('settings', v_ca_settings);
                    END IF;
                    PERFORM _insert_next_job(NEW.user_id, NEW.track_id, 'cover_art', v_payload);
                ELSE
                    -- Cover art disabled — skip to next non-exportify step
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

        -- ── COVER ART ────────────────────────────────────────────────────
        WHEN 'cover_art' THEN
            IF (v_result ->> 'cover_art_written')::BOOLEAN IS TRUE THEN
                UPDATE tracks SET
                    cover_art_written = TRUE,
                    cover_art_embedded_at = NOW()
                WHERE id = NEW.track_id AND user_id = NEW.user_id;
            END IF;

            -- Persist discovered spotify_uri back to track
            IF v_result ->> 'spotify_uri' IS NOT NULL THEN
                UPDATE tracks SET
                    spotify_uri = v_result ->> 'spotify_uri'
                WHERE id = NEW.track_id
                  AND user_id = NEW.user_id
                  AND spotify_uri IS NULL;
            END IF;

            SELECT source, local_path
            INTO v_track
            FROM tracks WHERE id = NEW.track_id;

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
                    gen_random_uuid(), NEW.user_id, NEW.track_id, 'download', 'pending',
                    NEW.payload, NEW.retry_count + 1
                )
                ON CONFLICT (track_id, job_type)
                    WHERE status = ANY (ARRAY['pending','claimed','running'])
                DO NOTHING;
            ELSE
                -- Max retries exceeded — mark track failed
                -- (only if not already promoted to 'available' by a parallel chain)
                UPDATE tracks SET
                    acquisition_status = 'failed'
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
            -- Other failures: no automatic action
            NULL;
        END CASE;

    END IF;

    -- ── NOTIFICATIONS ────────────────────────────────────────────────────
    -- After all chaining logic, generate push notifications.
    -- The trigger WHEN clause guarantees NEW.status IN ('done','failed').

    -- Track failed notification
    IF NEW.status = 'failed' THEN
        SELECT title, artist INTO _track_title, _track_artist
        FROM tracks WHERE id = NEW.track_id;

        INSERT INTO push_notifications (user_id, type, title, body, url, data)
        VALUES (
            NEW.user_id,
            'track_failed',
            'Track failed',
            COALESCE(_track_artist, 'Unknown') || ' - ' || COALESCE(_track_title, 'Unknown') ||
                ': ' || NEW.job_type || ' failed',
            '/pipeline',
            jsonb_build_object('track_id', NEW.track_id, 'job_type', NEW.job_type,
                               'error', NEW.result ->> 'error')
        );
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

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Database webhook: push_notifications INSERT → push-send Edge Function
-- ─────────────────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pg_net SCHEMA extensions;

CREATE OR REPLACE FUNCTION notify_push_send()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  PERFORM net.http_post(
    url := 'https://wpjrzpsfssyzjgfzcmvf.supabase.co/functions/v1/push-send',
    body := jsonb_build_object(
      'type', 'INSERT',
      'table', 'push_notifications',
      'schema', 'public',
      'record', row_to_json(NEW)::jsonb,
      'old_record', NULL
    ),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('supabase.service_role_key', true)
    )
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER push_notifications_webhook
AFTER INSERT ON push_notifications
FOR EACH ROW
EXECUTE FUNCTION notify_push_send();
