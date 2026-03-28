/**
 * GET /api/catalog/import/trackid/[jobId]/status
 *
 * Poll the status of a track identification job. The Hetzner analysis service
 * updates the trackid_import_jobs table directly, so this endpoint simply
 * reads the current state from the DB.
 *
 * Returns 200: { status, progress, step, error, result }
 */

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";
import { rateLimit, limiters } from "@/lib/api-server/rate-limit";
import { createServiceClient } from "@/lib/supabase/service";
import { jsonError } from "@/lib/api-server/errors";

export const maxDuration = 10;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const rl = await rateLimit(request, limiters.read);
  if (rl) return rl;

  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  const { jobId } = await params;

  if (!jobId || typeof jobId !== "string") {
    return jsonError("jobId is required", 400);
  }

  const supabase = createServiceClient();

  const { data: job, error } = await supabase
    .from("trackid_import_jobs")
    .select("status, progress, step, error, result, youtube_url, updated_at")
    .eq("id", jobId)
    .eq("user_id", user.userId)
    .maybeSingle();

  if (error) {
    return jsonError("Failed to fetch job status", 500);
  }

  if (!job) {
    return jsonError("Job not found", 404);
  }

  // Parse result if stored as JSON string
  const result =
    typeof job.result === "string" ? JSON.parse(job.result) : job.result;

  return NextResponse.json({
    status: job.status,
    progress: job.progress,
    step: job.step,
    error: job.error,
    result: result ?? null,
  });
}
