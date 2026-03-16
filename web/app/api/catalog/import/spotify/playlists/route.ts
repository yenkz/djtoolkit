/**
 * GET /api/catalog/import/spotify/playlists
 *
 * Returns importable Spotify sources for the authenticated user.
 * Currently only Liked Songs (/me/tracks) is available — Spotify
 * Development Mode blocks /playlists/{id}/tracks for all playlists.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";
import { rateLimit, limiters } from "@/lib/api-server/rate-limit";
import { jsonError } from "@/lib/api-server/errors";
import { getSpotifyToken } from "@/lib/api-server/spotify";

const SPOTIFY_API = "https://api.spotify.com/v1";

export async function GET(request: NextRequest) {
  const rl = await rateLimit(request, limiters.read);
  if (rl) return rl;

  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  let accessToken: string;
  try {
    accessToken = await getSpotifyToken(user.userId);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to get Spotify token";
    return jsonError(message, 401);
  }

  const headers = { Authorization: `Bearer ${accessToken}` };

  // Fetch profile for display name
  const meResp = await fetch(`${SPOTIFY_API}/me`, { headers });
  if (!meResp.ok) {
    return jsonError("Failed to fetch Spotify profile", 502);
  }
  const meData = (await meResp.json()) as { id?: string; display_name?: string };

  // Fetch Liked Songs count
  const likedResp = await fetch(`${SPOTIFY_API}/me/tracks?limit=1`, { headers });
  const likedCount = likedResp.ok
    ? ((await likedResp.json()) as { total?: number }).total ?? 0
    : 0;

  return NextResponse.json([
    {
      id: "liked",
      name: "Liked Songs",
      track_count: likedCount,
      owner: meData.display_name ?? "",
      owner_id: meData.id ?? "",
      image_url: null,
      is_owner: true,
    },
  ]);
}
