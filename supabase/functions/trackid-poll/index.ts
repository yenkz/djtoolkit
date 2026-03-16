/**
 * trackid-poll — Supabase Edge Function (Deno runtime)
 *
 * Submits a YouTube URL to TrackID.dev, polls until the analysis job
 * completes, filters and deduplicates the identified tracks, saves them
 * to the URL cache, inserts them into the tracks table, and optionally
 * creates pipeline download jobs.
 *
 * Uses EdgeRuntime.waitUntil() to respond immediately and process in the
 * background, avoiding the 150s wall-clock limit on HTTP responses.
 *
 * Accepts two invocation modes:
 *   1. Fresh start: { job_id, url, user_id, queue_jobs }
 *   2. Resume (relay): { job_id, url, user_id, queue_jobs, trackid_job_id }
 *      — skips submission and jumps straight to polling with the provided
 *        TrackID job ID (used when the function self-relays to stay within
 *        the Deno wall-clock limit).
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TRACKID_BASE = "https://trackid.dev";
const TRACKID_CONFIDENCE = 0.7;
const POLL_INTERVAL_MS = 7000;
/** Max polling time per invocation before relaying to a new invocation. */
const MAX_POLL_DURATION_MS = 120_000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

// ─── Main processing ─────────────────────────────────────────────────────────

async function processJob(
  job_id: string,
  url: string,
  user_id: string,
  queue_jobs: boolean,
  resumeTrackidJobId?: string
): Promise<void> {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  async function updateJob(updates: Record<string, unknown>): Promise<void> {
    await supabase
      .from("trackid_import_jobs")
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq("id", job_id);
  }

  async function fail(msg: string): Promise<void> {
    await updateJob({ status: "failed", progress: 0, step: "Failed", error: msg });
  }

  try {
    let trackidJobId: string;

    if (resumeTrackidJobId) {
      // ── Resume mode: relay continuation ─────────────────────────────────
      trackidJobId = resumeTrackidJobId;
      await updateJob({ status: "processing", step: "Resuming TrackID.dev poll…" });
    } else {
      // ── Fresh start: submit URL to TrackID.dev ───────────────────────────
      await updateJob({
        status: "submitting",
        progress: 5,
        step: "Submitting to TrackID.dev…",
      });

      const submitResp = await fetch(`${TRACKID_BASE}/api/analyze`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "djtoolkit/1.0",
        },
        body: JSON.stringify({ url }),
      });

      if (submitResp.status === 429) {
        await fail("TrackID.dev rate limit reached. Try again in a few minutes.");
        return;
      }
      if (!submitResp.ok) {
        await fail(`TrackID.dev submission failed: ${submitResp.status}`);
        return;
      }

      const submitData = await submitResp.json();
      trackidJobId = submitData.jobId as string;
    }

    // ── Poll for completion ──────────────────────────────────────────────

    const pollUrl = `${TRACKID_BASE}/api/job/${trackidJobId}`;
    const startTime = Date.now();
    let jobData: Record<string, unknown> = {};

    while (true) {
      if (Date.now() - startTime > MAX_POLL_DURATION_MS) {
        // Relay: re-invoke self to continue polling from where we left off
        await updateJob({ step: "Relaying to continue polling…" });
        const { error: relayErr } = await supabase.functions.invoke("trackid-poll", {
          body: {
            job_id,
            url,
            user_id,
            queue_jobs,
            trackid_job_id: trackidJobId,
          },
        });
        if (relayErr) {
          await fail(`Relay failed: ${relayErr.message ?? relayErr}`);
        }
        return;
      }

      const pollResp = await fetch(pollUrl, {
        headers: { "User-Agent": "djtoolkit/1.0" },
      });

      if (pollResp.status === 429) {
        await new Promise((r) => setTimeout(r, 15_000));
        continue;
      }
      if (!pollResp.ok) {
        await fail(`TrackID.dev poll error: ${pollResp.status}`);
        return;
      }

      jobData = await pollResp.json();
      const jobStatus = (jobData.status as string) || "";
      const pct = Math.min(Number(jobData.progress || 0), 90);
      const step = (jobData.currentStep as string) || jobStatus;

      await updateJob({ status: jobStatus, progress: pct, step });

      if (jobStatus === "completed") break;
      if (jobStatus === "failed") {
        await fail("TrackID.dev job failed on server.");
        return;
      }

      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    // ── Filter and deduplicate identified tracks ─────────────────────────

    await updateJob({
      status: "inserting",
      progress: 95,
      step: "Saving tracks to your library…",
    });

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
      duration_ms: null;
      search_string: string | null;
    }> = [];

    for (const t of rawTracks) {
      if (t.isUnknown) continue;
      if (Number(t.confidence || 0) < TRACKID_CONFIDENCE) continue;

      const artist = String(t.artist || "");
      const title = String(t.title || "");
      const key = `${title.toLowerCase().trim()}|${artist.toLowerCase().trim()}`;

      if (seenKeys.has(key)) continue;
      seenKeys.add(key);

      tracks.push({
        title: title || null,
        artist: artist || null,
        artists: artist || null,
        duration_ms: null,
        search_string: buildSearchString(artist, title) || null,
      });
    }

    // ── Save to URL cache ────────────────────────────────────────────────

    await supabase
      .from("trackid_url_cache")
      .upsert(
        {
          youtube_url: url,
          tracks,
          track_count: tracks.length,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "youtube_url" }
      );

    // ── Insert tracks ────────────────────────────────────────────────────

    let inserted = 0;
    let skipped = 0;
    let jobsCreated = 0;
    const insertedIds: number[] = [];

    for (const t of tracks) {
      const { data: row, error: insertErr } = await supabase
        .from("tracks")
        .insert({
          user_id,
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

      if (queue_jobs) {
        await supabase.from("pipeline_jobs").insert({
          user_id,
          track_id: row.id,
          job_type: "download",
          payload: {
            track_id: row.id,
            search_string: t.search_string ?? "",
            artist: t.artist ?? "",
            title: t.title ?? "",
            duration_ms: 0,
          },
        });
        jobsCreated++;
      }
    }

    // ── Finalize job ─────────────────────────────────────────────────────

    await updateJob({
      status: "completed",
      progress: 100,
      step: `Done — ${inserted} track${inserted !== 1 ? "s" : ""} identified`,
      result: JSON.stringify({
        imported: inserted,
        skipped_duplicates: skipped,
        jobs_created: jobsCreated,
        track_ids: insertedIds,
      }),
    });
  } catch (err) {
    await fail(`Unexpected error: ${err}`);
  }
}

// ─── Handler — respond immediately, process in background ────────────────────

Deno.serve(async (req: Request) => {
  const body = await req.json();

  // deno-lint-ignore no-explicit-any
  (globalThis as any).EdgeRuntime.waitUntil(
    processJob(
      body.job_id,
      body.url,
      body.user_id,
      body.queue_jobs ?? true,
      body.trackid_job_id
    )
  );

  return new Response(
    JSON.stringify({ ok: true, job_id: body.job_id }),
    { headers: { "Content-Type": "application/json" } }
  );
});
