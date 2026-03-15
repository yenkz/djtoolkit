import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";
import { rateLimit, limiters } from "@/lib/api-server/rate-limit";
import { createServiceClient } from "@/lib/supabase/service";
import { jsonError } from "@/lib/api-server/errors";

export async function GET(request: NextRequest) {
  const rateLimitResponse = await rateLimit(request, limiters.read);
  if (rateLimitResponse) return rateLimitResponse;

  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  const supabase = createServiceClient();

  const [pendingResult, runningResult, agentsResult] = await Promise.all([
    supabase
      .from("pipeline_jobs")
      .select("*", { count: "exact", head: true })
      .eq("user_id", user.userId)
      .eq("status", "pending"),
    supabase
      .from("pipeline_jobs")
      .select("*", { count: "exact", head: true })
      .eq("user_id", user.userId)
      .in("status", ["claimed", "running"]),
    supabase
      .from("agents")
      .select("id, machine_name, last_seen_at, capabilities")
      .eq("user_id", user.userId)
      .order("last_seen_at", { ascending: false, nullsFirst: false }),
  ]);

  if (pendingResult.error || runningResult.error || agentsResult.error) {
    return jsonError("Failed to fetch pipeline status", 500);
  }

  const agents = (agentsResult.data ?? []).map((r) => ({
    id: String(r.id),
    machine_name: r.machine_name,
    last_seen_at: r.last_seen_at ?? null,
    capabilities: Array.isArray(r.capabilities) ? r.capabilities : [],
  }));

  return NextResponse.json({
    pending: pendingResult.count ?? 0,
    running: runningResult.count ?? 0,
    agents,
  });
}
