-- Add 'pending_review' acquisition_status for folder-imported duplicates.
-- Update chain trigger: folder-source duplicates pause for user review
-- instead of being auto-marked as 'duplicate'.

-- ── 1. Update CHECK constraint ───────────────────────────────────────────────
ALTER TABLE public.tracks
    DROP CONSTRAINT IF EXISTS tracks_acquisition_status_check;

ALTER TABLE public.tracks
    ADD CONSTRAINT tracks_acquisition_status_check
    CHECK (acquisition_status IN (
        'candidate', 'downloading', 'available',
        'failed', 'duplicate', 'pending_review'
    ));

-- ── 2. Update chain_pipeline_job trigger ─────────────────────────────────────
-- Only the FINGERPRINT branch changes: folder-source duplicates get
-- 'pending_review' instead of 'duplicate', pausing the pipeline for user review.
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

            -- ▶ CHANGED: folder-source duplicates pause for user review
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
                RETURN NEW;  -- Pipeline stops — user review or auto-duplicate
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
                cover_art_written    = TRUE,
                cover_art_embedded_at = NOW(),
                spotify_uri = COALESCE(v_result ->> 'spotify_uri', spotify_uri)
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

        -- ── FOLDER IMPORT (no track-level update needed) ─────────────────────
        WHEN 'folder_import' THEN
            NULL;  -- folder_import creates its own fingerprint jobs directly

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

    -- ── BATCH COMPLETE ───────────────────────────────────────────────────────
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
