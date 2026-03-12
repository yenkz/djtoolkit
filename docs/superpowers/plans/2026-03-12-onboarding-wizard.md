# Onboarding Wizard Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a 3-step first-run onboarding wizard at `/onboarding` that guides new djtoolkit users through importing music (Spotify or CSV), reviewing and confirming the candidate list, and installing the local agent.

**Architecture:** Full-screen Next.js page (no sidebar) with a step state machine (step 1 → 2 → 3). New backend endpoints support the wizard's `queue_jobs=false` import mode, bulk job creation, and bulk candidate deletion. First-run detection uses a `onboarding_completed` flag in Supabase `user_metadata`.

**Tech Stack:** Python 3.11 / FastAPI / asyncpg (backend), Next.js 14 App Router / TypeScript / Tailwind / @supabase/ssr (frontend)

**Spec:** `docs/superpowers/specs/2026-03-12-onboarding-wizard-design.md`

---

## Chunk 1: Backend API changes

### Task 1: Add `queue_jobs` param to import helper and endpoints

The two import endpoints always create `pipeline_jobs` today. In onboarding the wizard creates jobs explicitly at step 2, so imports must be able to skip job creation.

**Files:**
- Modify: `djtoolkit/api/catalog_routes.py`
- Modify: `tests/test_catalog_routes.py`

- [ ] **Step 0: Install `respx` dev dependency**

The Spotify import test mocks outbound HTTP with `respx`. Add it before writing any tests that use it:

```bash
poetry add --group dev respx
```

- [ ] **Step 1: Write failing tests**

Add to `tests/test_catalog_routes.py` (in the integration section — these tests skip without `SUPABASE_DATABASE_URL`):

```python
@_needs_db
@pytest.mark.asyncio
async def test_import_csv_queue_jobs_false(db_user):
    """POST /catalog/import/csv?queue_jobs=false inserts tracks but no pipeline_jobs."""
    user_id, token = db_user
    csv_bytes = _sample_csv()
    async with _async_client() as c:
        r = await c.post(
            "/api/catalog/import/csv?queue_jobs=false",
            files={"file": ("test.csv", io.BytesIO(csv_bytes), "text/csv")},
            headers={"Authorization": f"Bearer {token}"},
        )
    assert r.status_code == 201
    data = r.json()
    assert data["imported"] > 0
    assert data["jobs_created"] == 0

    # Verify no pipeline_jobs were created
    conn = await asyncpg.connect(os.environ["SUPABASE_DATABASE_URL"])
    count = await conn.fetchval(
        "SELECT count(*) FROM pipeline_jobs WHERE user_id = $1", user_id
    )
    await conn.close()
    assert count == 0


@_needs_db
@pytest.mark.asyncio
async def test_import_spotify_queue_jobs_false_skips_jobs(db_user, monkeypatch):
    """POST /catalog/import/spotify?queue_jobs=false creates no pipeline_jobs."""
    # Monkeypatch _get_spotify_token to avoid real Spotify OAuth
    from djtoolkit.api import catalog_routes
    monkeypatch.setattr(
        catalog_routes, "_get_spotify_token",
        lambda user_id: "fake-token"
    )

    # Monkeypatch httpx to return a fake playlist response
    import respx, httpx as _httpx
    with respx.mock:
        respx.get("https://api.spotify.com/v1/playlists/test123/tracks").mock(
            return_value=_httpx.Response(200, json={
                "items": [{
                    "added_by": {"id": "user"},
                    "added_at": "2024-01-01T00:00:00Z",
                    "track": {
                        "uri": "spotify:track:abc123",
                        "name": "Test Track",
                        "duration_ms": 240000,
                        "artists": [{"name": "Test Artist"}],
                        "album": {"name": "Test Album", "release_date": "2024"},
                        "explicit": False,
                        "popularity": 50,
                        "external_ids": {},
                    }
                }],
                "next": None,
            })
        )
        user_id, token = db_user
        async with _async_client() as c:
            r = await c.post(
                "/api/catalog/import/spotify?queue_jobs=false",
                json={"playlist_id": "test123"},
                headers={"Authorization": f"Bearer {token}"},
            )

    assert r.status_code == 201
    assert r.json()["jobs_created"] == 0
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
poetry run pytest tests/test_catalog_routes.py::test_import_csv_queue_jobs_false tests/test_catalog_routes.py::test_import_spotify_queue_jobs_false_skips_jobs -v
```

Expected: FAIL or SKIP (SKIP is fine if no DB — that proves the test structure is valid and they won't run without DB credentials)

- [ ] **Step 3: Add `queue_jobs` param to `_insert_tracks_and_create_jobs`**

In `djtoolkit/api/catalog_routes.py`, change the helper signature and body:

```python
async def _insert_tracks_and_create_jobs(
    conn, user_id: str, tracks: list[dict], source: str, *, queue_jobs: bool = True
) -> tuple[int, int, int]:
    """Insert tracks (ON CONFLICT DO NOTHING) and optionally create download jobs.

    Returns (inserted, skipped_duplicates, jobs_created).
    """
    inserted = 0
    skipped = 0
    jobs_created = 0

    for t in tracks:
        result = await conn.fetchval(
            """
            INSERT INTO tracks (
                user_id, acquisition_status, source,
                title, artist, artists, album, year, release_date,
                duration_ms, isrc, genres, spotify_uri, popularity,
                explicit, added_by, added_at, search_string
            ) VALUES (
                $1, 'candidate', $2,
                $3, $4, $5, $6, $7, $8,
                $9, $10, $11, $12, $13,
                $14, $15, $16, $17
            )
            ON CONFLICT (user_id, spotify_uri) DO NOTHING
            RETURNING id
            """,
            user_id, source,
            t.get("title"), t.get("artist"), t.get("artists"),
            t.get("album"), t.get("year"), t.get("release_date"),
            t.get("duration_ms"), t.get("isrc"), t.get("genres"),
            t.get("spotify_uri"), t.get("popularity"),
            t.get("explicit", False), t.get("added_by"), t.get("added_at"),
            t.get("search_string"),
        )
        if result is None:
            skipped += 1
        else:
            inserted += 1
            if queue_jobs:
                await conn.execute(
                    """
                    INSERT INTO pipeline_jobs (user_id, track_id, job_type, payload)
                    VALUES ($1, $2, 'download', $3)
                    """,
                    user_id, result,
                    json.dumps({
                        "track_id": result,
                        "search_string": t.get("search_string", ""),
                        "artist": t.get("artist", ""),
                        "title": t.get("title", ""),
                        "duration_ms": t.get("duration_ms", 0),
                    }),
                )
                jobs_created += 1

    return inserted, skipped, jobs_created
```

- [ ] **Step 4: Wire `queue_jobs` query param into both import endpoints**

In `import_csv`:
```python
@router.post("/import/csv", response_model=ImportResult, status_code=status.HTTP_201_CREATED)
async def import_csv(
    file: UploadFile = File(...),
    queue_jobs: bool = Query(True),
    user: CurrentUser = Depends(get_current_user),
):
    # ... existing validation unchanged ...
    pool = await get_pool()
    async with rls_transaction(pool, user.user_id) as conn:
        inserted, skipped, jobs_created = await _insert_tracks_and_create_jobs(
            conn, user.user_id, tracks, "exportify", queue_jobs=queue_jobs
        )
    return ImportResult(imported=inserted, skipped_duplicates=skipped, jobs_created=jobs_created)
```

In `import_spotify`, add `queue_jobs: bool = Query(True)` to the signature and pass `queue_jobs=queue_jobs` to `_insert_tracks_and_create_jobs`.

- [ ] **Step 5: Run tests**

```bash
poetry run pytest tests/test_catalog_routes.py -v -k "queue_jobs"
```

Expected: PASS (or SKIP if no DB — both acceptable)

- [ ] **Step 6: Commit**

```bash
git add djtoolkit/api/catalog_routes.py tests/test_catalog_routes.py
git commit -m "feat(catalog): add queue_jobs param to import endpoints"
```

---

### Task 2: Add `already_owned` field to track list response

The onboarding step 2 needs to know which candidates are already in the user's library.

**Files:**
- Modify: `djtoolkit/api/catalog_routes.py`
- Modify: `tests/test_catalog_routes.py`

- [ ] **Step 1: Write failing test**

```python
@_needs_db
@pytest.mark.asyncio
async def test_list_tracks_already_owned_flag(db_user):
    """already_owned=true when a candidate's spotify_uri matches an available track."""
    user_id, token = db_user
    conn = await asyncpg.connect(os.environ["SUPABASE_DATABASE_URL"])

    # Insert one available track and one candidate with the same spotify_uri
    spotify_uri = f"spotify:track:{uuid.uuid4().hex}"
    await conn.execute(
        """INSERT INTO tracks (user_id, acquisition_status, source, title, artist,
                               spotify_uri, search_string)
           VALUES ($1, 'available', 'folder', 'Owned Track', 'Artist A', $2, '')""",
        user_id, spotify_uri,
    )
    await conn.execute(
        """INSERT INTO tracks (user_id, acquisition_status, source, title, artist,
                               spotify_uri, search_string)
           VALUES ($1, 'candidate', 'spotify', 'Owned Track', 'Artist A', $2, '')
           ON CONFLICT DO NOTHING""",
        user_id, spotify_uri,
    )
    await conn.close()

    async with _async_client() as c:
        r = await c.get(
            "/api/catalog/tracks?status=candidate",
            headers={"Authorization": f"Bearer {token}"},
        )
    assert r.status_code == 200
    tracks = r.json()["tracks"]
    owned = [t for t in tracks if t["spotify_uri"] == spotify_uri]
    assert len(owned) == 1
    assert owned[0]["already_owned"] is True
```

- [ ] **Step 2: Run test to verify it fails**

```bash
poetry run pytest tests/test_catalog_routes.py::test_list_tracks_already_owned_flag -v
```

Expected: FAIL with `KeyError: 'already_owned'`

- [ ] **Step 3: Add `already_owned` to `TrackOut` and `_row_to_track`**

In `TrackOut`:
```python
class TrackOut(BaseModel):
    # ... existing fields ...
    already_owned: bool = False
```

In `_row_to_track`:
```python
def _row_to_track(r) -> TrackOut:
    return TrackOut(
        # ... existing fields ...
        already_owned=bool(r.get("already_owned", False)),
    )
```

- [ ] **Step 4: Update `list_tracks` SQL to compute `already_owned`**

In `list_tracks`, replace the SELECT query with a LEFT JOIN that checks for a matching `available` track with the same `spotify_uri` for the same user:

```python
    query = f"""
        SELECT t.*,
               (owned.id IS NOT NULL) AS already_owned
        FROM tracks t
        LEFT JOIN LATERAL (
            SELECT id FROM tracks o
            WHERE o.user_id = t.user_id
              AND o.spotify_uri IS NOT NULL
              AND o.spotify_uri = t.spotify_uri
              AND o.acquisition_status = 'available'
            LIMIT 1
        ) owned ON TRUE
        WHERE {where}
        ORDER BY t.created_at DESC
        LIMIT $... OFFSET $...
    """
```

> **Note:** Adapt the `$N` placeholders to match the existing argument list. The pattern is: use `LATERAL` subquery to avoid needing a join-condition that breaks when `spotify_uri` is NULL.

- [ ] **Step 5: Also raise `per_page` max from 200 to 1000**

In `list_tracks` signature:
```python
per_page: int = Query(50, ge=1, le=1000),
```

This allows the onboarding step 2 to fetch up to 1000 candidates in one call.

- [ ] **Step 6: Run tests**

```bash
poetry run pytest tests/test_catalog_routes.py -v
```

Expected: all existing tests still PASS, new test PASSES or SKIPS.

- [ ] **Step 7: Commit**

```bash
git add djtoolkit/api/catalog_routes.py tests/test_catalog_routes.py
git commit -m "feat(catalog): add already_owned flag to track list + raise per_page max"
```

---

### Task 3: Add `POST /pipeline/jobs/bulk` endpoint

The onboarding step 2 confirmation creates download jobs for selected tracks.

**Files:**
- Modify: `djtoolkit/api/pipeline_routes.py`
- Modify: `tests/test_pipeline_routes.py`

- [ ] **Step 1: Write failing test**

Add to `tests/test_pipeline_routes.py`:

```python
@_needs_db
@pytest.mark.asyncio
async def test_bulk_create_jobs(db_user):
    """POST /pipeline/jobs/bulk creates one job per track_id."""
    user_id, token = db_user
    conn = await asyncpg.connect(os.environ["SUPABASE_DATABASE_URL"])

    # Insert two candidate tracks (no pipeline_jobs)
    t1 = await conn.fetchval(
        """INSERT INTO tracks (user_id, acquisition_status, source, title, artist, search_string)
           VALUES ($1, 'candidate', 'spotify', 'Track One', 'Artist', '')
           RETURNING id""", user_id
    )
    t2 = await conn.fetchval(
        """INSERT INTO tracks (user_id, acquisition_status, source, title, artist, search_string)
           VALUES ($1, 'candidate', 'spotify', 'Track Two', 'Artist', '')
           RETURNING id""", user_id
    )
    await conn.close()

    async with _async_client() as c:
        r = await c.post(
            "/api/pipeline/jobs/bulk",
            json={"track_ids": [t1, t2]},
            headers={"Authorization": f"Bearer {token}"},
        )
    assert r.status_code == 201
    data = r.json()
    assert data["created"] == 2
```

- [ ] **Step 2: Run test to verify it fails**

```bash
poetry run pytest tests/test_pipeline_routes.py::test_bulk_create_jobs -v
```

Expected: FAIL with 404 (route doesn't exist yet)

- [ ] **Step 3: Add the endpoint to `pipeline_routes.py`**

Add request model and endpoint:

```python
class BulkJobsRequest(BaseModel):
    track_ids: list[int]


class BulkJobsResult(BaseModel):
    created: int


@router.post("/jobs/bulk", response_model=BulkJobsResult, status_code=status.HTTP_201_CREATED)
async def bulk_create_jobs(
    body: BulkJobsRequest,
    user: CurrentUser = Depends(get_current_user),
):
    """Create one download job per track_id. Skips tracks that already have
    a pending or running job. Only creates jobs for tracks owned by the requesting user."""
    if not body.track_ids:
        return BulkJobsResult(created=0)

    pool = await get_pool()
    async with pool.acquire() as conn:
        created = 0
        for track_id in body.track_ids:
            # Verify track belongs to user and is a candidate
            track = await conn.fetchrow(
                """SELECT id, title, artist, search_string, duration_ms
                   FROM tracks
                   WHERE id = $1 AND user_id = $2 AND acquisition_status = 'candidate'""",
                track_id, user.user_id,
            )
            if track is None:
                continue  # not found or not owned — skip silently

            # Skip if a pending/running job already exists for this track
            existing = await conn.fetchval(
                """SELECT id FROM pipeline_jobs
                   WHERE track_id = $1 AND status IN ('pending', 'claimed', 'running')
                   LIMIT 1""",
                track_id,
            )
            if existing:
                continue

            await conn.execute(
                """INSERT INTO pipeline_jobs (user_id, track_id, job_type, payload)
                   VALUES ($1, $2, 'download', $3)""",
                user.user_id, track_id,
                json.dumps({
                    "track_id": track_id,
                    "search_string": track["search_string"] or "",
                    "artist": track["artist"] or "",
                    "title": track["title"] or "",
                    "duration_ms": track["duration_ms"] or 0,
                }),
            )
            created += 1

    return BulkJobsResult(created=created)
```

> **Note:** `json` is already imported at the top of `pipeline_routes.py`.

- [ ] **Step 4: Run test**

```bash
poetry run pytest tests/test_pipeline_routes.py::test_bulk_create_jobs -v
```

Expected: PASS or SKIP

- [ ] **Step 5: Commit**

```bash
git add djtoolkit/api/pipeline_routes.py tests/test_pipeline_routes.py
git commit -m "feat(pipeline): add POST /pipeline/jobs/bulk endpoint"
```

---

### Task 4: Add `DELETE /catalog/tracks/bulk` endpoint

Deletes candidate tracks the user chose not to download.

**Files:**
- Modify: `djtoolkit/api/catalog_routes.py`
- Modify: `tests/test_catalog_routes.py`

- [ ] **Step 1: Write failing test**

```python
@_needs_db
@pytest.mark.asyncio
async def test_bulk_delete_tracks_candidates_only(db_user):
    """DELETE /catalog/tracks/bulk deletes candidates; ignores available tracks."""
    user_id, token = db_user
    conn = await asyncpg.connect(os.environ["SUPABASE_DATABASE_URL"])

    candidate_id = await conn.fetchval(
        """INSERT INTO tracks (user_id, acquisition_status, source, title, artist, search_string)
           VALUES ($1, 'candidate', 'spotify', 'To Delete', 'Artist', '') RETURNING id""",
        user_id,
    )
    available_id = await conn.fetchval(
        """INSERT INTO tracks (user_id, acquisition_status, source, title, artist, search_string)
           VALUES ($1, 'available', 'spotify', 'Keep Me', 'Artist', '') RETURNING id""",
        user_id,
    )
    await conn.close()

    async with _async_client() as c:
        r = await c.request(
            "DELETE",
            "/api/catalog/tracks/bulk",
            json={"track_ids": [candidate_id, available_id]},
            headers={"Authorization": f"Bearer {token}"},
        )
    assert r.status_code == 200
    assert r.json()["deleted"] == 1  # only the candidate

    conn = await asyncpg.connect(os.environ["SUPABASE_DATABASE_URL"])
    still_there = await conn.fetchval("SELECT id FROM tracks WHERE id = $1", available_id)
    gone = await conn.fetchval("SELECT id FROM tracks WHERE id = $1", candidate_id)
    await conn.close()
    assert still_there is not None
    assert gone is None
```

- [ ] **Step 2: Run to verify it fails**

```bash
poetry run pytest tests/test_catalog_routes.py::test_bulk_delete_tracks_candidates_only -v
```

Expected: FAIL with 404

- [ ] **Step 3: Add request model and endpoint to `catalog_routes.py`**

Add these models near the other request models:

```python
class BulkTrackIdsRequest(BaseModel):
    track_ids: list[int]


class BulkDeleteResult(BaseModel):
    deleted: int
```

Add the endpoint (after `reset_track`):

```python
@router.delete("/tracks/bulk", response_model=BulkDeleteResult)
async def bulk_delete_tracks(
    body: BulkTrackIdsRequest,
    user: CurrentUser = Depends(get_current_user),
):
    """Delete candidate tracks the user chose not to download.

    Only deletes tracks with acquisition_status='candidate' owned by the requesting user.
    Available/downloading/failed tracks are silently ignored.
    """
    if not body.track_ids:
        return BulkDeleteResult(deleted=0)

    pool = await get_pool()
    async with rls_transaction(pool, user.user_id) as conn:
        result = await conn.execute(
            """DELETE FROM tracks
               WHERE id = ANY($1::bigint[])
                 AND user_id = $2
                 AND acquisition_status = 'candidate'""",
            body.track_ids, user.user_id,
        )
    # asyncpg returns "DELETE N" as the command tag
    deleted = int(result.split()[-1])
    return BulkDeleteResult(deleted=deleted)
```

- [ ] **Step 4: Run tests**

```bash
poetry run pytest tests/test_catalog_routes.py -v
```

Expected: all PASS or SKIP

- [ ] **Step 5: Commit**

```bash
git add djtoolkit/api/catalog_routes.py tests/test_catalog_routes.py
git commit -m "feat(catalog): add DELETE /catalog/tracks/bulk endpoint"
```

---

## Chunk 2: Frontend infrastructure

### Task 5: Update auth callback to handle `return_to`

The Spotify OAuth flow redirects back through `/auth/callback`. Currently it always goes to `/catalog`. It needs to respect a `return_to` query param set by the onboarding wizard.

**Files:**
- Modify: `web/app/auth/callback/route.ts`

- [ ] **Step 1: Understand current behavior**

Read `web/app/auth/callback/route.ts`. The current code reads `?next=` param and defaults to `/catalog`.

- [ ] **Step 2: Update to use `return_to` with `?spotify=connected` appended**

Replace the entire file:

```typescript
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  // Support both legacy `next` param and new `return_to` param.
  // If return_to=/onboarding, append ?spotify=connected so the wizard
  // knows to auto-expand the Spotify section.
  const returnTo = searchParams.get("return_to");
  const next = searchParams.get("next") ?? "/catalog";

  const destination = returnTo
    ? returnTo === "/onboarding"
      ? "/onboarding?spotify=connected"
      : returnTo
    : next;

  if (code) {
    const cookieStore = await cookies();
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() { return cookieStore.getAll(); },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          },
        },
      }
    );
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(`${origin}${destination}`);
  }
  return NextResponse.redirect(`${origin}/login?error=auth_failed`);
}
```

- [ ] **Step 3: Manual test (no build needed — just verify the change is correct)**

Start the Next.js dev server (`cd web && npm run dev`) and verify `/auth/callback?code=test&return_to=/onboarding` redirects to `/onboarding?spotify=connected`.

- [ ] **Step 4: Commit**

```bash
git add web/app/auth/callback/route.ts
git commit -m "feat(auth): support return_to param in OAuth callback for onboarding"
```

---

### Task 6: Add first-run redirect to app layout

**Files:**
- Modify: `web/app/(app)/layout.tsx`

- [ ] **Step 1: Read the current layout**

Read `web/app/(app)/layout.tsx`. It currently does a Supabase auth check and redirects to `/login` if not authenticated.

- [ ] **Step 2: Add onboarding redirect after the auth check**

```typescript
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import Sidebar from "@/components/sidebar";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // First-run detection: redirect to onboarding if not yet completed.
  // Primary gate: onboarding_completed flag in user_metadata.
  // Fallback for pre-flag users: check track count only if flag is absent.
  const onboardingCompleted = user.user_metadata?.onboarding_completed === true;
  if (!onboardingCompleted) {
    // Avoid the extra API call when flag is explicitly false (new users).
    // Only check track count for users who predate the flag (flag is undefined/null).
    const flagAbsent = user.user_metadata?.onboarding_completed === undefined ||
                       user.user_metadata?.onboarding_completed === null;
    if (!flagAbsent) {
      // Flag is explicitly false — definitely redirect.
      redirect("/onboarding");
    }
    // Flag is absent — check track count as fallback.
    const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
    const { data: { session } } = await supabase.auth.getSession();
    if (session) {
      try {
        const res = await fetch(`${apiUrl}/api/catalog/stats`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
          cache: "no-store",
        });
        if (res.ok) {
          const stats = await res.json();
          if (stats.total === 0) redirect("/onboarding");
        }
      } catch {
        // Network error — don't block the user, show the app.
      }
    }
  }

  return (
    <div className="flex h-screen bg-gray-950">
      <Sidebar userEmail={user.email ?? ""} />
      <main className="flex-1 overflow-y-auto p-6">{children}</main>
    </div>
  );
}
```

- [ ] **Step 3: Verify manually**

Log in as a new user (zero tracks, no onboarding_completed flag). Verify redirect to `/onboarding`. Log in as an existing user (has tracks or flag set). Verify no redirect.

- [ ] **Step 4: Commit**

```bash
git add web/app/\(app\)/layout.tsx
git commit -m "feat(layout): add first-run redirect to /onboarding"
```

---

### Task 7: Add onboarding API functions to `web/lib/api.ts`

**Files:**
- Modify: `web/lib/api.ts`

- [ ] **Step 1: Read the current `api.ts`**

Understand existing patterns (`apiClient`, `apiClientForm`, `getToken`).

- [ ] **Step 2: Add the new functions at the end of the file**

```typescript
// ─── Onboarding API functions ─────────────────────────────────────────────────

export async function importSpotifyPlaylistNoJobs(
  playlistId: string
): Promise<ImportResult> {
  const r = await apiClient(
    `/api/catalog/import/spotify?queue_jobs=false`,
    { method: "POST", body: JSON.stringify({ playlist_id: playlistId }) }
  );
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.detail ?? `Spotify import failed (${r.status})`);
  }
  return r.json();
}

export async function importCsvNoJobs(file: File): Promise<ImportResult> {
  const form = new FormData();
  form.append("file", file);
  const r = await apiClientForm(
    `/api/catalog/import/csv?queue_jobs=false`,
    form
  );
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.detail ?? `CSV import failed (${r.status})`);
  }
  return r.json();
}

export async function bulkCreateJobs(trackIds: number[]): Promise<{ created: number }> {
  const r = await apiClient("/api/pipeline/jobs/bulk", {
    method: "POST",
    body: JSON.stringify({ track_ids: trackIds }),
  });
  if (!r.ok) throw new Error(`Failed to queue jobs (${r.status})`);
  return r.json();
}

export async function bulkDeleteTracks(trackIds: number[]): Promise<{ deleted: number }> {
  const r = await apiClient("/api/catalog/tracks/bulk", {
    method: "DELETE",
    body: JSON.stringify({ track_ids: trackIds }),
  });
  if (!r.ok) throw new Error(`Failed to delete tracks (${r.status})`);
  return r.json();
}

export async function fetchCandidateTracks(): Promise<Track[]> {
  const r = await apiClient("/api/catalog/tracks?status=candidate&per_page=1000");
  if (!r.ok) throw new Error(`Failed to fetch candidates (${r.status})`);
  const data = await r.json();
  return data.tracks as Track[];
}
```

> **Note:** `ImportResult` and `Track` types are defined earlier in `api.ts`. `Track` will need `already_owned?: boolean` added to its type definition to match the new backend field.

- [ ] **Step 3: Add `already_owned` to the `Track` type**

Find the `Track` type in `api.ts` and add:
```typescript
already_owned?: boolean;
```

- [ ] **Step 4: Commit**

```bash
git add web/lib/api.ts
git commit -m "feat(api): add onboarding API functions to web/lib/api.ts"
```

---

## Chunk 3: Onboarding wizard — layout and step 1

### Task 8: Create onboarding standalone layout

**Files:**
- Create: `web/app/onboarding/layout.tsx`

- [ ] **Step 1: Create the layout**

```typescript
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export default async function OnboardingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      {children}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add web/app/onboarding/layout.tsx
git commit -m "feat(onboarding): add standalone layout"
```

---

### Task 9: Create the onboarding page with step bar and step 1

This is the main wizard component. It manages step state and renders the correct step.

**Files:**
- Create: `web/app/onboarding/page.tsx`

The component is large. Build it in sub-steps.

- [ ] **Step 1: Scaffold the step state machine and step bar**

Create `web/app/onboarding/page.tsx`:

```typescript
"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import {
  fetchSpotifyPlaylists,
  importSpotifyPlaylistNoJobs,
  importCsvNoJobs,
  fetchCandidateTracks,
  bulkCreateJobs,
  bulkDeleteTracks,
  fetchAgents,
  fetchPipelineStatus,
  registerAgent,
  type Track,
} from "@/lib/api";
import { createClient } from "@/lib/supabase/client";

type Step = 1 | 2 | 3;

const STEP_LABELS = ["Import", "Review", "Download Agent"] as const;

function StepBar({ current }: { current: Step }) {
  return (
    <div className="flex border-b border-gray-800">
      {STEP_LABELS.map((label, i) => {
        const stepNum = (i + 1) as Step;
        const isDone = stepNum < current;
        const isActive = stepNum === current;
        return (
          <div
            key={label}
            className={`flex-1 py-3.5 text-center text-xs font-semibold tracking-widest uppercase border-b-2 transition-colors ${
              isActive
                ? "text-indigo-400 border-indigo-500"
                : isDone
                ? "text-green-400 border-transparent"
                : "text-gray-600 border-transparent"
            }`}
          >
            {isDone ? `✓ ${label}` : `${stepNum} · ${label}`}
          </div>
        );
      })}
    </div>
  );
}

export default function OnboardingPage() {
  const [step, setStep] = useState<Step>(1);
  const [candidates, setCandidates] = useState<Track[]>([]);
  const [apiKey, setApiKey] = useState<string>("");
  const [machineName] = useState("My Mac");
  const router = useRouter();
  const searchParams = useSearchParams();

  return (
    <div className="flex flex-col min-h-screen">
      <StepBar current={step} />
      <div className="flex-1 overflow-y-auto">
        {step === 1 && (
          <Step1Import
            searchParams={searchParams}
            onComplete={(tracks) => {
              setCandidates(tracks);
              setStep(2);
            }}
          />
        )}
        {step === 2 && (
          <Step2Review
            candidates={candidates}
            onBack={() => setStep(1)}
            onComplete={() => setStep(3)}
          />
        )}
        {step === 3 && (
          <Step3Agent
            apiKey={apiKey}
            setApiKey={setApiKey}
            machineName={machineName}
            onDone={() => router.push("/pipeline")}
          />
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Implement `Step1Import` component**

Add below `OnboardingPage` in the same file:

```typescript
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
const SESSION_KEY = "djtoolkit_onboarding_state";

interface Step1Props {
  searchParams: ReturnType<typeof useSearchParams>;
  onComplete: (tracks: Track[]) => void;
}

function Step1Import({ searchParams, onComplete }: Step1Props) {
  const [playlists, setPlaylists] = useState<
    { id: string; name: string; track_count: number }[]
  >([]);
  const [spotifyConnected, setSpotifyConnected] = useState(false);
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<string | null>(null);
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [csvRowCount, setCsvRowCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [dragging, setDragging] = useState(false);

  // Load Spotify playlists (also determines if connected)
  const loadPlaylists = useCallback(async () => {
    try {
      const data = await fetchSpotifyPlaylists();
      setPlaylists(data);
      setSpotifyConnected(true);
    } catch {
      setSpotifyConnected(false);
    }
  }, []);

  useEffect(() => {
    loadPlaylists();
    // If returning from Spotify OAuth, restore saved state from sessionStorage
    if (searchParams.get("spotify") === "connected") {
      const saved = sessionStorage.getItem(SESSION_KEY);
      if (saved) {
        try {
          const { csvName } = JSON.parse(saved);
          if (csvName) {
            // File is lost after redirect — inform user
            toast("CSV file was cleared during Spotify auth. Please re-upload.");
          }
        } catch { /* ignore */ }
        sessionStorage.removeItem(SESSION_KEY);
      }
    }
  }, [loadPlaylists, searchParams]);

  // Client-side CSV row count
  function handleCsvFile(file: File) {
    setCsvFile(file);
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      const lines = text.split("\n").filter((l) => l.trim()).length;
      setCsvRowCount(Math.max(0, lines - 1)); // subtract header row
    };
    reader.readAsText(file);
  }

  const selectedPlaylist = playlists.find((p) => p.id === selectedPlaylistId);
  const totalTracks = (selectedPlaylist?.track_count ?? 0) + csvRowCount;
  const sourcesSelected = (selectedPlaylistId ? 1 : 0) + (csvFile ? 1 : 0);

  async function handleContinue() {
    if (!selectedPlaylistId && !csvFile) return;
    setLoading(true);
    try {
      const calls: Promise<unknown>[] = [];
      if (selectedPlaylistId) calls.push(importSpotifyPlaylistNoJobs(selectedPlaylistId));
      if (csvFile) calls.push(importCsvNoJobs(csvFile));
      await Promise.all(calls);
      const tracks = await fetchCandidateTracks();
      onComplete(tracks);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Import failed");
    } finally {
      setLoading(false);
    }
  }

  function handleSpotifyConnect() {
    // Save any CSV filename to sessionStorage before redirecting
    if (csvFile) {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({ csvName: csvFile.name }));
    }
    window.location.href = `${API_URL}/api/auth/spotify/connect?return_to=/onboarding`;
  }

  return (
    <div className="max-w-lg mx-auto px-6 py-10">
      <h1 className="text-xl font-bold text-white mb-1">Where's your music coming from?</h1>
      <p className="text-sm text-gray-500 mb-7">
        You can import from multiple sources — all tracks will be combined in step 2.
      </p>

      {/* Spotify card */}
      <div
        className={`border rounded-xl p-4 mb-3 ${
          spotifyConnected ? "border-indigo-500 bg-indigo-950/40" : "border-gray-700 bg-gray-900"
        }`}
      >
        <div className="flex items-center gap-3 mb-3">
          <span className="text-2xl">🎵</span>
          <div className="flex-1">
            <div className="text-sm font-bold text-white">Spotify</div>
            {spotifyConnected ? (
              <div className="text-xs text-indigo-400">Connected</div>
            ) : (
              <div className="text-xs text-gray-500">Connect your Spotify account</div>
            )}
          </div>
          {spotifyConnected ? (
            <span className="text-xs bg-green-900 text-green-300 px-2 py-0.5 rounded font-semibold">
              ✓ Connected
            </span>
          ) : (
            <button
              onClick={handleSpotifyConnect}
              className="text-xs border border-indigo-500 text-indigo-400 px-3 py-1.5 rounded-lg hover:bg-indigo-900/30"
            >
              Connect Spotify
            </button>
          )}
        </div>
        {spotifyConnected && playlists.length > 0 && (
          <div className="bg-gray-950 border border-indigo-900 rounded-lg overflow-hidden">
            <div className="px-3 py-2 text-xs text-gray-500 uppercase tracking-wider border-b border-gray-800">
              Select playlist
            </div>
            {playlists.map((p) => (
              <button
                key={p.id}
                onClick={() => setSelectedPlaylistId(p.id === selectedPlaylistId ? null : p.id)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 text-left border-b border-gray-800 last:border-0 transition-colors ${
                  selectedPlaylistId === p.id ? "bg-indigo-950/60" : "hover:bg-gray-900"
                }`}
              >
                <div
                  className={`w-3 h-3 rounded-full border-2 flex-shrink-0 ${
                    selectedPlaylistId === p.id
                      ? "bg-indigo-500 border-indigo-500"
                      : "border-gray-600"
                  }`}
                />
                <span className="flex-1 text-sm text-white">{p.name}</span>
                <span className="text-xs text-gray-500">{p.track_count} tracks</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* CSV card */}
      <div className="border border-gray-700 rounded-xl p-4 mb-3 bg-gray-900">
        <div className="flex items-center gap-3">
          <span className="text-2xl">📄</span>
          <div className="flex-1">
            <div className="text-sm font-bold text-white">Exported Spotify Playlist (CSV)</div>
            <div className="text-xs text-gray-500">Upload a CSV exported from exportify.app</div>
          </div>
          <button
            onClick={() => document.getElementById("csv-upload")?.click()}
            className="text-xs border border-gray-600 text-gray-300 px-3 py-1.5 rounded-lg hover:bg-gray-800"
          >
            {csvFile ? "Change" : "Upload file"}
          </button>
          <input
            id="csv-upload"
            type="file"
            accept=".csv"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleCsvFile(f);
            }}
          />
        </div>
        {csvFile && (
          <div className="mt-3 text-xs text-green-400">✓ {csvFile.name} ({csvRowCount} tracks)</div>
        )}
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const f = e.dataTransfer.files[0];
            if (f) handleCsvFile(f);
          }}
          className={`mt-3 border-2 border-dashed rounded-lg p-4 text-center text-xs transition-colors ${
            dragging ? "border-indigo-500 bg-indigo-900/20 text-indigo-300" : "border-gray-700 text-gray-600"
          }`}
        >
          Or drag & drop CSV here
        </div>
      </div>

      {/* TrackID — coming soon */}
      <div className="border border-gray-800 rounded-xl p-4 mb-8 bg-gray-950 opacity-40">
        <div className="flex items-center gap-3">
          <span className="text-2xl">🎧</span>
          <div className="flex-1">
            <div className="text-sm font-bold text-gray-400">TrackID</div>
            <div className="text-xs text-gray-600">
              Identify tracks from a YouTube, SoundCloud, or Mixcloud set
            </div>
          </div>
          <span className="text-xs bg-gray-800 text-gray-600 px-2 py-0.5 rounded">
            Coming soon
          </span>
        </div>
      </div>

      {/* CTA */}
      <div className="flex items-center justify-between">
        <span className="text-sm text-gray-500">
          {sourcesSelected > 0
            ? `${sourcesSelected} source${sourcesSelected > 1 ? "s" : ""} selected · ${totalTracks} tracks`
            : "Select at least one source"}
        </span>
        <button
          onClick={handleContinue}
          disabled={totalTracks === 0 || loading}
          className="bg-indigo-600 text-white text-sm font-semibold px-6 py-2.5 rounded-lg hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {loading ? "Importing…" : "Review tracks →"}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Verify step 1 renders**

Run `cd web && npm run dev`. Navigate to `/onboarding`. Verify step 1 renders correctly: Spotify card, CSV upload, TrackID grayed, step bar shows "1 · Import" active.

- [ ] **Step 4: Commit**

```bash
git add web/app/onboarding/page.tsx
git commit -m "feat(onboarding): add step bar + step 1 import UI"
```

---

## Chunk 4: Onboarding wizard — steps 2 and 3

### Task 10: Implement Step 2 (Review candidates)

Add `Step2Review` component to `web/app/onboarding/page.tsx`.

**Files:**
- Modify: `web/app/onboarding/page.tsx`

- [ ] **Step 1: Add the Step2Review component**

```typescript
interface Step2Props {
  candidates: Track[];
  onBack: () => void;
  onComplete: () => void;
}

function Step2Review({ candidates, onBack, onComplete }: Step2Props) {
  const [search, setSearch] = useState("");
  // Track selection state: true = selected (will download), false = deselected
  const [selected, setSelected] = useState<Record<number, boolean>>(() => {
    const initial: Record<number, boolean> = {};
    for (const t of candidates) {
      initial[t.id] = !t.already_owned; // pre-deselect already-owned
    }
    return initial;
  });
  const [loading, setLoading] = useState(false);

  const alreadyOwnedIds = new Set(candidates.filter((t) => t.already_owned).map((t) => t.id));

  const filtered = candidates.filter((t) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      (t.title ?? "").toLowerCase().includes(q) ||
      (t.artist ?? "").toLowerCase().includes(q)
    );
  });

  const selectedCount = Object.values(selected).filter(Boolean).length;
  const ownedCount = candidates.filter((t) => t.already_owned).length;
  const allSelected = filtered.every((t) => selected[t.id]);

  function toggleAll() {
    const newVal = !allSelected;
    setSelected((prev) => {
      const next = { ...prev };
      for (const t of filtered) next[t.id] = newVal;
      return next;
    });
  }

  async function handleConfirm() {
    const toDownload = candidates.filter((t) => selected[t.id]).map((t) => t.id);
    const toDelete = candidates
      .filter((t) => !selected[t.id] && !alreadyOwnedIds.has(t.id))
      .map((t) => t.id);

    if (toDownload.length === 0) return;
    setLoading(true);
    try {
      await Promise.all([
        bulkCreateJobs(toDownload),
        toDelete.length > 0 ? bulkDeleteTracks(toDelete) : Promise.resolve(),
      ]);
      onComplete();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to queue downloads");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="max-w-2xl mx-auto px-6 py-8">
      <h1 className="text-xl font-bold text-white mb-1">Confirm your download list</h1>
      <p className="text-sm text-gray-500 mb-5">
        Deselect any tracks you don't want. Already-owned tracks are excluded automatically.
      </p>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3 mb-5">
        {[
          { label: "To download", value: selectedCount },
          { label: "Already owned", value: ownedCount },
          { label: "Total imported", value: candidates.length },
        ].map(({ label, value }) => (
          <div key={label} className="bg-gray-900 border border-gray-800 rounded-lg p-3 text-center">
            <div className="text-2xl font-bold text-white">{value}</div>
            <div className="text-xs text-gray-500 mt-0.5">{label}</div>
          </div>
        ))}
      </div>

      {/* Search */}
      <input
        type="text"
        placeholder="Search by title or artist…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 mb-2 focus:outline-none focus:border-indigo-500"
      />

      {/* Select all */}
      <div className="flex items-center gap-2.5 px-3 py-2 bg-gray-800 rounded-t-lg border-b border-gray-900">
        <input
          type="checkbox"
          checked={allSelected}
          onChange={toggleAll}
          className="w-3.5 h-3.5 accent-indigo-500"
        />
        <span className="text-xs text-gray-300 font-semibold flex-1">Select all</span>
        <span className="text-xs text-gray-500">{selectedCount} selected</span>
      </div>

      {/* Track list */}
      <div
        className="border border-gray-800 border-t-0 rounded-b-lg overflow-y-auto"
        style={{ maxHeight: "calc(100vh - 420px)" }}
      >
        {filtered.map((t) => {
          const isOwned = alreadyOwnedIds.has(t.id);
          const isSelected = selected[t.id];
          return (
            <div
              key={t.id}
              onClick={() => setSelected((p) => ({ ...p, [t.id]: !p[t.id] }))}
              className={`flex items-center gap-3 px-3 py-2.5 border-b border-gray-900 last:border-0 cursor-pointer transition-colors ${
                isSelected ? "bg-gray-900 hover:bg-gray-800/60" : "bg-gray-950 opacity-50"
              }`}
            >
              <input
                type="checkbox"
                checked={isSelected}
                onChange={() => {}}
                className="w-3.5 h-3.5 accent-indigo-500 flex-shrink-0"
                onClick={(e) => e.stopPropagation()}
              />
              <div className="flex-1 min-w-0">
                <span
                  className={`text-sm ${isSelected ? "text-white" : "text-gray-500 line-through"}`}
                >
                  {t.title}
                </span>
              </div>
              <div className="w-40 text-xs text-gray-500 truncate">{t.artist}</div>
              {isOwned && (
                <span className="text-xs bg-gray-800 text-gray-500 px-1.5 py-0.5 rounded flex-shrink-0">
                  Already owned
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* CTA */}
      <div className="flex items-center justify-between mt-5">
        <button onClick={onBack} className="text-sm text-gray-500 hover:text-gray-300">
          ← Back
        </button>
        <button
          onClick={handleConfirm}
          disabled={selectedCount === 0 || loading}
          className="bg-indigo-600 text-white text-sm font-semibold px-6 py-2.5 rounded-lg hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {loading ? "Queuing…" : `Queue ${selectedCount} download${selectedCount !== 1 ? "s" : ""} →`}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify step 2 renders correctly**

Complete step 1 in the browser. Verify step 2 shows: stats bar, search, track list with checkboxes, already-owned tracks grayed.

- [ ] **Step 3: Commit**

```bash
git add web/app/onboarding/page.tsx
git commit -m "feat(onboarding): add step 2 candidate review UI"
```

---

### Task 11: Implement Step 3 (Download Agent)

**Files:**
- Modify: `web/app/onboarding/page.tsx`

- [ ] **Step 1: Add the Step3Agent component**

```typescript
// CopyBlock is defined at module scope so it doesn't remount on every render
function CopyBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="bg-gray-950 border border-gray-800 rounded-lg px-4 py-2.5 flex items-center justify-between gap-3 mb-2">
      <code className="text-green-300 text-xs font-mono break-all">{text}</code>
      <button
        onClick={() => {
          navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }}
        className="text-xs text-gray-500 hover:text-white flex-shrink-0"
      >
        {copied ? "Copied!" : "Copy"}
      </button>
    </div>
  );
}

interface Step3Props {
  apiKey: string;
  setApiKey: (key: string) => void;
  machineName: string;
  onDone: () => void;
}

function Step3Agent({ apiKey, setApiKey, machineName, onDone }: Step3Props) {
  const [agentConnected, setAgentConnected] = useState(false);
  const [agentName, setAgentName] = useState("");
  const [pendingJobs, setPendingJobs] = useState<number | null>(null);
  const [pollErrors, setPollErrors] = useState(0);
  const [registering, setRegistering] = useState(false);
  const supabase = createClient();

  // Generate API key on mount (only once — apiKey is stored in parent state)
  useEffect(() => {
    if (apiKey) return; // already generated this session
    setRegistering(true);
    registerAgent(machineName)
      .then((result) => setApiKey(result.api_key))
      .catch(() => toast.error("Failed to generate API key. Please try again."))
      .finally(() => setRegistering(false));
  }, [apiKey, machineName, setApiKey]);

  // Poll for agent connection every 5 seconds
  useEffect(() => {
    if (agentConnected) return;
    const interval = setInterval(async () => {
      try {
        const agents = await fetchAgents();
        const now = Date.now();
        const live = agents.find(
          (a) =>
            a.last_seen_at &&
            now - new Date(a.last_seen_at).getTime() < 60_000
        );
        if (live) {
          setAgentConnected(true);
          setAgentName(live.machine_name ?? "your Mac");
          setPollErrors(0);
          // Fetch job count once on connection
          fetchPipelineStatus()
            .then((s) => setPendingJobs(s.pending))
            .catch(() => {});
        } else {
          setPollErrors((e) => 0); // reset on successful (empty) response
        }
      } catch {
        setPollErrors((e) => e + 1);
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [agentConnected]);

  async function handleDone() {
    await supabase.auth.updateUser({
      data: { onboarding_completed: true },
    });
    onDone();
  }

  // Determine status indicator state
  const statusState =
    agentConnected ? "connected" : pollErrors >= 3 ? "error" : "waiting";

  return (
    <div className="max-w-lg mx-auto px-6 py-10">
      <h1 className="text-xl font-bold text-white mb-1">Install the djtoolkit agent</h1>
      <p className="text-sm text-gray-500 mb-6">
        The agent runs on your Mac and handles downloading, fingerprinting, and tagging
        — your files never leave your machine.
      </p>

      {/* Download DMG */}
      <div className="border border-indigo-500 bg-indigo-950/30 rounded-xl p-4 mb-4 flex items-center gap-3">
        <span className="text-2xl">💿</span>
        <div className="flex-1">
          <div className="text-sm font-bold text-white">Download for macOS</div>
          <div className="text-xs text-indigo-300">arm64 + x86_64 · Includes all dependencies</div>
        </div>
        <a
          href="https://github.com/YOUR_ORG/djtoolkit/releases/latest/download/djtoolkit-macos.dmg"
          className="bg-indigo-600 text-white text-xs font-semibold px-4 py-2 rounded-lg hover:bg-indigo-500"
          download
        >
          Download .dmg
        </a>
      </div>

      {/* pip alternative */}
      <div className="mb-5">
        <div className="text-xs text-gray-500 uppercase tracking-wider mb-2">Or install via pip</div>
        <CopyBlock text="pip install djtoolkit" />
      </div>

      {/* Configure + start */}
      <div className="mb-6">
        <div className="text-xs text-gray-500 uppercase tracking-wider mb-2">
          Configure &amp; start
        </div>
        {registering || !apiKey ? (
          <div className="text-xs text-gray-500 py-2">Generating API key…</div>
        ) : (
          <>
            <CopyBlock text={`djtoolkit agent configure --api-key ${apiKey}`} />
            <CopyBlock text="djtoolkit agent start" />
          </>
        )}
      </div>

      {/* Status indicator */}
      <div
        className={`border rounded-lg px-4 py-3 flex items-center gap-3 mb-5 ${
          statusState === "connected"
            ? "border-green-700 bg-green-950/30"
            : statusState === "error"
            ? "border-yellow-700 bg-yellow-950/20"
            : "border-gray-700 bg-gray-900"
        }`}
      >
        <div
          className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${
            statusState === "connected"
              ? "bg-green-500 shadow-[0_0_8px_2px_rgba(34,197,94,0.5)]"
              : statusState === "error"
              ? "bg-yellow-400 shadow-[0_0_8px_2px_rgba(250,204,21,0.4)]"
              : "bg-red-500 shadow-[0_0_8px_2px_rgba(239,68,68,0.4)]"
          }`}
        />
        <div>
          {statusState === "connected" ? (
            <>
              <div className="text-sm font-semibold text-green-300">
                Agent connected — {agentName}
              </div>
              <div className="text-xs text-green-700">
                {pendingJobs !== null ? `${pendingJobs} download jobs queued and ready` : ""}
              </div>
            </>
          ) : statusState === "error" ? (
            <div className="text-sm text-yellow-300">Connection check failed — retrying…</div>
          ) : (
            <>
              <div className="text-sm text-gray-300">Agent not connected</div>
              <div className="text-xs text-gray-600">Checking every 5s…</div>
            </>
          )}
        </div>
      </div>

      {/* CTAs */}
      <div className="flex flex-col items-end gap-2">
        <button
          onClick={handleDone}
          disabled={!agentConnected}
          className={`text-sm font-bold px-6 py-2.5 rounded-lg transition-colors ${
            agentConnected
              ? "bg-green-600 text-white hover:bg-green-500"
              : "bg-gray-800 text-gray-600 cursor-not-allowed"
          }`}
        >
          {agentConnected ? "Go to Pipeline →" : "Done →"}
        </button>
        <button
          onClick={() => window.location.href = "/catalog"}
          className="text-xs text-gray-600 hover:text-gray-400"
        >
          Skip for now
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Fix the `TODO` GitHub URL**

Replace `YOUR_ORG` in the `.dmg` download link with the actual GitHub org name once the repo is public.

- [ ] **Step 3: Verify step 3 in the browser**

Complete steps 1 and 2. Verify step 3 shows:
- Download .dmg button
- pip install command (copyable)
- API key command (copyable, key is shown)
- Red dot "Agent not connected"
- "Done →" button is disabled

Then start the local agent (`djtoolkit agent start`) and verify the dot turns green and "Go to Pipeline →" becomes active.

- [ ] **Step 4: Commit**

```bash
git add web/app/onboarding/page.tsx
git commit -m "feat(onboarding): add step 3 agent download + connection polling UI"
```

---

## Chunk 5: Integration smoke test

### Task 12: End-to-end manual verification

- [ ] **Step 1: Start backend and frontend**

```bash
# Terminal 1
make ui   # or: poetry run uvicorn djtoolkit.api.app:app --reload

# Terminal 2
cd web && npm run dev
```

- [ ] **Step 2: Create a test user and verify the full flow**

1. Register a new user via `/login`
2. Verify redirect to `/onboarding`
3. Connect Spotify (or upload a small CSV)
4. Select a playlist / confirm file
5. Click "Review tracks →" — verify loading state, then step 2 loads with candidate list
6. Deselect 2 tracks, verify "Already owned" tracks are grayed
7. Click "Queue N downloads →" — verify step 3 loads
8. Verify API key is shown in the configure command
9. Start `djtoolkit agent start` locally — verify green dot appears within 10s
10. Click "Go to Pipeline →" — verify redirect to `/pipeline`
11. Reload the app — verify no redirect to `/onboarding` (flag is set)

- [ ] **Step 3: Verify existing user is not redirected**

Log in as a user who already has tracks. Verify `/catalog` loads directly.

- [ ] **Step 4: Run full backend test suite**

```bash
poetry run pytest tests/ -v
```

Expected: all existing tests pass.

- [ ] **Step 5: Final commit (if any cleanup needed)**

```bash
git add -p
git commit -m "chore(onboarding): cleanup after smoke test"
```
