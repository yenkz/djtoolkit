import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";
import { rateLimit, limiters } from "@/lib/api-server/rate-limit";
import { createServiceClient } from "@/lib/supabase/service";
import { jsonError } from "@/lib/api-server/errors";

export async function GET(request: NextRequest) {
  const rateLimitResponse = await rateLimit(request, limiters.read);
  if (rateLimitResponse) return rateLimitResponse;

  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  const { searchParams } = request.nextUrl;

  let page = parseInt(searchParams.get("page") ?? "1", 10);
  if (isNaN(page) || page < 1) page = 1;

  let perPage = parseInt(searchParams.get("per_page") ?? "50", 10);
  if (isNaN(perPage) || perPage < 1) perPage = 1;
  if (perPage > 200) perPage = 200;

  const statusFilter = searchParams.get("status");
  const jobTypeFilter = searchParams.get("job_type");

  const supabase = createServiceClient();

  // Build the query for pipeline_jobs
  let countQuery = supabase
    .from("pipeline_jobs")
    .select("*", { count: "exact", head: true })
    .eq("user_id", user.userId);

  let dataQuery = supabase
    .from("pipeline_jobs")
    .select(
      "id, job_type, status, track_id, payload, result, error, retry_count, claimed_at, completed_at, created_at"
    )
    .eq("user_id", user.userId)
    .order("created_at", { ascending: false })
    .range((page - 1) * perPage, page * perPage - 1);

  if (statusFilter) {
    countQuery = countQuery.eq("status", statusFilter);
    dataQuery = dataQuery.eq("status", statusFilter);
  }
  if (jobTypeFilter) {
    countQuery = countQuery.eq("job_type", jobTypeFilter);
    dataQuery = dataQuery.eq("job_type", jobTypeFilter);
  }

  const [countResult, dataResult] = await Promise.all([
    countQuery,
    dataQuery,
  ]);

  if (countResult.error) {
    return jsonError("Failed to count jobs", 500);
  }
  if (dataResult.error) {
    return jsonError("Failed to fetch jobs", 500);
  }

  const total = countResult.count ?? 0;
  const jobs = dataResult.data ?? [];

  // Collect unique track_ids and batch-fetch track data
  const trackIds = [
    ...new Set(
      jobs.map((j) => j.track_id).filter((id): id is string => id != null)
    ),
  ];

  let trackMap: Record<
    string,
    {
      title: string | null;
      artist: string | null;
      artwork_url: string | null;
      album: string | null;
    }
  > = {};

  if (trackIds.length > 0) {
    const { data: tracks } = await supabase
      .from("tracks")
      .select("id, title, artist, artwork_url, album")
      .in("id", trackIds);

    if (tracks) {
      for (const t of tracks) {
        trackMap[t.id] = {
          title: t.title,
          artist: t.artist,
          artwork_url: t.artwork_url,
          album: t.album,
        };
      }
    }
  }

  // Merge track data into job results
  const enrichedJobs = jobs.map((j) => {
    const track = j.track_id ? trackMap[j.track_id] : undefined;
    return {
      id: String(j.id),
      job_type: j.job_type,
      status: j.status,
      track_id: j.track_id,
      payload: j.payload,
      result: j.result,
      error: j.error,
      retry_count: j.retry_count,
      claimed_at: j.claimed_at,
      completed_at: j.completed_at,
      created_at: j.created_at,
      track_title: track?.title ?? null,
      track_artist: track?.artist ?? null,
      track_artwork_url: track?.artwork_url ?? null,
      track_album: track?.album ?? null,
    };
  });

  return NextResponse.json({
    jobs: enrichedJobs,
    total,
    page,
    per_page: perPage,
  });
}
