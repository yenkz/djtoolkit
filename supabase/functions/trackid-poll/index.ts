/**
 * trackid-poll — Supabase Edge Function (Deno runtime)
 *
 * Submits a YouTube URL to TrackID.dev, polls until the analysis job
 * completes, filters and deduplicates the identified tracks, saves them
 * to the URL cache, inserts them into the tracks table, and optionally
 * creates pipeline download jobs.
 *
 * Accepts two invocation modes:
 *   1. Fresh start: { job_id, url, user_id, queue_jobs }
 *   2. Resume (relay): { job_id, url, user_id, queue_jobs, trackid_job_id }
 *      — skips submission and jumps straight to polling with the provided
 *        TrackID job ID (used when the function needs to relay itself to
 *        stay within the 150 s Edge Function wall-clock limit).
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TRACKID_BASE = "https://trackid.dev";
const TRACKID_CONFIDENCE = 0.7;
const POLL_INTERVAL_MS = 7000;
/** Stay well under the 150 s Edge Function wall-clock limit. */
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

// ─── Handler ─────────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  const {
    job_id,
    url,
    user_id,
    queue_jobs,
    trackid_job_id: resumeTrackidJobId,
  } = await req.json();

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // ── Job update helper ────────────────────────────────────────────────────

  async function updateJob(updates: Record<string, unknown>): Promise<void> {
    await supabase
      .from("trackid_import_jobs")
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq("id", job_id);
  }

  async function fail(msg: string): Promise<void> {
    await updateJob({ status: "failed", progress: 0, step: "", error: msg });
  }

  // ── Main logic ───────────────────────────────────────────────────────────

  try {
    let trackidJobId: string;

    if (resumeTrackidJobId) {
      // ── Resume mode: relay continuation ─────────────────────────────────
      trackidJobId = resumeTrackidJobId as string;
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
        return new Response(JSON.stringify({ ok: false }), { status: 429 });
      }
      if (!submitResp.ok) {
        await fail(`TrackID.dev submission failed: ${submitResp.status}`);
        return new Response(JSON.stringify({ ok: false }), { status: 502 });
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
        await supabase.functions.invoke("trackid-poll", {
          body: {
            job_id,
            url,
            user_id,
            queue_jobs,
            trackid_job_id: trackidJobId,
          },
        });
        return new Response(JSON.stringify({ ok: true, relayed: true }));
      }

      const pollResp = await fetch(pollUrl, {
        headers: { "User-Agent": "djtoolkit/1.0" },
      });

      if (pollResp.status === 429) {
        // Back off on rate limit before retrying
        await new Promise((r) => setTimeout(r, 15_000));
        continue;
      }
      if (!pollResp.ok) {
        await fail(`TrackID.dev poll error: ${pollResp.status}`);
        return new Response(JSON.stringify({ ok: false }));
      }

      jobData = await pollResp.json();
      const jobStatus = (jobData.status as string) || "";
      const pct = Math.min(Number(jobData.progress || 0), 90);
      const step = (jobData.currentStep as string) || jobStatus;

      await updateJob({ status: jobStatus, progress: pct, step });

      if (jobStatus === "completed") break;
      if (jobStatus === "failed") {
        await fail("TrackID.dev job failed on server.");
        return new Response(JSON.stringify({ ok: false }));
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
        // TrackID returns the detected window size, not the real track duration
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
      )
      .then(() => {});

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

    return new Response(JSON.stringify({ ok: true }));
  } catch (err) {
    await fail(`Unexpected error: ${err}`);
    return new Response(
      JSON.stringify({ ok: false, error: String(err) }),
      { status: 500 }
    );
  }
});
