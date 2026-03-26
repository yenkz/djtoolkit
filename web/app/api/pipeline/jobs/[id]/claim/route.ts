import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";
import { rateLimit, limiters } from "@/lib/api-server/rate-limit";
import { auditLog, getClientIp } from "@/lib/api-server/audit";
import { createServiceClient } from "@/lib/supabase/service";
import { jsonError } from "@/lib/api-server/errors";

/**
 * POST /api/pipeline/jobs/[id]/claim
 *
 * Atomically claim a single pending job by ID using FOR UPDATE SKIP LOCKED.
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

  const { data: claimed, error } = await supabase.rpc("claim_job_by_id", {
    p_job_id: jobId,
    p_user_id: user.userId,
    p_agent_id: user.agentId ?? null,
  });

  if (error) {
    console.error("claim_job_by_id rpc error:", error);
    return jsonError("Failed to claim job", 500);
  }

  if (!claimed || claimed.length === 0) {
    return jsonError(
      "Job is not available (already claimed or not found)",
      409
    );
  }

  const job = claimed[0] as Record<string, unknown>;

  await auditLog(user.userId, "job.claim", {
    resourceType: "pipeline_job",
    resourceId: String(job.id),
    details: { job_type: job.job_type, track_id: job.track_id },
    ipAddress: getClientIp(request),
  });

  return NextResponse.json({
    id: String(job.id),
    job_type: job.job_type,
    status: job.status,
    track_id: job.track_id,
    payload: job.payload,
    created_at: job.created_at,
  });
}
