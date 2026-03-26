import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";
import { rateLimit, limiters } from "@/lib/api-server/rate-limit";
import { auditLog, getClientIp } from "@/lib/api-server/audit";
import { createServiceClient } from "@/lib/supabase/service";
import { jsonError } from "@/lib/api-server/errors";

/**
 * POST /api/pipeline/jobs/batch/claim?type=download&limit=50
 *
 * Atomically claim pending jobs of a given type using FOR UPDATE SKIP LOCKED.
 * Returns the claimed jobs as an array.
 *
 * Query params:
 *   - type  (required): job type to claim (e.g. "download")
 *   - limit (optional): max jobs to claim, default 50, max 100
 */
export async function POST(request: NextRequest) {
  const rateLimitResponse = await rateLimit(request, limiters.batch);
  if (rateLimitResponse) return rateLimitResponse;

  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  const { searchParams } = request.nextUrl;

  const type = searchParams.get("type");
  if (!type) {
    return jsonError("Query parameter 'type' is required", 400);
  }

  let limit = 50;
  const rawLimit = searchParams.get("limit");
  if (rawLimit !== null) {
    limit = parseInt(rawLimit, 10);
    if (isNaN(limit) || limit < 1) limit = 1;
    if (limit > 100) limit = 100;
  }

  const supabase = createServiceClient();

  const { data: claimedJobs, error } = await supabase.rpc("claim_jobs_batch", {
    p_user_id: user.userId,
    p_job_type: type,
    p_agent_id: user.agentId ?? null,
    p_limit: limit,
  });

  if (error) {
    console.error("claim_jobs_batch rpc error:", error);
    return jsonError("Failed to claim jobs", 500);
  }

  const jobs = (claimedJobs ?? []).map(
    (row: Record<string, unknown>) => ({
      id: String(row.id),
      job_type: row.job_type,
      status: row.status,
      track_id: row.track_id,
      payload: row.payload,
      created_at: row.created_at,
    })
  );

  await auditLog(user.userId, "job.batch_claim", {
    resourceType: "pipeline_job",
    details: { claimed: jobs.length, job_type: type },
    ipAddress: getClientIp(request),
  });

  return NextResponse.json(jobs);
}
