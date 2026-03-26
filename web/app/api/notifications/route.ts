import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";
import { rateLimit, limiters } from "@/lib/api-server/rate-limit";
import { createServiceClient } from "@/lib/supabase/service";
import { jsonError } from "@/lib/api-server/errors";

/**
 * GET /api/notifications?limit=20&offset=0&type=batch_complete
 *
 * List push notifications for the authenticated user, newest first.
 * Optional `type` param filters by notification type.
 * Optional `offset` param for pagination.
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

  let offset = 0;
  const rawOffset = searchParams.get("offset");
  if (rawOffset !== null) {
    offset = parseInt(rawOffset, 10);
    if (isNaN(offset) || offset < 0) offset = 0;
  }

  const type = searchParams.get("type");

  const supabase = createServiceClient();

  let query = supabase
    .from("push_notifications")
    .select("id, type, title, body, url, data, read, created_at")
    .eq("user_id", user.userId)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (type) {
    query = query.eq("type", type);
  }

  const { data, error } = await query;

  if (error) {
    console.error("notifications list error:", error);
    return jsonError("Failed to fetch notifications", 500);
  }

  return NextResponse.json(data ?? []);
}

/**
 * DELETE /api/notifications
 *
 * Delete notifications. Accepts { id: string } for a single notification
 * or { all: true } to delete all notifications for the user.
 */
export async function DELETE(request: NextRequest) {
  const rateLimitResponse = await rateLimit(request, limiters.write);
  if (rateLimitResponse) return rateLimitResponse;

  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  let body: { id?: string; all?: boolean };
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  const supabase = createServiceClient();

  if (body.all) {
    const { error } = await supabase
      .from("push_notifications")
      .delete()
      .eq("user_id", user.userId);

    if (error) {
      console.error("delete all notifications error:", error);
      return jsonError("Failed to delete notifications", 500);
    }
  } else if (body.id) {
    const { error } = await supabase
      .from("push_notifications")
      .delete()
      .eq("id", body.id)
      .eq("user_id", user.userId);

    if (error) {
      console.error("delete notification error:", error);
      return jsonError("Failed to delete notification", 500);
    }
  } else {
    return jsonError("Must provide 'id' or 'all: true'", 400);
  }

  return new NextResponse(null, { status: 204 });
}
