import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";
import { rateLimit, limiters } from "@/lib/api-server/rate-limit";
import { auditLog, getClientIp } from "@/lib/api-server/audit";
import { createServiceClient } from "@/lib/supabase/service";
import { jsonError } from "@/lib/api-server/errors";

/**
 * POST /api/pipeline/jobs/batch/claim?type=download&limit=50
 *
 * Claim pending jobs of a given type for the authenticated user's agent.
 * Returns the claimed jobs as an array.
 *
 * Query params:
 *   - type  (required): job type to claim (e.g. "download")
 *   - limit (optional): max jobs to claim, default 50, max 100
 *
 * NOTE: The Python version uses FOR UPDATE SKIP LOCKED for atomic claim.
 * The Supabase JS client doesn't support row-level locking, so we use a
 * two-step SELECT + UPDATE approach. This has a theoretical race condition
 * if multiple agents claim simultaneously — a Postgres function with
 * FOR UPDATE SKIP LOCKED would be ideal for production use.
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

  // Step 1: Select pending jobs for this user + type
  const { data: pendingJobs, error: selectErr } = await supabase
    .from("pipeline_jobs")
    .select("id")
    .eq("user_id", user.userId)
    .eq("status", "pending")
    .eq("job_type", type)
    .order("priority", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(limit);

  if (selectErr) {
    return jsonError("Failed to fetch pending jobs", 500);
  }

  if (!pendingJobs || pendingJobs.length === 0) {
    return NextResponse.json([]);
  }

  const jobIds = pendingJobs.map((j) => j.id);

  // Step 2: Update those jobs to claimed status
  // Race condition note: between SELECT and UPDATE, another agent could claim
  // the same jobs. A Postgres function with FOR UPDATE SKIP LOCKED would
  // eliminate this window. Acceptable for a personal tool with few agents.
  const { data: claimedJobs, error: updateErr } = await supabase
    .from("pipeline_jobs")
    .update({
      status: "claimed",
      claimed_at: new Date().toISOString(),
      agent_id: user.agentId ?? null,
    })
    .in("id", jobIds)
    .eq("status", "pending") // guard: only claim if still pending
    .select("id, job_type, status, track_id, payload, created_at");

  if (updateErr) {
    return jsonError("Failed to claim jobs", 500);
  }

  const jobs = (claimedJobs ?? []).map((row) => ({
    id: String(row.id),
    job_type: row.job_type,
    status: row.status,
    track_id: row.track_id,
    payload: row.payload,
    created_at: row.created_at,
  }));

  await auditLog(user.userId, "job.batch_claim", {
    resourceType: "pipeline_job",
    details: { claimed: jobs.length, job_type: type },
    ipAddress: getClientIp(request),
  });

  return NextResponse.json(jobs);
}
