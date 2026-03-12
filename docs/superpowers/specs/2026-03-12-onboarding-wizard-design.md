# Onboarding Wizard Design

**Date:** 2026-03-12
**Status:** Approved
**Scope:** First-run onboarding flow for new djtoolkit SaaS users

---

## Overview

New users are redirected to `/onboarding` on first login. The wizard is a full-screen, step-by-step flow (no sidebar, no app chrome) that guides them through importing their music, reviewing the candidate list, and installing the local agent. After completing all three steps, they land on the Pipeline page to start downloads.

---

## First-Run Detection

**Primary gate:** `onboarding_completed` in Supabase `user_metadata` (`user.user_metadata.onboarding_completed !== true`).

**Fallback for pre-flag users:** If the flag is absent AND `tracks.total === 0`, also redirect to onboarding.

**Where the check runs:** In `web/app/(app)/layout.tsx` (server component). It reads the Supabase session, checks `user.user_metadata.onboarding_completed`, and optionally calls `GET /catalog/stats` to check track count. If conditions are met, `redirect('/onboarding')`.

**How the flag is set:** When the agent connects (step 3 green light), the frontend calls `supabase.auth.updateUser({ data: { onboarding_completed: true } })` directly from the browser using the user's session. This writes to `user_metadata` (user-writable, not admin-only). No backend endpoint needed.

---

## Route

`/onboarding` — standalone page, does **not** use the `(app)` layout (no sidebar). Has its own `web/app/onboarding/layout.tsx` with just the step bar and full-screen content area. The layout still requires auth (`createClient()` check → redirect to `/login` if not authenticated).

---

## Step Bar

Three steps shown as a persistent horizontal bar at the top of every step:

| State | Appearance |
|-------|-----------|
| Upcoming | Gray label, no border |
| Active | Indigo label + bold + 2px indigo bottom border |
| Completed | Green label prefixed with ✓ |

Labels: **1 · Import** / **2 · Review** / **3 · Download Agent**

**Navigation:** Completed step labels are **not** clickable links. Backward navigation is only via the "← Back" button in each step's CTA bar. Step 3 is a one-way door once the API key is generated — navigating back would require generating a new key (out of scope for v1; user can manage keys on the Agents page).

---

## Step 1 — Import

**Heading:** "Where's your music coming from?"
**Subheading:** "You can import from multiple sources — all tracks will be combined in step 2."

Three import source cards, stacked vertically:

### Spotify
- Calls `GET /catalog/import/spotify/playlists` on component mount to check if Spotify is connected
  - If connected: show "✓ Connected" badge + inline playlist picker (radio list: name + track count from response)
  - If not connected: show "Connect Spotify" button → redirects to `/auth/spotify/connect?return_to=/onboarding`
- Before redirecting for OAuth, save current wizard state (e.g. whether CSV was uploaded) to `sessionStorage` under key `djtoolkit_onboarding_state`
- After OAuth, callback handler reads `return_to` param and redirects to `/onboarding?spotify=connected`. On load with that param, auto-expand the Spotify section and trigger `GET /catalog/import/spotify/playlists`
- Selected playlist highlighted with indigo border; track count contributed to the CTA counter

### Exported Spotify Playlist (CSV)
- "Upload file" button on the right; clicking expands a drag-and-drop zone
- Accepts `.csv` files only, max 10MB (client-side validation before upload)
- **Track count for CTA:** parsed client-side by counting rows in the file (no server call needed for the count)
- The actual `POST /catalog/import/csv` call is deferred until the user clicks "Review tracks →"
- File is held in component state until submission

### TrackID *(Coming Soon)*
- Grayed out, 45% opacity, "Coming soon" badge
- Description: "Identify tracks from a YouTube, SoundCloud, or Mixcloud set"
- Not interactive

**CTA bar (bottom):**
- Left: "N source(s) selected · M tracks" counter (Spotify count from API response; CSV count from client-side row parse)
- Right: "Review tracks →" button (disabled until at least one source has tracks)

---

## Transition: Step 1 → Step 2

When "Review tracks →" is clicked:

1. Show a loading state (spinner overlay or inline "Importing…" message)
2. Fire whichever import calls are needed in parallel:
   - If Spotify playlist selected: `POST /catalog/import/spotify` with `{ playlist_id: "<selected_id>" }`
   - If CSV file present: `POST /catalog/import/csv` (multipart/form-data)
3. Both calls are **synchronous** — they return `{ imported, skipped_duplicates, jobs_created }` when done. The server inserts tracks with `acquisition_status = 'candidate'` but does **not** create `pipeline_jobs` at this stage (unlike the normal catalog import flow). This is controlled by a `?queue_jobs=false` query param on both endpoints.
4. On any error (malformed CSV, Spotify token expired): surface error toast on step 1, stay on step 1. Do not advance.
5. On success: advance to step 2. The step 2 track list is loaded from `GET /catalog/tracks?status=candidate&per_page=500`.

**Multi-source deduplication:** Handled server-side at insert time via `ON CONFLICT (user_id, spotify_uri) DO NOTHING`. CSV tracks without a `spotify_uri` are never deduplicated against Spotify tracks and appear as separate rows. If both sources import the same track (one with URI, one without), they appear as two rows in step 2.

---

## Step 2 — Review

**Heading:** "Confirm your download list"
**Subheading:** "Deselect any tracks you don't want. Already-owned tracks are excluded automatically."

**All queries are user-scoped** via JWT claim in the API (RLS enforced at the DB level — `user_id = current_setting('app.current_user_id')::UUID`). No cross-user data leakage is possible.

### Stats bar
Three stat cards: **N to download** / **N already owned** / **N total imported**

- Total = all tracks returned from `GET /catalog/tracks?status=candidate`
- Already owned = tracks returned by `GET /catalog/tracks?status=candidate` where the API sets `already_owned: true` on each track. The API computes this via a LEFT JOIN against `tracks WHERE acquisition_status = 'available' AND user_id = $user_id` on `spotify_uri`. The `TrackOut` model must include an `already_owned: bool` field (defaults to `false`). Client renders this flag directly — no cross-referencing against a second API call.
- To download = Total − Already owned (before any manual deselection)

### Search bar
Simple text input filtering the list by title or artist (client-side, no API call).

### Track list
- Scrollable, max height fills the viewport (CSS: `overflow-y: auto; max-height: calc(100vh - 320px)`)
- "Select all" checkbox row at top with count on the right
- Each row: checkbox · title · artist
- **Owned tracks:** pre-deselected, grayed out (50% opacity), title struck through, "Already owned" badge. Checkbox can be re-checked if user wants to re-download.
- **Manually deselected:** strikethrough, dimmed, no badge

### CTA bar (bottom)
- Left: "← Back" (returns to step 1; tracks already inserted remain as candidates — no rollback)
- Right: **"Queue N downloads →"** — N = selected tracks. Clicking:
  1. Calls `POST /pipeline/jobs/bulk` with `{ track_ids: [<selected ids>] }` — a new endpoint that creates one `pipeline_jobs` row per track with `job_type = 'download'`
  2. Tracks that were deselected (and not "already owned") are deleted via `DELETE /catalog/tracks/bulk` with `{ track_ids: [<deselected ids>] }`. The endpoint constrains deletion to `acquisition_status = 'candidate'` rows owned by the requesting user — arbitrary or already-downloaded track IDs are ignored silently.
  3. On success, advance to step 3

**Zero tracks selected:** "Queue downloads" button is disabled.

---

## Step 3 — Download Agent

**Heading:** "Install the djtoolkit agent"
**Subheading:** "The agent runs on your Mac and handles downloading, fingerprinting, and tagging — your files never leave your machine."

**On mount:** Calls `POST /agents/register` with `{ machine_name: "My Mac" }` to pre-generate an API key. The key is stored in component state and displayed once. If the user navigates back to step 2 and returns to step 3, the same key is shown (component state persists within the wizard session). The agent does **not** call `POST /agents/register` again — `djtoolkit agent configure` just stores the key locally. `djtoolkit agent start` authenticates with the stored key on first heartbeat.

### Download options

**Primary — macOS .dmg:**
- Indigo card with "Download for macOS" + filename + "arm64 + x86_64 · Includes all dependencies"
- "Download .dmg" links to `https://github.com/{org}/djtoolkit/releases/latest/download/djtoolkit-macos.dmg`
- URL is hardcoded (not fetched from GitHub API) — keeps it simple, always resolves to latest

**Secondary — pip:**
```
pip install djtoolkit
```
Copy button.

### Configuration commands (pre-populated with user's API key)
```
djtoolkit agent configure --api-key djt_<generated_key>
```
```
djtoolkit agent start
```
Each has a copy button. The full key is shown (not truncated).

### Connection status indicator

Polls `GET /agents` every 5 seconds looking for an agent with `last_seen_at` within the last 60 seconds. When connected, also fetches `GET /pipeline/status` (single call, not polled) to get the `pending` job count for the "N download jobs queued and ready" label.

| State | Indicator |
|-------|-----------|
| Waiting | Red dot (glow), "Agent not connected · Checking every 5s…" |
| Connected | Green dot (glow), "Agent connected — {machine_name} · N download jobs queued and ready" |
| Poll error | Silently retry. After 3 consecutive failures, show yellow dot + "Connection check failed — retrying…" |

### CTA
- **Waiting / Error:** "Done →" button, disabled (gray)
- **Connected:** "Go to Pipeline →" button, active green — calls `supabase.auth.updateUser({ data: { onboarding_completed: true } })` then navigates to `/pipeline`
- **"Skip for now" link:** small gray link below the CTA button, always visible. Navigates to `/catalog` without setting the flag. On next login, step 3 will reappear (the flag is not set).

---

## Navigation & Edge Cases

| Scenario | Behavior |
|----------|----------|
| User already has `onboarding_completed = true` | No redirect; normal app loads |
| User has tracks but no flag (legacy / pre-flag) | No redirect (track count fallback: `tracks.total > 0` → skip) |
| Spotify OAuth redirect mid-step-1 | State saved to `sessionStorage`; callback redirects to `/onboarding?spotify=connected`; page restores state + auto-expands Spotify section |
| User closes browser mid-wizard | On next login, onboarding check fires again; tracks already imported remain as `candidate` in DB |
| User clicks "Skip for now" on step 3 | Goes to `/catalog`; onboarding_completed stays false; step 3 shown again on next login |
| Zero tracks selected in step 2 | "Queue downloads" button disabled |
| Back from step 2 to step 1 | Already-imported tracks remain in DB as candidates; re-importing the same playlist does nothing (ON CONFLICT DO NOTHING) |

---

## New API Endpoints Required

| Endpoint | Description |
|----------|-------------|
| `POST /pipeline/jobs/bulk` | Body: `{ track_ids: [uuid] }`. Creates one `pipeline_jobs` row per ID with `job_type='download', status='pending'`. Returns `{ created: N }`. |
| `DELETE /catalog/tracks/bulk` | Body: `{ track_ids: [uuid] }`. Deletes candidate tracks the user chose to skip. Returns `{ deleted: N }`. |

Existing endpoints used:
- `GET /catalog/import/spotify/playlists`
- `POST /catalog/import/spotify?queue_jobs=false`
- `POST /catalog/import/csv?queue_jobs=false`
- `GET /catalog/tracks?status=candidate&per_page=500`
- `GET /catalog/stats`
- `POST /agents/register`
- `GET /agents`

---

## Files to Create / Modify

| File | Change |
|------|--------|
| `web/app/onboarding/page.tsx` | **NEW** — main wizard component (state machine: step 1/2/3) |
| `web/app/onboarding/layout.tsx` | **NEW** — standalone layout (no sidebar, auth check) |
| `web/app/(app)/layout.tsx` | Add first-run redirect: `onboarding_completed !== true` in user_metadata (+ track count fallback) |
| `web/app/auth/callback/route.ts` | Handle `return_to` query param; redirect back to `/onboarding?spotify=connected` if present |
| `web/lib/api.ts` | Add `importSpotifyPlaylistNoJobs()`, `importCsvNoJobs()`, `bulkCreateJobs()`, `bulkDeleteTracks()` |
| `djtoolkit/api/pipeline_routes.py` | Add `POST /pipeline/jobs/bulk` endpoint |
| `djtoolkit/api/catalog_routes.py` | Add `DELETE /catalog/tracks/bulk` endpoint; add `queue_jobs` query param to both import endpoints |

---

## Out of Scope

- TrackID import (UI slot reserved as "coming soon", not interactive)
- Windows / Linux agent install instructions (macOS only for v1)
- Per-track download progress bar (visible on Pipeline page after onboarding)
- Rollback of step 1 imports when user navigates back (tracks stay as candidates)
