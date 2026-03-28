-- Migration: Pin search_path on _is_step_enabled to fix Supabase advisor lint 0011.
--
-- Functions with a mutable search_path are flagged because unqualified names inside
-- the body resolve against whatever search_path the caller happens to have, which can
-- cause inconsistent behaviour and is a security concern for SECURITY DEFINER functions.
-- The fix is SET search_path = '' and schema-qualifying every object reference.

CREATE OR REPLACE FUNCTION public._is_step_enabled(
    p_user_id UUID,
    p_step    TEXT        -- 'fingerprint', 'cover_art', 'audio_analysis', 'loudnorm'
) RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
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
    FROM public.user_settings us
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
