/**
 * Job settings helper — extracts user settings relevant to each job type
 * and checks enabled toggles for pipeline step gating.
 */

import { SupabaseClient } from "@supabase/supabase-js";

/** Keys from user_settings relevant to each job type. */
const JOB_SETTINGS_KEYS: Record<string, string[]> = {
  download: ["min_score", "duration_tolerance_ms", "search_timeout_sec"],
  cover_art: ["coverart_sources"],
};

/** Toggle key mapping and defaults for each gatable step. */
const STEP_TOGGLES: Record<string, { key: string; defaultEnabled: boolean }> = {
  fingerprint: { key: "fingerprint_enabled", defaultEnabled: true },
  cover_art: { key: "coverart_enabled", defaultEnabled: true },
  audio_analysis: { key: "analysis_enabled", defaultEnabled: false },
  loudnorm: { key: "loudnorm_enabled", defaultEnabled: false },
};

/**
 * Fetch user_settings.settings JSONB for a user.
 * Returns empty object if no settings row exists.
 */
export async function getUserSettings(
  supabase: SupabaseClient,
  userId: string
): Promise<Record<string, unknown>> {
  const { data } = await supabase
    .from("user_settings")
    .select("settings")
    .eq("user_id", userId)
    .maybeSingle();

  return (data?.settings as Record<string, unknown>) ?? {};
}

/**
 * Extract only the settings keys relevant to a given job type.
 * Pure function — operates on an already-fetched settings object.
 */
export function getJobSettings(
  settings: Record<string, unknown>,
  jobType: string
): Record<string, unknown> {
  const keys = JOB_SETTINGS_KEYS[jobType];
  if (!keys) return {};

  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in settings && settings[key] !== undefined) {
      result[key] = settings[key];
    }
  }
  return result;
}

/**
 * Check if a pipeline step is enabled based on user settings.
 * Pure function — operates on an already-fetched settings object.
 */
export function isStepEnabled(
  settings: Record<string, unknown>,
  step: "fingerprint" | "cover_art" | "audio_analysis" | "loudnorm"
): boolean {
  const toggle = STEP_TOGGLES[step];
  if (!toggle) return true;

  const value = settings[toggle.key];
  if (value === undefined || value === null) return toggle.defaultEnabled;
  return Boolean(value);
}
