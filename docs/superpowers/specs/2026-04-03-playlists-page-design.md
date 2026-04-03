# Playlists Page — Design Spec

**Date:** 2026-04-03
**Status:** Approved

## Summary

Add a `/playlists` page to browse, edit, re-export, and continue refining playlists created through the recommendation flow. The `playlists` and `playlist_tracks` tables already exist in the DB.

## Navigation

Add `/playlists` (label: "Playlists") to the sidebar `NAV` array between "Catalog" and "Export".

## Playlists List Page (`/playlists`)

- Fetch all user playlists via `GET /api/playlists`
- Display as vertical card list (not grid — consistent with other list pages)
- Each card shows:
  - Playlist name (bold)
  - Track count, total duration (Xh Ym format)
  - Creation date (relative: "2 days ago")
  - Venue name or mood preset name (from linked `recommendation_sessions` via `session_id`)
  - Lineup position badge (warmup/middle/headliner)
  - Mini EnergyArc strip (compact, reuse existing component)
- Click card → accordion expand below (inline detail, no page navigation)
- Delete button on each card (with confirmation prompt)
- Default sort: newest first
- Empty state: message with link to `/recommend`

## Playlist Detail (Accordion Expand)

When a card is clicked, expand below it showing:

### Header
- Editable playlist name (inline text input, click-to-edit)
- Action buttons row:
  - **Re-export** — opens ExportDialog with the playlist's session_id
  - **Continue Refining** — navigates to `/recommend?session=<session_id>`
  - **Save** — appears only when changes are pending (reorder/remove/rename)

### Track List
- Same column layout as ResultsList: artwork (32x32), title/artist, BPM, Key, EnergyBar, Danceability, Genre
- Hover highlight (matching ResultsList style)
- Drag handle for reorder (GripVertical icon)
- Remove button (X icon) per track
- Play button per track (using preview player context)

### Saving Changes
- Track reorder and removal are local state until Save is clicked
- Save calls `PATCH /api/playlists/[id]` with updated name and track list (ordered track_ids)
- Toast on success/error

## API Routes

All routes require authentication (Bearer token) and rate limiting (matching existing patterns).

### `GET /api/playlists` — List playlists
- Query: `playlists` table filtered by user_id, ordered by created_at desc
- Join: count of playlist_tracks per playlist
- Join: recommendation_sessions → venues.name / mood_presets.name for context label
- Also fetch track energies for the mini EnergyArc (via playlist_tracks → tracks.energy)
- Response: array of playlist objects with nested metadata

### `GET /api/playlists/[id]` — Playlist detail with tracks
- Fetch playlist by id (verify user ownership)
- Join playlist_tracks ordered by position → tracks (select same columns as catalog: id, title, artist, album, tempo, key_normalized, energy, danceability, genres, artwork_url, preview_url, spotify_uri, duration_ms)
- Response: playlist object with `tracks` array

### `PATCH /api/playlists/[id]` — Update playlist
- Body: `{ name?: string, tracks?: number[] }` (tracks = ordered array of track_ids)
- If `name` provided: update playlists.name
- If `tracks` provided: delete all playlist_tracks for this playlist, re-insert with new positions
- Verify user ownership
- Response: updated playlist object

### `DELETE /api/playlists/[id]` — Delete playlist
- Delete playlist (playlist_tracks cascade via FK)
- Verify user ownership
- Response: 204 No Content

## "Continue Refining" Flow

- Button navigates to `/recommend?session=<session_id>`
- Recommend page checks for `session` query param on mount
- If present: load session via existing expand endpoint (or a new `GET /api/recommend/session/[id]` that returns the session's last expand response)
- Drop user into the "results" step with existing tracks, similarity graph, and feedback controls
- If session has no expand data (only seeds were generated): drop into "seeds" step instead

### Session Restore API
- `GET /api/recommend/session/[id]` — returns session data + re-runs expand to get current track list
- Backend: load session, verify ownership, call the expand/scoring logic with stored seed_feedback, return ExpandResponse
- This reuses `_load_analyzed_library()` and scoring from the existing expand endpoint

## Components

### New Files
- `web/app/(app)/playlists/page.tsx` — Playlists page
- `web/components/playlists/PlaylistCard.tsx` — Card with expand/collapse
- `web/components/playlists/PlaylistDetail.tsx` — Expanded track list + actions
- `web/app/api/playlists/route.ts` — GET (list), POST not needed (created via export)
- `web/app/api/playlists/[id]/route.ts` — GET, PATCH, DELETE
- `web/app/api/recommend/session/[id]/route.ts` — GET for session restore

### Reused Components
- `EnergyArc` — mini strip on cards
- `EnergyBar` — per-track energy indicator
- `ExportDialog` — re-export modal
- Preview player context — track playback
- Design tokens (HARDWARE, LED_COLORS, FONTS)

## Client API Functions (`web/lib/api.ts`)

```typescript
// Add to api.ts
export interface Playlist {
  id: string;
  name: string;
  session_id: string | null;
  created_at: string;
  track_count: number;
  total_duration_ms: number;
  venue_name: string | null;
  mood_name: string | null;
  lineup_position: string | null;
  energies: number[];  // for mini EnergyArc
}

export interface PlaylistDetail extends Playlist {
  tracks: Track[];
}

export async function fetchPlaylists(): Promise<Playlist[]>
export async function fetchPlaylist(id: string): Promise<PlaylistDetail>
export async function updatePlaylist(id: string, data: { name?: string; tracks?: number[] }): Promise<void>
export async function deletePlaylist(id: string): Promise<void>
export async function restoreSession(sessionId: string): Promise<ExpandResponse>
```
