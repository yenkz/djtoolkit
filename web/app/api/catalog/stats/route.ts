import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";
import { rateLimit, limiters } from "@/lib/api-server/rate-limit";
import { createServiceClient } from "@/lib/supabase/service";
import { jsonError } from "@/lib/api-server/errors";

/**
 * GET /api/catalog/stats
 *
 * Return aggregate counts for the authenticated user's catalog
 * using a single SQL query instead of 12+ separate count queries.
 *
 * Returns:
 * {
 *   total: number,
 *   by_status: { candidate, downloading, available, failed, duplicate },
 *   flags: { fingerprinted, enriched_spotify, enriched_audio,
 *             metadata_written, cover_art_written, in_library }
 * }
 */
export async function GET(request: NextRequest) {
  const rl = await rateLimit(request, limiters.read);
  if (rl) return rl;

  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  const supabase = createServiceClient();

  const { data, error } = await supabase.rpc("catalog_stats", {
    p_user_id: user.userId,
  });

  if (error) {
    // Fallback: if the RPC doesn't exist yet, use inline SQL
    const { data: raw, error: sqlErr } = await supabase
      .from("tracks")
      .select("acquisition_status, fingerprinted, enriched_spotify, enriched_audio, metadata_written, cover_art_written, in_library")
      .eq("user_id", user.userId);

    if (sqlErr) {
      return jsonError("Failed to fetch catalog stats", 500);
    }

    const rows = (raw ?? []) as Record<string, unknown>[];
    const total = rows.length;
    const by_status: Record<string, number> = {};
    const flags: Record<string, number> = {};

    for (const r of rows) {
      const st = r.acquisition_status as string;
      by_status[st] = (by_status[st] ?? 0) + 1;
      if (r.fingerprinted) flags.fingerprinted = (flags.fingerprinted ?? 0) + 1;
      if (r.enriched_spotify) flags.enriched_spotify = (flags.enriched_spotify ?? 0) + 1;
      if (r.enriched_audio) flags.enriched_audio = (flags.enriched_audio ?? 0) + 1;
      if (r.metadata_written) flags.metadata_written = (flags.metadata_written ?? 0) + 1;
      if (r.cover_art_written) flags.cover_art_written = (flags.cover_art_written ?? 0) + 1;
      if (r.in_library) flags.in_library = (flags.in_library ?? 0) + 1;
    }

    return NextResponse.json({ total, by_status, flags });
  }

  // RPC returns a single row with all counts
  const row = Array.isArray(data) ? data[0] : data;

  return NextResponse.json({
    total: row.total ?? 0,
    by_status: {
      candidate: row.candidate ?? 0,
      downloading: row.downloading ?? 0,
      available: row.available ?? 0,
      failed: row.failed ?? 0,
      duplicate: row.duplicate ?? 0,
    },
    flags: {
      fingerprinted: row.fingerprinted ?? 0,
      enriched_spotify: row.enriched_spotify ?? 0,
      enriched_audio: row.enriched_audio ?? 0,
      metadata_written: row.metadata_written ?? 0,
      cover_art_written: row.cover_art_written ?? 0,
      in_library: row.in_library ?? 0,
    },
  });
}
