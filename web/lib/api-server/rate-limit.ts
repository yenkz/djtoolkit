/**
 * Upstash Redis rate limiters mirroring the FastAPI slowapi configuration.
 *
 * Usage:
 *
 *   import { limiters, rateLimit } from "@/lib/api-server/rate-limit";
 *
 *   const limited = await rateLimit(request, limiters.read);
 *   if (limited) return limited;
 */

import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { jsonError } from "./errors";

const hasRedis =
  !!process.env.UPSTASH_REDIS_REST_URL &&
  !!process.env.UPSTASH_REDIS_REST_TOKEN;

const redis = hasRedis ? Redis.fromEnv() : (null as unknown as Redis);

/**
 * Pre-configured rate limiters keyed by endpoint category.
 * All windows are sliding 1-hour windows, matching the FastAPI slowapi config.
 */
export const limiters = {
  /** Standard read endpoints — 300 req/hour */
  read: new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(300, "1 h"),
    prefix: "rl:read",
  }),

  /** Agent claim / result endpoints — 100 req/hour */
  agent: new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(100, "1 h"),
    prefix: "rl:agent",
  }),

  /** Batch claim endpoints — 60 req/hour */
  batch: new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(60, "1 h"),
    prefix: "rl:batch",
  }),

  /** Bulk create / retry endpoints — 30 req/hour */
  write: new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(30, "1 h"),
    prefix: "rl:write",
  }),

  /** Import / OAuth endpoints — 20 req/hour */
  import: new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(20, "1 h"),
    prefix: "rl:import",
  }),

  /** Agent registration — 10 req/hour */
  register: new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(10, "1 h"),
    prefix: "rl:register",
  }),

  /** Backfill operations — 5 req/hour */
  backfill: new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(5, "1 h"),
    prefix: "rl:backfill",
  }),
} as const;

export type LimiterKey = keyof typeof limiters;

/**
 * Check the rate limit for a request.
 *
 * @param request  - The incoming Next.js/Fetch API Request.
 * @param limiter  - One of the pre-configured `limiters` instances.
 * @param identifier - Optional explicit identifier (e.g. userId). Falls back
 *                     to x-forwarded-for → x-real-ip → "anonymous".
 * @returns `null` if the request is allowed; a 429 Response if rate-limited.
 */
export async function rateLimit(
  request: Request,
  limiter: Ratelimit,
  identifier?: string
): Promise<Response | null> {
  const id =
    identifier ??
    request.headers.get("x-forwarded-for")?.split(",")[0].trim() ??
    request.headers.get("x-real-ip") ??
    "anonymous";

  if (!hasRedis) return null; // Skip rate limiting when Redis is not configured

  const { success } = await limiter.limit(id);

  if (!success) {
    return jsonError("Rate limit exceeded. Please try again later.", 429);
  }

  return null;
}
