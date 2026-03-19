import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";
import { rateLimit, limiters } from "@/lib/api-server/rate-limit";
import { auditLog, getClientIp } from "@/lib/api-server/audit";
import { createServiceClient } from "@/lib/supabase/service";
import { jsonError } from "@/lib/api-server/errors";
import { applyJobResult, buildMetadataPayload } from "@/lib/api-server/job-result";

const MAX_DOWNLOAD_RETRIES = 3;

/**
 * PUT /api/pipeline/jobs/[id]/result
 *
 * Agent reports completion or failure of a job.
 * On success, track flags are updated and the next pipeline job is auto-queued.
 * On failure of a download job, re-queues with incremented retry_count (up to 3).
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

  try {
    // Update the job row
    const { error: updateErr } = await supabase
      .from("pipeline_jobs")
      .update({
        status: body.status,
        result: body.result ? body.result : null,
        error: body.error ?? null,
        completed_at: new Date().toISOString(),
      })
      .eq("id", jobId);

    if (updateErr) {
      return jsonError("Failed to update job", 500);
    }

    if (body.status === "done" && body.result) {
      // Apply result: update track flags and auto-queue next job
      await applyJobResult(
        supabase,
        jobId,
        user.userId,
        job.job_type,
        body.result
      );
    } else if (body.status === "failed" && job.job_type === "download") {
      // Retry logic for failed downloads
      const { data: jobDetails } = await supabase
        .from("pipeline_jobs")
        .select("retry_count, payload")
        .eq("id", jobId)
        .single();

      const retryCount = jobDetails?.retry_count ?? 0;

      if (retryCount < MAX_DOWNLOAD_RETRIES) {
        // Re-queue with incremented retry count
        await supabase.from("pipeline_jobs").insert({
          user_id: user.userId,
          track_id: job.track_id,
          job_type: "download",
          payload: jobDetails?.payload ?? null,
          retry_count: retryCount + 1,
        });
      } else {
        // Max retries exceeded — mark track as failed
        await supabase
          .from("tracks")
          .update({
            acquisition_status: "failed",
            updated_at: new Date().toISOString(),
          })
          .eq("id", job.track_id)
          .eq("user_id", user.userId);
      }
    } else if (body.status === "failed" && job.job_type === "audio_analysis") {
      // Audio analysis failed — still queue metadata so pipeline doesn't stall
      const { data: existing } = await supabase
        .from("pipeline_jobs")
        .select("id")
        .eq("track_id", job.track_id)
        .eq("job_type", "metadata")
        .in("status", ["pending", "claimed", "running"])
        .limit(1)
        .maybeSingle();

      if (!existing) {
        const metaPayload = await buildMetadataPayload(supabase, job.track_id, user.userId);
        if (metaPayload) {
          await supabase.from("pipeline_jobs").insert({
            user_id: user.userId,
            track_id: job.track_id,
            job_type: "metadata",
            payload: metaPayload,
          });
        }
      }
    }
  } catch (err) {
    console.error(
      `report_job_result failed for job ${jobId} (type=${job.job_type}):`,
      err
    );
    throw err;
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
