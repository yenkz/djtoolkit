import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import { jsonError } from "./errors";
import { createServiceClient } from "@/lib/supabase/service";

// ─── Current user context ───────────────────────────────────────────────────

export interface CurrentUser {
  userId: string;
  email?: string | null;
  agentId?: string | null;
}

// ─── Type guard ─────────────────────────────────────────────────────────────

/**
 * Type guard to distinguish auth errors (Response) from successful auth
 * (CurrentUser). Use after calling `getAuthUser` or `getAuthUserFromCookies`.
 */
export function isAuthError(
  result: CurrentUser | NextResponse,
): result is NextResponse {
  return result instanceof NextResponse;
}

// ─── JWT verification ───────────────────────────────────────────────────────

/**
 * Verify a Supabase JWT by delegating to the Supabase service client's
 * `auth.getUser(token)`. This avoids manual EC/HS256 key management —
 * Supabase handles verification server-side.
 *
 * Returns `CurrentUser` on success or an error `Response` on failure.
 */
export async function verifyJwt(
  token: string,
): Promise<CurrentUser | NextResponse> {
  const supabase = createServiceClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser(token);

  if (error || !user) {
    return jsonError("Invalid or expired token", 401);
  }

  return {
    userId: user.id,
    email: user.email ?? null,
  };
}

// ─── Agent key verification ─────────────────────────────────────────────────

/**
 * Verify a `djt_` agent API key against `agents.api_key_hash` in the DB.
 *
 * Uses the key prefix (first 8 chars after `djt_`) for an indexed lookup,
 * then bcrypt-verifies only the matching row(s). Returns an error Response
 * if no match.
 */
export async function verifyAgentKey(
  token: string,
): Promise<CurrentUser | NextResponse> {
  if (!token.startsWith("djt_") || token.length < 12) {
    return jsonError("Invalid agent API key", 401);
  }

  const prefix = token.slice(4, 12);
  const supabase = createServiceClient();

  const { data: rows, error } = await supabase
    .from("agents")
    .select("id, user_id, api_key_hash")
    .eq("api_key_prefix", prefix);

  if (error || !rows || rows.length === 0) {
    return jsonError("Invalid agent API key", 401);
  }

  for (const row of rows) {
    try {
      const match = await bcrypt.compare(token, row.api_key_hash);
      if (match) {
        return {
          userId: String(row.user_id),
          agentId: String(row.id),
        };
      }
    } catch {
      // Malformed hash or bcrypt error — skip this row
      continue;
    }
  }

  return jsonError("Invalid agent API key", 401);
}

// ─── Bearer token auth (API routes) ────────────────────────────────────────

/**
 * Extract Bearer token from the Authorization header and dispatch to JWT or
 * agent key verification based on token shape:
 * - Three dot-separated segments -> Supabase JWT
 * - `djt_` prefix -> agent API key
 *
 * Returns `CurrentUser` on success or an error `Response` on failure.
 */
export async function getAuthUser(
  request: NextRequest,
): Promise<CurrentUser | NextResponse> {
  const authorization = request.headers.get("Authorization");

  if (!authorization || !authorization.startsWith("Bearer ")) {
    return jsonError("Authorization header must use Bearer scheme", 401);
  }

  const token = authorization.slice("Bearer ".length);

  if (token.split(".").length === 3) {
    return verifyJwt(token);
  }

  return verifyAgentKey(token);
}

// ─── Cookie-based auth (browser / SSR routes) ──────────────────────────────

/**
 * Authenticate from Supabase SSR cookies — used in browser-facing routes
 * (Server Components, server actions) where auth comes from cookies rather
 * than an Authorization header.
 *
 * Returns `CurrentUser` on success or an error `Response` on failure.
 */
export async function getAuthUserFromCookies(): Promise<
  CurrentUser | NextResponse
> {
  const cookieStore = await cookies();

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Server Component — cookies can't be set here
          }
        },
      },
    },
  );

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    return jsonError("Not authenticated", 401);
  }

  return {
    userId: user.id,
    email: user.email ?? null,
  };
}
