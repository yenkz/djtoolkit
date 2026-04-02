import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";
import { rateLimit, limiters } from "@/lib/api-server/rate-limit";

const API_URL = process.env.DJTOOLKIT_API_URL || "https://app.djtoolkit.net";

export async function POST(request: NextRequest) {
  const rl = await rateLimit(request, limiters.write);
  if (rl) return rl;
  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  const body = await request.json();
  const res = await fetch(`${API_URL}/recommend/expand`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: request.headers.get("Authorization") || "",
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
