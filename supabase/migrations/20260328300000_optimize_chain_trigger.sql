-- Migration: Reduce Disk IO from chain_pipeline_job trigger.
--
-- Changes:
--
-- 1. Add composite index on pipeline_jobs(user_id, status) so the batch_complete
--    count(*) query is an index scan instead of a table scan.
--
-- 2. Pin search_path = '' on helper functions (_get_coverart_settings,
--    _build_metadata_payload, _insert_next_job) and schema-qualify their table
--    references, fixing Supabase advisor lint 0011 on those functions.
--
-- 3. Rewrite chain_pipeline_job() to:
--    a. Load user_settings ONCE at the top and inline the step-enabled flags,
--       replacing 2–3 separate user_settings queries per invocation with one.
--    b. Restrict the batch_complete count(*) check to terminal events only
--       (metadata done, or any failed job), eliminating ~80% of those count
--       queries for typical 5-stage pipelines.
--    c. Apply SET search_path = '' and schema-qualify all table references.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Composite index for batch_complete count query
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_pipeline_jobs_user_status
ON public.pipeline_jobs (user_id, status);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Fix search_path on helper functions
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._get_coverart_settings(p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_settings JSONB;
    v_sources  JSONB;
    v_result   JSONB := '{}';
BEGIN
    SELECT us.settings INTO v_settings
    FROM public.user_settings us
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

CREATE OR REPLACE FUNCTION public._build_metadata_payload(p_track_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
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
    FROM public.tracks
    WHERE id = p_track_id;

    IF v_track.local_path IS NULL THEN
        RETURN NULL;
    END IF;

    IF v_track.key IS NOT NULL AND v_track.mode IS NOT NULL
       AND v_track.key >= 0 AND v_track.key < 12 THEN
        v_musical_key := KEY_NAMES[v_track.key + 1]
                         || CASE WHEN v_track.mode = 0 THEN 'm' ELSE '' END;
    END IF;

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

CREATE OR REPLACE FUNCTION public._insert_next_job(
    p_user_id  UUID,
    p_track_id BIGINT,
    p_job_type TEXT,
    p_payload  JSONB DEFAULT '{}'
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    INSERT INTO public.pipeline_jobs (id, user_id, track_id, job_type, status, payload)
    VALUES (gen_random_uuid(), p_user_id, p_track_id, p_job_type, 'pending', p_payload)
    ON CONFLICT (track_id, job_type)
        WHERE status = ANY (ARRAY['pending','claimed','running'])
    DO NOTHING;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Optimised chain_pipeline_job trigger function
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.chain_pipeline_job()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_track        RECORD;
    v_result       JSONB;
    v_payload      JSONB;
    -- User settings loaded once
    v_settings     JSONB;
    v_fp_enabled   BOOLEAN;
    v_ca_enabled   BOOLEAN;
    v_aa_enabled   BOOLEAN;
    v_ca_sources   JSONB;
    -- Batch complete counters
    _active_count  INTEGER;
    _done_count    INTEGER;
    _failed_count  INTEGER;
BEGIN
    IF NEW.status NOT IN ('done', 'failed') THEN
        RETURN NEW;
    END IF;

    -- Load the track
    SELECT * INTO v_track FROM public.tracks WHERE id = NEW.track_id;
    IF NOT FOUND THEN RETURN NEW; END IF;

    v_result := COALESCE(NEW.result, '{}'::JSONB);

    -- Load user settings once — replaces 2-3 separate _is_step_enabled /
    -- _get_coverart_settings queries per invocation
    SELECT us.settings INTO v_settings
    FROM public.user_settings us
    WHERE us.user_id = NEW.user_id;

    v_fp_enabled := COALESCE((v_settings -> 'fingerprint_enabled')::BOOLEAN, TRUE);
    v_ca_enabled := COALESCE((v_settings -> 'coverart_enabled')::BOOLEAN,    TRUE);
    v_aa_enabled := COALESCE((v_settings -> 'analysis_enabled')::BOOLEAN,    FALSE);

    -- Cover art sources setting (NULL if not configured)
    IF v_settings IS NOT NULL AND v_settings -> 'coverart_sources' IS NOT NULL
       AND v_settings -> 'coverart_sources' != 'null'::JSONB THEN
        v_ca_sources := jsonb_build_object('coverart_sources', v_settings -> 'coverart_sources');
    END IF;

    -- ── SUCCESS ────────────────────────────────────────────────────────────
    IF NEW.status = 'done' THEN

        CASE NEW.job_type

        -- ── DOWNLOAD ──────────────────────────────────────────────────────
        WHEN 'download' THEN
            UPDATE public.tracks SET
                acquisition_status = 'available',
                local_path = COALESCE(v_result ->> 'local_path', local_path)
            WHERE id = NEW.track_id AND user_id = NEW.user_id;
            -- Refresh to pick up updated local_path
            SELECT * INTO v_track FROM public.tracks WHERE id = NEW.track_id;

            IF v_fp_enabled THEN
                PERFORM public._insert_next_job(
                    NEW.user_id, NEW.track_id, 'fingerprint',
                    jsonb_build_object('local_path', v_track.local_path)
                );
            ELSIF v_track.source != 'exportify' THEN
                PERFORM public._insert_next_job(
                    NEW.user_id, NEW.track_id, 'spotify_lookup',
                    jsonb_build_object(
                        'artist',      COALESCE(v_track.artist, ''),
                        'title',       COALESCE(v_track.title, ''),
                        'duration_ms', COALESCE(v_track.duration_ms, 0)
                    )
                );
            ELSE
                v_payload := public._build_metadata_payload(NEW.track_id);
                IF v_payload IS NOT NULL THEN
                    PERFORM public._insert_next_job(NEW.user_id, NEW.track_id, 'metadata', v_payload);
                END IF;
            END IF;

        -- ── FINGERPRINT ───────────────────────────────────────────────────
        WHEN 'fingerprint' THEN
            INSERT INTO public.fingerprints (chromaprint, acoustid, duration_sec, track_id)
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

            IF (v_result ->> 'is_duplicate')::BOOLEAN IS TRUE THEN
                UPDATE public.tracks SET
                    acquisition_status = 'duplicate',
                    fingerprinted      = TRUE
                WHERE id = NEW.track_id AND user_id = NEW.user_id;
                RETURN NEW;  -- Pipeline stops for duplicates
            END IF;

            UPDATE public.tracks SET fingerprinted = TRUE
            WHERE id = NEW.track_id AND user_id = NEW.user_id;

            IF v_track.source = 'exportify' THEN
                IF v_ca_enabled THEN
                    v_payload := jsonb_build_object(
                        'local_path',  v_track.local_path,
                        'artist',      COALESCE(v_track.artist, ''),
                        'album',       COALESCE(v_track.album, ''),
                        'title',       COALESCE(v_track.title, ''),
                        'spotify_uri', COALESCE(v_track.spotify_uri, '')
                    );
                    IF v_ca_sources IS NOT NULL THEN
                        v_payload := v_payload || jsonb_build_object('settings', v_ca_sources);
                    END IF;
                    PERFORM public._insert_next_job(NEW.user_id, NEW.track_id, 'cover_art', v_payload);
                ELSE
                    v_payload := public._build_metadata_payload(NEW.track_id);
                    IF v_payload IS NOT NULL THEN
                        PERFORM public._insert_next_job(NEW.user_id, NEW.track_id, 'metadata', v_payload);
                    END IF;
                END IF;
            ELSE
                -- Non-exportify: spotify_lookup first
                PERFORM public._insert_next_job(
                    NEW.user_id, NEW.track_id, 'spotify_lookup',
                    jsonb_build_object(
                        'artist',      COALESCE(v_track.artist, ''),
                        'title',       COALESCE(v_track.title, ''),
                        'duration_ms', COALESCE(v_track.duration_ms, 0),
                        'spotify_uri', COALESCE(v_track.spotify_uri, '')
                    )
                );
            END IF;

        -- ── SPOTIFY LOOKUP ────────────────────────────────────────────────
        WHEN 'spotify_lookup' THEN
            IF (v_result ->> 'matched')::BOOLEAN IS NOT FALSE THEN
                UPDATE public.tracks SET
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
                -- Refresh after metadata update
                SELECT * INTO v_track FROM public.tracks WHERE id = NEW.track_id;
            END IF;

            IF v_track.source != 'exportify' THEN
                IF v_ca_enabled THEN
                    v_payload := jsonb_build_object(
                        'local_path',  v_track.local_path,
                        'artist',      COALESCE(v_track.artist, ''),
                        'album',       COALESCE(v_track.album, ''),
                        'title',       COALESCE(v_track.title, ''),
                        'spotify_uri', COALESCE(v_track.spotify_uri, '')
                    );
                    IF v_ca_sources IS NOT NULL THEN
                        v_payload := v_payload || jsonb_build_object('settings', v_ca_sources);
                    END IF;
                    PERFORM public._insert_next_job(NEW.user_id, NEW.track_id, 'cover_art', v_payload);
                ELSIF v_aa_enabled THEN
                    PERFORM public._insert_next_job(
                        NEW.user_id, NEW.track_id, 'audio_analysis',
                        jsonb_build_object(
                            'track_id',  NEW.track_id,
                            'local_path', v_track.local_path
                        )
                    );
                ELSE
                    v_payload := public._build_metadata_payload(NEW.track_id);
                    IF v_payload IS NOT NULL THEN
                        PERFORM public._insert_next_job(NEW.user_id, NEW.track_id, 'metadata', v_payload);
                    END IF;
                END IF;
            END IF;

        -- ── COVER ART ─────────────────────────────────────────────────────
        WHEN 'cover_art' THEN
            UPDATE public.tracks SET
                cover_art_written = COALESCE((v_result ->> 'cover_art_written')::BOOLEAN, cover_art_written),
                spotify_uri       = COALESCE(v_result ->> 'spotify_uri', spotify_uri)
            WHERE id = NEW.track_id AND user_id = NEW.user_id;

            IF v_track.local_path IS NULL THEN RETURN NEW; END IF;

            IF v_track.source != 'exportify' THEN
                IF v_aa_enabled THEN
                    PERFORM public._insert_next_job(
                        NEW.user_id, NEW.track_id, 'audio_analysis',
                        jsonb_build_object(
                            'track_id',   NEW.track_id,
                            'local_path', v_track.local_path
                        )
                    );
                ELSE
                    v_payload := public._build_metadata_payload(NEW.track_id);
                    IF v_payload IS NOT NULL THEN
                        PERFORM public._insert_next_job(NEW.user_id, NEW.track_id, 'metadata', v_payload);
                    END IF;
                END IF;
            ELSE
                -- Exportify: straight to metadata
                v_payload := public._build_metadata_payload(NEW.track_id);
                IF v_payload IS NOT NULL THEN
                    PERFORM public._insert_next_job(NEW.user_id, NEW.track_id, 'metadata', v_payload);
                END IF;
            END IF;

        -- ── AUDIO ANALYSIS ────────────────────────────────────────────────
        WHEN 'audio_analysis' THEN
            UPDATE public.tracks SET
                enriched_audio = TRUE,
                tempo          = COALESCE((v_result ->> 'tempo')::REAL,        tempo),
                key            = COALESCE((v_result ->> 'key')::INT,           key),
                mode           = COALESCE((v_result ->> 'mode')::INT,          mode),
                danceability   = COALESCE((v_result ->> 'danceability')::REAL, danceability),
                energy         = COALESCE((v_result ->> 'energy')::REAL,       energy),
                loudness       = COALESCE((v_result ->> 'loudness')::REAL,     loudness)
            WHERE id = NEW.track_id AND user_id = NEW.user_id;

            INSERT INTO public.push_notifications (user_id, type, title, body, url, data)
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
                    'title',    v_track.title,
                    'artist',   v_track.artist,
                    'tempo',    v_result ->> 'tempo',
                    'key',      v_result ->> 'key',
                    'energy',   v_result ->> 'energy'
                )
            );

            v_payload := public._build_metadata_payload(NEW.track_id);
            IF v_payload IS NOT NULL THEN
                PERFORM public._insert_next_job(NEW.user_id, NEW.track_id, 'metadata', v_payload);
            END IF;

        -- ── METADATA ──────────────────────────────────────────────────────
        WHEN 'metadata' THEN
            UPDATE public.tracks SET
                metadata_written = TRUE,
                local_path = COALESCE(v_result ->> 'local_path', local_path)
            WHERE id = NEW.track_id AND user_id = NEW.user_id;

        ELSE
            NULL;
        END CASE;

    -- ── FAILURE ────────────────────────────────────────────────────────────
    ELSIF NEW.status = 'failed' THEN

        CASE NEW.job_type

        WHEN 'download' THEN
            IF NEW.retry_count < 3 THEN
                INSERT INTO public.pipeline_jobs (
                    id, user_id, track_id, job_type, status, payload, retry_count
                ) VALUES (
                    gen_random_uuid(), NEW.user_id, NEW.track_id, 'download',
                    'pending', NEW.payload, NEW.retry_count + 1
                );
            ELSE
                UPDATE public.tracks SET acquisition_status = 'failed'
                WHERE id = NEW.track_id
                  AND user_id = NEW.user_id
                  AND acquisition_status IN ('candidate', 'downloading');
            END IF;

        WHEN 'audio_analysis' THEN
            -- Audio analysis failed — still queue metadata so pipeline doesn't stall
            v_payload := public._build_metadata_payload(NEW.track_id);
            IF v_payload IS NOT NULL THEN
                PERFORM public._insert_next_job(NEW.user_id, NEW.track_id, 'metadata', v_payload);
            END IF;

        ELSE
            NULL;
        END CASE;

        IF NEW.job_type = 'download' AND NEW.retry_count >= 3 THEN
            INSERT INTO public.push_notifications (user_id, type, title, body, url, data)
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

    -- ── BATCH COMPLETE ─────────────────────────────────────────────────────
    -- Only check on terminal events: metadata completion (always the final
    -- successful step) or any failure. This avoids running count(*) on every
    -- intermediate job completion (fingerprint, cover_art, etc.), cutting
    -- ~80% of these count queries for a typical 5-stage pipeline.
    IF NEW.job_type = 'metadata' OR NEW.status = 'failed' THEN
        SELECT count(*) INTO _active_count
        FROM public.pipeline_jobs
        WHERE user_id = NEW.user_id
          AND status IN ('pending', 'claimed', 'running');

        IF _active_count = 0 THEN
            SELECT
                count(*) FILTER (WHERE status = 'done'),
                count(*) FILTER (WHERE status = 'failed')
            INTO _done_count, _failed_count
            FROM public.pipeline_jobs
            WHERE user_id = NEW.user_id
              AND completed_at > NOW() - INTERVAL '24 hours';

            INSERT INTO public.push_notifications (user_id, type, title, body, url, data)
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
    END IF;

    RETURN NEW;
END;
$$;
