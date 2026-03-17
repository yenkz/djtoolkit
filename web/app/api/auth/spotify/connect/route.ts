/**
 * GET /api/auth/spotify/connect
 *
 * Initiate Spotify OAuth flow. Takes a JWT token and optional return_to path
 * as query params. Verifies the JWT, stores OAuth state in the database, and
 * redirects the user to Spotify's authorization page.
 */

import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { verifyJwt, isAuthError } from "@/lib/api-server/auth";
import { rateLimit, limiters } from "@/lib/api-server/rate-limit";
import { createServiceClient } from "@/lib/supabase/service";
import { getFrontendUrl, getSpotifyCallbackUrl } from "@/lib/api-server/url";

const SPOTIFY_AUTHORIZE_URL = "https://accounts.spotify.com/authorize";
const SCOPES = "playlist-read-private playlist-read-collaborative user-library-read";

export async function GET(request: NextRequest) {
  const rl = await rateLimit(request, limiters.write);
  if (rl) return rl;

  const { searchParams } = request.nextUrl;
  const token = searchParams.get("token");
  let returnTo = searchParams.get("return_to") || "/";

  const frontendUrl = getFrontendUrl(request);

  if (!token) {
    return NextResponse.redirect(
      new URL(`${frontendUrl}${returnTo}?spotify=error&reason=missing_token`)
    );
  }

  // Verify JWT
  const user = await verifyJwt(token);
  if (isAuthError(user)) {
    return NextResponse.redirect(
      new URL(`${frontendUrl}${returnTo}?spotify=error&reason=invalid_token`)
    );
  }

  // Sanitize return_to to prevent open redirects
  if (
    returnTo.includes("://") ||
    returnTo.startsWith("//") ||
    returnTo.startsWith("/\\")
  ) {
    returnTo = "/";
  }

  // Generate state token
  const state =
    crypto.randomUUID() + crypto.randomBytes(16).toString("hex");

  // Store state in DB (single-use, expires in 10 minutes)
  const supabase = createServiceClient();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  const { error: insertError } = await supabase.from("oauth_states").insert({
    state,
    user_id: user.userId,
    return_to: returnTo,
    expires_at: expiresAt,
  });

  if (insertError) {
    console.error("oauth_states insert failed:", insertError.message, insertError.code);
    return NextResponse.redirect(
      new URL(`${frontendUrl}${returnTo}?spotify=error&reason=state_error`)
    );
  }

  // Build Spotify authorization URL
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const callbackUrl = getSpotifyCallbackUrl(request);

  if (!clientId) {
    return NextResponse.redirect(
      new URL(`${frontendUrl}${returnTo}?spotify=error&reason=config_error`)
    );
  }

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: callbackUrl,
    state,
    scope: SCOPES,
    show_dialog: "true",
  });

  const spotifyUrl = `${SPOTIFY_AUTHORIZE_URL}?${params.toString()}`;

  return NextResponse.redirect(new URL(spotifyUrl));
}
