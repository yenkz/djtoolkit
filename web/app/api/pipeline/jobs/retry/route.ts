import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";
import { rateLimit, limiters } from "@/lib/api-server/rate-limit";
import { auditLog, getClientIp } from "@/lib/api-server/audit";
import { createServiceClient } from "@/lib/supabase/service";
import { jsonError } from "@/lib/api-server/errors";

interface RetryBody {
  job_ids?: string[];
  filter_status?: string;
  filter_job_type?: string;
}

export async function POST(request: NextRequest) {
  const rateLimitResponse = await rateLimit(request, limiters.write);
  if (rateLimitResponse) return rateLimitResponse;

  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  let body: RetryBody;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  const supabase = createServiceClient();
  let retried = 0;

  if (body.job_ids && body.job_ids.length > 0) {
    // Retry specific jobs by ID
    const { data, error } = await supabase
      .from("pipeline_jobs")
      .update({
        status: "pending",
        claimed_at: null,
        completed_at: null,
        agent_id: null,
        error: null,
        result: null,
      })
      .eq("user_id", user.userId)
      .in("id", body.job_ids)
      .in("status", ["failed", "done"])
      .select("id");

    if (error) {
      return jsonError("Failed to retry jobs", 500);
    }
    retried = data?.length ?? 0;
  } else {
    // Retry by filter
    let query = supabase
      .from("pipeline_jobs")
      .update({
        status: "pending",
        claimed_at: null,
        completed_at: null,
        agent_id: null,
        error: null,
        result: null,
      })
      .eq("user_id", user.userId);

    if (
      body.filter_status &&
      (body.filter_status === "failed" || body.filter_status === "done")
    ) {
      query = query.eq("status", body.filter_status);
    } else {
      query = query.in("status", ["failed", "done"]);
    }

    if (body.filter_job_type) {
      query = query.eq("job_type", body.filter_job_type);
    }

    const { data, error } = await query.select("id");

    if (error) {
      return jsonError("Failed to retry jobs", 500);
    }
    retried = data?.length ?? 0;
  }

  await auditLog(user.userId, "job.retry", {
    resourceType: "pipeline_job",
    details: {
      retried,
      job_ids: body.job_ids ?? null,
      filter_status: body.filter_status ?? null,
      filter_job_type: body.filter_job_type ?? null,
    },
    ipAddress: getClientIp(request),
  });

  return NextResponse.json({ retried });
}
