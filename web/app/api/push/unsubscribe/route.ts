import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";
import { rateLimit, limiters } from "@/lib/api-server/rate-limit";
import { createServiceClient } from "@/lib/supabase/service";
import { jsonError } from "@/lib/api-server/errors";

/**
 * DELETE /api/push/unsubscribe
 *
 * Remove a Web Push subscription for the authenticated user.
 */
export async function DELETE(request: NextRequest) {
  const rateLimitResponse = await rateLimit(request, limiters.write);
  if (rateLimitResponse) return rateLimitResponse;

  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  let body: { endpoint?: string };
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  if (!body.endpoint) {
    return jsonError("Missing required field: endpoint", 400);
  }

  const supabase = createServiceClient();

  const { error } = await supabase
    .from("push_subscriptions")
    .delete()
    .eq("endpoint", body.endpoint)
    .eq("user_id", user.userId);

  if (error) {
    console.error("push unsubscribe error:", error);
    return jsonError("Failed to remove subscription", 500);
  }

  return new NextResponse(null, { status: 204 });
}
