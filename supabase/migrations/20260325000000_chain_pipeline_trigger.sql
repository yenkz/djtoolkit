-- Migration: Move pipeline job chaining from Vercel API to PostgreSQL trigger.
--
-- When a pipeline_job status changes to 'done' or 'failed', this trigger
-- atomically updates the track and inserts the next chained job — eliminating
-- the previous failure window where the API could timeout between steps.
--
-- Also creates the user_settings table (needed for step toggles).

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Create user_settings table (referenced by web API, did not exist yet)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_settings (
    user_id  UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    settings JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE user_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_settings_isolation ON user_settings
    USING  (user_id = current_setting('app.current_user_id', true)::UUID)
    WITH CHECK (user_id = current_setting('app.current_user_id', true)::UUID);

GRANT SELECT, INSERT, UPDATE, DELETE ON user_settings TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Helper: check if a pipeline step is enabled for a user
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION _is_step_enabled(
    p_user_id UUID,
    p_step    TEXT        -- 'fingerprint', 'cover_art', 'audio_analysis', 'loudnorm'
) RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE
    v_settings JSONB;
    v_key      TEXT;
    v_default  BOOLEAN;
    v_value    JSONB;
BEGIN
    -- Map step names to setting keys + defaults
    CASE p_step
        WHEN 'fingerprint'     THEN v_key := 'fingerprint_enabled'; v_default := TRUE;
        WHEN 'cover_art'       THEN v_key := 'coverart_enabled';    v_default := TRUE;
        WHEN 'audio_analysis'  THEN v_key := 'analysis_enabled';    v_default := FALSE;
        WHEN 'loudnorm'        THEN v_key := 'loudnorm_enabled';    v_default := FALSE;
        ELSE RETURN TRUE;
    END CASE;

    SELECT us.settings INTO v_settings
    FROM user_settings us
    WHERE us.user_id = p_user_id;

    IF v_settings IS NULL THEN
        RETURN v_default;
    END IF;

    v_value := v_settings -> v_key;
    IF v_value IS NULL OR v_value = 'null'::JSONB THEN
        RETURN v_default;
    END IF;

    -- JSONB boolean: true/false; JSONB string "true"/"false"
    IF jsonb_typeof(v_value) = 'boolean' THEN
        RETURN v_value::TEXT::BOOLEAN;
    END IF;

    RETURN v_default;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Helper: extract coverart_sources from user settings (for cover_art payload)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION _get_coverart_settings(p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE
    v_settings JSONB;
    v_sources  JSONB;
    v_result   JSONB := '{}';
BEGIN
    SELECT us.settings INTO v_settings
    FROM user_settings us
    WHERE us.user_id = p_user_id;

    IF v_settings IS NULL THEN
        RETURN v_result;
    END IF;

    v_sources := v_settings -> 'coverart_sources';
    IF v_sources IS NOT NULL AND v_sources != 'null'::JSONB THEN
        v_result := jsonb_build_object('coverart_sources', v_sources);
    END IF;

    RETURN v_result;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Helper: build metadata job payload from current track state
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION _build_metadata_payload(p_track_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE
    v_track        RECORD;
    v_musical_key  TEXT := '';
    v_meta_source  TEXT;
    KEY_NAMES      TEXT[] := ARRAY['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
BEGIN
    SELECT local_path, title, artist, album, artists,
           year, release_date, genres, record_label, isrc,
           tempo, key, mode, duration_ms,
           enriched_spotify, enriched_audio
    INTO v_track
    FROM tracks
    WHERE id = p_track_id;

    IF v_track.local_path IS NULL THEN
        RETURN NULL;
    END IF;

    -- Camelot key conversion: Spotify key (0-11) + mode (0=minor, 1=major)
    IF v_track.key IS NOT NULL AND v_track.mode IS NOT NULL
       AND v_track.key >= 0 AND v_track.key < 12 THEN
        v_musical_key := KEY_NAMES[v_track.key + 1]
                         || CASE WHEN v_track.mode = 0 THEN 'm' ELSE '' END;
    END IF;

    -- Determine metadata_source
    IF v_track.enriched_spotify THEN
        v_meta_source := 'spotify';
    ELSIF v_track.enriched_audio THEN
        v_meta_source := 'audio-analysis';
    ELSE
        v_meta_source := NULL;
    END IF;

    RETURN jsonb_build_object(
        'track_id',        p_track_id,
        'local_path',      v_track.local_path,
        'title',           COALESCE(v_track.title, ''),
        'artist',          COALESCE(v_track.artist, ''),
        'album',           COALESCE(v_track.album, ''),
        'artists',         COALESCE(v_track.artists, ''),
        'year',            v_track.year,
        'release_date',    COALESCE(v_track.release_date, ''),
        'genres',          COALESCE(v_track.genres, ''),
        'record_label',    COALESCE(v_track.record_label, ''),
        'isrc',            COALESCE(v_track.isrc, ''),
        'bpm',             v_track.tempo,
        'musical_key',     v_musical_key,
        'duration_ms',     v_track.duration_ms,
        'metadata_source', v_meta_source
    );
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Helper: safely insert a pipeline job (no-op if active job already exists)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION _insert_next_job(
    p_user_id  UUID,
    p_track_id BIGINT,
    p_job_type TEXT,
    p_payload  JSONB DEFAULT '{}'
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    INSERT INTO pipeline_jobs (id, user_id, track_id, job_type, status, payload)
    VALUES (gen_random_uuid(), p_user_id, p_track_id, p_job_type, 'pending', p_payload)
    ON CONFLICT (track_id, job_type)
        WHERE status = ANY (ARRAY['pending','claimed','running'])
    DO NOTHING;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Main trigger function
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

    RETURN NEW;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. Create the trigger
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TRIGGER chain_pipeline_job_trigger
    AFTER UPDATE OF status ON pipeline_jobs
    FOR EACH ROW
    WHEN (OLD.status IS DISTINCT FROM NEW.status
          AND NEW.status IN ('done', 'failed'))
    EXECUTE FUNCTION chain_pipeline_job();
