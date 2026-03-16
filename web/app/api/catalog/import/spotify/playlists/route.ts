/**
 * GET /api/catalog/import/spotify/playlists
 *
 * Returns importable Spotify sources for the authenticated user:
 * Liked Songs + all user playlists (owned and followed).
 */

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";
import { rateLimit, limiters } from "@/lib/api-server/rate-limit";
import { jsonError } from "@/lib/api-server/errors";
import { getSpotifyToken } from "@/lib/api-server/spotify";

const SPOTIFY_API = "https://api.spotify.com/v1";

interface SpotifyPlaylistItem {
  id: string;
  name: string;
  tracks?: { total?: number };
  items?: { total?: number };
  owner?: { id?: string; display_name?: string };
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

  const headers = { Authorization: `Bearer ${accessToken}` };

  // Fetch profile for display name + Spotify user ID
  const meResp = await fetch(`${SPOTIFY_API}/me`, { headers });
  if (!meResp.ok) {
    return jsonError("Failed to fetch Spotify profile", 502);
  }
  const meData = (await meResp.json()) as {
    id?: string;
    display_name?: string;
  };
  const spotifyUserId = meData.id;

  // Fetch Liked Songs count
  const likedResp = await fetch(`${SPOTIFY_API}/me/tracks?limit=1`, {
    headers,
  });
  const likedCount = likedResp.ok
    ? ((await likedResp.json()) as { total?: number }).total ?? 0
    : 0;

  // Build results starting with Liked Songs
  const results: Array<{
    id: string;
    name: string;
    track_count: number | null;
    owner: string;
    owner_id: string;
    image_url: string | null;
    is_owner: boolean;
  }> = [
    {
      id: "liked",
      name: "Liked Songs",
      track_count: likedCount,
      owner: meData.display_name ?? "",
      owner_id: meData.id ?? "",
      image_url: null,
      is_owner: true,
    },
  ];

  // Paginate through user's playlists
  const seenIds = new Set<string>();
  let url: string | null = `${SPOTIFY_API}/me/playlists?limit=50`;

  while (url) {
    const resp = await fetch(url, { headers });
    if (!resp.ok) break;

    const data = (await resp.json()) as {
      items: SpotifyPlaylistItem[];
      next: string | null;
    };

    for (const p of data.items ?? []) {
      if (!p || seenIds.has(p.id)) continue;
      seenIds.add(p.id);

      const images = p.images ?? [];
      const ownerObj = p.owner ?? {};
      const ownerId = ownerObj.id;

      results.push({
        id: p.id,
        name: p.name,
        track_count: (p.tracks ?? p.items)?.total ?? null,
        owner: ownerObj.display_name ?? "",
        owner_id: ownerId ?? "",
        image_url: images[0]?.url ?? null,
        is_owner: spotifyUserId && ownerId ? ownerId === spotifyUserId : false,
      });
    }

    url = data.next;
  }

  return NextResponse.json(results);
}
