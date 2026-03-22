/**
 * POST /api/catalog/tracks/[id]/preview-url
 *
 * Refresh a stale Spotify preview URL. Looks up the track's spotify_uri,
 * fetches fresh data from Spotify, updates the DB, and returns the new URL.
 * POST (not GET) because it writes to the DB.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";
import { rateLimit, limiters } from "@/lib/api-server/rate-limit";
import { createServiceClient } from "@/lib/supabase/service";
import { jsonError } from "@/lib/api-server/errors";
import { getSpotifyToken } from "@/lib/api-server/spotify";

const SPOTIFY_API = "https://api.spotify.com/v1";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const rl = await rateLimit(request, limiters.read);
  if (rl) return rl;

  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  const { id } = await params;
  const trackId = parseInt(id, 10);
  if (isNaN(trackId)) return jsonError("Invalid track ID", 400);

  const supabase = createServiceClient();

  // Fetch the track's spotify_uri
  const { data: track, error: fetchError } = await supabase
    .from("tracks")
    .select("spotify_uri")
    .eq("id", trackId)
    .eq("user_id", user.userId)
    .single();

  if (fetchError || !track) return jsonError("Track not found", 404);
  if (!track.spotify_uri) return jsonError("Track has no Spotify URI", 400);

  // Get Spotify access token
  let accessToken: string;
  try {
    accessToken = await getSpotifyToken(user.userId);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to get Spotify token";
    return jsonError(message, 401);
  }

  // Extract Spotify track ID from URI (spotify:track:XXXXX)
  const parts = (track.spotify_uri as string).split(":");
  if (parts.length !== 3 || parts[1] !== "track") {
    return jsonError("Invalid spotify_uri format", 400);
  }

  const resp = await fetch(`${SPOTIFY_API}/tracks/${parts[2]}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!resp.ok) {
    return jsonError(
      `Spotify API error: ${resp.status} ${resp.statusText}`,
      502
    );
  }

  const data = (await resp.json()) as { preview_url?: string | null };
  const previewUrl = data.preview_url || null;

  // Update DB
  await supabase
    .from("tracks")
    .update({ preview_url: previewUrl })
    .eq("id", trackId)
    .eq("user_id", user.userId);

  return NextResponse.json({ preview_url: previewUrl });
}
