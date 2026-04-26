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

  // Insert agent row
  const { error } = await supabase.from("agents").insert({
    id: agentId,
    user_id: user.userId,
    api_key_hash: hash,
    api_key_prefix: prefix,
    machine_name: machine_name ?? null,
    capabilities: capabilities ?? [],
  });

  if (error) {
    console.error("agents.insert failed", {
      code: error.code,
      message: error.message,
      details: error.details,
      hint: error.hint,
    });
    return jsonError("Failed to register agent", 500);
  }

  // Create a Supabase Auth machine user for Realtime subscriptions.
  // The machine user's app_metadata.owner_user_id links it to the real user
  // so the RLS policy can grant SELECT access to the owner's pipeline_jobs.
  const agentEmail = `agent-${agentId}@agents.djtoolkit.net`;
  const agentPassword = crypto.randomBytes(32).toString("hex");

  let supabaseUid: string | null = null;
  const { data: authUser, error: authErr } =
    await supabase.auth.admin.createUser({
      email: agentEmail,
      password: agentPassword,
      email_confirm: true,
      app_metadata: { owner_user_id: user.userId, is_agent: true },
    });

  if (!authErr && authUser?.user) {
    supabaseUid = authUser.user.id;
    await supabase
      .from("agents")
      .update({ supabase_uid: supabaseUid })
      .eq("id", agentId);
  } else {
    // Non-fatal: agent works without Realtime (falls back to polling)
    console.warn(
      `Failed to create machine auth user for agent ${agentId}:`,
      authErr
    );
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
      // Realtime credentials (public values + machine user creds)
      supabase_url: process.env.NEXT_PUBLIC_SUPABASE_URL ?? null,
      supabase_anon_key: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? null,
      agent_email: supabaseUid ? agentEmail : null,
      agent_password: supabaseUid ? agentPassword : null,
      message: "Store this key securely — it will not be shown again.",
    },
    { status: 201 }
  );
}
