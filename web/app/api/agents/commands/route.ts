import { NextRequest, NextResponse } from "next/server";
import {
  getAuthUser,
  isAuthError,
} from "@/lib/api-server/auth";
import { createServiceClient } from "@/lib/supabase/service";
import { jsonError } from "@/lib/api-server/errors";

// GET — agent polls for pending commands (auth: API key)
export async function GET(request: NextRequest) {
  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  if (!user.agentId) {
    return jsonError("Requires agent API key", 403);
  }

  const limit = Math.min(
    Number(request.nextUrl.searchParams.get("limit") ?? 5),
    20,
  );

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("agent_commands")
    .select("*")
    .eq("agent_id", user.agentId)
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) return jsonError(error.message, 500);
  return NextResponse.json(data);
}

// POST — web UI creates a command (auth: JWT)
export async function POST(request: NextRequest) {
  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  let body: { agent_id?: string; command_type?: string; payload?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  const { agent_id, command_type, payload } = body;
  if (!agent_id || typeof agent_id !== "string") {
    return jsonError("agent_id is required", 400);
  }
  if (!command_type || typeof command_type !== "string") {
    return jsonError("command_type is required", 400);
  }

  const validCommands = ["browse_folder"];
  if (!validCommands.includes(command_type)) {
    return jsonError(`Invalid command_type: ${command_type}`, 400);
  }

  // Verify agent belongs to user
  const supabase = createServiceClient();
  const { data: agent } = await supabase
    .from("agents")
    .select("id")
    .eq("id", agent_id)
    .eq("user_id", user.userId)
    .single();

  if (!agent) {
    return jsonError("Agent not found", 404);
  }

  const { data, error } = await supabase
    .from("agent_commands")
    .insert({
      user_id: user.userId,
      agent_id,
      command_type,
      payload: payload ?? {},
    })
    .select("id, status")
    .single();

  if (error) return jsonError(error.message, 500);
  return NextResponse.json(data, { status: 201 });
}
