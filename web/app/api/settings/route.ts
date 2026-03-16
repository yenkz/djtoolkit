import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";
import { rateLimit, limiters } from "@/lib/api-server/rate-limit";
import { createServiceClient } from "@/lib/supabase/service";
import { jsonError } from "@/lib/api-server/errors";

const ALLOWED_KEYS = new Set([
  "display_name",
  "downloads_dir",
  "library_dir",
  "soulseek_username",
  "soulseek_password",
  "soulseek_enabled",
  "min_score",
  "duration_tolerance_ms",
  "search_timeout_sec",
  "fingerprint_enabled",
  "acoustid_api_key",
  "loudnorm_target_lufs",
  "loudnorm_enabled",
  "coverart_sources",
  "coverart_enabled",
  "export_formats",
  "export_output_path",
  "analysis_essentia_model_path",
  "analysis_enabled",
]);

export async function GET(request: NextRequest) {
  const rl = await rateLimit(request, limiters.read);
  if (rl) return rl;

  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  const supabase = createServiceClient();

  // Upsert on first access: insert if missing, then select
  await supabase
    .from("user_settings")
    .upsert(
      { user_id: user.userId, settings: {} },
      { onConflict: "user_id", ignoreDuplicates: true },
    );

  const { data, error } = await supabase
    .from("user_settings")
    .select("settings")
    .eq("user_id", user.userId)
    .single();

  if (error) {
    return jsonError("Failed to fetch settings", 500);
  }

  return NextResponse.json({
    settings: data?.settings ?? {},
    email: user.email ?? null,
  });
}

export async function PUT(request: NextRequest) {
  const rl = await rateLimit(request, limiters.write);
  if (rl) return rl;

  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  // Validate keys
  const invalidKeys = Object.keys(body).filter((k) => !ALLOWED_KEYS.has(k));
  if (invalidKeys.length > 0) {
    return jsonError(`Invalid settings keys: ${invalidKeys.join(", ")}`, 400);
  }

  const supabase = createServiceClient();

  // Fetch current settings
  const { data: existing } = await supabase
    .from("user_settings")
    .select("settings")
    .eq("user_id", user.userId)
    .single();

  const currentSettings =
    (existing?.settings as Record<string, unknown>) ?? {};
  const merged = { ...currentSettings, ...body };

  const { error } = await supabase
    .from("user_settings")
    .upsert(
      { user_id: user.userId, settings: merged },
      { onConflict: "user_id" },
    );

  if (error) {
    return jsonError("Failed to update settings", 500);
  }

  return NextResponse.json({ settings: merged });
}
