import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";
import { rateLimit, limiters } from "@/lib/api-server/rate-limit";
import { auditLog, getClientIp } from "@/lib/api-server/audit";
import { createServiceClient } from "@/lib/supabase/service";
import { jsonError } from "@/lib/api-server/errors";

const MAX_TRACK_IDS = 1000;

/**
 * POST /api/pipeline/jobs/bulk
 *
 * Create one download job per track_id. Skips tracks the user doesn't own,
 * non-candidate tracks, and tracks that already have a pending/running job.
 *
 * Body: { track_ids: number[] } (max 1000)
 * Returns: { created: number } with status 201
 */
export async function POST(request: NextRequest) {
  const rateLimitResponse = await rateLimit(request, limiters.write);
  if (rateLimitResponse) return rateLimitResponse;

  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  let body: { track_ids?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  const { track_ids } = body;
  if (!Array.isArray(track_ids)) {
    return jsonError("track_ids must be an array", 400);
  }
  if (track_ids.length === 0) {
    return NextResponse.json({ created: 0 }, { status: 201 });
  }
  if (track_ids.length > MAX_TRACK_IDS) {
    return jsonError(`track_ids exceeds maximum of ${MAX_TRACK_IDS}`, 400);
  }
  if (!track_ids.every((id) => typeof id === "number" && Number.isInteger(id))) {
    return jsonError("track_ids must contain only integers", 400);
  }

  const supabase = createServiceClient();
  let created = 0;

  for (const trackId of track_ids) {
    // Check ownership + candidate status
    const { data: track, error: trackErr } = await supabase
      .from("tracks")
      .select("id, title, artist, search_string, duration_ms")
      .eq("id", trackId)
      .eq("user_id", user.userId)
      .eq("acquisition_status", "candidate")
      .maybeSingle();

    if (trackErr || !track) continue;

    // Check no existing pending/claimed/running job
    const { data: existing } = await supabase
      .from("pipeline_jobs")
      .select("id")
      .eq("track_id", trackId)
      .in("status", ["pending", "claimed", "running"])
      .limit(1)
      .maybeSingle();

    if (existing) continue;

    // Insert pipeline job with download payload
    const { error: insertErr } = await supabase
      .from("pipeline_jobs")
      .insert({
        user_id: user.userId,
        track_id: trackId,
        job_type: "download",
        payload: {
          track_id: trackId,
          search_string: track.search_string ?? "",
          artist: track.artist ?? "",
          title: track.title ?? "",
          duration_ms: track.duration_ms ?? 0,
        },
      });

    if (!insertErr) created++;
  }

  await auditLog(user.userId, "job.bulk_create", {
    resourceType: "pipeline_job",
    details: { created, requested_track_ids: track_ids },
    ipAddress: getClientIp(request),
  });

  return NextResponse.json({ created }, { status: 201 });
}
