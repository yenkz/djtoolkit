/**
 * POST /api/auth/spotify/disconnect
 *
 * Remove stored Spotify tokens for the authenticated user.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";
import { rateLimit, limiters } from "@/lib/api-server/rate-limit";
import { createServiceClient } from "@/lib/supabase/service";
import { jsonError } from "@/lib/api-server/errors";
import { auditLog, getClientIp } from "@/lib/api-server/audit";

export async function POST(request: NextRequest) {
  const rl = await rateLimit(request, limiters.write);
  if (rl) return rl;

  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  const supabase = createServiceClient();

  const { error } = await supabase
    .from("users")
    .update({
      spotify_access_token: null,
      spotify_refresh_token: null,
      spotify_token_expires_at: null,
    })
    .eq("id", user.userId);

  if (error) {
    return jsonError("Failed to disconnect Spotify", 500);
  }

  await auditLog(user.userId, "spotify.disconnect", {
    ipAddress: getClientIp(request),
  });

  return new NextResponse(null, { status: 204 });
}
