import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";
import { rateLimit, limiters } from "@/lib/api-server/rate-limit";
import { createServiceClient } from "@/lib/supabase/service";
import { jsonError } from "@/lib/api-server/errors";

export async function GET(request: NextRequest) {
  const rateLimitResponse = await rateLimit(request, limiters.read);
  if (rateLimitResponse) return rateLimitResponse;

  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  const supabase = createServiceClient();

  const sp = request.nextUrl.searchParams;
  const page = Math.max(1, Number(sp.get("page")) || 1);
  const perPage = Math.min(100, Math.max(1, Number(sp.get("per_page")) || 25));
  const status = sp.get("status");
  const search = sp.get("search");
  const ALLOWED_SORT = new Set(["updated_at", "created_at", "title", "acquisition_status", "search_results_count"]);
  const sortBy = ALLOWED_SORT.has(sp.get("sort_by") ?? "") ? sp.get("sort_by")! : "updated_at";
  const sortDir = sp.get("sort_dir") === "asc";
  const offset = (page - 1) * perPage;

  const columns = [
    "id", "title", "artist", "album", "artwork_url",
    "acquisition_status", "search_string", "search_results_count",
    "created_at", "updated_at",
  ].join(",");

  let query = supabase
    .from("tracks")
    .select(columns, { count: "exact" })
    .eq("user_id", user.userId)
    .not("acquisition_status", "in", "(available,duplicate)");

  if (status) {
    query = query.eq("acquisition_status", status);
  }

  if (search && search.trim()) {
    query = query.or(
      `title.ilike.%${search.trim()}%,artist.ilike.%${search.trim()}%`
    );
  }

  query = query.order(sortBy, { ascending: sortDir }).range(offset, offset + perPage - 1);

  const { data, error, count } = await query;

  if (error) {
    return jsonError(error.message, 500);
  }

  return NextResponse.json({
    tracks: data || [],
    total: count || 0,
    page,
    per_page: perPage,
  });
}
