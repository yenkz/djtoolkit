/**
 * GET /api/debug/spotify — temporary debug endpoint
 * Returns raw Spotify API responses to diagnose 403/0-tracks issues.
 * DELETE THIS FILE after debugging.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";
import { getSpotifyToken } from "@/lib/api-server/spotify";

const SPOTIFY_API = "https://api.spotify.com/v1";

export async function GET(request: NextRequest) {
  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

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

  // 3. Try to access first owned playlist's tracks
  let tracksResult: unknown = null;
  const firstPlaylist = playlistsData.items?.[0];
  if (firstPlaylist?.id) {
    const tracksResp = await fetch(
      `${SPOTIFY_API}/playlists/${firstPlaylist.id}/tracks?limit=5`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    tracksResult = {
      status: tracksResp.status,
      statusText: tracksResp.statusText,
      body: await tracksResp.json().catch(() => tracksResp.text()),
    };
  }

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
    tracks_test: tracksResult,
  });
}
