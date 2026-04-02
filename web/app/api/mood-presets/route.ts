import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";
import { createServiceClient } from "@/lib/supabase/service";

export async function GET(request: NextRequest) {
  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("mood_presets")
    .select("*")
    .order("category")
    .order("name");

  if (error)
    return NextResponse.json({ detail: error.message }, { status: 500 });
  return NextResponse.json(data);
}
