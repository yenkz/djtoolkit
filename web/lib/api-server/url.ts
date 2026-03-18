/**
 * Derive base URLs from environment variables, falling back to the incoming
 * request's own origin so that production deployments work correctly even when
 * SPOTIFY_CALLBACK_URL / PLATFORM_FRONTEND_URL are not explicitly set.
 *
 * Precedence for the base origin:
 *   1. Explicit env var (PLATFORM_FRONTEND_URL)
 *   2. VERCEL_PROJECT_PRODUCTION_URL (set automatically on every Vercel deployment)
 *   3. The Host header of the current request (reflects the actual domain the
 *      user is visiting — more reliable than VERCEL_URL when a custom domain is
 *      mapped to a preview deployment)
 *   4. VERCEL_URL (deployment-specific URL — only as a last resort before localhost)
 *   5. localhost:3000 (last resort)
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
  // Prefer the Host header over VERCEL_URL — it reflects the actual domain
  // the user is visiting (e.g. www.djtoolkit.net), whereas VERCEL_URL is the
  // internal deployment URL which may differ when a custom domain is in use.
  const host = request.headers.get("host");
  if (host) {
    const proto = request.headers.get("x-forwarded-proto") || "https";
    return `${proto}://${host}`;
  }
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
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

/**
 * Return the origin the user is actually visiting, derived from the Host
 * header. Returns `null` when the host cannot be determined.
 *
 * This is used by the Spotify connect route to remember which deployment the
 * user started on (e.g. a Vercel preview URL) so the callback can redirect
 * them back to the same origin instead of always landing on production.
 */
export function getRequestOrigin(request: NextRequest): string | null {
  const host = request.headers.get("host");
  if (!host) return null;
  const proto = request.headers.get("x-forwarded-proto") || "https";
  return `${proto}://${host}`;
}

/**
 * Check whether a full URL points to a trusted origin.
 * Allows the production domain, any Vercel preview/branch deployment for the
 * project, and localhost for development.
 */
export function isTrustedOrigin(url: string): boolean {
  try {
    const { hostname } = new URL(url);

    // Production domain
    if (hostname === "www.djtoolkit.net" || hostname === "djtoolkit.net") {
      return true;
    }

    // Vercel preview / branch deployments (e.g. djtoolkit-xxx-yenkzs-projects.vercel.app)
    if (
      hostname.endsWith("-yenkzs-projects.vercel.app") ||
      (hostname.endsWith(".vercel.app") && hostname.startsWith("djtoolkit"))
    ) {
      return true;
    }

    // Local development
    if (hostname === "localhost" || hostname === "127.0.0.1") {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

/** Frontend URL for redirecting users back to the UI. */
export function getFrontendUrl(request: NextRequest): string {
  return getBaseOrigin(request);
}

/**
 * Production-safe frontend URL. Skips VERCEL_URL so OAuth callbacks always
 * redirect to the production domain, never to a preview deployment.
 */
export function getProductionFrontendUrl(request: NextRequest): string {
  return getProductionOrigin(request);
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
