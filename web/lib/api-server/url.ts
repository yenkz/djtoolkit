/**
 * Derive base URLs from environment variables, falling back to the incoming
 * request's own origin so that production deployments work correctly even when
 * SPOTIFY_CALLBACK_URL / PLATFORM_FRONTEND_URL are not explicitly set.
 *
 * Precedence for the base origin:
 *   1. Explicit env var (PLATFORM_FRONTEND_URL)
 *   2. VERCEL_PROJECT_PRODUCTION_URL (set automatically on Vercel production)
 *   3. VERCEL_URL (set on every Vercel deployment, including previews)
 *   4. The Host header of the current request
 *   5. localhost:3000 (last resort)
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

/** Frontend URL for redirecting users back to the UI. */
export function getFrontendUrl(request: NextRequest): string {
  return getBaseOrigin(request);
}

/**
 * Spotify OAuth redirect URI.
 *
 * Uses SPOTIFY_CALLBACK_URL if set, otherwise derives from the request origin.
 * The value MUST match what is registered in the Spotify Developer Dashboard.
 */
export function getSpotifyCallbackUrl(request: NextRequest): string {
  if (process.env.SPOTIFY_CALLBACK_URL) {
    return process.env.SPOTIFY_CALLBACK_URL;
  }
  return `${getBaseOrigin(request)}/api/auth/spotify/callback`;
}
