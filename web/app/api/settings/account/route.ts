import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";
import { rateLimit, limiters } from "@/lib/api-server/rate-limit";
import { createServiceClient } from "@/lib/supabase/service";
import { jsonError } from "@/lib/api-server/errors";

export async function DELETE(request: NextRequest) {
  const rl = await rateLimit(request, limiters.write);
  if (rl) return rl;

  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  const supabase = createServiceClient();

  // Delete all user data in order: pipeline_jobs -> tracks -> agents -> user_settings
  const { data: trackIds } = await supabase
    .from("tracks")
    .select("id")
    .eq("user_id", user.userId);

  if (trackIds && trackIds.length > 0) {
    const ids = trackIds.map((t) => t.id);
    await supabase.from("pipeline_jobs").delete().in("track_id", ids);
  }

  await supabase.from("tracks").delete().eq("user_id", user.userId);
  await supabase.from("agents").delete().eq("user_id", user.userId);
  await supabase.from("user_settings").delete().eq("user_id", user.userId);

  // Delete the auth user via admin API
  const { error } = await supabase.auth.admin.deleteUser(user.userId);

  if (error) {
    return jsonError("Failed to delete account", 500);
  }

  return NextResponse.json({ deleted: true });
}
