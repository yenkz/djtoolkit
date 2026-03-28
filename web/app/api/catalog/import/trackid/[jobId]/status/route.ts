/**
 * GET /api/catalog/import/trackid/[jobId]/status
 *
 * Poll the status of a TrackID import job. For in-progress jobs, proxies
 * a single poll to TrackID.dev and updates the DB. When TrackID completes,
 * filters/deduplicates tracks and inserts them inline.
 *
 * This replaces the edge-function-based polling architecture — the frontend's
 * own 2s poll loop drives progress instead.
 *
 * Returns 200: { status, progress, step, error, result }
 */

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";
import { rateLimit, limiters } from "@/lib/api-server/rate-limit";
import { createServiceClient } from "@/lib/supabase/service";
import { jsonError } from "@/lib/api-server/errors";
import { getUserSettings } from "@/lib/api-server/job-settings";

export const maxDuration = 10;

const TRACKID_BASE = "https://trackid.dev";
const DEFAULT_TRACKID_CONFIDENCE = 0.7;

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

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const rl = await rateLimit(request, limiters.read);
  if (rl) return rl;

  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  const { jobId } = await params;

  if (!jobId || typeof jobId !== "string") {
    return jsonError("jobId is required", 400);
  }

  const supabase = createServiceClient();

  const { data: job, error } = await supabase
    .from("trackid_import_jobs")
    .select("status, progress, step, error, result, trackid_job_id, youtube_url, user_id, updated_at, preview")
    .eq("id", jobId)
    .eq("user_id", user.userId)
    .maybeSingle();

  if (error) {
    return jsonError("Failed to fetch job status", 500);
  }

  if (!job) {
    return jsonError("Job not found", 404);
  }

  // If already terminal, return immediately
  if (job.status === "completed" || job.status === "failed") {
    const result =
      typeof job.result === "string" ? JSON.parse(job.result) : job.result;
    return NextResponse.json({
      status: job.status,
      progress: job.progress,
      step: job.step,
      error: job.error,
      result,
    });
  }

  // In-progress: poll TrackID.dev once
  if (!job.trackid_job_id) {
    return NextResponse.json({
      status: job.status,
      progress: job.progress,
      step: job.step,
      error: job.error,
      result: null,
    });
  }

  // Throttle: only poll TrackID.dev if last update was >10s ago.
  // On 429, updated_at is set into the future to extend the gap automatically.
  const MIN_POLL_GAP_MS = 10_000;
  const lastUpdate = job.updated_at ? new Date(job.updated_at).getTime() : 0;
  if (Date.now() - lastUpdate < MIN_POLL_GAP_MS) {
    return NextResponse.json({
      status: job.status,
      progress: job.progress,
      step: job.step,
      error: null,
      result: null,
    });
  }

  const pollResp = await fetch(
    `${TRACKID_BASE}/api/job/${job.trackid_job_id}`,
    { headers: { "User-Agent": "djtoolkit/1.0" } }
  );

  if (pollResp.status === 429) {
    // Rate limited — push updated_at 30s into the future so the throttle
    // check above automatically backs off without a schema change.
    const backoffUntil = new Date(Date.now() + 30_000).toISOString();
    await supabase
      .from("trackid_import_jobs")
      .update({ updated_at: backoffUntil })
      .eq("id", jobId);

    return NextResponse.json({
      status: job.status,
      progress: job.progress,
      step: "Rate limited by TrackID.dev, retrying soon…",
      error: null,
      result: null,
    });
  }

  if (!pollResp.ok) {
    await supabase
      .from("trackid_import_jobs")
      .update({
        status: "failed",
        error: `TrackID.dev poll error: ${pollResp.status}`,
        step: "Failed",
        updated_at: new Date().toISOString(),
      })
      .eq("id", jobId);

    return NextResponse.json({
      status: "failed",
      progress: 0,
      step: "Failed",
      error: `TrackID.dev poll error: ${pollResp.status}`,
      result: null,
    });
  }

  const jobData = await pollResp.json();
  const trackidStatus = (jobData.status as string) || "";
  const pct = Math.min(Number(jobData.progress || 0), 90);
  const step = (jobData.currentStep as string) || trackidStatus;

  // TrackID job failed
  if (trackidStatus === "failed") {
    await supabase
      .from("trackid_import_jobs")
      .update({
        status: "failed",
        progress: 0,
        step: "Failed",
        error: "TrackID.dev job failed on server.",
        updated_at: new Date().toISOString(),
      })
      .eq("id", jobId);

    return NextResponse.json({
      status: "failed",
      progress: 0,
      step: "Failed",
      error: "TrackID.dev job failed on server.",
      result: null,
    });
  }

  // Still processing — update DB and return
  if (trackidStatus !== "completed") {
    await supabase
      .from("trackid_import_jobs")
      .update({
        status: trackidStatus,
        progress: pct,
        step,
        updated_at: new Date().toISOString(),
      })
      .eq("id", jobId);

    return NextResponse.json({
      status: trackidStatus,
      progress: pct,
      step,
      error: null,
      result: null,
    });
  }

  // ── TrackID completed — filter, deduplicate, insert tracks ────────────

  const userSettings = await getUserSettings(supabase, user.userId);
  const confidenceThreshold = Number(
    userSettings.trackid_confidence_threshold ?? DEFAULT_TRACKID_CONFIDENCE
  );

  const rawTracks = (
    (jobData.tracks as Array<Record<string, unknown>>) ?? []
  ).sort(
    (a, b) => Number(b.confidence || 0) - Number(a.confidence || 0)
  );

  const seenKeys = new Set<string>();
  const tracks: Array<{
    title: string | null;
    artist: string | null;
    artists: string | null;
    duration_ms: number | null;
    search_string: string | null;
  }> = [];

  for (const t of rawTracks) {
    if (t.isUnknown || t.unknown) continue;
    if (Number(t.confidence || 0) < confidenceThreshold) continue;

    const artist = String(t.artist || "");
    const title = String(t.title || "");
    const key = `${title.toLowerCase().trim()}|${artist.toLowerCase().trim()}`;

    if (seenKeys.has(key)) continue;
    seenKeys.add(key);

    const durationSec = Number(t.duration || 0);
    const durationMs = durationSec > 0 ? Math.round(durationSec * 1000) : null;

    tracks.push({
      title: title || null,
      artist: artist || null,
      artists: artist || null,
      duration_ms: durationMs,
      search_string: buildSearchString(artist, title) || null,
    });
  }

  // Save to URL cache
  await supabase
    .from("trackid_url_cache")
    .upsert(
      {
        youtube_url: job.youtube_url,
        tracks,
        track_count: tracks.length,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "youtube_url" }
    );

  const isPreview = !!job.preview;

  if (isPreview) {
    const { data: ownedRows } = await supabase
      .from("tracks")
      .select("title, artist")
      .eq("user_id", user.userId)
      .eq("acquisition_status", "available");
    const ownedSet = new Set(
      (ownedRows ?? [])
        .filter((r: Record<string, unknown>) => r.title && r.artist)
        .map((r: Record<string, unknown>) =>
          `${String(r.title).toLowerCase().trim()}|${String(r.artist).toLowerCase().trim()}`
        )
    );

    const previewTracks = tracks.map((t) => {
      const key = `${(t.title ?? "").toLowerCase().trim()}|${(t.artist ?? "").toLowerCase().trim()}`;
      return {
        _key: key,
        source: "trackid",
        title: t.title ?? "",
        artist: t.artist ?? "",
        artists: t.artists != null ? t.artists : undefined,
        duration_ms: t.duration_ms != null ? t.duration_ms : undefined,
        search_string: t.search_string,
        already_owned: ownedSet.has(key),
      };
    });

    const resultObj = { tracks: previewTracks, total: previewTracks.length };

    await supabase
      .from("trackid_import_jobs")
      .update({
        status: "completed",
        progress: 100,
        step: `Done — ${previewTracks.length} track${previewTracks.length !== 1 ? "s" : ""} identified`,
        result: JSON.stringify(resultObj),
        updated_at: new Date().toISOString(),
      })
      .eq("id", jobId);

    return NextResponse.json({
      status: "completed",
      progress: 100,
      step: `Done — ${previewTracks.length} track${previewTracks.length !== 1 ? "s" : ""} identified`,
      error: null,
      result: resultObj,
      tracks_found: rawTracks.length,
    });
  }

  // Insert tracks
  let inserted = 0;
  let skipped = 0;
  const insertedIds: number[] = [];

  for (const t of tracks) {
    const { data: row, error: insertErr } = await supabase
      .from("tracks")
      .insert({
        user_id: user.userId,
        acquisition_status: "candidate",
        source: "trackid",
        title: t.title,
        artist: t.artist,
        artists: t.artists,
        duration_ms: t.duration_ms,
        search_string: t.search_string,
      })
      .select("id")
      .maybeSingle();

    if (insertErr || !row) {
      skipped++;
      continue;
    }

    inserted++;
    insertedIds.push(row.id as number);
  }

  // Finalize
  const resultObj = {
    imported: inserted,
    skipped_duplicates: skipped,
    jobs_created: 0,
    track_ids: insertedIds,
  };

  await supabase
    .from("trackid_import_jobs")
    .update({
      status: "completed",
      progress: 100,
      step: `Done — ${inserted} track${inserted !== 1 ? "s" : ""} identified`,
      result: JSON.stringify(resultObj),
      updated_at: new Date().toISOString(),
    })
    .eq("id", jobId);

  return NextResponse.json({
    status: "completed",
    progress: 100,
    step: `Done — ${inserted} track${inserted !== 1 ? "s" : ""} identified`,
    error: null,
    result: resultObj,
    tracks_found: rawTracks.length,
  });
}
