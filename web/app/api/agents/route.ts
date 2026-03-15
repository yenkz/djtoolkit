import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";
import { rateLimit, limiters } from "@/lib/api-server/rate-limit";
import { createServiceClient } from "@/lib/supabase/service";
import { jsonError } from "@/lib/api-server/errors";

export async function GET(request: NextRequest) {
  const rl = await rateLimit(request, limiters.read);
  if (rl) return rl;

  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from("agents")
    .select("id, machine_name, last_seen_at, capabilities, created_at")
    .eq("user_id", user.userId)
    .order("created_at", { ascending: false });

  if (error) {
    return jsonError("Failed to fetch agents", 500);
  }

  const agents = (data ?? []).map((row) => ({
    id: String(row.id),
    machine_name: row.machine_name,
    last_seen_at: row.last_seen_at ?? null,
    capabilities: Array.isArray(row.capabilities) ? row.capabilities : [],
    created_at: row.created_at,
  }));

  return NextResponse.json(agents);
}
