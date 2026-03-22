import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";
import { rateLimit, limiters } from "@/lib/api-server/rate-limit";
import { auditLog, getClientIp } from "@/lib/api-server/audit";
import { createServiceClient } from "@/lib/supabase/service";
import { jsonError } from "@/lib/api-server/errors";
import { getUserSettings, getJobSettings } from "@/lib/api-server/job-settings";

interface PreviewTrack {
  _key: string;
  source: string;
  title: string;
  artist: string;
  artists?: string;
  album?: string;
  year?: number;
  duration_ms?: number;
  genres?: string;
  spotify_uri?: string;
  artwork_url?: string;
  search_string?: string;
  already_owned: boolean;
  release_date?: string;
  isrc?: string;
  popularity?: number;
  record_label?: string;
  danceability?: number;
  energy?: number;
  key?: number;
  loudness?: number;
  mode?: number;
  speechiness?: number;
  acousticness?: number;
  instrumentalness?: number;
  liveness?: number;
  valence?: number;
  tempo?: number;
  time_signature?: number;
  explicit?: boolean;
  added_by?: string;
  added_at?: string;
}

const MAX_TRACKS = 2000;

/**
 * POST /api/catalog/import/confirm
 *
 * Insert user-confirmed preview tracks into the tracks table and optionally
 * create download pipeline jobs.
 *
 * Body: { tracks: PreviewTrack[], queue_jobs: boolean }
 * Returns 201: { imported, skipped_duplicates, jobs_created, track_ids }
 */
export async function POST(request: NextRequest) {
  const rl = await rateLimit(request, limiters.import);
  if (rl) return rl;

  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  let body: { tracks?: PreviewTrack[]; queue_jobs?: boolean };
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  const { tracks, queue_jobs: queueJobs = false } = body;
  if (!Array.isArray(tracks) || tracks.length === 0) {
    return jsonError("tracks must be a non-empty array", 400);
  }
  if (tracks.length > MAX_TRACKS) {
    return jsonError(`tracks exceeds maximum of ${MAX_TRACKS}`, 400);
  }

  const supabase = createServiceClient();

  // Split tracks by dedup strategy
  const withUri = tracks.filter((t) => t.spotify_uri);
  const withoutUri = tracks.filter((t) => !t.spotify_uri);

  let totalImported = 0;
  let totalSkipped = 0;
  const allInsertedIds: number[] = [];

  // ── Tracks with spotify_uri: use upsert with ignoreDuplicates ──
  if (withUri.length > 0) {
    const rows = withUri.map((t) => ({
      user_id: user.userId,
      acquisition_status: "candidate",
      source: t.source,
      title: t.title || null,
      artist: t.artist || null,
      artists: t.artists || null,
      album: t.album || null,
      year: t.year ?? null,
      duration_ms: t.duration_ms ?? null,
      genres: t.genres || null,
      spotify_uri: t.spotify_uri,
      artwork_url: t.artwork_url || null,
      search_string: t.search_string || null,
      release_date: t.release_date || null,
      isrc: t.isrc || null,
      popularity: t.popularity ?? null,
      record_label: t.record_label || null,
      danceability: t.danceability ?? null,
      energy: t.energy ?? null,
      key: t.key ?? null,
      loudness: t.loudness ?? null,
      mode: t.mode ?? null,
      speechiness: t.speechiness ?? null,
      acousticness: t.acousticness ?? null,
      instrumentalness: t.instrumentalness ?? null,
      liveness: t.liveness ?? null,
      valence: t.valence ?? null,
      tempo: t.tempo ?? null,
      time_signature: t.time_signature ?? null,
      explicit: t.explicit ?? null,
      added_by: t.added_by || null,
      added_at: t.added_at || null,
    }));

    const { error: upsertErr } = await supabase
      .from("tracks")
      .upsert(rows, { onConflict: "user_id,spotify_uri", ignoreDuplicates: true });

    if (upsertErr) {
      return jsonError(`Failed to insert tracks: ${upsertErr.message}`, 500);
    }

    // Fetch IDs of newly inserted candidate tracks
    const uris = withUri.map((t) => t.spotify_uri!);
    for (let i = 0; i < uris.length; i += 500) {
      const batch = uris.slice(i, i + 500);
      const { data: matched } = await supabase
        .from("tracks")
        .select("id, acquisition_status")
        .eq("user_id", user.userId)
        .in("spotify_uri", batch);
      for (const row of matched ?? []) {
        if (row.acquisition_status === "candidate") {
          totalImported++;
          allInsertedIds.push(row.id);
        } else {
          totalSkipped++;
        }
      }
    }
  }

  // ── Tracks without spotify_uri (TrackID): dedup by title+artist ──
  if (withoutUri.length > 0) {
    const { data: existingRows } = await supabase
      .from("tracks")
      .select("title, artist")
      .eq("user_id", user.userId);
    const existingSet = new Set(
      (existingRows ?? [])
        .filter((r: Record<string, unknown>) => r.title && r.artist)
        .map((r: Record<string, unknown>) =>
          `${String(r.title).toLowerCase().trim()}|${String(r.artist).toLowerCase().trim()}`
        )
    );

    for (const t of withoutUri) {
      const key = `${t.title.toLowerCase().trim()}|${t.artist.toLowerCase().trim()}`;
      if (existingSet.has(key)) {
        totalSkipped++;
        continue;
      }

      const { data: row, error: insertErr } = await supabase
        .from("tracks")
        .insert({
          user_id: user.userId,
          acquisition_status: "candidate",
          source: t.source,
          title: t.title || null,
          artist: t.artist || null,
          artists: t.artists || null,
          duration_ms: t.duration_ms ?? null,
          search_string: t.search_string || null,
        })
        .select("id")
        .maybeSingle();

      if (insertErr || !row) {
        totalSkipped++;
        continue;
      }

      totalImported++;
      allInsertedIds.push(row.id);
      existingSet.add(key);
    }
  }

  // ── Create download pipeline jobs ──
  let jobsCreated = 0;
  if (queueJobs && allInsertedIds.length > 0) {
    const userSettings = await getUserSettings(supabase, user.userId);
    const downloadSettings = getJobSettings(userSettings, "download");

    // Fetch track data for job payloads
    const trackDataMap = new Map<number, Record<string, unknown>>();
    for (let i = 0; i < allInsertedIds.length; i += 500) {
      const batch = allInsertedIds.slice(i, i + 500);
      const { data: rows } = await supabase
        .from("tracks")
        .select("id, search_string, artist, title, duration_ms, acquisition_status")
        .eq("user_id", user.userId)
        .eq("acquisition_status", "candidate")
        .in("id", batch);
      for (const row of rows ?? []) {
        trackDataMap.set(row.id, row);
      }
    }

    const jobRows = [...trackDataMap.entries()].map(([trackId, track]) => ({
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
    }));

    if (jobRows.length > 0) {
      const { data: createdJobs, error: jobErr } = await supabase
        .from("pipeline_jobs")
        .insert(jobRows)
        .select("id");

      if (!jobErr && createdJobs) {
        jobsCreated = createdJobs.length;
      }
    }
  }

  await auditLog(user.userId, "track.import.confirm", {
    resourceType: "track",
    details: {
      imported: totalImported,
      skipped_duplicates: totalSkipped,
      jobs_created: jobsCreated,
      sources: [...new Set(tracks.map((t) => t.source))],
    },
    ipAddress: getClientIp(request),
  });

  return NextResponse.json(
    {
      imported: totalImported,
      skipped_duplicates: totalSkipped,
      jobs_created: jobsCreated,
      track_ids: allInsertedIds,
    },
    { status: 201 }
  );
}
