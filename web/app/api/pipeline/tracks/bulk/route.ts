import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";
import { rateLimit, limiters } from "@/lib/api-server/rate-limit";
import { auditLog, getClientIp } from "@/lib/api-server/audit";
import { createServiceClient } from "@/lib/supabase/service";
import { jsonError } from "@/lib/api-server/errors";
import { getUserSettings, getJobSettings } from "@/lib/api-server/job-settings";

/**
 * POST /api/pipeline/tracks/bulk
 *
 * Bulk actions on pipeline tracks by status filter.
 *
 * Body: { action: string, track_ids?: number[] }
 *
 * When track_ids is provided, operations are scoped to those specific tracks.
 * When omitted, operations apply to ALL tracks matching the status filter.
 *
 * - retry_failed:       reset failed + not_found tracks → candidate
 * - delete_failed:      permanently delete failed + not_found tracks
 * - delete_candidates:  permanently delete candidate tracks (cancel)
 * - delete_selected:    permanently delete specific tracks (requires track_ids)
 * - pause_candidates:   move candidate tracks → paused (agent skips them)
 * - resume_paused:      move paused tracks → candidate (agent picks them up)
 * - queue_candidates:   create download jobs for idle candidates (no active job)
 */
export async function POST(request: NextRequest) {
  const rl = await rateLimit(request, limiters.write);
  if (rl) return rl;

  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  let body: { action?: string; track_ids?: number[] };
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  const { action, track_ids } = body;

  if (track_ids !== undefined) {
    if (!Array.isArray(track_ids) || track_ids.length === 0 || !track_ids.every((id) => typeof id === "number")) {
      return jsonError("track_ids must be a non-empty array of numbers", 400);
    }
  }

  const VALID_ACTIONS = [
    "retry_failed", "delete_failed", "delete_candidates",
    "pause_candidates", "resume_paused", "queue_candidates",
    "delete_selected",
  ];
  if (!action || !VALID_ACTIONS.includes(action)) {
    return jsonError(
      `action must be one of: ${VALID_ACTIONS.join(", ")}`,
      400
    );
  }

  const supabase = createServiceClient();

  if (action === "retry_failed") {
    let q = supabase
      .from("tracks")
      .update({ acquisition_status: "candidate", search_results_count: null })
      .eq("user_id", user.userId)
      .in("acquisition_status", ["failed", "not_found"]);
    if (track_ids) q = q.in("id", track_ids);
    const { data, error } = await q.select("id");

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
    let fq = supabase.from("tracks").select("id").eq("user_id", user.userId).in("acquisition_status", ["failed", "not_found"]);
    if (track_ids) fq = fq.in("id", track_ids);
    const { data: tracks, error: fetchErr } = await fq;

    if (fetchErr) return jsonError(fetchErr.message, 500);

    const matchedIds = (tracks ?? []).map((t) => t.id);

    if (matchedIds.length > 0) {
      await supabase.from("pipeline_jobs").delete().in("track_id", matchedIds);
      const { error: delErr } = await supabase.from("tracks").delete().eq("user_id", user.userId).in("id", matchedIds);
      if (delErr) return jsonError(delErr.message, 500);
    }

    const deleted = matchedIds.length;

    await auditLog(user.userId, "track.bulk_delete_failed", {
      resourceType: "track",
      details: { deleted },
      ipAddress: getClientIp(request),
    });

    return NextResponse.json({ deleted });
  }

  if (action === "delete_candidates") {
    let fq = supabase.from("tracks").select("id").eq("user_id", user.userId).eq("acquisition_status", "candidate");
    if (track_ids) fq = fq.in("id", track_ids);
    const { data: tracks, error: fetchErr } = await fq;

    if (fetchErr) return jsonError(fetchErr.message, 500);

    const matchedIds = (tracks ?? []).map((t) => t.id);

    if (matchedIds.length > 0) {
      await supabase.from("pipeline_jobs").delete().in("track_id", matchedIds);
      const { error: delErr } = await supabase.from("tracks").delete().eq("user_id", user.userId).in("id", matchedIds);
      if (delErr) return jsonError(delErr.message, 500);
    }

    const deleted = matchedIds.length;

    await auditLog(user.userId, "track.bulk_delete_candidates", {
      resourceType: "track",
      details: { deleted },
      ipAddress: getClientIp(request),
    });

    return NextResponse.json({ deleted });
  }

  if (action === "pause_candidates") {
    let q = supabase.from("tracks").update({ acquisition_status: "paused" }).eq("user_id", user.userId).eq("acquisition_status", "candidate");
    if (track_ids) q = q.in("id", track_ids);
    const { data, error } = await q.select("id");

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
    let q = supabase.from("tracks").update({ acquisition_status: "candidate" }).eq("user_id", user.userId).eq("acquisition_status", "paused");
    if (track_ids) q = q.in("id", track_ids);
    const { data, error } = await q.select("id");

    if (error) return jsonError(error.message, 500);

    const updated = data?.length ?? 0;

    await auditLog(user.userId, "track.bulk_resume_paused", {
      resourceType: "track",
      details: { updated },
      ipAddress: getClientIp(request),
    });

    return NextResponse.json({ updated });
  }

  if (action === "queue_candidates") {
    let fq = supabase.from("tracks").select("id, title, artist, search_string, duration_ms").eq("user_id", user.userId).eq("acquisition_status", "candidate");
    if (track_ids) fq = fq.in("id", track_ids);
    const { data: candidates, error: fetchErr } = await fq;

    if (fetchErr) return jsonError(fetchErr.message, 500);

    const trackIds = (candidates ?? []).map((t) => t.id);
    if (trackIds.length === 0) {
      return NextResponse.json({ created: 0 });
    }

    // Find which already have an active job
    const activeJobTrackIds = new Set<number>();
    for (let i = 0; i < trackIds.length; i += 100) {
      const batch = trackIds.slice(i, i + 100);
      const { data: activeJobs } = await supabase
        .from("pipeline_jobs")
        .select("track_id")
        .in("track_id", batch)
        .in("status", ["pending", "claimed", "running"]);
      for (const j of activeJobs ?? []) {
        if (j.track_id) activeJobTrackIds.add(j.track_id);
      }
    }

    // Filter to idle candidates only
    const idle = (candidates ?? []).filter((t) => !activeJobTrackIds.has(t.id));
    if (idle.length === 0) {
      return NextResponse.json({ created: 0 });
    }

    const userSettings = await getUserSettings(supabase, user.userId);
    const downloadSettings = getJobSettings(userSettings, "download");

    let created = 0;
    for (const track of idle) {
      const { error: insertErr } = await supabase
        .from("pipeline_jobs")
        .insert({
          user_id: user.userId,
          track_id: track.id,
          job_type: "download",
          payload: {
            track_id: track.id,
            search_string: track.search_string ?? "",
            artist: track.artist ?? "",
            title: track.title ?? "",
            duration_ms: track.duration_ms ?? 0,
            ...(Object.keys(downloadSettings).length > 0 && { settings: downloadSettings }),
          },
        });
      if (!insertErr) created++;
    }

    await auditLog(user.userId, "track.bulk_queue_candidates", {
      resourceType: "pipeline_job",
      details: { created, idle_count: idle.length },
      ipAddress: getClientIp(request),
    });

    return NextResponse.json({ created });
  }

  if (action === "delete_selected") {
    if (!track_ids) return jsonError("delete_selected requires track_ids", 400);

    const deletableStatuses = ["candidate", "paused", "failed", "not_found"];
    const { data: tracks, error: fetchErr } = await supabase
      .from("tracks").select("id").eq("user_id", user.userId)
      .in("id", track_ids).in("acquisition_status", deletableStatuses);

    if (fetchErr) return jsonError(fetchErr.message, 500);

    const matchedIds = (tracks ?? []).map((t) => t.id);
    if (matchedIds.length > 0) {
      await supabase.from("pipeline_jobs").delete().in("track_id", matchedIds);
      const { error: delErr } = await supabase.from("tracks").delete().eq("user_id", user.userId).in("id", matchedIds);
      if (delErr) return jsonError(delErr.message, 500);
    }

    await auditLog(user.userId, "track.bulk_delete_selected", {
      resourceType: "track",
      details: { deleted: matchedIds.length, requested: track_ids.length },
      ipAddress: getClientIp(request),
    });

    return NextResponse.json({ deleted: matchedIds.length });
  }

  return jsonError("Unknown action", 400);
}
