import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";
import { rateLimit, limiters } from "@/lib/api-server/rate-limit";
import { auditLog, getClientIp } from "@/lib/api-server/audit";
import { createServiceClient } from "@/lib/supabase/service";
import { jsonError } from "@/lib/api-server/errors";

function createAgentKey(): { plain: string; hash: string; prefix: string } {
  const plain = "djt_" + crypto.randomBytes(20).toString("hex");
  const hash = bcrypt.hashSync(plain, 10);
  const prefix = plain.slice(4, 12);
  return { plain, hash, prefix };
}

export async function POST(request: NextRequest) {
  const rl = await rateLimit(request, limiters.register);
  if (rl) return rl;

  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  let body: { machine_name?: string; capabilities?: string[] } = {};
  try {
    body = await request.json();
  } catch {
    // Empty or non-JSON body is fine — all fields are optional
  }

  const { machine_name, capabilities } = body;
  const { plain, hash, prefix } = createAgentKey();
  const agentId = crypto.randomUUID();

  const supabase = createServiceClient();

  const { error } = await supabase.from("agents").insert({
    id: agentId,
    user_id: user.userId,
    api_key_hash: hash,
    api_key_prefix: prefix,
    machine_name: machine_name ?? null,
    capabilities: capabilities ?? [],
  });

  if (error) {
    return jsonError("Failed to register agent", 500);
  }

  await auditLog(user.userId, "agent.register", {
    resourceType: "agent",
    resourceId: agentId,
    details: { machine_name: machine_name ?? null },
    ipAddress: getClientIp(request),
  });

  return NextResponse.json(
    {
      agent_id: agentId,
      api_key: plain,
      message: "Store this key securely — it will not be shown again.",
    },
    { status: 201 },
  );
}
