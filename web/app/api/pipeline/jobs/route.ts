import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";
import { rateLimit, limiters } from "@/lib/api-server/rate-limit";
import { auditLog, getClientIp } from "@/lib/api-server/audit";
import { createServiceClient } from "@/lib/supabase/service";

export async function GET(request: NextRequest) {
  const rateLimitResponse = await rateLimit(request, limiters.read);
  if (rateLimitResponse) return rateLimitResponse;

  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  const { searchParams } = request.nextUrl;
  const rawLimit = searchParams.get("limit");
  let limit = rawLimit !== null ? parseInt(rawLimit, 10) : 2;
  if (isNaN(limit) || limit < 1) limit = 1;
  if (limit > 10) limit = 10;

  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from("pipeline_jobs")
    .select("id, job_type, status, track_id, payload, created_at")
    .eq("user_id", user.userId)
    .eq("status", "pending")
    .order("priority", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) {
    await auditLog(user.userId, "pipeline_jobs.fetch.error", {
      ipAddress: getClientIp(request),
      details: { error: error.message },
    });
    return NextResponse.json({ error: "Failed to fetch jobs" }, { status: 500 });
  }

  await auditLog(user.userId, "pipeline_jobs.fetch", {
    ipAddress: getClientIp(request),
    details: { count: data.length, limit },
  });

  const jobs = (data ?? []).map((row) => ({
    id: String(row.id),
    job_type: row.job_type,
    status: row.status,
    track_id: row.track_id,
    payload: row.payload,
    created_at: row.created_at,
  }));

  return NextResponse.json(jobs);
}
