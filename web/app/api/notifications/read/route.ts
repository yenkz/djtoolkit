import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";
import { rateLimit, limiters } from "@/lib/api-server/rate-limit";
import { createServiceClient } from "@/lib/supabase/service";
import { jsonError } from "@/lib/api-server/errors";

/**
 * PATCH /api/notifications/read
 *
 * Mark notifications as read. Accepts { id: string } for a single
 * notification or { all: true } to mark all as read.
 */
export async function PATCH(request: NextRequest) {
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
      .update({ read: true })
      .eq("user_id", user.userId)
      .eq("read", false);

    if (error) {
      console.error("mark all read error:", error);
      return jsonError("Failed to mark notifications as read", 500);
    }
  } else if (body.id) {
    const { error } = await supabase
      .from("push_notifications")
      .update({ read: true })
      .eq("id", body.id)
      .eq("user_id", user.userId);

    if (error) {
      console.error("mark read error:", error);
      return jsonError("Failed to mark notification as read", 500);
    }
  } else {
    return jsonError("Must provide 'id' or 'all: true'", 400);
  }

  return new NextResponse(null, { status: 204 });
}
