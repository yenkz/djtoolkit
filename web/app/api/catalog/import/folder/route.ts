// web/app/api/catalog/import/folder/route.ts
import { NextRequest, NextResponse } from "next/server";
import {
  getAuthUser,
  isAuthError,
} from "@/lib/api-server/auth";
import { createServiceClient } from "@/lib/supabase/service";
import { jsonError } from "@/lib/api-server/errors";

// POST — create a folder_import pipeline job
export async function POST(request: NextRequest) {
  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  let body: { path?: string; recursive?: boolean; agent_id?: string };
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  const { path, agent_id } = body;
  if (!path || typeof path !== "string" || path.trim().length === 0) {
    return jsonError("path is required", 400);
  }
  if (!agent_id || typeof agent_id !== "string") {
    return jsonError("agent_id is required", 400);
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
    .from("pipeline_jobs")
    .insert({
      user_id: user.userId,
      track_id: null,
      job_type: "folder_import",
      payload: {
        path: path.trim(),
        recursive: body.recursive !== false,
        user_id: user.userId,
        agent_id,
      },
    })
    .select("id, status")
    .single();

  if (error) return jsonError(error.message, 500);
  return NextResponse.json(data, { status: 201 });
}
