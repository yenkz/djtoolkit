/**
 * POST /api/catalog/import/trackid
 *
 * Start a track identification job. Accepts a YouTube or SoundCloud URL,
 * checks cache, and either inserts tracks immediately (cache hit) or submits
 * to the Hetzner analysis service for Shazam-based identification.
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
import { getUserSettings, getJobSettings } from "@/lib/api-server/job-settings";

// ─── URL validator (YouTube + SoundCloud) ───────────────────────────────────

const YT_VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

function validateMixUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");

    // YouTube
    if (host === "youtube.com" || host === "m.youtube.com") {
      let videoId: string | null = null;
      if (parsed.pathname === "/watch") {
        videoId = parsed.searchParams.get("v");
      } else if (parsed.pathname.startsWith("/embed/")) {
        videoId = parsed.pathname.slice("/embed/".length).split("/")[0];
      }
      if (videoId && YT_VIDEO_ID_RE.test(videoId)) {
        return `https://www.youtube.com/watch?v=${videoId}`;
      }
    }
    if (host === "youtu.be") {
      const videoId = parsed.pathname.slice(1).split("/")[0];
      if (videoId && YT_VIDEO_ID_RE.test(videoId)) {
        return `https://www.youtube.com/watch?v=${videoId}`;
      }
    }

    // SoundCloud
    if (host === "soundcloud.com" || host === "m.soundcloud.com") {
      const path = parsed.pathname.replace(/^\/+|\/+$/g, "");
      if (path.includes("/")) {
        return `https://soundcloud.com/${path}`;
      }
    }
  } catch {
    throw new Error("Invalid URL");
  }

  throw new Error(
    "URL must be a YouTube or SoundCloud link (youtube.com/watch?v=ID, youtu.be/ID, or soundcloud.com/artist/set)"
  );
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
  preview_url?: string | null;
  artwork_url?: string | null;
}

const ANALYSIS_API = process.env.DJTOOLKIT_API_URL || "https://api.djtoolkit.net";

// ─── Route handler ───────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const rl = await rateLimit(request, limiters.import);
  if (rl) return rl;

  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  const { searchParams } = request.nextUrl;
  const queueJobs = searchParams.get("queue_jobs") !== "false";
  const preview = searchParams.get("preview") === "true";

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
    normalizedUrl = validateMixUrl(body.url);
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

    if (preview) {
      const { data: existingRows } = await supabase
        .from("tracks")
        .select("title, artist")
        .eq("user_id", user.userId)
        .eq("acquisition_status", "available");
      const ownedSet = new Set(
        (existingRows ?? [])
          .filter((r: Record<string, unknown>) => r.title && r.artist)
          .map((r: Record<string, unknown>) =>
            `${String(r.title).toLowerCase().trim()}|${String(r.artist).toLowerCase().trim()}`
          )
      );

      const previewTracks = cachedTracks.map((t) => {
        const key = `${(t.title ?? "").toLowerCase().trim()}|${(t.artist ?? "").toLowerCase().trim()}`;
        return {
          _key: key,
          source: "trackid",
          title: t.title ?? "",
          artist: t.artist ?? "",
          artists: t.artists ?? undefined,
          duration_ms: t.duration_ms ?? undefined,
          search_string: t.search_string ?? undefined,
          preview_url: t.preview_url ?? undefined,
          artwork_url: t.artwork_url ?? undefined,
          already_owned: ownedSet.has(key),
        };
      });

      return NextResponse.json(
        { tracks: previewTracks, total: previewTracks.length, cached: true },
        { status: 200 }
      );
    }

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

    const insertedIds: number[] = [];
    let newlyInsertedCount = 0;
    let jobsCreated = 0;

    if (trackRows.length > 0) {
      // Insert one-at-a-time; the DB unique partial index on
      // (user_id, lower(title), lower(artist)) WHERE source='trackid'
      // rejects duplicates from previous imports.
      const newlyInserted: Array<{ id: number; search_string: string | null; artist: string | null; title: string | null; duration_ms: number | null }> = [];

      for (const row of trackRows) {
        const { data: inserted, error: insertErr } = await supabase
          .from("tracks")
          .insert(row)
          .select("id, search_string, artist, title, duration_ms")
          .maybeSingle();

        if (insertErr || !inserted) continue;
        newlyInsertedCount++;
        insertedIds.push(inserted.id as number);
        newlyInserted.push(inserted as typeof newlyInserted[number]);
      }

      if (queueJobs && newlyInsertedCount > 0) {
        const userSettings = await getUserSettings(supabase, user.userId);
        const downloadSettings = getJobSettings(userSettings, "download");

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
            ...(Object.keys(downloadSettings).length > 0 && { settings: downloadSettings }),
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

  // Cache miss — submit to Hetzner analysis service
  const userSettings = await getUserSettings(supabase, user.userId);
  const confidenceThreshold = Number(
    userSettings.trackid_confidence_threshold ?? 0.7
  );

  const submitResp = await fetch(`${ANALYSIS_API}/trackid/analyze`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: request.headers.get("Authorization") ?? "",
    },
    body: JSON.stringify({
      url: normalizedUrl,
      job_id: jobId,
      confidence_threshold: confidenceThreshold,
      preview,
    }),
  });

  if (!submitResp.ok) {
    const errText = await submitResp.text().catch(() => "");
    return jsonError(`Analysis service error: ${submitResp.status} ${errText}`, 502);
  }

  await auditLog(user.userId, "track.import.trackid", {
    resourceType: "youtube_url",
    resourceId: normalizedUrl,
    details: { job_id: jobId, cache_hit: false },
    ipAddress: getClientIp(request),
  });

  return NextResponse.json({ job_id: jobId }, { status: 202 });
}
