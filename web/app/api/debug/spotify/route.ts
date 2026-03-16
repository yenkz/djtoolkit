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

  const tracksAny = firstPlaylist?.id ? await testTracks(firstPlaylist.id) : null;
  const tracksOwned = firstOwnedPlaylist?.id && firstOwnedPlaylist.id !== firstPlaylist?.id
    ? await testTracks(firstOwnedPlaylist.id)
    : firstOwnedPlaylist?.id === firstPlaylist?.id ? "same as first — see tracks_any" : null;

  return NextResponse.json({
    me: { status: meResp.status, data: meData },
    playlists: {
      status: playlistsResp.status,
      first_three: playlistsData.items?.map((p: { id: string; name: string; tracks?: { total?: number }; owner?: { id?: string } }) => ({
        id: p.id,
        name: p.name,
        tracks_total: p.tracks?.total,
        owner_id: p.owner?.id,
      })),
    },
    tracks_any: { playlist: firstPlaylist?.name, owner: firstPlaylist?.owner?.id, result: tracksAny },
    tracks_owned: { playlist: firstOwnedPlaylist?.name, owner: firstOwnedPlaylist?.owner?.id, result: tracksOwned },
  });
}
