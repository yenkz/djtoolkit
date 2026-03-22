# Spotify Preview Player — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 30-second Spotify preview playback to the catalog, with artwork hover-to-play and LED glow now-playing indicators.

**Architecture:** Single hidden `<audio>` element managed by a React context (`PreviewPlayerContext`) at the `(app)` layout level. `preview_url` is stored on the `tracks` table at import time. UI components consume the context to show play/pause overlays and now-playing state.

**Tech Stack:** Next.js 16, React 19, Supabase (PostgreSQL), Spotify Web API, Sonner (toasts), Lucide React (icons)

**Spec:** `docs/superpowers/specs/2026-03-22-spotify-preview-player-design.md`

---

## File Map

### New Files

| File | Responsibility |
| ---- | -------------- |
| `supabase/migrations/20260322000000_add_preview_url.sql` | Add `preview_url TEXT` column to `tracks` |
| `web/lib/preview-player-context.tsx` | React context + hidden `<audio>` element, play/pause/stop/progress |
| `web/app/api/catalog/tracks/[id]/preview-url/route.ts` | POST endpoint — refresh stale preview URL from Spotify |
| `web/app/api/catalog/backfill-preview/route.ts` | POST endpoint — batch-fill preview URLs for existing tracks |

### Modified Files

| File | Change |
| ---- | ------ |
| `web/app/api/catalog/import/spotify/route.ts:29-42,54-80` | Add `preview_url` to `SpotifyTrack` interface and `mapSpotifyTrack()` |
| `web/app/api/catalog/tracks/route.ts:7-35` | Add `"preview_url"` to `TRACK_COLUMNS` |
| `web/app/api/catalog/tracks/[id]/route.ts:7-31` | Add `"preview_url"` to `TRACK_COLUMNS` |
| `web/lib/api.ts:55-78` | Add `preview_url?: string` to `Track` interface |
| `web/app/(app)/layout.tsx` | Wrap `{children}` with `PreviewPlayerProvider` |
| `web/app/(app)/catalog/page.tsx:40-55` | Pass `preview_url` through `toComponentTrack()` |
| `web/components/ui/TrackCard.tsx` | Add `preview_url` to local interface, hover overlay, playing state |
| `web/components/ui/TrackListRow.tsx` | Add `preview_url` to local interface, hover overlay, playing state |

---

## Task 1: Database Migration

**Files:**

- Create: `supabase/migrations/20260322000000_add_preview_url.sql`

- [ ] **Step 1: Write migration SQL**

```sql
-- Add preview_url column for Spotify 30-second preview URLs
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS preview_url TEXT;
```

Write this to `supabase/migrations/20260322000000_add_preview_url.sql`.

- [ ] **Step 2: Apply migration via Supabase MCP**

Run: `apply_migration` with name `add_preview_url` and the SQL above.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260322000000_add_preview_url.sql
git commit -m "feat(db): add preview_url column to tracks table"
```

---

## Task 2: Add `preview_url` to API Layer

**Files:**

- Modify: `web/app/api/catalog/tracks/route.ts:7-35`
- Modify: `web/app/api/catalog/tracks/[id]/route.ts:7-31`
- Modify: `web/lib/api.ts:55-78`
- Modify: `web/app/api/catalog/import/spotify/route.ts:29-42,54-80`

- [ ] **Step 1: Add `preview_url` to `TRACK_COLUMNS` in tracks list route**

In `web/app/api/catalog/tracks/route.ts`, add `"preview_url"` to the `TRACK_COLUMNS` array (after `"spotify_uri"`, before `"local_path"`):

```typescript
// line ~24, after "spotify_uri",
  "preview_url",
```

- [ ] **Step 2: Add `preview_url` to `TRACK_COLUMNS` in single-track route**

In `web/app/api/catalog/tracks/[id]/route.ts`, same change — add `"preview_url"` after `"spotify_uri"`:

```typescript
// line ~20, after "spotify_uri",
  "preview_url",
```

- [ ] **Step 3: Add `preview_url` to TypeScript `Track` interface**

In `web/lib/api.ts`, add after line 71 (`spotify_uri?: string;`):

```typescript
  preview_url?: string;
```

- [ ] **Step 4: Add `preview_url` to `SpotifyTrack` interface and `mapSpotifyTrack()`**

In `web/app/api/catalog/import/spotify/route.ts`:

Add `preview_url?: string;` to the `SpotifyTrack` interface (after `external_ids`, ~line 41):

```typescript
  external_ids?: { isrc?: string };
  preview_url?: string;
}
```

In `mapSpotifyTrack()`, add `preview_url` to the returned object (after `source: "spotify"`, ~line 79):

```typescript
    source: "spotify",
    preview_url: track.preview_url || null,
  };
```

- [ ] **Step 5: Verify the dev server compiles**

Run: `cd web && npx next build --no-lint` (or just start `npm run dev` and check for errors)

- [ ] **Step 6: Commit**

```bash
git add web/app/api/catalog/tracks/route.ts web/app/api/catalog/tracks/\[id\]/route.ts web/lib/api.ts web/app/api/catalog/import/spotify/route.ts
git commit -m "feat(api): add preview_url to track columns, interface, and Spotify import"
```

---

## Task 3: Preview URL Refresh Endpoint

**Files:**

- Create: `web/app/api/catalog/tracks/[id]/preview-url/route.ts`

- [ ] **Step 1: Create the refresh endpoint**

Create `web/app/api/catalog/tracks/[id]/preview-url/route.ts`:

```typescript
/**
 * POST /api/catalog/tracks/[id]/preview-url
 *
 * Refresh a stale Spotify preview URL. Looks up the track's spotify_uri,
 * fetches fresh data from Spotify, updates the DB, and returns the new URL.
 * POST (not GET) because it writes to the DB.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";
import { rateLimit, limiters } from "@/lib/api-server/rate-limit";
import { createServiceClient } from "@/lib/supabase/service";
import { jsonError } from "@/lib/api-server/errors";
import { getSpotifyToken } from "@/lib/api-server/spotify";

const SPOTIFY_API = "https://api.spotify.com/v1";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const rl = await rateLimit(request, limiters.read);
  if (rl) return rl;

  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  const { id } = await params;
  const trackId = parseInt(id, 10);
  if (isNaN(trackId)) return jsonError("Invalid track ID", 400);

  const supabase = createServiceClient();

  // Fetch the track's spotify_uri
  const { data: track, error: fetchError } = await supabase
    .from("tracks")
    .select("spotify_uri")
    .eq("id", trackId)
    .eq("user_id", user.userId)
    .single();

  if (fetchError || !track) return jsonError("Track not found", 404);
  if (!track.spotify_uri) return jsonError("Track has no Spotify URI", 400);

  // Get Spotify access token
  let accessToken: string;
  try {
    accessToken = await getSpotifyToken(user.userId);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to get Spotify token";
    return jsonError(message, 401);
  }

  // Extract Spotify track ID from URI (spotify:track:XXXXX)
  const parts = (track.spotify_uri as string).split(":");
  if (parts.length !== 3 || parts[1] !== "track") {
    return jsonError("Invalid spotify_uri format", 400);
  }

  const resp = await fetch(`${SPOTIFY_API}/tracks/${parts[2]}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!resp.ok) {
    return jsonError(
      `Spotify API error: ${resp.status} ${resp.statusText}`,
      502
    );
  }

  const data = (await resp.json()) as { preview_url?: string | null };
  const previewUrl = data.preview_url || null;

  // Update DB
  await supabase
    .from("tracks")
    .update({ preview_url: previewUrl })
    .eq("id", trackId)
    .eq("user_id", user.userId);

  return NextResponse.json({ preview_url: previewUrl });
}
```

- [ ] **Step 2: Verify route compiles**

Run: `cd web && npx next build --no-lint`

- [ ] **Step 3: Commit**

```bash
git add web/app/api/catalog/tracks/\[id\]/preview-url/route.ts
git commit -m "feat(api): add POST preview-url refresh endpoint for stale URL recovery"
```

---

## Task 4: Backfill Endpoint

**Files:**

- Create: `web/app/api/catalog/backfill-preview/route.ts`

- [ ] **Step 1: Create the backfill endpoint**

Model on the existing `web/app/api/catalog/backfill-artwork/route.ts`. Create `web/app/api/catalog/backfill-preview/route.ts`:

```typescript
/**
 * POST /api/catalog/backfill-preview
 *
 * Backfill preview URLs from Spotify for tracks that have a spotify_uri
 * but no preview_url. Processes one batch of up to 50 tracks per invocation.
 * Use the `offset` query param for pagination across invocations.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";
import { rateLimit, limiters } from "@/lib/api-server/rate-limit";
import { createServiceClient } from "@/lib/supabase/service";
import { jsonError } from "@/lib/api-server/errors";
import { auditLog, getClientIp } from "@/lib/api-server/audit";
import { getSpotifyToken } from "@/lib/api-server/spotify";

const SPOTIFY_API = "https://api.spotify.com/v1";
const BATCH_SIZE = 50;

export async function POST(request: NextRequest) {
  const rl = await rateLimit(request, limiters.backfill);
  if (rl) return rl;

  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  const rawOffset = request.nextUrl.searchParams.get("offset");
  const offset = rawOffset ? parseInt(rawOffset, 10) : 0;

  let accessToken: string;
  try {
    accessToken = await getSpotifyToken(user.userId);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to get Spotify token";
    return jsonError(message, 401);
  }

  const supabase = createServiceClient();

  // Count total tracks missing preview_url
  const { count: totalMissing } = await supabase
    .from("tracks")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.userId)
    .not("spotify_uri", "is", null)
    .is("preview_url", null);

  // Fetch one batch
  const { data: tracks, error: fetchError } = await supabase
    .from("tracks")
    .select("id, spotify_uri")
    .eq("user_id", user.userId)
    .not("spotify_uri", "is", null)
    .is("preview_url", null)
    .order("id", { ascending: true })
    .range(offset, offset + BATCH_SIZE - 1);

  if (fetchError) return jsonError("Failed to fetch tracks", 500);

  const rows = tracks ?? [];

  if (rows.length === 0) {
    return NextResponse.json({
      updated: 0,
      skipped: 0,
      total_missing: totalMissing ?? 0,
      next_offset: null,
    });
  }

  // Extract Spotify track IDs from URIs
  const trackIdMap = new Map<string, number>();
  for (const row of rows) {
    const uri = row.spotify_uri as string;
    const parts = uri.split(":");
    if (parts.length === 3 && parts[1] === "track") {
      trackIdMap.set(parts[2], row.id);
    }
  }

  if (trackIdMap.size === 0) {
    return NextResponse.json({
      updated: 0,
      skipped: rows.length,
      total_missing: totalMissing ?? 0,
      next_offset: null,
    });
  }

  // Fetch track details from Spotify (max 50 IDs per request)
  const spotifyIds = Array.from(trackIdMap.keys());
  const resp = await fetch(
    `${SPOTIFY_API}/tracks?ids=${spotifyIds.join(",")}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!resp.ok) {
    return jsonError(
      `Spotify API error: ${resp.status} ${resp.statusText}`,
      502
    );
  }

  const data = (await resp.json()) as {
    tracks: Array<{ id: string; preview_url?: string | null } | null>;
  };

  let updated = 0;
  let skipped = 0;

  for (const spotifyTrack of data.tracks) {
    if (!spotifyTrack) {
      skipped++;
      continue;
    }

    const previewUrl = spotifyTrack.preview_url || null;
    const dbId = trackIdMap.get(spotifyTrack.id);
    if (!dbId) continue;

    if (!previewUrl) {
      skipped++;
      continue;
    }

    const { error: updateError } = await supabase
      .from("tracks")
      .update({ preview_url: previewUrl })
      .eq("id", dbId)
      .eq("user_id", user.userId);

    if (!updateError) updated++;
    else skipped++;
  }

  const nextOffset =
    rows.length === BATCH_SIZE ? offset + BATCH_SIZE : null;

  await auditLog(user.userId, "track.backfill_preview", {
    details: { updated, skipped, batch_offset: offset },
    ipAddress: getClientIp(request),
  });

  return NextResponse.json({
    updated,
    skipped,
    total_missing: totalMissing ?? 0,
    next_offset: nextOffset,
  });
}
```

- [ ] **Step 2: Verify route compiles**

Run: `cd web && npx next build --no-lint`

- [ ] **Step 3: Commit**

```bash
git add web/app/api/catalog/backfill-preview/route.ts
git commit -m "feat(api): add backfill-preview endpoint for batch preview URL population"
```

---

## Task 5: PreviewPlayerContext

**Files:**

- Create: `web/lib/preview-player-context.tsx`
- Modify: `web/app/(app)/layout.tsx`

- [ ] **Step 1: Create the context provider**

Create `web/lib/preview-player-context.tsx`:

```typescript
"use client";

import {
  createContext,
  useContext,
  useRef,
  useState,
  useCallback,
  useEffect,
  type ReactNode,
} from "react";
import { toast } from "sonner";

interface PreviewPlayerState {
  currentTrackId: number | null;
  isPlaying: boolean;
  progress: number;
}

interface PreviewPlayerActions {
  play(trackId: number, previewUrl: string): void;
  pause(): void;
  stop(): void;
}

type PreviewPlayerContextValue = PreviewPlayerState & PreviewPlayerActions;

const PreviewPlayerContext = createContext<PreviewPlayerContextValue | null>(
  null
);

export function usePreviewPlayer() {
  const ctx = useContext(PreviewPlayerContext);
  if (!ctx) {
    throw new Error("usePreviewPlayer must be used within PreviewPlayerProvider");
  }
  return ctx;
}

export function PreviewPlayerProvider({ children }: { children: ReactNode }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [currentTrackId, setCurrentTrackId] = useState<number | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  // Track whether we've already attempted a refresh for the current URL
  const refreshAttemptedRef = useRef(false);
  const currentTrackIdRef = useRef<number | null>(null);

  // Keep ref in sync for use in event handlers
  useEffect(() => {
    currentTrackIdRef.current = currentTrackId;
  }, [currentTrackId]);

  // Create audio element once
  useEffect(() => {
    const audio = new Audio();
    audio.preload = "none";
    audioRef.current = audio;

    const onTimeUpdate = () => {
      if (audio.duration) {
        setProgress(audio.currentTime / audio.duration);
      }
    };

    const onEnded = () => {
      setCurrentTrackId(null);
      setIsPlaying(false);
      setProgress(0);
    };

    const onError = async () => {
      const trackId = currentTrackIdRef.current;
      if (!trackId || refreshAttemptedRef.current) {
        toast.error("Preview unavailable");
        setCurrentTrackId(null);
        setIsPlaying(false);
        setProgress(0);
        return;
      }

      // Attempt one refresh
      refreshAttemptedRef.current = true;
      try {
        const resp = await fetch(`/api/catalog/tracks/${trackId}/preview-url`, {
          method: "POST",
        });
        if (resp.ok) {
          const data = await resp.json();
          if (data.preview_url) {
            audio.src = data.preview_url;
            audio.play().catch(() => {
              toast.error("Preview unavailable");
              setCurrentTrackId(null);
              setIsPlaying(false);
              setProgress(0);
            });
            return;
          }
        }
      } catch {
        // refresh failed
      }

      toast.error("Preview unavailable");
      setCurrentTrackId(null);
      setIsPlaying(false);
      setProgress(0);
    };

    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("error", onError);

    return () => {
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("error", onError);
      audio.pause();
      audio.src = "";
    };
  }, []);

  const play = useCallback((trackId: number, previewUrl: string) => {
    const audio = audioRef.current;
    if (!audio) return;

    refreshAttemptedRef.current = false;
    setCurrentTrackId(trackId);
    setIsPlaying(true);
    setProgress(0);
    audio.src = previewUrl;
    audio.play().catch(() => {
      toast.error("Preview unavailable");
      setCurrentTrackId(null);
      setIsPlaying(false);
      setProgress(0);
    });
  }, []);

  const pause = useCallback(() => {
    audioRef.current?.pause();
    setIsPlaying(false);
  }, []);

  const stop = useCallback(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.src = "";
    }
    setCurrentTrackId(null);
    setIsPlaying(false);
    setProgress(0);
  }, []);

  return (
    <PreviewPlayerContext.Provider
      value={{ currentTrackId, isPlaying, progress, play, pause, stop }}
    >
      {children}
    </PreviewPlayerContext.Provider>
  );
}
```

- [ ] **Step 2: Wrap app layout with provider**

In `web/app/(app)/layout.tsx`, the layout is an async Server Component. Add the client provider inside the JSX. Change from:

```tsx
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import Sidebar from "@/components/sidebar";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  return (
    <div className="flex h-screen bg-hw-body">
      <Sidebar userEmail={user.email ?? ""} />
      <main className="flex-1 overflow-y-auto p-6 pt-14 md:pt-6">{children}</main>
    </div>
  );
}
```

To:

```tsx
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import Sidebar from "@/components/sidebar";
import { PreviewPlayerProvider } from "@/lib/preview-player-context";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  return (
    <div className="flex h-screen bg-hw-body">
      <Sidebar userEmail={user.email ?? ""} />
      <main className="flex-1 overflow-y-auto p-6 pt-14 md:pt-6">
        <PreviewPlayerProvider>{children}</PreviewPlayerProvider>
      </main>
    </div>
  );
}
```

- [ ] **Step 3: Verify dev server compiles**

Run: `cd web && npm run dev` — check browser for errors.

- [ ] **Step 4: Commit**

```bash
git add web/lib/preview-player-context.tsx web/app/\(app\)/layout.tsx
git commit -m "feat(ui): add PreviewPlayerContext with hidden audio element"
```

---

## Task 6: Pass `preview_url` Through Catalog Page

**Files:**

- Modify: `web/app/(app)/catalog/page.tsx:40-55`

- [ ] **Step 1: Add `preview_url` to `toComponentTrack()`**

In `web/app/(app)/catalog/page.tsx`, update the `toComponentTrack` function (line ~40) to pass through `preview_url`:

```typescript
function toComponentTrack(t: Track) {
  return {
    id: t.id,
    title: t.title,
    artist: t.artist,
    album: t.album,
    bpm: t.tempo ? Math.round(t.tempo) : undefined,
    key: resolveKey(t),
    genre: t.genres?.split(",")[0]?.trim() || undefined,
    energy: t.energy,
    status: t.acquisition_status,
    artwork_url: t.artwork_url,
    local_path: t.local_path,
    created_at: t.created_at,
    preview_url: t.preview_url,
  };
}
```

The only change is adding `preview_url: t.preview_url,` at the end.

- [ ] **Step 2: Commit**

```bash
git add web/app/\(app\)/catalog/page.tsx
git commit -m "feat(ui): pass preview_url through toComponentTrack mapping"
```

---

## Task 7: TrackCard — Hover Overlay + Playing State

**Files:**

- Modify: `web/components/ui/TrackCard.tsx`

- [ ] **Step 1: Add `preview_url` to local Track interface and import context**

In `web/components/ui/TrackCard.tsx`, add to the `Track` interface (after `artwork_url?: string;`):

```typescript
  preview_url?: string;
```

Add import at top:

```typescript
import { usePreviewPlayer } from "@/lib/preview-player-context";
import { LED_COLORS } from "@/lib/design-system/tokens";
```

- [ ] **Step 2: Add player state consumption**

Inside the `TrackCard` component function, after the existing `useState` calls, add:

```typescript
  const { currentTrackId, isPlaying, progress, play, pause } =
    usePreviewPlayer();
  const isThisPlaying =
    currentTrackId === track.id && isPlaying;
  const isThisPaused =
    currentTrackId === track.id && !isPlaying;
  const isThisActive = currentTrackId === track.id;
  const LED = LED_COLORS.green;
```

- [ ] **Step 3: Update card container styles for playing state**

Update the outer `<div>` styles to add LED glow when playing. Modify the `style` prop:

```typescript
      style={{
        background: hovered
          ? "var(--hw-card-hover)"
          : "var(--hw-card-bg)",
        border: `2px solid ${isThisActive ? LED.on : hovered ? "var(--hw-border-light)" : "var(--hw-card-border)"}`,
        borderRadius: 8,
        boxShadow: isThisActive
          ? LED.glowHot
          : hovered
            ? "0 4px 16px rgba(0,0,0,0.1)"
            : "0 1px 3px rgba(0,0,0,0.04)",
        transform: hovered ? "translateY(-2px)" : "none",
        transition: "all 0.2s ease",
      }}
```

- [ ] **Step 4: Add play/pause overlay and progress bar to artwork area**

Inside the artwork `<div>` (the one with `height: 140`), after the MiniWave overlay and before the closing `</div>`, add:

```tsx
        {/* Play/Pause overlay */}
        {track.preview_url && (hovered || isThisActive) && (
          <div
            role="button"
            tabIndex={0}
            aria-label={isThisPlaying ? "Pause preview" : "Play preview"}
            onClick={(e) => {
              e.stopPropagation();
              if (isThisPlaying) {
                pause();
              } else {
                play(track.id, track.preview_url!);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                if (isThisPlaying) pause();
                else play(track.id, track.preview_url!);
              }
            }}
            style={{
              position: "absolute",
              inset: 0,
              background: "rgba(0,0,0,0.45)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              zIndex: 2,
            }}
          >
            <div
              style={{
                width: 40,
                height: 40,
                borderRadius: "50%",
                background: "rgba(0,0,0,0.6)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                border: `2px solid ${LED.on}`,
                boxShadow: LED.glow,
                backdropFilter: "blur(4px)",
              }}
            >
              {isThisPlaying ? (
                <svg width="12" height="14" viewBox="0 0 12 14">
                  <rect x="1" y="0" width="3.5" height="14" rx="1" fill={LED.on} />
                  <rect x="7.5" y="0" width="3.5" height="14" rx="1" fill={LED.on} />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24">
                  <path d="M6 3l12 9-12 9V3z" fill={LED.on} />
                </svg>
              )}
            </div>
          </div>
        )}

        {/* Progress bar */}
        {isThisActive && (
          <div
            style={{
              position: "absolute",
              bottom: 0,
              left: 0,
              right: 0,
              height: 3,
              background: "var(--hw-groove, #0E0C0E)",
              zIndex: 3,
            }}
          >
            <div
              style={{
                width: `${progress * 100}%`,
                height: "100%",
                background: `linear-gradient(90deg, ${LED.on}, ${LED.mid})`,
                borderRadius: "0 2px 2px 0",
                transition: "width 0.25s linear",
              }}
            />
          </div>
        )}
```

- [ ] **Step 5: Update title color when playing**

In the body section, update the title `<div>` style to use green when this track is active:

```typescript
            color: isThisActive ? LED.on : "var(--hw-text)",
```

- [ ] **Step 6: Verify in browser**

Run: `cd web && npm run dev` — navigate to catalog, hover over a card. Verify:

- Play icon appears on hover (only for tracks with artwork)
- The overlay does not open the detail panel
- If you had a track with a real preview URL, clicking would play audio

- [ ] **Step 7: Commit**

```bash
git add web/components/ui/TrackCard.tsx
git commit -m "feat(ui): add preview play/pause overlay and LED glow to TrackCard"
```

---

## Task 8: TrackListRow — Hover Overlay + Playing State

**Files:**

- Modify: `web/components/ui/TrackListRow.tsx`

- [ ] **Step 1: Add `preview_url` to local Track interface and import context**

In `web/components/ui/TrackListRow.tsx`, add to the `Track` interface (after `artwork_url?: string;`):

```typescript
  preview_url?: string;
```

Add import at top:

```typescript
import { usePreviewPlayer } from "@/lib/preview-player-context";
import { LED_COLORS } from "@/lib/design-system/tokens";
```

- [ ] **Step 2: Add player state consumption**

Inside the component function, after existing `useState` calls:

```typescript
  const { currentTrackId, isPlaying, progress, play, pause } =
    usePreviewPlayer();
  const isThisPlaying = currentTrackId === track.id && isPlaying;
  const isThisActive = currentTrackId === track.id;
  const LED = LED_COLORS.green;
```

- [ ] **Step 3: Update row container styles for playing state**

Update the outer `<div>` styles to add green left border and glow when playing:

```typescript
      style={{
        display: "grid",
        gridTemplateColumns: "44px 2fr 1.5fr 50px 60px 0.5fr 0.8fr 0.6fr 48px",
        padding: "8px 14px",
        gap: 10,
        alignItems: "center",
        borderBottom: isLast
          ? "none"
          : "1px solid var(--hw-list-border)",
        borderLeft: isThisActive ? `3px solid ${LED.on}` : "3px solid transparent",
        background: hovered
          ? "var(--hw-list-row-hover)"
          : "var(--hw-list-row-bg)",
        boxShadow: isThisActive ? LED.glow : "none",
        transition: "background 0.12s, border-left 0.2s, box-shadow 0.2s",
      }}
```

- [ ] **Step 4: Add play/pause overlay to artwork thumbnail**

Replace the artwork thumbnail `<div>` (the first grid cell, ~38px square) with a version that has an overlay. Wrap it so it has `position: relative` and add the overlay inside:

```tsx
      {/* Artwork thumbnail */}
      <div style={{ position: "relative", width: 38, height: 38 }}>
        <div
          style={{
            width: 38,
            height: 38,
            borderRadius: 4,
            backgroundImage: track.artwork_url
              ? `url(${track.artwork_url})`
              : `linear-gradient(135deg, ${color}44 0%, ${color}11 100%)`,
            backgroundSize: "cover",
            backgroundPosition: "center",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {!track.artwork_url && (
            <span
              className="font-sans"
              style={{
                fontSize: 13,
                fontWeight: 800,
                color: `${color}88`,
              }}
            >
              {initials}
            </span>
          )}
        </div>

        {/* Play/Pause overlay */}
        {track.preview_url && (hovered || isThisActive) && (
          <div
            role="button"
            tabIndex={0}
            aria-label={isThisPlaying ? "Pause preview" : "Play preview"}
            onClick={(e) => {
              e.stopPropagation();
              if (isThisPlaying) {
                pause();
              } else {
                play(track.id, track.preview_url!);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                if (isThisPlaying) pause();
                else play(track.id, track.preview_url!);
              }
            }}
            style={{
              position: "absolute",
              inset: 0,
              borderRadius: 4,
              background: "rgba(0,0,0,0.5)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
            }}
          >
            <div
              style={{
                width: 24,
                height: 24,
                borderRadius: "50%",
                background: "rgba(0,0,0,0.5)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                border: `1.5px solid ${LED.on}`,
                boxShadow: LED.glow,
              }}
            >
              {isThisPlaying ? (
                <svg width="8" height="10" viewBox="0 0 12 14">
                  <rect x="1" y="0" width="3.5" height="14" rx="1" fill={LED.on} />
                  <rect x="7.5" y="0" width="3.5" height="14" rx="1" fill={LED.on} />
                </svg>
              ) : (
                <svg width="8" height="8" viewBox="0 0 24 24">
                  <path d="M6 3l12 9-12 9V3z" fill={LED.on} />
                </svg>
              )}
            </div>
          </div>
        )}

        {/* Progress bar under thumbnail */}
        {isThisActive && (
          <div
            style={{
              position: "absolute",
              bottom: 0,
              left: 0,
              right: 0,
              height: 2,
              background: "var(--hw-groove, #0E0C0E)",
              borderRadius: "0 0 4px 4px",
            }}
          >
            <div
              style={{
                width: `${progress * 100}%`,
                height: "100%",
                background: LED.on,
                borderRadius: "0 1px 1px 0",
                transition: "width 0.25s linear",
              }}
            />
          </div>
        )}
      </div>
```

- [ ] **Step 5: Update title color when playing**

Update the track title style to use green when active:

```typescript
            color: isThisActive ? LED.on : "var(--hw-text)",
```

- [ ] **Step 6: Verify in browser**

Run: `cd web && npm run dev` — switch to list view in catalog, hover over a row's artwork. Verify:

- Play icon appears on hover over artwork thumbnail
- Green left border on active row
- Progress bar under thumbnail

- [ ] **Step 7: Commit**

```bash
git add web/components/ui/TrackListRow.tsx
git commit -m "feat(ui): add preview play/pause overlay and LED glow to TrackListRow"
```

---

## Task 9: Final Integration Test

- [ ] **Step 1: Run full build**

```bash
cd web && npx next build
```

Verify no TypeScript or build errors.

- [ ] **Step 2: Manual smoke test**

1. Open the catalog in the browser
2. Verify tracks load normally (no regressions)
3. Hover over a grid card — play button appears if artwork present
4. Switch to list view — hover over thumbnail shows play button
5. Switch to compact view — no play button (expected)
6. If you have a track with a working `preview_url`, click play and verify audio plays, progress bar fills, LED glow activates
7. Click another track — previous stops, new one starts
8. Click pause — audio pauses, LED glow stays, progress bar freezes

- [ ] **Step 3: Commit any fixes from smoke test**

If issues found, fix and commit with descriptive message.

- [ ] **Step 4: Final commit — done**

```bash
git log --oneline feat/spotify-preview-player --not master
```

Verify all commits are clean and describe the feature correctly.
