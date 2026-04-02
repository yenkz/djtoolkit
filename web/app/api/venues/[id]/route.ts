import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";
import { createServiceClient } from "@/lib/supabase/service";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  const { id } = await params;
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("venues")
    .select("*")
    .eq("id", id)
    .single();
  if (error || !data)
    return NextResponse.json({ detail: "Venue not found" }, { status: 404 });
  return NextResponse.json(data);
}
