/**
 * GET /api/auth/spotify/callback
 *
 * Handle Spotify OAuth callback. Exchanges the authorization code for tokens,
 * encrypts them, and stores them in the users table. Redirects back to the
 * frontend with a success or error query param.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { fernetEncrypt } from "@/lib/api-server/fernet";
import { auditLog, getClientIp } from "@/lib/api-server/audit";
import { getFrontendUrl, getSpotifyCallbackUrl } from "@/lib/api-server/url";

const TOKEN_ENDPOINT = "https://accounts.spotify.com/api/token";

export async function GET(request: NextRequest) {
  const frontendUrl = getFrontendUrl(request);

  const { searchParams } = request.nextUrl;
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");

  // Spotify returned an error or missing params
  if (error || !code || !state) {
    return NextResponse.redirect(
      new URL(`${frontendUrl}/?spotify=error&reason=${error || "missing_params"}`)
    );
  }

  const supabase = createServiceClient();

  // Look up and immediately delete the state (single-use)
  const { data: oauthState, error: stateError } = await supabase
    .from("oauth_states")
    .select("user_id, return_to, expires_at")
    .eq("state", state)
    .single();

  if (stateError || !oauthState) {
    return NextResponse.redirect(
      new URL(`${frontendUrl}/?spotify=error&reason=invalid_state`)
    );
  }

  // Delete the state row immediately (single-use)
  await supabase.from("oauth_states").delete().eq("state", state);

  // Check expiry
  const expiresAt = new Date(oauthState.expires_at).getTime();
  if (Date.now() > expiresAt) {
    return NextResponse.redirect(
      new URL(`${frontendUrl}/?spotify=error&reason=state_expired`)
    );
  }

  const returnTo = oauthState.return_to || "/";
  const userId = oauthState.user_id;

  // Exchange authorization code for tokens
  const clientId = process.env.SPOTIFY_CLIENT_ID!;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET!;
  const callbackUrl = getSpotifyCallbackUrl(request);

  const tokenResp = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: callbackUrl,
    }),
  });

  if (!tokenResp.ok) {
    const body = await tokenResp.text();
    console.error("Spotify token exchange failed:", tokenResp.status, body);
    return NextResponse.redirect(
      new URL(`${frontendUrl}${returnTo}?spotify=error&reason=token_exchange_failed`)
    );
  }

  const tokens = (await tokenResp.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  // Encrypt tokens before storing
  const encryptedAccess = fernetEncrypt(tokens.access_token);
  const encryptedRefresh = fernetEncrypt(tokens.refresh_token);
  const expiresAtIso = new Date(
    Date.now() + tokens.expires_in * 1000
  ).toISOString();

  // Update user's Spotify tokens
  const { error: updateError } = await supabase
    .from("users")
    .update({
      spotify_access_token: encryptedAccess,
      spotify_refresh_token: encryptedRefresh,
      spotify_token_expires_at: expiresAtIso,
    })
    .eq("id", userId);

  if (updateError) {
    console.error("users update failed:", updateError.message, updateError.code);
    return NextResponse.redirect(
      new URL(`${frontendUrl}${returnTo}?spotify=error&reason=save_failed`)
    );
  }

  // Audit log (fire-and-forget)
  await auditLog(userId, "spotify.connect", {
    ipAddress: getClientIp(request),
  });

  return NextResponse.redirect(
    new URL(`${frontendUrl}${returnTo}?spotify=connected`)
  );
}
