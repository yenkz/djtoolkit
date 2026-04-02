// web/app/api/catalog/import/folder/[jobId]/status/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";
import { createServiceClient } from "@/lib/supabase/service";
import { jsonError } from "@/lib/api-server/errors";

type Params = { params: Promise<{ jobId: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  const { jobId } = await params;
  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from("pipeline_jobs")
    .select("id, status, result")
    .eq("id", jobId)
    .eq("user_id", user.userId)
    .single();

  if (error || !data) {
    return jsonError("Job not found", 404);
  }

  return NextResponse.json({
    id: data.id,
    status: data.status,
    result: data.result,
  });
}
