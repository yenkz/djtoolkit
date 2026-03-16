/**
 * POST /api/catalog/import/spotify
 *
 * Import tracks from a Spotify playlist into the catalog. Paginates through
 * all playlist items, maps them to the tracks schema, upserts (skipping
 * duplicates by spotify_uri), and optionally creates pipeline jobs.
 */

export const maxDuration = 10;

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";
import { rateLimit, limiters } from "@/lib/api-server/rate-limit";
import { createServiceClient } from "@/lib/supabase/service";
import { jsonError } from "@/lib/api-server/errors";
import { auditLog, getClientIp } from "@/lib/api-server/audit";
import { getSpotifyToken, buildSearchString } from "@/lib/api-server/spotify";

const SPOTIFY_API = "https://api.spotify.com/v1";

interface SpotifyPlaylistItem {
  track?: SpotifyTrack | null;
  item?: SpotifyTrack | null;
  added_by?: { id?: string };
  added_at?: string;
}

interface SpotifyTrack {
  name?: string;
  uri?: string;
  duration_ms?: number;
  popularity?: number;
  explicit?: boolean;
  artists?: Array<{ name: string }>;
  album?: {
    name?: string;
    release_date?: string;
    images?: Array<{ url: string }>;
  };
  external_ids?: { isrc?: string };
}

function mapSpotifyTrack(
  item: SpotifyPlaylistItem,
  userId: string
): Record<string, unknown> {
  const track = item.track || item.item || ({} as SpotifyTrack);
  const artists = track.artists || [];
  const album = track.album || {};
  const images = album.images || [];
  const releaseDate = album.release_date || "";

  return {
    user_id: userId,
    title: track.name || null,
    artist: artists[0]?.name || "",
    artists: artists.map((a) => a.name).join("|"),
    album: album.name || null,
    year:
      releaseDate.length >= 4 ? parseInt(releaseDate.slice(0, 4)) : null,
    release_date: releaseDate || null,
    duration_ms: track.duration_ms || null,
    isrc: track.external_ids?.isrc || null,
    spotify_uri: track.uri || null,
    popularity: track.popularity ?? null,
    explicit: track.explicit || false,
    added_by: item.added_by?.id || null,
    added_at: item.added_at || null,
    artwork_url:
      images.length > 1
        ? images[images.length - 1]?.url
        : images[0]?.url || null,
    search_string: buildSearchString(
      artists[0]?.name || "",
      (track.name || "") as string
    ),
    acquisition_status: "candidate",
    source: "spotify",
  };
}

export async function POST(request: NextRequest) {
  const rl = await rateLimit(request, limiters.import);
  if (rl) return rl;

  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  // Parse body
  let body: { playlist_id?: string };
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  const playlistId = body.playlist_id;
  if (!playlistId || typeof playlistId !== "string") {
    return jsonError("playlist_id is required", 400);
  }

  const queueJobs =
    request.nextUrl.searchParams.get("queue_jobs") !== "false";

  // Get Spotify access token
  let accessToken: string;
  try {
    accessToken = await getSpotifyToken(user.userId);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to get Spotify token";
    return jsonError(message, 401);
  }

  // Paginate through playlist items
  const allItems: SpotifyPlaylistItem[] = [];
  let url: string | null =
    `${SPOTIFY_API}/playlists/${encodeURIComponent(playlistId)}/tracks?limit=100`;

  while (url) {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!resp.ok) {
      const errBody = await resp.text();
      console.error("Spotify playlist tracks error:", resp.status, errBody);
      return jsonError(
        `Spotify API error: ${resp.status} ${resp.statusText}`,
        502
      );
    }

    const page = (await resp.json()) as {
      items: SpotifyPlaylistItem[];
      next: string | null;
    };

    // Filter out null/local tracks
    for (const item of page.items) {
      const track = item.track || item.item;
      if (track?.uri && !track.uri.startsWith("spotify:local:")) {
        allItems.push(item);
      }
    }

    url = page.next;
  }

  if (allItems.length === 0) {
    return NextResponse.json(
      { imported: 0, skipped_duplicates: 0, jobs_created: 0, track_ids: [] },
      { status: 201 }
    );
  }

  // Map to track rows
  const trackRows = allItems.map((item) =>
    mapSpotifyTrack(item, user.userId)
  );

  // Upsert tracks, ignoring duplicates on (user_id, spotify_uri)
  const supabase = createServiceClient();

  const { data: inserted, error: insertError } = await supabase
    .from("tracks")
    .upsert(trackRows, {
      onConflict: "user_id, spotify_uri",
      ignoreDuplicates: true,
    })
    .select("id");

  if (insertError) {
    return jsonError(`Failed to insert tracks: ${insertError.message}`, 500);
  }

  const insertedRows = inserted ?? [];
  const trackIds = insertedRows.map((r) => r.id);
  const imported = trackIds.length;
  const skippedDuplicates = allItems.length - imported;

  // Create pipeline jobs for newly imported tracks
  let jobsCreated = 0;
  if (queueJobs && trackIds.length > 0) {
    const jobs = trackIds.map((trackId: number) => ({
      user_id: user.userId,
      track_id: trackId,
      stage: "download",
      status: "pending",
    }));

    const { data: createdJobs, error: jobError } = await supabase
      .from("pipeline_jobs")
      .insert(jobs)
      .select("id");

    if (!jobError && createdJobs) {
      jobsCreated = createdJobs.length;
    }
  }

  // Audit log
  await auditLog(user.userId, "track.import.spotify", {
    resourceType: "playlist",
    resourceId: playlistId,
    details: { imported, skipped_duplicates: skippedDuplicates, jobsCreated },
    ipAddress: getClientIp(request),
  });

  return NextResponse.json(
    {
      imported,
      skipped_duplicates: skippedDuplicates,
      jobs_created: jobsCreated,
      track_ids: trackIds,
    },
    { status: 201 }
  );
}
