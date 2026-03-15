import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";
import { rateLimit, limiters } from "@/lib/api-server/rate-limit";
import { createServiceClient } from "@/lib/supabase/service";
import { jsonError } from "@/lib/api-server/errors";

export async function POST(request: NextRequest) {
  const rl = await rateLimit(request, limiters.agent);
  if (rl) return rl;

  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  if (!user.agentId) {
    return jsonError(
      "Heartbeat requires an agent API key, not a JWT",
      403,
    );
  }

  let body: {
    capabilities?: string[];
    version?: string;
    active_jobs?: number;
  } = {};
  try {
    body = await request.json();
  } catch {
    // Empty or non-JSON body is fine — all fields are optional
  }

  const { capabilities, version, active_jobs } = body;

  const updates: Record<string, unknown> = { last_seen_at: new Date().toISOString() };
  if (capabilities !== undefined) updates.capabilities = capabilities;
  if (version !== undefined) updates.version = version;
  if (active_jobs !== undefined) updates.active_jobs = active_jobs;

  const supabase = createServiceClient();

  const { error } = await supabase
    .from("agents")
    .update(updates)
    .eq("id", user.agentId)
    .eq("user_id", user.userId);

  if (error) {
    return jsonError("Failed to update heartbeat", 500);
  }

  return new NextResponse(null, { status: 204 });
}
