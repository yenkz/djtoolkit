import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";
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

  let body: { email?: string; password?: string; machine_name?: string } = {};
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid request body", 400);
  }

  const { email, password, machine_name } = body;
  if (!email || !password) {
    return jsonError("email and password are required", 400);
  }

  // Sign in with the user's credentials via the anon client.
  const anonClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false } }
  );

  const { data: authData, error: signInError } =
    await anonClient.auth.signInWithPassword({ email, password });

  if (signInError || !authData.user) {
    return jsonError("Invalid email or password", 401);
  }

  const userId = authData.user.id;
  const { plain, hash, prefix } = createAgentKey();
  const agentId = crypto.randomUUID();

  const supabase = createServiceClient();

  const { error } = await supabase.from("agents").insert({
    id: agentId,
    user_id: userId,
    api_key_hash: hash,
    api_key_prefix: prefix,
    machine_name: machine_name ?? null,
    capabilities: [],
  });

  if (error) {
    return jsonError("Failed to register agent", 500);
  }

  // Create a Supabase Auth machine user for Realtime subscriptions.
  const agentEmail = `agent-${agentId}@agents.djtoolkit.net`;
  const agentPassword = crypto.randomBytes(32).toString("hex");

  let supabaseUid: string | null = null;
  const { data: agentAuthUser, error: authErr } =
    await supabase.auth.admin.createUser({
      email: agentEmail,
      password: agentPassword,
      email_confirm: true,
      app_metadata: { owner_user_id: userId, is_agent: true },
    });

  if (!authErr && agentAuthUser?.user) {
    supabaseUid = agentAuthUser.user.id;
    await supabase
      .from("agents")
      .update({ supabase_uid: supabaseUid })
      .eq("id", agentId);
  } else {
    console.warn(
      `Failed to create machine auth user for agent ${agentId}:`,
      authErr
    );
  }

  await auditLog(userId, "agent.register", {
    resourceType: "agent",
    resourceId: agentId,
    details: { machine_name: machine_name ?? null, method: "password" },
    ipAddress: getClientIp(request),
  });

  return NextResponse.json(
    {
      agent_id: agentId,
      api_key: plain,
      supabase_url: process.env.NEXT_PUBLIC_SUPABASE_URL ?? null,
      supabase_anon_key: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? null,
      agent_email: supabaseUid ? agentEmail : null,
      agent_password: supabaseUid ? agentPassword : null,
      message: "Store this key securely — it will not be shown again.",
    },
    { status: 201 }
  );
}
