import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";
import { rateLimit, limiters } from "@/lib/api-server/rate-limit";
import { auditLog, getClientIp } from "@/lib/api-server/audit";
import { createServiceClient } from "@/lib/supabase/service";
import { jsonError } from "@/lib/api-server/errors";

const MAX_TRACK_IDS = 1000;

/**
 * POST /api/catalog/analyze
 *
 * Create one audio_analysis job per track_id. Skips tracks the user doesn't
 * own, non-available tracks, tracks without local_path, and tracks that are
 * already analyzed (unless force=true).
 *
 * Body: { track_ids: number[], force?: boolean }
 * Returns: { created: number, skipped: number } with status 201
 */
export async function POST(request: NextRequest) {
  const rateLimitResponse = await rateLimit(request, limiters.write);
  if (rateLimitResponse) return rateLimitResponse;

  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  let body: { track_ids?: unknown; force?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  const { track_ids, force } = body;
  if (!Array.isArray(track_ids)) {
    return jsonError("track_ids must be an array", 400);
  }
  if (track_ids.length === 0) {
    return NextResponse.json({ created: 0, skipped: 0 }, { status: 201 });
  }
  if (track_ids.length > MAX_TRACK_IDS) {
    return jsonError(`track_ids exceeds maximum of ${MAX_TRACK_IDS}`, 400);
  }
  if (!track_ids.every((id) => typeof id === "number" && Number.isInteger(id))) {
    return jsonError("track_ids must contain only integers", 400);
  }

  const forceReanalyze = force === true;
  const supabase = createServiceClient();

  let created = 0;
  let skipped = 0;

  for (const trackId of track_ids) {
    // Check ownership + available status + has local_path
    const { data: track, error: trackErr } = await supabase
      .from("tracks")
      .select("id, local_path, enriched_audio")
      .eq("id", trackId)
      .eq("user_id", user.userId)
      .eq("acquisition_status", "available")
      .not("local_path", "is", null)
      .maybeSingle();

    if (trackErr || !track) {
      skipped++;
      continue;
    }

    // Skip already-analyzed tracks unless force
    if (track.enriched_audio && !forceReanalyze) {
      skipped++;
      continue;
    }

    // Check no existing active audio_analysis job
    const { data: existing } = await supabase
      .from("pipeline_jobs")
      .select("id")
      .eq("track_id", trackId)
      .eq("job_type", "audio_analysis")
      .in("status", ["pending", "claimed", "running"])
      .limit(1)
      .maybeSingle();

    if (existing) {
      skipped++;
      continue;
    }

    // Insert audio_analysis pipeline job
    const { error: insertErr } = await supabase
      .from("pipeline_jobs")
      .insert({
        user_id: user.userId,
        track_id: trackId,
        job_type: "audio_analysis",
        payload: {
          track_id: trackId,
          local_path: track.local_path,
        },
      });

    if (!insertErr) {
      created++;
    } else {
      skipped++;
    }
  }

  await auditLog(user.userId, "track.bulk_analyze", {
    resourceType: "pipeline_job",
    details: { created, skipped, requested: track_ids.length, force: forceReanalyze },
    ipAddress: getClientIp(request),
  });

  return NextResponse.json({ created, skipped }, { status: 201 });
}