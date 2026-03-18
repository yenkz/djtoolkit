import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";

export async function POST(req: NextRequest) {
  const user = await getAuthUser(req);
  if (isAuthError(user)) return user;

  // Forward the raw Bearer token to Hetzner (getAuthUser verified it but doesn't return it)
  const token =
    req.headers.get("Authorization")?.slice("Bearer ".length) ?? "";

  const apiUrl = process.env.DJTOOLKIT_API_URL;
  if (!apiUrl) {
    return NextResponse.json(
      { detail: "DJTOOLKIT_API_URL not configured" },
      { status: 503 },
    );
  }

  const formData = await req.formData();
  const file = formData.get("file");
  if (!file || !(file instanceof Blob)) {
    return NextResponse.json(
      { detail: "No file provided" },
      { status: 400 },
    );
  }

  const upstream = new FormData();
  upstream.append("file", file);

  const resp = await fetch(`${apiUrl}/parse`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: upstream,
  });

  const body = await resp.json();
  return NextResponse.json(body, { status: resp.status });
}
