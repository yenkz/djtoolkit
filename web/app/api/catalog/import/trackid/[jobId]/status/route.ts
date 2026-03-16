/**
 * GET /api/catalog/import/trackid/[jobId]/status
 *
 * Poll the status of a TrackID import job.
 *
 * Returns 200: { status, progress, step, error, result }
 * Returns 404 if the job is not found.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";
import { rateLimit, limiters } from "@/lib/api-server/rate-limit";
import { createServiceClient } from "@/lib/supabase/service";
import { jsonError } from "@/lib/api-server/errors";

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
    .select("status, progress, step, error, result")
    .eq("id", jobId)
    .maybeSingle();

  if (error) {
    return jsonError("Failed to fetch job status", 500);
  }

  if (!job) {
    return jsonError("Job not found", 404);
  }

  // `result` is stored as a JSON string — parse it so the client gets an object
  const result =
    typeof job.result === "string" ? JSON.parse(job.result) : job.result;

  return NextResponse.json({ ...job, result });
}
