import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";
import { rateLimit, limiters } from "@/lib/api-server/rate-limit";
import { createServiceClient } from "@/lib/supabase/service";
import { jsonError } from "@/lib/api-server/errors";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const rateLimitResponse = await rateLimit(request, limiters.write);
  if (rateLimitResponse) return rateLimitResponse;

  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  const { id: trackId } = await params;
  const supabase = createServiceClient();

  // Verify track belongs to user and is retryable
  const { data: track, error: fetchErr } = await supabase
    .from("tracks")
    .select("id, acquisition_status, user_id")
    .eq("id", trackId)
    .single();

  if (fetchErr || !track) {
    return jsonError("Track not found", 404);
  }
  if (track.user_id !== user.userId) {
    return jsonError("Forbidden", 403);
  }
  if (!["not_found", "failed"].includes(track.acquisition_status)) {
    return jsonError(
      `Cannot retry track with status '${track.acquisition_status}'`,
      400
    );
  }

  // Optional: update search_string if provided
  const body = await request.json().catch(() => ({}));
  const updates: Record<string, unknown> = {
    acquisition_status: "candidate",
    search_results_count: null,
  };
  if (body.search_string && typeof body.search_string === "string") {
    updates.search_string = body.search_string.trim();
  }

  const { data: updated, error: updateErr } = await supabase
    .from("tracks")
    .update(updates)
    .eq("id", trackId)
    .select()
    .single();

  if (updateErr) {
    return jsonError(updateErr.message, 500);
  }

  return NextResponse.json(updated);
}
