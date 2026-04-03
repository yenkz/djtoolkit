import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";
import { rateLimit, limiters } from "@/lib/api-server/rate-limit";
import { createServiceClient } from "@/lib/supabase/service";

export async function GET(request: NextRequest) {
  const rl = await rateLimit(request, limiters.read);
  if (rl) return rl;
  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  const supabase = createServiceClient();

  // Fetch playlists with track count, session info, and energies
  const { data: playlists, error } = await supabase
    .from("playlists")
    .select("id, name, session_id, created_at")
    .eq("user_id", user.userId)
    .order("created_at", { ascending: false });

  if (error)
    return NextResponse.json({ detail: error.message }, { status: 500 });

  // Enrich each playlist with track count, duration, session context, energies
  const enriched = await Promise.all(
    (playlists ?? []).map(async (pl) => {
      // Track count + duration + energies
      const { data: ptRows } = await supabase
        .from("playlist_tracks")
        .select("track_id, tracks(duration_ms, energy)")
        .eq("playlist_id", pl.id)
        .order("position");

      const trackCount = ptRows?.length ?? 0;
      let totalDurationMs = 0;
      const energies: number[] = [];
      for (const row of ptRows ?? []) {
        const t = row.tracks as unknown as { duration_ms: number | null; energy: number | null } | null;
        totalDurationMs += t?.duration_ms ?? 0;
        energies.push(t?.energy ?? 0);
      }

      // Session context (venue name or mood name)
      let venueName: string | null = null;
      let moodName: string | null = null;
      let lineupPosition: string | null = null;

      if (pl.session_id) {
        const { data: sess } = await supabase
          .from("recommendation_sessions")
          .select("venue_id, mood_preset_id, lineup_position")
          .eq("id", pl.session_id)
          .single();

        if (sess) {
          lineupPosition = sess.lineup_position;
          if (sess.venue_id) {
            const { data: v } = await supabase
              .from("venues")
              .select("name")
              .eq("id", sess.venue_id)
              .single();
            venueName = v?.name ?? null;
          }
          if (sess.mood_preset_id) {
            const { data: m } = await supabase
              .from("mood_presets")
              .select("name")
              .eq("id", sess.mood_preset_id)
              .single();
            moodName = m?.name ?? null;
          }
        }
      }

      return {
        ...pl,
        track_count: trackCount,
        total_duration_ms: totalDurationMs,
        venue_name: venueName,
        mood_name: moodName,
        lineup_position: lineupPosition,
        energies,
      };
    })
  );

  return NextResponse.json(enriched);
}
