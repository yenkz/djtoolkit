import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";
import { rateLimit, limiters } from "@/lib/api-server/rate-limit";
import { createServiceClient } from "@/lib/supabase/service";
import { jsonError } from "@/lib/api-server/errors";

const TRACK_COLUMNS = [
  "id",
  "acquisition_status",
  "source",
  "title",
  "artist",
  "artists",
  "album",
  "year",
  "duration_ms",
  "genres",
  "tempo",
  "key_normalized",
  "key",
  "mode",
  "energy",
  "artwork_url",
  "spotify_uri",
  "local_path",
  "fingerprinted",
  "enriched_spotify",
  "enriched_audio",
  "metadata_written",
  "cover_art_written",
  "in_library",
  "metadata_source",
  "created_at",
  "updated_at",
].join(", ");

/**
 * GET /api/catalog/tracks
 *
 * List tracks with pagination and optional filters.
 * Query params:
 *   - page (default 1)
 *   - per_page (default 50, max 1000)
 *   - status (acquisition_status filter)
 *   - search (ILIKE on title/artist)
 *   - id (one or more track IDs — repeatable)
 *
 * Returns: { tracks, total, page, per_page }
 * Each track has an additional `already_owned` boolean: true if another
 * 'available' track with the same spotify_uri exists for this user.
 */
export async function GET(request: NextRequest) {
  const rl = await rateLimit(request, limiters.read);
  if (rl) return rl;

  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  const { searchParams } = request.nextUrl;

  // Pagination
  const rawPage = searchParams.get("page");
  const rawPerPage = searchParams.get("per_page");
  let page = rawPage !== null ? parseInt(rawPage, 10) : 1;
  let perPage = rawPerPage !== null ? parseInt(rawPerPage, 10) : 50;
  if (isNaN(page) || page < 1) page = 1;
  if (isNaN(perPage) || perPage < 1) perPage = 50;
  if (perPage > 1000) perPage = 1000;

  const from = (page - 1) * perPage;
  const to = from + perPage - 1;

  // Filters
  const status = searchParams.get("status");
  const search = searchParams.get("search");
  const idParams = searchParams.getAll("id");
  const ALLOWED_SORT = new Set(["created_at", "updated_at", "title", "artist", "album", "year", "tempo", "key_normalized", "energy", "genres"]);
  const sortBy = ALLOWED_SORT.has(searchParams.get("sort_by") ?? "") ? searchParams.get("sort_by")! : "created_at";
  const sortDir = searchParams.get("sort_dir") === "asc";

  const supabase = createServiceClient();

  let query = supabase
    .from("tracks")
    .select(TRACK_COLUMNS, { count: "exact" })
    .eq("user_id", user.userId);

  if (status) {
    query = query.eq("acquisition_status", status);
  }

  if (search && search.trim()) {
    query = query.or(
      `title.ilike.%${search.trim()}%,artist.ilike.%${search.trim()}%`
    );
  }

  if (idParams.length > 0) {
    const ids = idParams
      .map((v) => parseInt(v, 10))
      .filter((v) => !isNaN(v));
    if (ids.length > 0) {
      query = query.in("id", ids);
    }
  }

  query = query
    .order(sortBy, { ascending: sortDir, nullsFirst: false })
    .range(from, to);

  const { data: tracks, count, error } = await query;

  if (error) {
    return jsonError("Failed to fetch tracks", 500);
  }

  const rows = (tracks ?? []) as unknown as Record<string, unknown>[];
  const total = count ?? 0;

  // Batch already_owned check: find any 'available' tracks with matching
  // spotify_uris for this user. Batched in chunks of 100 for URL safety.
  const ownedUris = new Set<string>();
  if (rows.length > 0) {
    const uris = rows
      .map((t) => t.spotify_uri as string | null)
      .filter((u): u is string => typeof u === "string" && u.length > 0);

    for (let i = 0; i < uris.length; i += 100) {
      const batch = uris.slice(i, i + 100);
      const { data: owned } = await supabase
        .from("tracks")
        .select("spotify_uri")
        .eq("user_id", user.userId)
        .eq("acquisition_status", "available")
        .in("spotify_uri", batch);

      for (const row of (owned ?? []) as Record<string, unknown>[]) {
        if (row.spotify_uri) ownedUris.add(row.spotify_uri as string);
      }
    }
  }

  const enriched = rows.map((t) => ({
    ...t,
    already_owned:
      typeof t.spotify_uri === "string" && ownedUris.has(t.spotify_uri),
  }));

  return NextResponse.json({ tracks: enriched, total, page, per_page: perPage });
}
