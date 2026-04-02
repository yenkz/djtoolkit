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
  const res = await fetch(`${API_URL}/recommend/export`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: request.headers.get("Authorization") || "",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  }

  const blob = await res.arrayBuffer();
  return new Response(blob, {
    status: 200,
    headers: {
      "Content-Type":
        res.headers.get("Content-Type") || "application/octet-stream",
      "Content-Disposition": res.headers.get("Content-Disposition") || "",
    },
  });
}
