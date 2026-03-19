import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";

const VALID_FORMATS = new Set(["traktor", "rekordbox", "csv"]);

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ format: string }> },
) {
  const user = await getAuthUser(req);
  if (isAuthError(user)) return user;

  const token =
    req.headers.get("Authorization")?.slice("Bearer ".length) ?? "";
  const { format } = await params;

  if (!VALID_FORMATS.has(format)) {
    return NextResponse.json(
      { detail: `Unsupported format: ${format}` },
      { status: 400 },
    );
  }

  const apiUrl = process.env.DJTOOLKIT_API_URL;
  if (!apiUrl) {
    return NextResponse.json(
      { detail: "DJTOOLKIT_API_URL not configured" },
      { status: 503 },
    );
  }

  const genre = req.nextUrl.searchParams.get("genre");
  const qs = genre ? `?genre=${encodeURIComponent(genre)}` : "";

  let resp: Response;
  try {
    resp = await fetch(`${apiUrl}/export/${format}${qs}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (err) {
    return NextResponse.json(
      { detail: `Upstream unreachable: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }

  if (!resp.ok) {
    const text = await resp.text();
    let detail: string;
    try {
      detail = JSON.parse(text).detail ?? text;
    } catch {
      detail = text;
    }
    return NextResponse.json({ detail }, { status: resp.status });
  }

  const data = await resp.arrayBuffer();

  return new NextResponse(data, {
    status: 200,
    headers: {
      "Content-Type":
        resp.headers.get("Content-Type") || "application/octet-stream",
      "Content-Disposition":
        resp.headers.get("Content-Disposition") ||
        `attachment; filename=export.${format}`,
    },
  });
}
