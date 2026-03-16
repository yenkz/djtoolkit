/**
 * GET /api/debug/spotify — temporary debug endpoint
 * Returns raw Spotify API responses to diagnose 403/0-tracks issues.
 * DELETE THIS FILE after debugging.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  getAuthUser,
  getAuthUserFromCookies,
  isAuthError,
} from "@/lib/api-server/auth";
import { getSpotifyToken } from "@/lib/api-server/spotify";

const SPOTIFY_API = "https://api.spotify.com/v1";

export async function GET(request: NextRequest) {
  // Try Bearer token first, fall back to cookie auth (so you can visit in browser)
  let user = await getAuthUser(request);
  if (isAuthError(user)) {
    user = await getAuthUserFromCookies();
    if (isAuthError(user)) return user;
  }

  let accessToken: string;
  try {
    accessToken = await getSpotifyToken(user.userId);
  } catch (err) {
    return NextResponse.json({
      error: "token_error",
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // 1. Check /me
  const meResp = await fetch(`${SPOTIFY_API}/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const meData = await meResp.json();

  // 2. Check first playlist
  const playlistsResp = await fetch(`${SPOTIFY_API}/me/playlists?limit=3`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const playlistsData = await playlistsResp.json();

  // 3. Test tracks on first playlist (any owner) AND first user-owned playlist
  const spotifyUserId = meData.id;

  async function testTracks(playlistId: string) {
    const resp = await fetch(
      `${SPOTIFY_API}/playlists/${playlistId}/tracks?limit=5`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    return {
      status: resp.status,
      statusText: resp.statusText,
      body: await resp.json().catch(() => resp.text()),
    };
  }

  const firstPlaylist = playlistsData.items?.[0];
  const firstOwnedPlaylist = playlistsData.items?.find(
    (p: { owner?: { id?: string } }) => p.owner?.id === spotifyUserId
  );

  // Test the owned playlist with multiple endpoint variants
  const ownedId = firstOwnedPlaylist?.id;
  const headers = { Authorization: `Bearer ${accessToken}` };

  // Variant 1: /playlists/{id}/tracks (old endpoint — returns 403 in dev mode)
  const v1 = ownedId
    ? await fetch(`${SPOTIFY_API}/playlists/${ownedId}/tracks?limit=2`, { headers })
        .then(async (r) => ({ status: r.status, body: await r.json().catch(() => r.text()) }))
    : null;

  // Variant 2: /playlists/{id}/items (newer endpoint — used by FastAPI version)
  const v2 = ownedId
    ? await fetch(`${SPOTIFY_API}/playlists/${ownedId}/items?limit=2`, { headers })
        .then(async (r) => ({ status: r.status, body: await r.json().catch(() => r.text()) }))
    : null;

  // Variant 3: /playlists/{id} (full playlist object — tracks embedded)
  const v3 = ownedId
    ? await fetch(`${SPOTIFY_API}/playlists/${ownedId}?fields=id,name,tracks.total,tracks.items(track(name,artists(name),uri))&limit=2`, { headers })
        .then(async (r) => ({ status: r.status, body: await r.json().catch(() => r.text()) }))
    : null;

  // Variant 4: /me/tracks (saved/liked songs)
  const v4 = await fetch(`${SPOTIFY_API}/me/tracks?limit=2`, { headers })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => r.text()) }));

  return NextResponse.json({
    me: { status: meResp.status, spotify_user_id: meData.id, display_name: meData.display_name },
    playlists: {
      status: playlistsResp.status,
      first_three: playlistsData.items?.map((p: { id: string; name: string; tracks?: { total?: number }; owner?: { id?: string } }) => ({
        id: p.id,
        name: p.name,
        tracks_total: p.tracks?.total,
        owner_id: p.owner?.id,
      })),
    },
    test_playlist: firstOwnedPlaylist?.name ?? "(none found)",
    "v1_playlists/{id}/tracks": v1,
    "v2_playlists/{id}/items": v2,
    "v3_playlists/{id}_full": v3,
    "v4_me/tracks_saved": v4,
  });
}
