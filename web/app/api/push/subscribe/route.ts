import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";
import { rateLimit, limiters } from "@/lib/api-server/rate-limit";
import { createServiceClient } from "@/lib/supabase/service";
import { jsonError } from "@/lib/api-server/errors";

/**
 * POST /api/push/subscribe
 *
 * Save a Web Push subscription for the authenticated user.
 * Upserts on endpoint (same browser re-subscribing updates keys).
 */
export async function POST(request: NextRequest) {
  const rateLimitResponse = await rateLimit(request, limiters.write);
  if (rateLimitResponse) return rateLimitResponse;

  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  let body: { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  const { endpoint, keys } = body;
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return jsonError("Missing required fields: endpoint, keys.p256dh, keys.auth", 400);
  }

  const supabase = createServiceClient();

  const { error } = await supabase
    .from("push_subscriptions")
    .upsert(
      {
        user_id: user.userId,
        endpoint,
        keys_p256dh: keys.p256dh,
        keys_auth: keys.auth,
      },
      { onConflict: "endpoint" }
    );

  if (error) {
    console.error("push subscribe error:", error);
    return jsonError("Failed to save subscription", 500);
  }

  return new NextResponse(null, { status: 201 });
}
