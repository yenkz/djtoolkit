/**
 * POST /api/catalog/backfill-artwork
 *
 * Backfill artwork URLs from Spotify for tracks missing artwork. Processes
 * one batch of up to 50 tracks per invocation to stay within Vercel's 10s
 * timeout. Use the `offset` query param for pagination across invocations.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";
import { rateLimit, limiters } from "@/lib/api-server/rate-limit";
import { createServiceClient } from "@/lib/supabase/service";
import { jsonError } from "@/lib/api-server/errors";
import { auditLog, getClientIp } from "@/lib/api-server/audit";
import { getSpotifyToken } from "@/lib/api-server/spotify";

const SPOTIFY_API = "https://api.spotify.com/v1";
const BATCH_SIZE = 50;

export async function POST(request: NextRequest) {
  const rl = await rateLimit(request, limiters.backfill);
  if (rl) return rl;

  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  const rawOffset = request.nextUrl.searchParams.get("offset");
  const offset = rawOffset ? parseInt(rawOffset, 10) : 0;

  let accessToken: string;
  try {
    accessToken = await getSpotifyToken(user.userId);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to get Spotify token";
    return jsonError(message, 401);
  }

  const supabase = createServiceClient();

  // Count total tracks missing artwork
  const { count: totalMissing } = await supabase
    .from("tracks")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.userId)
    .not("spotify_uri", "is", null)
    .is("artwork_url", null);

  // Fetch one batch of tracks missing artwork
  const { data: tracks, error: fetchError } = await supabase
    .from("tracks")
    .select("id, spotify_uri")
    .eq("user_id", user.userId)
    .not("spotify_uri", "is", null)
    .is("artwork_url", null)
    .order("id", { ascending: true })
    .range(offset, offset + BATCH_SIZE - 1);

  if (fetchError) {
    return jsonError("Failed to fetch tracks", 500);
  }

  const rows = tracks ?? [];

  if (rows.length === 0) {
    return NextResponse.json({
      updated: 0,
      total_missing: totalMissing ?? 0,
      next_offset: null,
    });
  }

  // Extract Spotify track IDs from URIs (spotify:track:XXXXX -> XXXXX)
  const trackIdMap = new Map<string, number>(); // spotify_id -> db track id
  for (const row of rows) {
    const uri = row.spotify_uri as string;
    const parts = uri.split(":");
    if (parts.length === 3 && parts[1] === "track") {
      trackIdMap.set(parts[2], row.id);
    }
  }

  if (trackIdMap.size === 0) {
    return NextResponse.json({
      updated: 0,
      total_missing: totalMissing ?? 0,
      next_offset: null,
    });
  }

  // Fetch track details from Spotify (max 50 IDs per request)
  const spotifyIds = Array.from(trackIdMap.keys());
  const resp = await fetch(
    `${SPOTIFY_API}/tracks?ids=${spotifyIds.join(",")}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!resp.ok) {
    return jsonError(
      `Spotify API error: ${resp.status} ${resp.statusText}`,
      502
    );
  }

  const data = (await resp.json()) as {
    tracks: Array<{
      id: string;
      album?: { images?: Array<{ url: string }> };
    } | null>;
  };

  // Update artwork URLs
  let updated = 0;
  for (const spotifyTrack of data.tracks) {
    if (!spotifyTrack) continue;

    const images = spotifyTrack.album?.images ?? [];
    const artworkUrl =
      images.length > 1
        ? images[images.length - 1]?.url
        : images[0]?.url ?? null;

    if (!artworkUrl) continue;

    const dbId = trackIdMap.get(spotifyTrack.id);
    if (!dbId) continue;

    const { error: updateError } = await supabase
      .from("tracks")
      .update({ artwork_url: artworkUrl })
      .eq("id", dbId)
      .eq("user_id", user.userId);

    if (!updateError) {
      updated++;
    }
  }

  const nextOffset =
    rows.length === BATCH_SIZE ? offset + BATCH_SIZE : null;

  await auditLog(user.userId, "track.backfill_artwork", {
    details: { updated, batch_offset: offset },
    ipAddress: getClientIp(request),
  });

  return NextResponse.json({
    updated,
    total_missing: totalMissing ?? 0,
    next_offset: nextOffset,
  });
}
