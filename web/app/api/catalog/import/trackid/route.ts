/**
 * POST /api/catalog/import/trackid
 *
 * Start a TrackID import job. Accepts a YouTube URL, checks cache, and either
 * inserts tracks immediately (cache hit) or queues a background Edge Function
 * job (cache miss).
 *
 * Body: { url: string }
 * Query params:
 *   - queue_jobs (default "true") — create pipeline_jobs for each inserted track
 *
 * Returns 202: { job_id }
 */

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";
import { rateLimit, limiters } from "@/lib/api-server/rate-limit";
import { auditLog, getClientIp } from "@/lib/api-server/audit";
import { createServiceClient } from "@/lib/supabase/service";
import { jsonError } from "@/lib/api-server/errors";
import { randomUUID } from "crypto";

// ─── YouTube URL validator ───────────────────────────────────────────────────

const YT_VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/**
 * Validate and normalize a YouTube URL.
 * Accepts:
 *   - youtube.com/watch?v=VIDEO_ID
 *   - youtu.be/VIDEO_ID
 *   - youtube.com/embed/VIDEO_ID
 *
 * Returns the normalized URL on success, or throws an Error if invalid.
 */
function validateYouTubeUrl(url: string): string {
  let videoId: string | null = null;

  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");

    if (host === "youtube.com") {
      if (parsed.pathname === "/watch") {
        videoId = parsed.searchParams.get("v");
      } else if (parsed.pathname.startsWith("/embed/")) {
        videoId = parsed.pathname.slice("/embed/".length).split("/")[0];
      }
    } else if (host === "youtu.be") {
      videoId = parsed.pathname.slice(1).split("/")[0];
    }
  } catch {
    throw new Error("Invalid URL");
  }

  if (!videoId || !YT_VIDEO_ID_RE.test(videoId)) {
    throw new Error(
      "URL must be a valid YouTube video URL (youtube.com/watch?v=ID, youtu.be/ID, or youtube.com/embed/ID)"
    );
  }

  return `https://www.youtube.com/watch?v=${videoId}`;
}

// ─── Search string builder ───────────────────────────────────────────────────

function buildSearchString(artist: string, title: string): string {
  let a = artist.split(";")[0].trim();
  a = a.replace(/\s*(feat\.?|ft\.?|vs\.?).*$/i, "").trim();
  const t = title.replace(/\(.*?\)/g, "").trim();
  return `${a} ${t}`
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Cached track shape ──────────────────────────────────────────────────────

interface CachedTrack {
  title: string | null;
  artist: string | null;
  artists: string | null;
  duration_ms: number | null;
  search_string: string | null;
}

// ─── Route handler ───────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const rl = await rateLimit(request, limiters.import);
  if (rl) return rl;

  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  const { searchParams } = request.nextUrl;
  const queueJobs = searchParams.get("queue_jobs") !== "false";

  // Parse body
  let body: { url?: string };
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  if (!body.url || typeof body.url !== "string") {
    return jsonError("url is required", 400);
  }

  // Validate and normalize YouTube URL
  let normalizedUrl: string;
  try {
    normalizedUrl = validateYouTubeUrl(body.url);
  } catch (err) {
    return jsonError(
      err instanceof Error ? err.message : "Invalid YouTube URL",
      400
    );
  }

  const supabase = createServiceClient();
  const jobId = randomUUID();

  // Check cache
  const { data: cached } = await supabase
    .from("trackid_url_cache")
    .select("tracks")
    .eq("youtube_url", normalizedUrl)
    .maybeSingle();

  if (cached?.tracks) {
    // Cache hit — insert tracks immediately and create a completed job
    const cachedTracks = (cached.tracks as CachedTrack[]) ?? [];

    const trackRows = cachedTracks.map((t) => ({
      user_id: user.userId,
      acquisition_status: "candidate",
      source: "trackid",
      title: t.title,
      artist: t.artist,
      artists: t.artists,
      duration_ms: t.duration_ms,
      search_string:
        t.search_string ??
        buildSearchString(t.artist ?? "", t.title ?? ""),
    }));

    let insertedIds: number[] = [];
    let newlyInsertedCount = 0;
    let jobsCreated = 0;

    if (trackRows.length > 0) {
      const { data: inserted } = await supabase
        .from("tracks")
        .upsert(trackRows, { onConflict: "user_id,title,artist", ignoreDuplicates: true })
        .select("id, search_string, artist, title, duration_ms");

      const newlyInserted = inserted ?? [];
      newlyInsertedCount = newlyInsertedCount;

      // Re-fetch ALL matching track IDs (upsert with ignoreDuplicates returns
      // nothing for existing rows). Batch in chunks of 100 for URL safety.
      const titles = trackRows.map((r) => r.title).filter(Boolean) as string[];
      const allTrackIds: number[] = [];
      for (let i = 0; i < titles.length; i += 100) {
        const batch = titles.slice(i, i + 100);
        const { data: rows } = await supabase
          .from("tracks")
          .select("id")
          .eq("user_id", user.userId)
          .eq("source", "trackid")
          .in("title", batch);
        allTrackIds.push(...(rows ?? []).map((r) => r.id as number));
      }
      // Deduplicate IDs (a title may match multiple rows across batches)
      insertedIds = [...new Set(allTrackIds)];

      if (queueJobs && newlyInsertedCount > 0) {
        const jobRows = newlyInserted.map((track) => ({
          user_id: user.userId,
          track_id: track.id,
          job_type: "download",
          payload: {
            track_id: track.id,
            search_string: track.search_string ?? "",
            artist: track.artist ?? "",
            title: track.title ?? "",
            duration_ms: track.duration_ms ?? 0,
          },
        }));

        const { data: createdJobs } = await supabase
          .from("pipeline_jobs")
          .insert(jobRows)
          .select("id");

        jobsCreated = createdJobs?.length ?? 0;
      }
    }

    // Create a completed job record
    await supabase.from("trackid_import_jobs").insert({
      id: jobId,
      user_id: user.userId,
      youtube_url: normalizedUrl,
      status: "completed",
      progress: 100,
      step: `Done — ${insertedIds.length} track${insertedIds.length !== 1 ? "s" : ""} identified (cached)`,
      result: JSON.stringify({
        imported: newlyInsertedCount,
        skipped_duplicates: trackRows.length - newlyInsertedCount,
        jobs_created: jobsCreated,
        track_ids: insertedIds,
      }),
    });

    await auditLog(user.userId, "track.import.trackid", {
      resourceType: "youtube_url",
      resourceId: normalizedUrl,
      details: {
        job_id: jobId,
        cache_hit: true,
        imported: insertedIds.length,
        jobs_created: jobsCreated,
      },
      ipAddress: getClientIp(request),
    });

    return NextResponse.json({ job_id: jobId }, { status: 202 });
  }

  // Cache miss — create a pending job and invoke the Edge Function
  await supabase.from("trackid_import_jobs").insert({
    id: jobId,
    user_id: user.userId,
    youtube_url: normalizedUrl,
    status: "queued",
    progress: 0,
    step: "Queued…",
  });

  // Fire and forget — Edge Function runs in background
  supabase.functions
    .invoke("trackid-poll", {
      body: {
        job_id: jobId,
        url: normalizedUrl,
        user_id: user.userId,
        queue_jobs: queueJobs,
      },
    })
    .catch((err) => console.warn("Edge function invoke failed:", err));

  await auditLog(user.userId, "track.import.trackid", {
    resourceType: "youtube_url",
    resourceId: normalizedUrl,
    details: { job_id: jobId, cache_hit: false },
    ipAddress: getClientIp(request),
  });

  return NextResponse.json({ job_id: jobId }, { status: 202 });
}
