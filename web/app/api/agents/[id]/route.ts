import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";
import { rateLimit, limiters } from "@/lib/api-server/rate-limit";
import { auditLog, getClientIp } from "@/lib/api-server/audit";
import { createServiceClient } from "@/lib/supabase/service";
import { jsonError } from "@/lib/api-server/errors";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const rl = await rateLimit(request, limiters.write);
  if (rl) return rl;

  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  const { id } = await params;

  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from("agents")
    .delete()
    .eq("id", id)
    .eq("user_id", user.userId)
    .select("id");

  if (error) {
    return jsonError("Failed to delete agent", 500);
  }

  if (!data || data.length === 0) {
    return jsonError("Agent not found", 404);
  }

  await auditLog(user.userId, "agent.delete", {
    resourceType: "agent",
    resourceId: id,
    ipAddress: getClientIp(request),
  });

  return new NextResponse(null, { status: 204 });
}
