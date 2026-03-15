import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";
import { rateLimit, limiters } from "@/lib/api-server/rate-limit";
import { auditLog, getClientIp } from "@/lib/api-server/audit";
import { createServiceClient } from "@/lib/supabase/service";
import { jsonError } from "@/lib/api-server/errors";

const MAX_TRACK_IDS = 1000;

/**
 * DELETE /api/catalog/tracks/bulk
 *
 * Bulk-delete candidate tracks owned by the authenticated user.
 * Only tracks with acquisition_status = 'candidate' are eligible.
 *
 * Body: { track_ids: number[] } (max 1000)
 * Returns: { deleted: N }
 */
export async function DELETE(request: NextRequest) {
  const rl = await rateLimit(request, limiters.write);
  if (rl) return rl;

  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  let body: { track_ids?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  const { track_ids } = body;
  if (!Array.isArray(track_ids)) {
    return jsonError("track_ids must be an array", 400);
  }
  if (track_ids.length === 0) {
    return NextResponse.json({ deleted: 0 });
  }
  if (track_ids.length > MAX_TRACK_IDS) {
    return jsonError(`track_ids exceeds maximum of ${MAX_TRACK_IDS}`, 400);
  }
  if (!track_ids.every((id) => typeof id === "number" && Number.isInteger(id))) {
    return jsonError("track_ids must contain only integers", 400);
  }

  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from("tracks")
    .delete()
    .eq("user_id", user.userId)
    .eq("acquisition_status", "candidate")
    .in("id", track_ids)
    .select("id");

  if (error) {
    return jsonError("Failed to delete tracks", 500);
  }

  const deleted = data?.length ?? 0;

  await auditLog(user.userId, "track.bulk_delete", {
    resourceType: "track",
    details: { deleted, requested_track_ids: track_ids },
    ipAddress: getClientIp(request),
  });

  return NextResponse.json({ deleted });
}
