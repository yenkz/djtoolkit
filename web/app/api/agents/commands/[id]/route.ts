import { NextRequest, NextResponse } from "next/server";
import {
  getAuthUser,
  isAuthError,
} from "@/lib/api-server/auth";
import { createServiceClient } from "@/lib/supabase/service";
import { jsonError } from "@/lib/api-server/errors";

type Params = { params: Promise<{ id: string }> };

// GET — web UI polls for command result (auth: JWT)
export async function GET(request: NextRequest, { params }: Params) {
  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  const { id } = await params;
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("agent_commands")
    .select("*")
    .eq("id", id)
    .eq("user_id", user.userId)
    .single();

  if (error || !data) return jsonError("Command not found", 404);
  return NextResponse.json(data);
}

// PUT — agent reports status/result (auth: API key)
export async function PUT(request: NextRequest, { params }: Params) {
  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  const { id } = await params;
  let body: { status?: string; result?: unknown; error?: string };
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  const updates: Record<string, unknown> = {};
  if (body.status) {
    const valid = ["running", "completed", "failed"];
    if (!valid.includes(body.status)) {
      return jsonError(`Invalid status: ${body.status}`, 400);
    }
    updates.status = body.status;
    if (body.status === "completed" || body.status === "failed") {
      updates.completed_at = new Date().toISOString();
    }
  }
  if (body.result !== undefined) updates.result = body.result;
  if (body.error !== undefined) updates.error = body.error;

  // Scope update to caller's ownership (service client bypasses RLS)
  const supabase = createServiceClient();
  const query = supabase
    .from("agent_commands")
    .update(updates)
    .eq("id", id);

  // Agent callers can only update commands targeted at their agent
  if (user.agentId) {
    query.eq("agent_id", user.agentId);
  } else {
    query.eq("user_id", user.userId);
  }

  const { error } = await query;
  if (error) return jsonError(error.message, 500);
  return new NextResponse(null, { status: 204 });
}
