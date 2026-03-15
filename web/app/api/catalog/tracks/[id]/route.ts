import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";
import { rateLimit, limiters } from "@/lib/api-server/rate-limit";
import { createServiceClient } from "@/lib/supabase/service";
import { jsonError } from "@/lib/api-server/errors";

const TRACK_COLUMNS = [
  "id",
  "acquisition_status",
  "source",
  "title",
  "artist",
  "artists",
  "album",
  "year",
  "duration_ms",
  "genres",
  "tempo",
  "artwork_url",
  "spotify_uri",
  "local_path",
  "fingerprinted",
  "enriched_spotify",
  "enriched_audio",
  "metadata_written",
  "cover_art_written",
  "in_library",
  "metadata_source",
  "created_at",
  "updated_at",
].join(", ");

/**
 * GET /api/catalog/tracks/[id]
 *
 * Fetch a single track by ID. Returns 404 if not found or not owned by the
 * authenticated user.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const rl = await rateLimit(request, limiters.read);
  if (rl) return rl;

  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  const { id: rawId } = await params;
  const trackId = parseInt(rawId, 10);
  if (isNaN(trackId)) {
    return jsonError("Invalid track ID", 400);
  }

  const supabase = createServiceClient();

  const { data: track, error } = await supabase
    .from("tracks")
    .select(TRACK_COLUMNS)
    .eq("id", trackId)
    .eq("user_id", user.userId)
    .maybeSingle();

  if (error) {
    return jsonError("Failed to fetch track", 500);
  }

  if (!track) {
    return jsonError("Track not found", 404);
  }

  return NextResponse.json(track);
}
