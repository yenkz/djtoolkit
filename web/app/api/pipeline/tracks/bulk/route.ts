import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";
import { rateLimit, limiters } from "@/lib/api-server/rate-limit";
import { auditLog, getClientIp } from "@/lib/api-server/audit";
import { createServiceClient } from "@/lib/supabase/service";
import { jsonError } from "@/lib/api-server/errors";

/**
 * POST /api/pipeline/tracks/bulk
 *
 * Bulk actions on pipeline tracks by status filter.
 *
 * Body: { action: "retry_failed" | "delete_failed" | "delete_candidates" | "pause_candidates" | "resume_paused" }
 *
 * - retry_failed:      reset all failed + not_found tracks → candidate
 * - delete_failed:     permanently delete all failed + not_found tracks
 * - delete_candidates: permanently delete all candidate tracks (cancel)
 * - pause_candidates:  move all candidate tracks → paused (agent skips them)
 * - resume_paused:     move all paused tracks → candidate (agent picks them up)
 */
export async function POST(request: NextRequest) {
  const rl = await rateLimit(request, limiters.write);
  if (rl) return rl;

  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  let body: { action?: string };
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  const { action } = body;
  const VALID_ACTIONS = [
    "retry_failed", "delete_failed", "delete_candidates",
    "pause_candidates", "resume_paused",
  ];
  if (!action || !VALID_ACTIONS.includes(action)) {
    return jsonError(
      `action must be one of: ${VALID_ACTIONS.join(", ")}`,
      400
    );
  }

  const supabase = createServiceClient();

  if (action === "retry_failed") {
    const { data, error } = await supabase
      .from("tracks")
      .update({
        acquisition_status: "candidate",
        search_results_count: null,
      })
      .eq("user_id", user.userId)
      .in("acquisition_status", ["failed", "not_found"])
      .select("id");

    if (error) return jsonError(error.message, 500);

    const updated = data?.length ?? 0;

    await auditLog(user.userId, "track.bulk_retry_failed", {
      resourceType: "track",
      details: { updated },
      ipAddress: getClientIp(request),
    });

    return NextResponse.json({ updated });
  }

  if (action === "delete_failed") {
    // Delete associated pipeline_jobs first, then tracks
    const { data: tracks, error: fetchErr } = await supabase
      .from("tracks")
      .select("id")
      .eq("user_id", user.userId)
      .in("acquisition_status", ["failed", "not_found"]);

    if (fetchErr) return jsonError(fetchErr.message, 500);

    const trackIds = (tracks ?? []).map((t) => t.id);

    if (trackIds.length > 0) {
      // Clean up pipeline_jobs for these tracks
      await supabase
        .from("pipeline_jobs")
        .delete()
        .in("track_id", trackIds);

      const { error: delErr } = await supabase
        .from("tracks")
        .delete()
        .eq("user_id", user.userId)
        .in("acquisition_status", ["failed", "not_found"]);

      if (delErr) return jsonError(delErr.message, 500);
    }

    const deleted = trackIds.length;

    await auditLog(user.userId, "track.bulk_delete_failed", {
      resourceType: "track",
      details: { deleted },
      ipAddress: getClientIp(request),
    });

    return NextResponse.json({ deleted });
  }

  if (action === "delete_candidates") {
    // Candidates shouldn't have pipeline_jobs, but clean up just in case
    const { data: tracks, error: fetchErr } = await supabase
      .from("tracks")
      .select("id")
      .eq("user_id", user.userId)
      .eq("acquisition_status", "candidate");

    if (fetchErr) return jsonError(fetchErr.message, 500);

    const trackIds = (tracks ?? []).map((t) => t.id);

    if (trackIds.length > 0) {
      await supabase
        .from("pipeline_jobs")
        .delete()
        .in("track_id", trackIds);

      const { error: delErr } = await supabase
        .from("tracks")
        .delete()
        .eq("user_id", user.userId)
        .eq("acquisition_status", "candidate");

      if (delErr) return jsonError(delErr.message, 500);
    }

    const deleted = trackIds.length;

    await auditLog(user.userId, "track.bulk_delete_candidates", {
      resourceType: "track",
      details: { deleted },
      ipAddress: getClientIp(request),
    });

    return NextResponse.json({ deleted });
  }

  if (action === "pause_candidates") {
    const { data, error } = await supabase
      .from("tracks")
      .update({ acquisition_status: "paused" })
      .eq("user_id", user.userId)
      .eq("acquisition_status", "candidate")
      .select("id");

    if (error) return jsonError(error.message, 500);

    const updated = data?.length ?? 0;

    await auditLog(user.userId, "track.bulk_pause_candidates", {
      resourceType: "track",
      details: { updated },
      ipAddress: getClientIp(request),
    });

    return NextResponse.json({ updated });
  }

  if (action === "resume_paused") {
    const { data, error } = await supabase
      .from("tracks")
      .update({ acquisition_status: "candidate" })
      .eq("user_id", user.userId)
      .eq("acquisition_status", "paused")
      .select("id");

    if (error) return jsonError(error.message, 500);

    const updated = data?.length ?? 0;

    await auditLog(user.userId, "track.bulk_resume_paused", {
      resourceType: "track",
      details: { updated },
      ipAddress: getClientIp(request),
    });

    return NextResponse.json({ updated });
  }

  return jsonError("Unknown action", 400);
}
