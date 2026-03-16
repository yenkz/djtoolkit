/**
 * GET /api/catalog/import/spotify/playlists
 *
 * List the authenticated user's Spotify playlists. Paginates through the
 * Spotify API and deduplicates by playlist ID.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";
import { rateLimit, limiters } from "@/lib/api-server/rate-limit";
import { jsonError } from "@/lib/api-server/errors";
import { getSpotifyToken } from "@/lib/api-server/spotify";

const SPOTIFY_API = "https://api.spotify.com/v1";

interface SpotifyPlaylist {
  id: string;
  name: string;
  tracks?: { total?: number };
  owner?: { display_name?: string; id?: string };
  images?: Array<{ url: string }>;
}

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

  // Fetch current user's Spotify profile for is_owner check
  const meResp = await fetch(`${SPOTIFY_API}/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!meResp.ok) {
    return jsonError("Failed to fetch Spotify profile", 502);
  }

  const meData = (await meResp.json()) as { id?: string; display_name?: string };
  const spotifyUserId = meData.id;
  const headers = { Authorization: `Bearer ${accessToken}` };

  // Fetch Liked Songs count
  const likedResp = await fetch(`${SPOTIFY_API}/me/tracks?limit=1`, { headers });
  const likedCount = likedResp.ok
    ? ((await likedResp.json()) as { total?: number }).total ?? 0
    : 0;

  // Paginate through playlists (user-owned only — Spotify Development Mode
  // blocks /playlists/{id}/tracks for non-allowlisted playlist owners)
  const seen = new Set<string>();
  const playlists: Array<{
    id: string;
    name: string;
    track_count: number;
    owner: string;
    owner_id: string;
    image_url: string | null;
    is_owner: boolean;
  }> = [];

  // Liked Songs as the first entry (always accessible via /me/tracks)
  playlists.push({
    id: "liked",
    name: "Liked Songs",
    track_count: likedCount,
    owner: meData.display_name ?? "",
    owner_id: spotifyUserId ?? "",
    image_url: null,
    is_owner: true,
  });

  let url: string | null = `${SPOTIFY_API}/me/playlists?limit=50`;

  while (url) {
    const resp = await fetch(url, { headers });

    if (!resp.ok) {
      return jsonError(
        `Spotify API error: ${resp.status} ${resp.statusText}`,
        502
      );
    }

    const page = (await resp.json()) as {
      items: SpotifyPlaylist[];
      next: string | null;
    };

    for (const pl of page.items) {
      if (!pl.id || seen.has(pl.id)) continue;
      // Only show user-owned playlists (others will 403 in Development Mode)
      if (pl.owner?.id !== spotifyUserId) continue;
      seen.add(pl.id);

      playlists.push({
        id: pl.id,
        name: pl.name,
        track_count: pl.tracks?.total ?? 0,
        owner: pl.owner?.display_name ?? "",
        owner_id: pl.owner?.id ?? "",
        image_url: pl.images?.[0]?.url ?? null,
        is_owner: true,
      });
    }

    url = page.next;
  }

  return NextResponse.json(playlists);
}
