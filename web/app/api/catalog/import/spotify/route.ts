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
import { getUserSettings, getJobSettings } from "@/lib/api-server/job-settings";

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
  const preview = request.nextUrl.searchParams.get("preview") === "true";

  // Supabase client (needed for preview ownership check and normal upsert path)
  const supabase = createServiceClient();

  // Get Spotify access token
  let accessToken: string;
  try {
    accessToken = await getSpotifyToken(user.userId);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to get Spotify token";
    return jsonError(message, 401);
  }

  // Paginate through items — use /me/tracks for Liked Songs, /playlists/{id}/items otherwise
  // Fetch up to MAX_PAGES pages per request to stay within Vercel's 10s timeout.
  const MAX_PAGES = 8; // 8 × 50 = 400 tracks per request
  const allItems: SpotifyPlaylistItem[] = [];
  const isLiked = playlistId === "liked";
  const offset = parseInt(request.nextUrl.searchParams.get("offset") ?? "0", 10) || 0;
  let url: string | null = isLiked
    ? `${SPOTIFY_API}/me/tracks?limit=50&offset=${offset}`
    : `${SPOTIFY_API}/playlists/${encodeURIComponent(playlistId)}/items?limit=50&offset=${offset}`;

  let pagesRead = 0;
  let hasMore = false;
  let nextOffset = offset;

  while (url && pagesRead < MAX_PAGES) {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!resp.ok) {
      const errBody = await resp.text();
      console.error("Spotify tracks error:", resp.status, errBody);
      if (resp.status === 403) {
        return jsonError(
          "This playlist can't be read directly from Spotify. Export it as CSV from exportify.app and import it using the CSV option instead.",
          403
        );
      }
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

    pagesRead++;
    nextOffset += page.items.length;

    if (page.next && pagesRead < MAX_PAGES) {
      url = page.next;
    } else {
      hasMore = !!page.next;
      url = null;
    }
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

  // Preview mode: return parsed tracks + ownership info without inserting
  if (preview) {
    const spotifyUris = trackRows
      .map((r) => r.spotify_uri as string)
      .filter(Boolean);
    const ownedUris = new Set<string>();
    for (let i = 0; i < spotifyUris.length; i += 500) {
      const batch = spotifyUris.slice(i, i + 500);
      const { data: owned } = await supabase
        .from("tracks")
        .select("spotify_uri")
        .eq("user_id", user.userId)
        .eq("acquisition_status", "available")
        .in("spotify_uri", batch);
      for (const row of owned ?? []) {
        if (row.spotify_uri) ownedUris.add(row.spotify_uri as string);
      }
    }

    const previewTracks = trackRows.map((r) => ({
      _key: r.spotify_uri as string,
      source: r.source as string,
      title: (r.title as string) ?? "",
      artist: (r.artist as string) ?? "",
      artists: r.artists as string | undefined,
      album: r.album as string | undefined,
      year: r.year as number | undefined,
      duration_ms: r.duration_ms as number | undefined,
      genres: null as string | null,
      spotify_uri: r.spotify_uri as string | undefined,
      artwork_url: r.artwork_url as string | undefined,
      search_string: r.search_string as string,
      already_owned: ownedUris.has(r.spotify_uri as string),
      release_date: r.release_date as string | undefined,
      isrc: r.isrc as string | undefined,
      popularity: r.popularity as number | undefined,
      explicit: r.explicit as boolean | undefined,
      added_by: r.added_by as string | undefined,
      added_at: r.added_at as string | undefined,
    }));

    return NextResponse.json(
      {
        tracks: previewTracks,
        total: previewTracks.length,
        has_more: hasMore,
        next_offset: hasMore ? nextOffset : null,
      },
      { status: 200 }
    );
  }

  // Upsert tracks, ignoring duplicates on (user_id, spotify_uri)
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
  const imported = insertedRows.length;
  const skippedDuplicates = allItems.length - imported;

  // Re-fetch all track IDs by spotify_uri (includes pre-existing duplicates)
  // so the review step shows every track, not just newly inserted ones.
  // Batch in chunks of 100 to avoid PostgREST URL length limits.
  const spotifyUris = trackRows
    .map((r) => r.spotify_uri as string)
    .filter(Boolean);

  const trackIds: number[] = [];
  for (let i = 0; i < spotifyUris.length; i += 100) {
    const batch = spotifyUris.slice(i, i + 100);
    const { data: batchRows } = await supabase
      .from("tracks")
      .select("id")
      .eq("user_id", user.userId)
      .in("spotify_uri", batch);
    trackIds.push(...(batchRows ?? []).map((r) => r.id));
  }

  // Create pipeline jobs for newly imported tracks
  let jobsCreated = 0;
  if (queueJobs && trackIds.length > 0) {
    const userSettings = await getUserSettings(supabase, user.userId);
    const downloadSettings = getJobSettings(userSettings, "download");

    // Fetch track data needed for download payloads (batch by 100)
    const trackDataMap = new Map<number, Record<string, unknown>>();
    for (let i = 0; i < trackIds.length; i += 100) {
      const batch = trackIds.slice(i, i + 100);
      const { data: rows } = await supabase
        .from("tracks")
        .select("id, search_string, artist, title, duration_ms")
        .eq("user_id", user.userId)
        .in("id", batch);
      for (const row of rows ?? []) {
        trackDataMap.set(row.id, row);
      }
    }

    const jobs = trackIds.map((trackId: number) => {
      const track = trackDataMap.get(trackId) ?? {};
      return {
        user_id: user.userId,
        track_id: trackId,
        job_type: "download",
        payload: {
          track_id: trackId,
          search_string: (track.search_string as string) ?? "",
          artist: (track.artist as string) ?? "",
          title: (track.title as string) ?? "",
          duration_ms: (track.duration_ms as number) ?? 0,
          ...(Object.keys(downloadSettings).length > 0 && { settings: downloadSettings }),
        },
      };
    });

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
      has_more: hasMore,
      next_offset: hasMore ? nextOffset : null,
    },
    { status: 201 }
  );
}
