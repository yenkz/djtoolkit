import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";
import { rateLimit, limiters } from "@/lib/api-server/rate-limit";
import { createServiceClient } from "@/lib/supabase/service";

const TRACK_COLUMNS =
  "id, title, artist, album, tempo, key_normalized, energy, danceability, genres, artwork_url, preview_url, spotify_uri, duration_ms";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;
  const { id } = await params;

  const supabase = createServiceClient();

  const { data: playlist, error } = await supabase
    .from("playlists")
    .select("id, name, session_id, created_at")
    .eq("id", id)
    .eq("user_id", user.userId)
    .single();

  if (error || !playlist)
    return NextResponse.json({ detail: "Playlist not found" }, { status: 404 });

  const { data: ptRows } = await supabase
    .from("playlist_tracks")
    .select(`position, track_id, tracks(${TRACK_COLUMNS})`)
    .eq("playlist_id", id)
    .order("position");

  const tracks = (ptRows ?? []).map((row) => ({
    ...(row.tracks as unknown as Record<string, unknown>),
  }));

  const totalDurationMs = tracks.reduce(
    (sum, t) => sum + ((t.duration_ms as number) ?? 0),
    0,
  );

  return NextResponse.json({
    ...playlist,
    track_count: tracks.length,
    total_duration_ms: totalDurationMs,
    tracks,
  });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const rl = await rateLimit(request, limiters.write);
  if (rl) return rl;
  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;
  const { id } = await params;

  const supabase = createServiceClient();

  // Verify ownership
  const { data: playlist } = await supabase
    .from("playlists")
    .select("id")
    .eq("id", id)
    .eq("user_id", user.userId)
    .single();

  if (!playlist)
    return NextResponse.json({ detail: "Playlist not found" }, { status: 404 });

  const body = await request.json();

  // Update name
  if (body.name) {
    await supabase.from("playlists").update({ name: body.name }).eq("id", id);
  }

  // Update track order
  if (Array.isArray(body.tracks)) {
    // Delete existing
    await supabase.from("playlist_tracks").delete().eq("playlist_id", id);
    // Re-insert with new positions
    const rows = (body.tracks as number[]).map((trackId, i) => ({
      playlist_id: id,
      track_id: trackId,
      position: i,
    }));
    if (rows.length > 0) {
      await supabase.from("playlist_tracks").insert(rows);
    }
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const rl = await rateLimit(request, limiters.write);
  if (rl) return rl;
  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;
  const { id } = await params;

  const supabase = createServiceClient();

  // Verify ownership
  const { data: playlist } = await supabase
    .from("playlists")
    .select("id")
    .eq("id", id)
    .eq("user_id", user.userId)
    .single();

  if (!playlist)
    return NextResponse.json({ detail: "Playlist not found" }, { status: 404 });

  await supabase.from("playlist_tracks").delete().eq("playlist_id", id);
  await supabase.from("playlists").delete().eq("id", id);

  return new Response(null, { status: 204 });
}
