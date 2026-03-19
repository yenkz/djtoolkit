/**
 * Job chaining engine — when a pipeline job completes, update track flags
 * and auto-queue the next job in the pipeline.
 *
 * Chain: download → fingerprint → [exportify: cover_art → metadata]
 *                                 [other: spotify_lookup → cover_art → audio_analysis → metadata]
 */

import { SupabaseClient } from "@supabase/supabase-js";

const KEY_NAMES = [
  "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
] as const;

/**
 * Apply the result of a completed pipeline job: update track flags in the
 * database and auto-queue the next job in the pipeline chain.
 */
/**
 * Check if a pending/claimed/running job of the given type already exists
 * for this track. Prevents duplicate chained jobs on retry.
 */
async function hasActiveJob(
  supabase: SupabaseClient,
  trackId: number,
  jobType: string
): Promise<boolean> {
  const { data } = await supabase
    .from("pipeline_jobs")
    .select("id")
    .eq("track_id", trackId)
    .eq("job_type", jobType)
    .in("status", ["pending", "claimed", "running"])
    .limit(1)
    .maybeSingle();
  return !!data;
}

/**
 * Fetch track state from DB and build the metadata job payload.
 * Returns null if track has no local_path.
 */
export async function buildMetadataPayload(
  supabase: SupabaseClient,
  trackId: number,
  userId: string
): Promise<Record<string, unknown> | null> {
  const { data: trackRaw } = await supabase
    .from("tracks")
    .select(
      "local_path, title, artist, album, artists, year, release_date, " +
        "genres, record_label, isrc, tempo, key, mode, " +
        "duration_ms, enriched_spotify, enriched_audio"
    )
    .eq("id", trackId)
    .single();

  const track = trackRaw as Record<string, unknown> | null;
  if (!track?.local_path) return null;

  let musicalKey = "";
  if (track.key !== null && track.mode !== null) {
    const k = Number(track.key);
    if (k >= 0 && k < 12) {
      musicalKey = `${KEY_NAMES[k]}${Number(track.mode) === 0 ? "m" : ""}`;
    }
  }

  let metadataSource: string | null = null;
  if (track.enriched_spotify) {
    metadataSource = "spotify";
  } else if (track.enriched_audio) {
    metadataSource = "audio-analysis";
  }

  return {
    track_id: trackId,
    local_path: track.local_path as string,
    title: (track.title as string) ?? "",
    artist: (track.artist as string) ?? "",
    album: (track.album as string) ?? "",
    artists: (track.artists as string) ?? "",
    year: track.year,
    release_date: (track.release_date as string) ?? "",
    genres: (track.genres as string) ?? "",
    record_label: (track.record_label as string) ?? "",
    isrc: (track.isrc as string) ?? "",
    bpm: track.tempo,
    musical_key: musicalKey,
    duration_ms: track.duration_ms,
    metadata_source: metadataSource,
  };
}

export async function applyJobResult(
  supabase: SupabaseClient,
  jobId: string,
  userId: string,
  jobType: string,
  result: Record<string, unknown>
): Promise<void> {
  // Look up the track_id for this job
  const { data: jobRow } = await supabase
    .from("pipeline_jobs")
    .select("track_id")
    .eq("id", jobId)
    .single();

  if (!jobRow?.track_id) return;
  const trackId = jobRow.track_id;

  switch (jobType) {
    case "download": {
      const localPath = result.local_path as string | undefined;
      if (!localPath) return;

      // Update track to available with the local path
      await supabase
        .from("tracks")
        .update({
          acquisition_status: "available",
          local_path: localPath,
          updated_at: new Date().toISOString(),
        })
        .eq("id", trackId)
        .eq("user_id", userId);

      // Auto-queue fingerprint job (skip if one already exists)
      if (!(await hasActiveJob(supabase, trackId, "fingerprint"))) {
        await supabase.from("pipeline_jobs").insert({
          user_id: userId,
          track_id: trackId,
          job_type: "fingerprint",
          payload: { track_id: trackId, local_path: localPath },
        });
      }

      break;
    }

    case "fingerprint": {
      const fingerprint = result.fingerprint as string | undefined;
      if (!fingerprint) return;

      // Insert into fingerprints table
      const { data: fpRow } = await supabase
        .from("fingerprints")
        .insert({
          user_id: userId,
          track_id: trackId,
          fingerprint,
          acoustid: (result.acoustid as string) ?? null,
          duration: (result.duration as number) ?? null,
        })
        .select("id")
        .single();

      if (!fpRow) return;
      const fpId = fpRow.id;

      // Duplicate check — exact Chromaprint match against existing in-library tracks
      const { data: dupes } = await supabase
        .from("fingerprints")
        .select("id, tracks!inner(id, in_library)")
        .eq("user_id", userId)
        .eq("fingerprint", fingerprint)
        .neq("id", fpId)
        .limit(1);

      // Filter for in_library = true (the join filter)
      const dupe = dupes?.find((d: Record<string, unknown>) => {
        const tracks = d.tracks as
          | { in_library: boolean }
          | { in_library: boolean }[];
        if (Array.isArray(tracks)) {
          return tracks.some((t) => t.in_library === true);
        }
        return tracks?.in_library === true;
      });

      if (dupe) {
        // Mark as duplicate
        await supabase
          .from("tracks")
          .update({
            acquisition_status: "duplicate",
            fingerprinted: true,
            fingerprint_id: fpId,
            updated_at: new Date().toISOString(),
          })
          .eq("id", trackId);
      } else {
        // Mark as fingerprinted
        await supabase
          .from("tracks")
          .update({
            fingerprinted: true,
            fingerprint_id: fpId,
            updated_at: new Date().toISOString(),
          })
          .eq("id", trackId);

        // Auto-queue next job based on track source
        const { data: track } = await supabase
          .from("tracks")
          .select("local_path, artist, album, title, source, spotify_uri, duration_ms")
          .eq("id", trackId)
          .single();

        if (!track?.local_path) break;

        if (track.source === "exportify") {
          // Exportify tracks → cover_art (metadata from CSV already in DB)
          if (!(await hasActiveJob(supabase, trackId, "cover_art"))) {
            await supabase.from("pipeline_jobs").insert({
              user_id: userId,
              track_id: trackId,
              job_type: "cover_art",
              payload: {
                track_id: trackId,
                local_path: track.local_path,
                artist: track.artist ?? "",
                album: track.album ?? "",
                title: track.title ?? "",
                spotify_uri: track.spotify_uri ?? null,
              },
            });
          }
        } else {
          // Non-exportify tracks → spotify_lookup first
          if (!(await hasActiveJob(supabase, trackId, "spotify_lookup"))) {
            await supabase.from("pipeline_jobs").insert({
              user_id: userId,
              track_id: trackId,
              job_type: "spotify_lookup",
              payload: {
                track_id: trackId,
                artist: track.artist ?? "",
                title: track.title ?? "",
                duration_ms: track.duration_ms ?? null,
                spotify_uri: track.spotify_uri ?? null,
              },
            });
          }
        }
      }

      break;
    }

    case "spotify_lookup": {
      // Write metadata to tracks table (if match found)
      if (result.matched !== false) {
        const updates: Record<string, unknown> = {
          enriched_spotify: true,
          updated_at: new Date().toISOString(),
        };
        // Copy all non-null metadata fields
        for (const col of [
          "spotify_uri", "album", "release_date", "year", "genres",
          "record_label", "popularity", "explicit", "isrc", "duration_ms",
        ]) {
          if (result[col] !== undefined && result[col] !== null) {
            updates[col] = result[col];
          }
        }
        await supabase
          .from("tracks")
          .update(updates)
          .eq("id", trackId)
          .eq("user_id", userId);
      }

      // Always queue cover_art (even on no-match — falls back to other sources)
      const { data: track } = await supabase
        .from("tracks")
        .select("local_path, artist, album, title, spotify_uri")
        .eq("id", trackId)
        .single();

      if (track?.local_path && !(await hasActiveJob(supabase, trackId, "cover_art"))) {
        await supabase.from("pipeline_jobs").insert({
          user_id: userId,
          track_id: trackId,
          job_type: "cover_art",
          payload: {
            track_id: trackId,
            local_path: track.local_path,
            artist: track.artist ?? "",
            album: track.album ?? "",
            title: track.title ?? "",
            spotify_uri: track.spotify_uri ?? null,
          },
        });
      }

      break;
    }

    case "cover_art": {
      if (result.cover_art_written) {
        await supabase
          .from("tracks")
          .update({
            cover_art_written: true,
            cover_art_embedded_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", trackId)
          .eq("user_id", userId);
      }

      // Fetch track to determine source and build next job payload
      const { data: trackRaw } = await supabase
        .from("tracks")
        .select(
          "local_path, title, artist, album, artists, year, release_date, " +
            "genres, record_label, isrc, tempo, key, mode, " +
            "duration_ms, enriched_spotify, enriched_audio, source"
        )
        .eq("id", trackId)
        .single();

      const track = trackRaw as Record<string, unknown> | null;
      if (!track?.local_path) break;

      if (track.source !== "exportify") {
        // Non-exportify → queue audio_analysis
        if (!(await hasActiveJob(supabase, trackId, "audio_analysis"))) {
          await supabase.from("pipeline_jobs").insert({
            user_id: userId,
            track_id: trackId,
            job_type: "audio_analysis",
            payload: {
              track_id: trackId,
              local_path: track.local_path as string,
            },
          });
        }
      } else {
        // Exportify → queue metadata directly (uses shared helper)
        if (await hasActiveJob(supabase, trackId, "metadata")) break;
        const metaPayload = await buildMetadataPayload(supabase, trackId, userId);
        if (metaPayload) {
          await supabase.from("pipeline_jobs").insert({
            user_id: userId,
            track_id: trackId,
            job_type: "metadata",
            payload: metaPayload,
          });
        }
      }

      break;
    }

    case "audio_analysis": {
      // Write audio features to tracks table
      const featureUpdates: Record<string, unknown> = {
        enriched_audio: true,
        updated_at: new Date().toISOString(),
      };
      for (const col of ["tempo", "key", "mode", "danceability", "energy", "loudness"]) {
        if (result[col] !== undefined && result[col] !== null) {
          featureUpdates[col] = result[col];
        }
      }
      await supabase
        .from("tracks")
        .update(featureUpdates)
        .eq("id", trackId)
        .eq("user_id", userId);

      // Queue metadata job (uses shared helper)
      if (await hasActiveJob(supabase, trackId, "metadata")) break;
      const metaPayload = await buildMetadataPayload(supabase, trackId, userId);
      if (metaPayload) {
        await supabase.from("pipeline_jobs").insert({
          user_id: userId,
          track_id: trackId,
          job_type: "metadata",
          payload: metaPayload,
        });
      }

      break;
    }

    case "metadata": {
      const newPath = result.local_path as string | undefined;
      const updates: Record<string, unknown> = {
        metadata_written: true,
        updated_at: new Date().toISOString(),
      };
      if (newPath) {
        updates.local_path = newPath;
      }

      await supabase
        .from("tracks")
        .update(updates)
        .eq("id", trackId)
        .eq("user_id", userId);

      break;
    }
  }
}
