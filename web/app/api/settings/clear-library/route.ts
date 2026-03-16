import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";
import { rateLimit, limiters } from "@/lib/api-server/rate-limit";
import { createServiceClient } from "@/lib/supabase/service";
import { jsonError } from "@/lib/api-server/errors";

export async function POST(request: NextRequest) {
  const rl = await rateLimit(request, limiters.write);
  if (rl) return rl;

  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  const supabase = createServiceClient();

  // Delete all pipeline jobs for the user's tracks
  const { data: trackIds } = await supabase
    .from("tracks")
    .select("id")
    .eq("user_id", user.userId);

  if (trackIds && trackIds.length > 0) {
    const ids = trackIds.map((t) => t.id);
    await supabase.from("pipeline_jobs").delete().in("track_id", ids);
  }

  // Delete all tracks for the user
  const { error, count } = await supabase
    .from("tracks")
    .delete({ count: "exact" })
    .eq("user_id", user.userId);

  if (error) {
    return jsonError("Failed to clear library", 500);
  }

  return NextResponse.json({ deleted: count ?? 0 });
}
