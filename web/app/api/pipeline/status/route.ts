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

  // Single RPC for all status counts + agents query in parallel
  const [rpcResult, agentsResult] = await Promise.all([
    supabase.rpc("pipeline_status", { p_user_id: user.userId }),
    supabase
      .from("agents")
      .select("id, machine_name, last_seen_at, capabilities")
      .eq("user_id", user.userId)
      .order("last_seen_at", { ascending: false, nullsFirst: false }),
  ]);

  let counts: Record<string, number>;

  if (rpcResult.error) {
    // Fallback: 8 parallel count queries if RPC not deployed yet
    const countResults = await Promise.all(
      PIPELINE_STATUSES.map((s) =>
        supabase
          .from("tracks")
          .select("*", { count: "exact", head: true })
          .eq("user_id", user.userId)
          .eq("acquisition_status", s)
      ),
    );

    if (countResults.some((r) => r.error)) {
      return jsonError("Failed to fetch pipeline status", 500);
    }

    counts = {};
    PIPELINE_STATUSES.forEach((s, i) => {
      counts[s] = countResults[i].count ?? 0;
    });
  } else {
    const row = Array.isArray(rpcResult.data) ? rpcResult.data[0] : rpcResult.data;
    counts = {};
    for (const s of PIPELINE_STATUSES) {
      counts[s] = row?.[s] ?? 0;
    }
  }

  if (agentsResult.error) {
    return jsonError("Failed to fetch pipeline status", 500);
  }

  const agents = (agentsResult.data ?? []).map((r) => ({
    id: String(r.id),
    machine_name: r.machine_name,
    last_seen_at: r.last_seen_at ?? null,
    capabilities: Array.isArray(r.capabilities) ? r.capabilities : [],
  }));

  return NextResponse.json({ ...counts, agents });
}
