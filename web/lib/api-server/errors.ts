import { NextResponse } from "next/server";

export function jsonError(detail: string, status: number): NextResponse {
  return NextResponse.json({ detail }, { status });
}
