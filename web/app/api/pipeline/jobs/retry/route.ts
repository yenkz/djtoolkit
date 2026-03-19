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

  // Downstream job types that should be cancelled when retrying an earlier stage.
  // When a retried job completes again, job-result.ts will re-create them.
  const DOWNSTREAM: Record<string, string[]> = {
    download: ["fingerprint", "cover_art", "metadata"],
    fingerprint: ["cover_art", "metadata"],
    cover_art: ["metadata"],
  };

  if (body.job_ids && body.job_ids.length > 0) {
    // Fetch the jobs being retried so we know their track_ids and types
    const { data: retriedJobs } = await supabase
      .from("pipeline_jobs")
      .select("id, track_id, job_type")
      .eq("user_id", user.userId)
      .in("id", body.job_ids)
      .in("status", ["failed", "done"]);

    if (retriedJobs && retriedJobs.length > 0) {
      // Cancel pending downstream jobs for these tracks
      for (const job of retriedJobs) {
        const downstream = DOWNSTREAM[job.job_type];
        if (downstream && job.track_id) {
          await supabase
            .from("pipeline_jobs")
            .delete()
            .eq("user_id", user.userId)
            .eq("track_id", job.track_id)
            .in("job_type", downstream)
            .eq("status", "pending");
        }
      }
    }

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
    // Retry by filter — collect affected track_ids first
    let fetchQuery = supabase
      .from("pipeline_jobs")
      .select("id, track_id, job_type")
      .eq("user_id", user.userId);

    if (
      body.filter_status &&
      (body.filter_status === "failed" || body.filter_status === "done")
    ) {
      fetchQuery = fetchQuery.eq("status", body.filter_status);
    } else {
      fetchQuery = fetchQuery.in("status", ["failed", "done"]);
    }

    if (body.filter_job_type) {
      fetchQuery = fetchQuery.eq("job_type", body.filter_job_type);
    }

    const { data: affectedJobs } = await fetchQuery;

    // Cancel pending downstream jobs for affected tracks
    if (affectedJobs) {
      const tracksByDownstream = new Map<string, Set<number>>();
      for (const job of affectedJobs) {
        const downstream = DOWNSTREAM[job.job_type];
        if (downstream && job.track_id) {
          for (const dt of downstream) {
            if (!tracksByDownstream.has(dt)) tracksByDownstream.set(dt, new Set());
            tracksByDownstream.get(dt)!.add(job.track_id);
          }
        }
      }
      for (const [jobType, trackIds] of tracksByDownstream) {
        await supabase
          .from("pipeline_jobs")
          .delete()
          .eq("user_id", user.userId)
          .eq("job_type", jobType)
          .eq("status", "pending")
          .in("track_id", [...trackIds]);
      }
    }

    // Now retry the matching jobs
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
