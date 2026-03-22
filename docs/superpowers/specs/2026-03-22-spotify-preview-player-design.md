# Spotify Preview Player — Design Spec

**Date:** 2026-03-22
**Branch:** `feat/spotify-preview-player`
**Status:** Approved

## Summary

Add a 30-second Spotify preview player to the catalog. Users hover over track artwork to reveal a play button; clicking it streams the Spotify preview URL via a hidden `<audio>` element. The currently-playing track is highlighted with a green LED border glow and progress bar, consistent with the CDJ design system.

### Spotify Preview URL Availability

Since late 2024, Spotify has reduced `preview_url` availability in their Web API. Many tracks return `null`. Availability depends on the OAuth token scope and region. The UX should treat missing previews as normal (not exceptional) — tracks without `preview_url` simply don't show a play button. The backfill endpoint will surface a count of how many tracks got previews vs. how many returned null, so the user can gauge coverage.

## Decisions

| Decision | Choice | Rationale |
| -------- | ------ | --------- |
| Audio source | Spotify 30s preview URLs | No infrastructure changes, no local file serving |
| URL sourcing | Stored at import time | Saves API calls vs. on-demand fetch |
| Play button placement | Artwork overlay on hover | Natural, works in Grid + List views |
| Compact view | No play button | No artwork thumbnail to overlay |
| Multi-track behavior | Auto-stop (one at a time) | Click new track stops previous, like Spotify/SoundCloud |
| Now-playing indicator | Green LED border glow | Progress bar at bottom of artwork, pause icon always visible, title turns green |

## Architecture

```text
Import (CSV / Spotify) ──▶ Supabase (tracks.preview_url)
                                    │
                                    ▼
                          API: GET /catalog/tracks
                          (includes preview_url)
                                    │
                                    ▼
                        PreviewPlayerContext (React)
                        ┌──────────────────────┐
                        │ <audio> element       │
                        │ currentTrackId        │
                        │ isPlaying / progress  │
                        │ play() / pause()      │
                        └──────────────────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
              TrackCard       TrackListRow    (CompactRow: no change)
              (Grid view)    (List view)
```

### Stale URL Recovery

```text
audio.onerror ──▶ POST /tracks/{id}/preview-url ──▶ retry once ──▶ toast "Preview unavailable"
```

## Data Layer

### New DB Column

```sql
ALTER TABLE tracks ADD COLUMN preview_url TEXT;
```

Nullable. No index needed (never queried by this column).

### Population

1. **Spotify playlist import** (`web/app/api/catalog/import/spotify/route.ts`): The Spotify API response already contains `preview_url` on each track object. Persist it alongside existing fields.

2. **CSV import** (`web/app/api/catalog/import/csv/route.ts`): Exportify CSVs don't include preview URLs, and this route does not call the Spotify API. CSV-imported tracks rely on the backfill endpoint (below) to populate `preview_url` after import. No changes to the CSV import route itself.

3. **Backfill route**: `POST /api/catalog/backfill-preview` endpoint (modeled on the existing `backfill-artwork` route) that fetches `preview_url` for tracks with `spotify_uri IS NOT NULL AND preview_url IS NULL`. Batched, rate-limited (use existing `limiters.backfill`). Returns `{ updated: number, skipped: number }` so the user can see coverage. Triggered manually via Settings page or a one-time curl call — no automatic trigger.

### API Changes

Add `preview_url` to the column select lists in:

- `GET /api/catalog/tracks` (`web/app/api/catalog/tracks/route.ts`)
- `GET /api/catalog/tracks/[id]` (`web/app/api/catalog/tracks/[id]/route.ts`)

Add `preview_url` to the `Track` TypeScript interface in `web/lib/api.ts`.

### Preview URL Refresh Endpoint

`POST /api/catalog/tracks/[id]/preview-url`

POST (not GET) because it writes to the DB — avoids CDN/prefetch caching issues.

1. Read the track's `spotify_uri` from DB
2. Call Spotify API to get fresh track data (requires user's connected Spotify OAuth token)
3. Update `preview_url` in DB
4. Return `{ preview_url: string | null }`

Rate-limited with `limiters.read` to prevent burst requests when many URLs are stale. Used only when the stored URL fails (stale URL recovery).

## Player State — PreviewPlayerContext

A React context provider wrapped around children in `(app)/layout.tsx`. Since the layout is an async Server Component, a separate `PreviewPlayerProvider` client component will wrap `{children}` inside the layout's JSX (standard Next.js pattern for mixing server layouts with client providers).

### State

```typescript
interface PreviewPlayerState {
  currentTrackId: number | null;
  previewUrl: string | null;
  isPlaying: boolean;
  progress: number; // 0–1
}

interface PreviewPlayerActions {
  play(trackId: number, previewUrl: string): void;
  pause(): void;
  stop(): void;
}
```

### Behavior

- `play(trackId, url)`: If another track is playing, stop it first. Set `audio.src = url`, call `audio.play()`.
- `pause()`: Call `audio.pause()`. Keep `currentTrackId` so the UI still shows which track was playing.
- `stop()`: Call `audio.pause()`, reset all state to null/false/0.
- `timeupdate` event: Update `progress = currentTime / duration`.
- `ended` event: Reset state (track finished its 30s preview).
- `error` event: Attempt one refresh via the preview URL endpoint. If refresh also fails, fire a toast ("Preview unavailable for {title}") and reset state.

### File Location

`web/lib/preview-player-context.tsx`

## UI Changes

### TrackCard (Grid View)

Use design system tokens (`LED_COLORS.green.on`, `.glow`, `.glowHot`) — not raw hex values.

**Hover state** (only when track has `preview_url`):

- Semi-transparent dark overlay on artwork area (`rgba(0,0,0,0.45)`)
- Centered circular play button: 40px, dark background, 2px `LED_COLORS.green.on` border, green play icon, `LED_COLORS.green.glow` box-shadow
- Click on play button calls `play()` with `e.stopPropagation()` (does NOT open detail panel)
- Keyboard: space/enter on a focused track with `preview_url` toggles playback

**Playing state** (when `currentTrackId === track.id`):

- Card border: 2px solid `LED_COLORS.green.on` with `LED_COLORS.green.glowHot`
- Pause icon always visible centered on artwork (no hover needed)
- 3px progress bar at bottom of artwork area, rendered **above** the existing MiniWave overlay (higher z-index). MiniWave remains visible underneath.
- Track title text color changes to `LED_COLORS.green.on`
- Click pause icon calls `pause()`

**Clicking card body while playing**: Opens the detail panel without stopping playback (click on pause icon is the only way to stop).

**No preview_url**: No overlay on hover. Track behaves exactly as today.

### TrackListRow (List View)

**Hover state** (only when track has `preview_url`):

- Dark overlay on 38px artwork thumbnail
- 24px circular play button centered on thumbnail (same LED style, smaller)
- `e.stopPropagation()` on click

**Playing state**:

- Green left border accent on the row (`border-left: 3px solid LED_COLORS.green.on`)
- Subtle row glow (`box-shadow: LED_COLORS.green.glow`)
- Pause icon visible on thumbnail (always, not just hover)
- 2px progress bar at bottom of thumbnail
- Track title color changes to `LED_COLORS.green.on`

### TrackCompactRow

No changes. No artwork to overlay.

### DetailPanel

No changes in this iteration.

## Edge Cases

| Scenario | Behavior |
| -------- | -------- |
| Track has no `preview_url` | No play overlay on hover. Track unchanged. |
| Preview URL expired | `<audio>` error → refresh endpoint → retry once → toast if still fails |
| Click play on new track while one plays | Auto-stop previous, start new |
| Navigate between pages in (app) | Playback continues (context in shared layout) |
| Navigate outside (app) layout | Playback stops (context unmounts) |
| Compact view | No play button (no artwork) |
| Mobile / touch | No hover → follow-up iteration. For now, no play button on touch. |

## Files to Create/Modify

### New Files

- `web/lib/preview-player-context.tsx` — React context + `<audio>` management
- `web/app/api/catalog/backfill-preview/route.ts` — one-time backfill endpoint
- `web/app/api/catalog/tracks/[id]/preview-url/route.ts` — refresh endpoint
- `supabase/migrations/YYYYMMDD_add_preview_url.sql` — migration

### Modified Files

- `web/lib/api.ts` — add `preview_url` to `Track` interface
- `web/app/api/catalog/tracks/route.ts` — add `preview_url` to `TRACK_COLUMNS` (note: duplicated in `[id]/route.ts` — keep both in sync)
- `web/app/api/catalog/tracks/[id]/route.ts` — add `preview_url` to `TRACK_COLUMNS`
- `web/app/api/catalog/import/spotify/route.ts` — persist `preview_url` from Spotify response in `mapSpotifyTrack()`
- `web/app/(app)/layout.tsx` — wrap children with `PreviewPlayerProvider` (client component wrapper)
- `web/app/(app)/catalog/page.tsx` — update `toComponentTrack()` to pass `preview_url` through
- `web/components/ui/TrackCard.tsx` — add `preview_url` to local `Track` interface, hover overlay + playing state
- `web/components/ui/TrackListRow.tsx` — add `preview_url` to local `Track` interface, hover overlay + playing state

## Out of Scope

- Mobile/touch play button (follow-up)
- Volume control
- Playback in DetailPanel
- Full track playback (Spotify Web Playback SDK)
- Preview for non-Spotify tracks
