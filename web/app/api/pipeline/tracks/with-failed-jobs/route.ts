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

  const supabase = createServiceClient();

  const sp = request.nextUrl.searchParams;
  const page = Math.max(1, Number(sp.get("page")) || 1);
  const perPage = Math.min(100, Math.max(1, Number(sp.get("per_page")) || 25));
  const search = sp.get("search");

  // Get all distinct track_ids with failed jobs
  const { data: failedJobRows, error: jobsErr } = await supabase
    .from("pipeline_jobs")
    .select("track_id")
    .eq("user_id", user.userId)
    .eq("status", "failed")
    .not("track_id", "is", null);

  if (jobsErr) {
    return jsonError("Failed to fetch failed jobs", 500);
  }

  // Deduplicate track_ids
  const allTrackIds = [...new Set(
    failedJobRows
      .map((r) => r.track_id)
      .filter((id): id is number => id != null)
  )];

  // Apply search filter if present
  let filteredTrackIds = allTrackIds;

  if (search && search.trim()) {
    const { data: searchTracks } = await supabase
      .from("tracks")
      .select("id")
      .in("id", allTrackIds)
      .or(
        `title.ilike.%${search.trim()}%,artist.ilike.%${search.trim()}%`
      );
    filteredTrackIds = (searchTracks ?? []).map((t) => t.id);
  }

  const total = filteredTrackIds.length;
  const offset = (page - 1) * perPage;
  const pageTrackIds = filteredTrackIds.slice(offset, offset + perPage);

  if (pageTrackIds.length === 0) {
    return NextResponse.json({ tracks: [], total, page, per_page: perPage });
  }

  // Batch-fetch track metadata for this page
  const { data: tracks, error: tracksErr } = await supabase
    .from("tracks")
    .select(
      "id, title, artist, album, artwork_url, acquisition_status, source, created_at, updated_at"
    )
    .in("id", pageTrackIds);

  if (tracksErr) {
    return jsonError("Failed to fetch tracks", 500);
  }

  // Batch-fetch all failed jobs for these tracks
  const { data: failedJobs, error: failedErr } = await supabase
    .from("pipeline_jobs")
    .select("id, job_type, error, completed_at, track_id, retry_count")
    .eq("user_id", user.userId)
    .eq("status", "failed")
    .in("track_id", pageTrackIds)
    .order("completed_at", { ascending: false });

  if (failedErr) {
    return jsonError("Failed to fetch failed job details", 500);
  }

  // Group failed jobs by track_id
  const jobsByTrack = new Map<number, typeof failedJobs>();
  for (const job of failedJobs ?? []) {
    if (job.track_id == null) continue;
    const list = jobsByTrack.get(job.track_id) ?? [];
    list.push(job);
    jobsByTrack.set(job.track_id, list);
  }

  // Merge and return
  const enrichedTracks = (tracks ?? []).map((t) => ({
    ...t,
    failed_jobs: (jobsByTrack.get(t.id) ?? []).map((j) => ({
      id: String(j.id),
      job_type: j.job_type,
      error: j.error,
      completed_at: j.completed_at,
      retry_count: j.retry_count,
    })),
  }));

  return NextResponse.json({
    tracks: enrichedTracks,
    total,
    page,
    per_page: perPage,
  });
}
