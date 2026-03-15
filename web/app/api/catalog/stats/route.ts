import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";
import { rateLimit, limiters } from "@/lib/api-server/rate-limit";
import { createServiceClient } from "@/lib/supabase/service";
import { jsonError } from "@/lib/api-server/errors";

const ACQUISITION_STATUSES = [
  "candidate",
  "downloading",
  "available",
  "failed",
  "duplicate",
] as const;

const PROCESSING_FLAGS = [
  "fingerprinted",
  "enriched_spotify",
  "enriched_audio",
  "metadata_written",
  "cover_art_written",
  "in_library",
] as const;

type AcquisitionStatus = (typeof ACQUISITION_STATUSES)[number];
type ProcessingFlag = (typeof PROCESSING_FLAGS)[number];

/**
 * GET /api/catalog/stats
 *
 * Return aggregate counts for the authenticated user's catalog.
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

  // Total count
  const { count: total, error: totalErr } = await supabase
    .from("tracks")
    .select("*", { count: "exact", head: true })
    .eq("user_id", user.userId);

  if (totalErr) {
    return jsonError("Failed to fetch catalog stats", 500);
  }

  // Count per acquisition_status — run all queries in parallel
  const statusCountResults = await Promise.all(
    ACQUISITION_STATUSES.map((status) =>
      supabase
        .from("tracks")
        .select("*", { count: "exact", head: true })
        .eq("user_id", user.userId)
        .eq("acquisition_status", status)
        .then(({ count, error }) => ({ status, count: count ?? 0, error }))
    )
  );

  for (const result of statusCountResults) {
    if (result.error) {
      return jsonError("Failed to fetch catalog stats", 500);
    }
  }

  const by_status = Object.fromEntries(
    statusCountResults.map(({ status, count }) => [status, count])
  ) as Record<AcquisitionStatus, number>;

  // Count per processing flag — run all queries in parallel
  const flagCountResults = await Promise.all(
    PROCESSING_FLAGS.map((flag) =>
      supabase
        .from("tracks")
        .select("*", { count: "exact", head: true })
        .eq("user_id", user.userId)
        .eq(flag, true)
        .then(({ count, error }) => ({ flag, count: count ?? 0, error }))
    )
  );

  for (const result of flagCountResults) {
    if (result.error) {
      return jsonError("Failed to fetch catalog stats", 500);
    }
  }

  const flags = Object.fromEntries(
    flagCountResults.map(({ flag, count }) => [flag, count])
  ) as Record<ProcessingFlag, number>;

  return NextResponse.json({
    total: total ?? 0,
    by_status,
    flags,
  });
}
