import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";
import { rateLimit, limiters } from "@/lib/api-server/rate-limit";
import { createServiceClient } from "@/lib/supabase/service";
import { jsonError } from "@/lib/api-server/errors";

/**
 * GET /api/notifications?limit=20
 *
 * List push notifications for the authenticated user, newest first.
 */
export async function GET(request: NextRequest) {
  const rateLimitResponse = await rateLimit(request, limiters.read);
  if (rateLimitResponse) return rateLimitResponse;

  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  const { searchParams } = request.nextUrl;
  let limit = 20;
  const rawLimit = searchParams.get("limit");
  if (rawLimit !== null) {
    limit = parseInt(rawLimit, 10);
    if (isNaN(limit) || limit < 1) limit = 1;
    if (limit > 50) limit = 50;
  }

  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from("push_notifications")
    .select("id, type, title, body, url, data, read, created_at")
    .eq("user_id", user.userId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("notifications list error:", error);
    return jsonError("Failed to fetch notifications", 500);
  }

  return NextResponse.json(data ?? []);
}
