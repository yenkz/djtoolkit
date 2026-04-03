import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";

const API_URL = process.env.DJTOOLKIT_API_URL || "https://app.djtoolkit.net";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;
  const { id } = await params;

  const res = await fetch(`${API_URL}/recommend/session/${id}`, {
    headers: {
      Authorization: request.headers.get("Authorization") || "",
    },
  });

  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
