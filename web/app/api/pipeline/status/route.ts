import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";
import { rateLimit, limiters } from "@/lib/api-server/rate-limit";
import { createServiceClient } from "@/lib/supabase/service";
import { jsonError } from "@/lib/api-server/errors";

const PIPELINE_STATUSES = [
  "candidate", "searching", "found", "not_found",
  "queued", "downloading", "failed", "paused",
] as const;

export async function GET(request: NextRequest) {
  const rateLimitResponse = await rateLimit(request, limiters.read);
  if (rateLimitResponse) return rateLimitResponse;

  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  const supabase = createServiceClient();

  // Count each pipeline status with efficient head-only queries
  const countPromises = PIPELINE_STATUSES.map((s) =>
    supabase
      .from("tracks")
      .select("*", { count: "exact", head: true })
      .eq("user_id", user.userId)
      .eq("acquisition_status", s)
  );

  const agentsPromise = supabase
    .from("agents")
    .select("id, machine_name, last_seen_at, capabilities")
    .eq("user_id", user.userId)
    .order("last_seen_at", { ascending: false, nullsFirst: false });

  const [agentsResult, ...countResults] = await Promise.all([
    agentsPromise,
    ...countPromises,
  ]);

  if (countResults.some((r) => r.error) || agentsResult.error) {
    return jsonError("Failed to fetch pipeline status", 500);
  }

  const counts: Record<string, number> = {};
  PIPELINE_STATUSES.forEach((s, i) => {
    counts[s] = countResults[i].count ?? 0;
  });

  const agents = (agentsResult.data ?? []).map((r) => ({
    id: String(r.id),
    machine_name: r.machine_name,
    last_seen_at: r.last_seen_at ?? null,
    capabilities: Array.isArray(r.capabilities) ? r.capabilities : [],
  }));

  return NextResponse.json({ ...counts, agents });
}
