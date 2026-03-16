/**
 * Rate limiting stub.
 *
 * Redis-based rate limiting (Upstash) has been removed — unnecessary for a
 * single-user tool and caused repeated 429 errors during development.
 * All calls are no-ops that always allow the request through.
 */

export const limiters = {
  read: null,
  agent: null,
  batch: null,
  write: null,
  import: null,
  register: null,
  backfill: null,
} as const;

export type LimiterKey = keyof typeof limiters;

export async function rateLimit(
  _request: Request,
  _limiter: null,
  _identifier?: string
): Promise<Response | null> {
  return null;
}
