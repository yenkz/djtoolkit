import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";
import { rateLimit, limiters } from "@/lib/api-server/rate-limit";
import { auditLog, getClientIp } from "@/lib/api-server/audit";
import { createServiceClient } from "@/lib/supabase/service";
import { jsonError } from "@/lib/api-server/errors";

/**
 * POST /api/pipeline/jobs/[id]/claim
 *
 * Atomically claim a single pending job by ID for the authenticated agent.
 * Returns the claimed job or 409 if the job is not available.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const rateLimitResponse = await rateLimit(request, limiters.agent);
  if (rateLimitResponse) return rateLimitResponse;

  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  const { id: jobId } = await params;

  const supabase = createServiceClient();

  // Atomically claim: select the job only if it's pending and belongs to the user,
  // then update to claimed status.
  // Supabase doesn't support FOR UPDATE SKIP LOCKED, so we use a two-step
  // select-then-update with a status check to prevent race conditions.
  const { data: job, error: selectErr } = await supabase
    .from("pipeline_jobs")
    .select("id, job_type, status, track_id, payload, created_at")
    .eq("id", jobId)
    .eq("user_id", user.userId)
    .eq("status", "pending")
    .maybeSingle();

  if (selectErr) {
    return jsonError("Failed to fetch job", 500);
  }

  if (!job) {
    return jsonError(
      "Job is not available (already claimed or not found)",
      409
    );
  }

  // Update to claimed — re-check status = 'pending' to guard against races
  const { data: claimed, error: updateErr } = await supabase
    .from("pipeline_jobs")
    .update({
      status: "claimed",
      claimed_at: new Date().toISOString(),
      agent_id: user.agentId ?? null,
    })
    .eq("id", jobId)
    .eq("status", "pending")
    .select("id, job_type, status, track_id, payload, created_at")
    .maybeSingle();

  if (updateErr || !claimed) {
    return jsonError(
      "Job is not available (already claimed or not found)",
      409
    );
  }

  await auditLog(user.userId, "job.claim", {
    resourceType: "pipeline_job",
    resourceId: String(claimed.id),
    details: { job_type: claimed.job_type, track_id: claimed.track_id },
    ipAddress: getClientIp(request),
  });

  return NextResponse.json({
    id: String(claimed.id),
    job_type: claimed.job_type,
    status: claimed.status,
    track_id: claimed.track_id,
    payload: claimed.payload,
    created_at: claimed.created_at,
  });
}
