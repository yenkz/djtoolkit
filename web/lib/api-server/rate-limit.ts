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

function initRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    return Redis.fromEnv();
  } catch {
    console.warn("Failed to initialise Upstash Redis – rate limiting disabled");
    return null;
  }
}

const redis = initRedis();

function rl(max: number, prefix: string): Ratelimit | null {
  if (!redis) return null;
  return new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(max, "1 h"),
    prefix,
  });
}

/**
 * Pre-configured rate limiters keyed by endpoint category.
 * All windows are sliding 1-hour windows, matching the FastAPI slowapi config.
 * Values are null when Redis is not available — rateLimit() handles this gracefully.
 */
export const limiters = {
  read: rl(600, "rl:read"),
  agent: rl(100, "rl:agent"),
  batch: rl(60, "rl:batch"),
  write: rl(30, "rl:write"),
  import: rl(20, "rl:import"),
  register: rl(10, "rl:register"),
  backfill: rl(5, "rl:backfill"),
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
  limiter: Ratelimit | null,
  identifier?: string
): Promise<Response | null> {
  if (!limiter) return null; // Skip when Redis is not available

  const id =
    identifier ??
    request.headers.get("x-forwarded-for")?.split(",")[0].trim() ??
    request.headers.get("x-real-ip") ??
    "anonymous";

  const { success } = await limiter.limit(id);

  if (!success) {
    return jsonError("Rate limit exceeded. Please try again later.", 429);
  }

  return null;
}
