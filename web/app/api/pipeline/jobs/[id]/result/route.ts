import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";
import { rateLimit, limiters } from "@/lib/api-server/rate-limit";
import { auditLog, getClientIp } from "@/lib/api-server/audit";
import { createServiceClient } from "@/lib/supabase/service";
import { jsonError } from "@/lib/api-server/errors";

/**
 * PUT /api/pipeline/jobs/[id]/result
 *
 * Agent reports completion or failure of a job.
 * Track flag updates, retry logic, and next-job chaining are handled
 * atomically by the `chain_pipeline_job` PostgreSQL trigger.
 *
 * Body: { status: "done" | "failed", result?: object, error?: string }
 * Returns: 204 No Content
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const rateLimitResponse = await rateLimit(request, limiters.agent);
  if (rateLimitResponse) return rateLimitResponse;

  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  const { id: jobId } = await params;

  let body: {
    status?: unknown;
    result?: Record<string, unknown>;
    error?: string;
  };
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  if (body.status !== "done" && body.status !== "failed") {
    return jsonError("status must be 'done' or 'failed'", 422);
  }

  const supabase = createServiceClient();

  // Verify job belongs to this user
  const { data: job, error: jobErr } = await supabase
    .from("pipeline_jobs")
    .select("job_type, track_id")
    .eq("id", jobId)
    .eq("user_id", user.userId)
    .maybeSingle();

  if (jobErr || !job) {
    return jsonError("Job not found", 404);
  }

  // Update the job row — the chain_pipeline_job_trigger handles:
  // - Track flag updates (acquisition_status, fingerprinted, etc.)
  // - Next-job insertion (fingerprint → cover_art → metadata, etc.)
  // - Download retry (re-queue with retry_count + 1 up to 3)
  // - Audio analysis failure → metadata fallback
  const { error: updateErr } = await supabase
    .from("pipeline_jobs")
    .update({
      status: body.status,
      result: body.result ?? null,
      error: body.error ?? null,
      completed_at: new Date().toISOString(),
    })
    .eq("id", jobId);

  if (updateErr) {
    console.error(
      `report_job_result failed for job ${jobId} (type=${job.job_type}):`,
      updateErr
    );
    return jsonError("Failed to update job", 500);
  }

  await auditLog(user.userId, "job.result", {
    resourceType: "pipeline_job",
    resourceId: jobId,
    details: {
      job_type: job.job_type,
      status: body.status,
      track_id: job.track_id,
    },
    ipAddress: getClientIp(request),
  });

  return new NextResponse(null, { status: 204 });
}
