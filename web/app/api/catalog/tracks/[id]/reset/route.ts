import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";
import { rateLimit, limiters } from "@/lib/api-server/rate-limit";
import { auditLog, getClientIp } from "@/lib/api-server/audit";
import { createServiceClient } from "@/lib/supabase/service";
import { jsonError } from "@/lib/api-server/errors";

/**
 * POST /api/catalog/tracks/[id]/reset
 *
 * Reset a failed track back to 'candidate' and enqueue a new download job.
 * Returns 204 on success, 404 if the track is not found or not in 'failed' state.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const rl = await rateLimit(request, limiters.write);
  if (rl) return rl;

  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  const { id: rawId } = await params;
  const trackId = parseInt(rawId, 10);
  if (isNaN(trackId)) {
    return jsonError("Invalid track ID", 400);
  }

  const supabase = createServiceClient();

  // Update acquisition_status from 'failed' → 'candidate', scoped to the user.
  const { data: updated, error: updateErr } = await supabase
    .from("tracks")
    .update({ acquisition_status: "candidate" })
    .eq("id", trackId)
    .eq("user_id", user.userId)
    .eq("acquisition_status", "failed")
    .select("id, title, artist, search_string, duration_ms")
    .maybeSingle();

  if (updateErr) {
    return jsonError("Failed to reset track", 500);
  }

  if (!updated) {
    return jsonError("Track not found or not in failed state", 404);
  }

  // Enqueue a new download job for the reset track.
  const { error: jobErr } = await supabase.from("pipeline_jobs").insert({
    user_id: user.userId,
    track_id: trackId,
    job_type: "download",
    payload: {
      track_id: trackId,
      search_string: updated.search_string ?? "",
      artist: updated.artist ?? "",
      title: updated.title ?? "",
      duration_ms: updated.duration_ms ?? 0,
    },
  });

  if (jobErr) {
    // Job creation failure is non-fatal — the track is already reset to candidate.
    console.warn(
      `Failed to create download job for track ${trackId}:`,
      jobErr.message
    );
  }

  await auditLog(user.userId, "track.reset", {
    resourceType: "track",
    resourceId: String(trackId),
    details: { track_id: trackId, job_created: !jobErr },
    ipAddress: getClientIp(request),
  });

  return new NextResponse(null, { status: 204 });
}
