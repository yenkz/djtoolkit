// web/app/api/catalog/import/folder/[jobId]/report/route.ts
import { NextRequest, NextResponse } from "next/server";
import {
  getAuthUser,
  isAuthError,
} from "@/lib/api-server/auth";
import { createServiceClient } from "@/lib/supabase/service";
import { jsonError } from "@/lib/api-server/errors";

type Params = { params: Promise<{ jobId: string }> };

const TRACKED_FIELDS = [
  "artist",
  "title",
  "album",
  "tempo",
  "key",
  "genres",
  "cover_art_written",
] as const;

// GET — metadata completeness report for a folder import batch
export async function GET(request: NextRequest, { params }: Params) {
  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  const { jobId } = await params;
  const supabase = createServiceClient();

  // Get the folder_import job result to find track_ids
  const { data: job } = await supabase
    .from("pipeline_jobs")
    .select("result")
    .eq("id", jobId)
    .eq("user_id", user.userId)
    .eq("job_type", "folder_import")
    .single();

  if (!job?.result) {
    return jsonError("Job not found or not yet complete", 404);
  }

  const trackIds: number[] = (job.result as { track_ids?: number[] }).track_ids ?? [];
  if (trackIds.length === 0) {
    return NextResponse.json({ total: 0, fully_enriched: 0, missing: {}, tracks: [] });
  }

  const { data: tracks } = await supabase
    .from("tracks")
    .select(
      "id, title, artist, album, tempo, key, genres, cover_art_written, local_path, acquisition_status",
    )
    .in("id", trackIds)
    .eq("user_id", user.userId);

  if (!tracks) {
    return NextResponse.json({ total: 0, fully_enriched: 0, missing: {}, tracks: [] });
  }

  const missing: Record<string, number> = {};
  let fullyEnriched = 0;

  const trackDetails = tracks.map((t) => {
    const missingFields: string[] = [];
    for (const field of TRACKED_FIELDS) {
      const val = t[field];
      if (val === null || val === undefined || val === "" || val === false) {
        missingFields.push(field);
        missing[field] = (missing[field] ?? 0) + 1;
      }
    }
    if (missingFields.length === 0) fullyEnriched++;
    return {
      id: t.id,
      title: t.title,
      artist: t.artist,
      local_path: t.local_path,
      acquisition_status: t.acquisition_status,
      missing_fields: missingFields,
    };
  });

  return NextResponse.json({
    total: tracks.length,
    fully_enriched: fullyEnriched,
    missing,
    tracks: trackDetails,
  });
}
