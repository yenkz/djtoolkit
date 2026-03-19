import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";

export async function POST(req: NextRequest) {
  try {
    const user = await getAuthUser(req);
    if (isAuthError(user)) return user;

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

    let resp: Response;
    try {
      resp = await fetch(`${apiUrl}/parse`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: upstream,
      });
    } catch (err) {
      return NextResponse.json(
        { detail: `Upstream unreachable: ${err instanceof Error ? err.message : String(err)}` },
        { status: 502 },
      );
    }

    const text = await resp.text();
    if (!resp.ok) {
      let detail: string;
      try {
        detail = JSON.parse(text).detail ?? text;
      } catch {
        detail = text;
      }
      return NextResponse.json({ detail }, { status: resp.status });
    }

    try {
      const body = JSON.parse(text);
      return NextResponse.json(body, { status: 200 });
    } catch {
      return NextResponse.json(
        { detail: `Invalid JSON from upstream: ${text.slice(0, 200)}` },
        { status: 502 },
      );
    }
  } catch (err) {
    console.error("[collection/parse] Unhandled error:", err);
    return NextResponse.json(
      { detail: `Internal error: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }
}
