/**
 * Derive base URLs from environment variables, falling back to the incoming
 * request's own origin so that production deployments work correctly even when
 * SPOTIFY_CALLBACK_URL / PLATFORM_FRONTEND_URL are not explicitly set.
 *
 * Precedence for the base origin:
 *   1. Explicit env var (PLATFORM_FRONTEND_URL)
 *   2. VERCEL_PROJECT_PRODUCTION_URL (set automatically on every Vercel deployment)
 *   3. The Host header of the current request
 *   4. localhost:3000 (last resort)
 *
 * For OAuth callbacks specifically, we NEVER use VERCEL_URL because preview
 * deployments are behind Vercel Authentication (SSO), which intercepts the
 * callback from Spotify before it reaches our route handler. Instead, OAuth
 * always routes through the production URL.
 */

import { NextRequest } from "next/server";

function getBaseOrigin(request: NextRequest): string {
  if (process.env.PLATFORM_FRONTEND_URL) {
    return process.env.PLATFORM_FRONTEND_URL;
  }
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }
  // Derive from the incoming request
  const host = request.headers.get("host");
  if (host) {
    const proto = request.headers.get("x-forwarded-proto") || "https";
    return `${proto}://${host}`;
  }
  return "http://localhost:3000";
}

/**
 * Production-safe origin that skips VERCEL_URL (preview deployments).
 * Used for OAuth callbacks that must not hit Vercel Authentication.
 */
function getProductionOrigin(request: NextRequest): string {
  if (process.env.PLATFORM_FRONTEND_URL) {
    return process.env.PLATFORM_FRONTEND_URL;
  }
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  // Skip VERCEL_URL — preview deployments are behind Vercel Auth (SSO)
  const host = request.headers.get("host");
  if (host) {
    const proto = request.headers.get("x-forwarded-proto") || "https";
    return `${proto}://${host}`;
  }
  return "http://localhost:3000";
}

/** Frontend URL for redirecting users back to the UI. */
export function getFrontendUrl(request: NextRequest): string {
  return getBaseOrigin(request);
}

/**
 * Spotify OAuth redirect URI.
 *
 * Uses SPOTIFY_CALLBACK_URL if set, otherwise derives from the production
 * origin. Preview deployment URLs (VERCEL_URL) are intentionally skipped
 * because they sit behind Vercel Authentication, which blocks the OAuth
 * callback from Spotify.
 *
 * The value MUST match what is registered in the Spotify Developer Dashboard.
 */
export function getSpotifyCallbackUrl(request: NextRequest): string {
  if (process.env.SPOTIFY_CALLBACK_URL) {
    return process.env.SPOTIFY_CALLBACK_URL;
  }
  return `${getProductionOrigin(request)}/api/auth/spotify/callback`;
}
