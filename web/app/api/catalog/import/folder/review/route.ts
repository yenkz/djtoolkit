// web/app/api/catalog/import/folder/review/route.ts
import { NextRequest, NextResponse } from "next/server";
import {
  getAuthUser,
  isAuthError,
} from "@/lib/api-server/auth";
import { createServiceClient } from "@/lib/supabase/service";
import { jsonError } from "@/lib/api-server/errors";

interface Decision {
  track_id: number;
  action: "keep" | "skip" | "replace";
  duplicate_track_id?: number;
}

// POST — process user decisions for pending_review tracks
export async function POST(request: NextRequest) {
  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  let body: { decisions?: Decision[] };
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  const { decisions } = body;
  if (!Array.isArray(decisions) || decisions.length === 0) {
    return jsonError("decisions array is required", 400);
  }

  const supabase = createServiceClient();
  const results = { kept: 0, skipped: 0, replaced: 0, errors: 0 };

  for (const { track_id, action, duplicate_track_id } of decisions) {
    if (!["keep", "skip", "replace"].includes(action)) {
      results.errors++;
      continue;
    }

    // Verify track belongs to user and is pending_review
    const { data: track } = await supabase
      .from("tracks")
      .select("id, artist, title, duration_ms, spotify_uri, source")
      .eq("id", track_id)
      .eq("user_id", user.userId)
      .eq("acquisition_status", "pending_review")
      .single();

    if (!track) {
      results.errors++;
      continue;
    }

    if (action === "skip") {
      await supabase
        .from("tracks")
        .update({ acquisition_status: "duplicate" })
        .eq("id", track_id);
      results.skipped++;
    } else if (action === "keep" || action === "replace") {
      if (action === "replace" && duplicate_track_id) {
        // Delete the old track's DB record (file on disk left untouched)
        await supabase
          .from("tracks")
          .delete()
          .eq("id", duplicate_track_id)
          .eq("user_id", user.userId);
      }

      // Resume pipeline: set available + create spotify_lookup job
      await supabase
        .from("tracks")
        .update({ acquisition_status: "available" })
        .eq("id", track_id);

      await supabase
        .from("pipeline_jobs")
        .insert({
          user_id: user.userId,
          track_id,
          job_type: "spotify_lookup",
          payload: {
            artist: track.artist ?? "",
            title: track.title ?? "",
            duration_ms: track.duration_ms ?? 0,
            spotify_uri: track.spotify_uri ?? "",
          },
        });

      if (action === "keep") results.kept++;
      else results.replaced++;
    }
  }

  return NextResponse.json(results);
}
