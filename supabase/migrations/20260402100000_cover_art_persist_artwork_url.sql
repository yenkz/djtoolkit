-- Persist artwork_url and preview_url from cover_art job result so the UI
-- can display artwork immediately after the agent embeds it.
-- Previously only cover_art_written + spotify_uri were saved.

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
    v_settings     JSONB;
    v_fp_enabled   BOOLEAN;
    v_ca_enabled   BOOLEAN;
    v_aa_enabled   BOOLEAN;
    v_ca_sources   JSONB;
    _active_count  INTEGER;
    _done_count    INTEGER;
    _failed_count  INTEGER;
BEGIN
    IF NEW.status NOT IN ('done', 'failed') THEN
        RETURN NEW;
    END IF;

    SELECT * INTO v_track FROM public.tracks WHERE id = NEW.track_id;
    IF NOT FOUND THEN RETURN NEW; END IF;

    v_result := COALESCE(NEW.result, '{}'::JSONB);

    SELECT us.settings INTO v_settings
    FROM public.user_settings us
    WHERE us.user_id = NEW.user_id;

    v_fp_enabled := COALESCE((v_settings -> 'fingerprint_enabled')::BOOLEAN, TRUE);
    v_ca_enabled := COALESCE((v_settings -> 'coverart_enabled')::BOOLEAN,    TRUE);
    v_aa_enabled := COALESCE((v_settings -> 'analysis_enabled')::BOOLEAN,    FALSE);

    IF v_settings IS NOT NULL AND v_settings -> 'coverart_sources' IS NOT NULL
       AND v_settings -> 'coverart_sources' != 'null'::JSONB THEN
        v_ca_sources := jsonb_build_object('coverart_sources', v_settings -> 'coverart_sources');
    END IF;

    -- ── SUCCESS ──────────────────────────────────────────────────────────────
    IF NEW.status = 'done' THEN

        CASE NEW.job_type

        -- ── DOWNLOAD ─────────────────────────────────────────────────────────
        WHEN 'download' THEN
            UPDATE public.tracks SET
                acquisition_status = 'available',
                local_path = COALESCE(v_result ->> 'local_path', local_path)
            WHERE id = NEW.track_id AND user_id = NEW.user_id;
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

        -- ── FINGERPRINT ──────────────────────────────────────────────────────
        WHEN 'fingerprint' THEN
            INSERT INTO public.fingerprints (user_id, track_id, fingerprint, acoustid, duration)
            VALUES (
                NEW.user_id,
                NEW.track_id,
                v_result ->> 'fingerprint',
                v_result ->> 'acoustid',
                (v_result ->> 'duration')::REAL
            )
            ON CONFLICT (track_id) DO UPDATE SET
                fingerprint = EXCLUDED.fingerprint,
                acoustid    = EXCLUDED.acoustid,
                duration    = EXCLUDED.duration;

            -- folder-source duplicates pause for user review
            IF (v_result ->> 'is_duplicate')::BOOLEAN IS TRUE THEN
                IF v_track.source = 'folder' THEN
                    UPDATE public.tracks SET
                        acquisition_status = 'pending_review',
                        fingerprinted      = TRUE
                    WHERE id = NEW.track_id AND user_id = NEW.user_id;
                ELSE
                    UPDATE public.tracks SET
                        acquisition_status = 'duplicate',
                        fingerprinted      = TRUE
                    WHERE id = NEW.track_id AND user_id = NEW.user_id;
                END IF;
                RETURN NEW;
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

        -- ── SPOTIFY LOOKUP ───────────────────────────────────────────────────
        WHEN 'spotify_lookup' THEN
            IF (v_result ->> 'matched')::BOOLEAN IS NOT FALSE THEN
                UPDATE public.tracks SET
                    enriched_spotify = TRUE,
                    album        = COALESCE(v_result ->> 'album',        album),
                    release_date = COALESCE(v_result ->> 'release_date', release_date),
                    year         = COALESCE((v_result ->> 'year')::INT,  year),
                    genres       = COALESCE(v_result ->> 'genres',       genres),
                    record_label = COALESCE(v_result ->> 'record_label', record_label),
                    popularity   = COALESCE((v_result ->> 'popularity')::INT, popularity),
                    explicit     = COALESCE((v_result ->> 'explicit')::BOOLEAN, explicit),
                    isrc         = COALESCE(v_result ->> 'isrc',         isrc),
                    duration_ms  = COALESCE((v_result ->> 'duration_ms')::INT, duration_ms),
                    spotify_uri  = COALESCE(v_result ->> 'spotify_uri',  spotify_uri)
                WHERE id = NEW.track_id AND user_id = NEW.user_id;
            ELSE
                UPDATE public.tracks SET enriched_spotify = TRUE
                WHERE id = NEW.track_id AND user_id = NEW.user_id;
            END IF;

            SELECT * INTO v_track FROM public.tracks WHERE id = NEW.track_id;

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
                    jsonb_build_object('local_path', v_track.local_path, 'track_id', NEW.track_id)
                );
            ELSE
                v_payload := public._build_metadata_payload(NEW.track_id);
                IF v_payload IS NOT NULL THEN
                    PERFORM public._insert_next_job(NEW.user_id, NEW.track_id, 'metadata', v_payload);
                END IF;
            END IF;

        -- ── COVER ART ────────────────────────────────────────────────────────
        WHEN 'cover_art' THEN
            UPDATE public.tracks SET
                cover_art_written     = TRUE,
                cover_art_embedded_at = NOW(),
                spotify_uri  = COALESCE(v_result ->> 'spotify_uri',  spotify_uri),
                artwork_url  = COALESCE(v_result ->> 'artwork_url',  artwork_url),
                preview_url  = COALESCE(v_result ->> 'preview_url',  preview_url)
            WHERE id = NEW.track_id AND user_id = NEW.user_id;

            SELECT * INTO v_track FROM public.tracks WHERE id = NEW.track_id;

            IF v_track.source != 'exportify' AND v_aa_enabled THEN
                PERFORM public._insert_next_job(
                    NEW.user_id, NEW.track_id, 'audio_analysis',
                    jsonb_build_object('local_path', v_track.local_path, 'track_id', NEW.track_id)
                );
            ELSE
                v_payload := public._build_metadata_payload(NEW.track_id);
                IF v_payload IS NOT NULL THEN
                    PERFORM public._insert_next_job(NEW.user_id, NEW.track_id, 'metadata', v_payload);
                END IF;
            END IF;

        -- ── AUDIO ANALYSIS ───────────────────────────────────────────────────
        WHEN 'audio_analysis' THEN
            UPDATE public.tracks SET
                enriched_audio = TRUE,
                tempo        = COALESCE((v_result ->> 'tempo')::REAL,        tempo),
                key          = COALESCE((v_result ->> 'key')::INT,           key),
                mode         = COALESCE((v_result ->> 'mode')::INT,          mode),
                danceability = COALESCE((v_result ->> 'danceability')::REAL,  danceability),
                energy       = COALESCE((v_result ->> 'energy')::REAL,       energy),
                loudness     = COALESCE((v_result ->> 'loudness')::REAL,     loudness)
            WHERE id = NEW.track_id AND user_id = NEW.user_id;

            v_payload := public._build_metadata_payload(NEW.track_id);
            IF v_payload IS NOT NULL THEN
                PERFORM public._insert_next_job(NEW.user_id, NEW.track_id, 'metadata', v_payload);
            END IF;

        -- ── METADATA ─────────────────────────────────────────────────────────
        WHEN 'metadata' THEN
            UPDATE public.tracks SET
                metadata_written = TRUE,
                metadata_source  = v_result ->> 'metadata_source',
                local_path       = COALESCE(v_result ->> 'local_path', local_path)
            WHERE id = NEW.track_id AND user_id = NEW.user_id;

        -- ── FOLDER IMPORT ────────────────────────────────────────────────────
        WHEN 'folder_import' THEN
            NULL;

        ELSE
            NULL;

        END CASE;

    END IF;

    -- ── FAILED ───────────────────────────────────────────────────────────────
    IF NEW.status = 'failed' THEN
        CASE NEW.job_type
        WHEN 'download' THEN
            IF COALESCE(NEW.retry_count, 0) >= 3 THEN
                UPDATE public.tracks SET acquisition_status = 'failed'
                WHERE id = NEW.track_id AND user_id = NEW.user_id;
            END IF;
        WHEN 'audio_analysis' THEN
            v_payload := public._build_metadata_payload(NEW.track_id);
            IF v_payload IS NOT NULL THEN
                PERFORM public._insert_next_job(NEW.user_id, NEW.track_id, 'metadata', v_payload);
            END IF;
        ELSE
            NULL;
        END CASE;
    END IF;

    -- ── NOTIFICATIONS ────────────────────────────────────────────────────────

    -- Track downloaded
    IF NEW.status = 'done' AND NEW.job_type = 'download' THEN
        INSERT INTO public.push_notifications (user_id, type, title, body, url, data)
        VALUES (
            NEW.user_id,
            'track_downloaded',
            'Track downloaded',
            COALESCE(v_track.artist, '') || ' – ' || COALESCE(v_track.title, ''),
            '/pipeline',
            jsonb_build_object('track_id', NEW.track_id, 'job_type', NEW.job_type)
        );
    END IF;

    -- Analysis complete
    IF NEW.status = 'done' AND NEW.job_type = 'audio_analysis' THEN
        INSERT INTO public.push_notifications (user_id, type, title, body, url, data)
        VALUES (
            NEW.user_id,
            'analysis_complete',
            'Analysis complete',
            COALESCE(v_track.artist, '') || ' – ' || COALESCE(v_track.title, '') ||
                ' — BPM: ' || COALESCE(v_result ->> 'tempo', '?') ||
                ', Key: ' || COALESCE(v_result ->> 'key', '?'),
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
    END IF;

    -- Track failed
    IF NEW.status = 'failed' THEN
        INSERT INTO public.push_notifications (user_id, type, title, body, url, data)
        VALUES (
            NEW.user_id,
            'track_failed',
            'Track failed',
            COALESCE(v_track.artist, '') || ' – ' || COALESCE(v_track.title, '') ||
                ': ' || NEW.job_type || ' failed',
            '/pipeline',
            jsonb_build_object('track_id', NEW.track_id, 'job_type', NEW.job_type,
                               'error', v_result ->> 'error')
        );
    END IF;

    -- Batch complete: fire when no active jobs remain for this user
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

    RETURN NEW;
END;
$$;
