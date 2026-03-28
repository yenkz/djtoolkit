# Local Folder Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users browse their agent's local filesystem from the web UI and import existing audio files into the catalogue with full enrichment pipeline.

**Architecture:** New `agent_commands` table for interactive request/response (browse). New `folder_import` pipeline job scans a folder, inserts tracks, and kicks off per-track chains (fingerprint → spotify_lookup → cover_art → audio_analysis → metadata). Duplicate fingerprints pause as `pending_review` for user decision. Files are renamed in place to `Artist - Title (Version).ext`.

**Tech Stack:** Python 3.12, Supabase (PostgreSQL + Realtime), Next.js 14 (App Router), TypeScript, Tailwind CSS, mutagen, asyncio.

**Spec:** `docs/superpowers/specs/2026-03-28-local-folder-import-design.md`

---

## Parallelization Strategy

Three independent workstreams that can execute concurrently:

| Stream | Tasks | Touches |
|--------|-------|---------|
| **A — SQL + Web API** | Tasks 1–4, 8–12 | `supabase/migrations/`, `web/app/api/`, `web/lib/api.ts` |
| **B — Python Agent** | Tasks 5–7, 13–14 | `djtoolkit/agent/`, `djtoolkit/importers/` |
| **C — Metadata Writer** | Task 15 | `djtoolkit/metadata/writer.py`, `tests/` |

Stream C has zero file overlap with A and B. Streams A and B touch different directories entirely. After all three complete, **Stream D (Web UI, Tasks 16–19)** depends on Stream A's API routes being in place.

---

## File Map

### New files
| File | Responsibility |
|------|---------------|
| `supabase/migrations/20260329000000_agent_commands.sql` | agent_commands table, RLS, indexes, Realtime |
| `supabase/migrations/20260329100000_pending_review_status.sql` | Add `pending_review` to acquisition_status, update chain trigger |
| `djtoolkit/agent/commands/__init__.py` | Package init |
| `djtoolkit/agent/commands/browse_folder.py` | browse_folder command handler |
| `djtoolkit/agent/jobs/folder_import.py` | folder_import job handler |
| `web/app/api/agents/commands/route.ts` | GET (agent polls) + POST (UI creates) commands |
| `web/app/api/agents/commands/[id]/route.ts` | GET (UI polls result) + PUT (agent reports) |
| `web/app/api/catalog/import/folder/route.ts` | POST — creates folder_import pipeline_job |
| `web/app/api/catalog/import/folder/review/route.ts` | POST — processes duplicate review decisions |
| `web/app/api/catalog/import/folder/[jobId]/report/route.ts` | GET — metadata completeness report |
| `web/components/folder-import/FolderBrowser.tsx` | Folder browser modal |
| `web/components/folder-import/DuplicateReview.tsx` | Duplicate review cards |
| `web/components/folder-import/FolderImportReport.tsx` | Missing metadata report |
| `tests/test_version_extraction.py` | Unit tests for _extract_version |
| `tests/test_browse_folder.py` | Unit tests for browse_folder command |
| `tests/test_folder_import_job.py` | Unit tests for folder_import job |

### Modified files
| File | Lines | Change |
|------|-------|--------|
| `djtoolkit/agent/daemon.py` | 322–400, 525–529 | Command subscription + poll loop |
| `djtoolkit/agent/client.py` | After line 156 | poll_commands, report_command_result |
| `djtoolkit/agent/executor.py` | Line 149 | folder_import dispatch case |
| `djtoolkit/metadata/writer.py` | Lines 33–37 | `_extract_version()` + updated `_target_filename()` |
| `web/lib/api.ts` | After line 416 | API functions for commands/import/review |
| `web/app/(app)/import/page.tsx` | ~line 1142 | Local Folder source card |

---

## Stream A — SQL + Web API

### Task 1: Migration — `agent_commands` table

**Files:**
- Create: `supabase/migrations/20260329000000_agent_commands.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Agent commands: interactive request/response between web UI and agent.
-- Separate from pipeline_jobs (which are long-running queued work).

CREATE TABLE public.agent_commands (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    agent_id      UUID NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
    command_type  TEXT NOT NULL,
    payload       JSONB NOT NULL DEFAULT '{}',
    result        JSONB,
    status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'running', 'completed', 'failed')),
    error         TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at  TIMESTAMPTZ
);

-- Agent poll: find pending commands for this agent
CREATE INDEX idx_agent_commands_agent_pending
    ON public.agent_commands (agent_id, status)
    WHERE status = 'pending';

-- User lookup: list commands for a user (most recent first)
CREATE INDEX idx_agent_commands_user_created
    ON public.agent_commands (user_id, created_at DESC);

-- ── RLS ──────────────────────────────────────────────────────────────────────
ALTER TABLE public.agent_commands ENABLE ROW LEVEL SECURITY;

-- Users can manage their own commands
CREATE POLICY agent_commands_user_all ON public.agent_commands
    FOR ALL TO authenticated
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

-- Agent machine users can read/update commands targeted at them
-- (agent machine user's uid maps to agent owner via agents table)
CREATE POLICY agent_commands_agent_access ON public.agent_commands
    FOR ALL TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.agents a
            WHERE a.id = agent_commands.agent_id
              AND a.supabase_uid = auth.uid()
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.agents a
            WHERE a.id = agent_commands.agent_id
              AND a.supabase_uid = auth.uid()
        )
    );

-- Service role bypass
CREATE POLICY agent_commands_service ON public.agent_commands
    FOR ALL TO service_role
    USING (true)
    WITH CHECK (true);

-- ── Realtime ─────────────────────────────────────────────────────────────────
ALTER PUBLICATION supabase_realtime ADD TABLE public.agent_commands;
```

- [ ] **Step 2: Apply migration**

Run: `supabase db push` or use Supabase MCP `apply_migration` tool.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260329000000_agent_commands.sql
git commit -m "feat(db): add agent_commands table for interactive agent requests"
```

---

### Task 2: Migration — `pending_review` status + chain trigger update

**Files:**
- Create: `supabase/migrations/20260329100000_pending_review_status.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Add 'pending_review' acquisition_status for folder-imported duplicates.
-- Update chain trigger: folder-source duplicates pause for user review
-- instead of being auto-marked as 'duplicate'.

-- ── 1. Update CHECK constraint ───────────────────────────────────────────────
ALTER TABLE public.tracks
    DROP CONSTRAINT IF EXISTS tracks_acquisition_status_check;

ALTER TABLE public.tracks
    ADD CONSTRAINT tracks_acquisition_status_check
    CHECK (acquisition_status IN (
        'candidate', 'downloading', 'available',
        'failed', 'duplicate', 'pending_review'
    ));

-- ── 2. Update chain_pipeline_job trigger ─────────────────────────────────────
-- Only the FINGERPRINT branch changes: folder-source duplicates get
-- 'pending_review' instead of 'duplicate', pausing the pipeline for user review.
CREATE OR REPLACE FUNCTION public.chain_pipeline_job()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_track        RECORD;
    v_result       JSONB;
    v_payload      JSONB;
    v_settings     JSONB;
    v_fp_enabled   BOOLEAN;
    v_ca_enabled   BOOLEAN;
    v_aa_enabled   BOOLEAN;
    v_ca_sources   JSONB;
    _active_count  INTEGER;
    _done_count    INTEGER;
    _failed_count  INTEGER;
BEGIN
    IF NEW.status NOT IN ('done', 'failed') THEN
        RETURN NEW;
    END IF;

    SELECT * INTO v_track FROM public.tracks WHERE id = NEW.track_id;
    IF NOT FOUND THEN RETURN NEW; END IF;

    v_result := COALESCE(NEW.result, '{}'::JSONB);

    SELECT us.settings INTO v_settings
    FROM public.user_settings us
    WHERE us.user_id = NEW.user_id;

    v_fp_enabled := COALESCE((v_settings -> 'fingerprint_enabled')::BOOLEAN, TRUE);
    v_ca_enabled := COALESCE((v_settings -> 'coverart_enabled')::BOOLEAN,    TRUE);
    v_aa_enabled := COALESCE((v_settings -> 'analysis_enabled')::BOOLEAN,    FALSE);

    IF v_settings IS NOT NULL AND v_settings -> 'coverart_sources' IS NOT NULL
       AND v_settings -> 'coverart_sources' != 'null'::JSONB THEN
        v_ca_sources := jsonb_build_object('coverart_sources', v_settings -> 'coverart_sources');
    END IF;

    -- ── SUCCESS ──────────────────────────────────────────────────────────────
    IF NEW.status = 'done' THEN

        CASE NEW.job_type

        -- ── DOWNLOAD ─────────────────────────────────────────────────────────
        WHEN 'download' THEN
            UPDATE public.tracks SET
                acquisition_status = 'available',
                local_path = COALESCE(v_result ->> 'local_path', local_path)
            WHERE id = NEW.track_id AND user_id = NEW.user_id;
            SELECT * INTO v_track FROM public.tracks WHERE id = NEW.track_id;

            IF v_fp_enabled THEN
                PERFORM public._insert_next_job(
                    NEW.user_id, NEW.track_id, 'fingerprint',
                    jsonb_build_object('local_path', v_track.local_path)
                );
            ELSIF v_track.source != 'exportify' THEN
                PERFORM public._insert_next_job(
                    NEW.user_id, NEW.track_id, 'spotify_lookup',
                    jsonb_build_object(
                        'artist',      COALESCE(v_track.artist, ''),
                        'title',       COALESCE(v_track.title, ''),
                        'duration_ms', COALESCE(v_track.duration_ms, 0)
                    )
                );
            ELSE
                v_payload := public._build_metadata_payload(NEW.track_id);
                IF v_payload IS NOT NULL THEN
                    PERFORM public._insert_next_job(NEW.user_id, NEW.track_id, 'metadata', v_payload);
                END IF;
            END IF;

        -- ── FINGERPRINT ──────────────────────────────────────────────────────
        WHEN 'fingerprint' THEN
            INSERT INTO public.fingerprints (chromaprint, acoustid, duration_sec, track_id)
            VALUES (
                v_result ->> 'fingerprint',
                v_result ->> 'acoustid',
                (v_result ->> 'duration')::REAL,
                NEW.track_id
            )
            ON CONFLICT (track_id) DO UPDATE SET
                chromaprint  = EXCLUDED.chromaprint,
                acoustid     = EXCLUDED.acoustid,
                duration_sec = EXCLUDED.duration_sec;

            -- ▶ CHANGED: folder-source duplicates pause for user review
            IF (v_result ->> 'is_duplicate')::BOOLEAN IS TRUE THEN
                IF v_track.source = 'folder' THEN
                    UPDATE public.tracks SET
                        acquisition_status = 'pending_review',
                        fingerprinted      = TRUE
                    WHERE id = NEW.track_id AND user_id = NEW.user_id;
                ELSE
                    UPDATE public.tracks SET
                        acquisition_status = 'duplicate',
                        fingerprinted      = TRUE
                    WHERE id = NEW.track_id AND user_id = NEW.user_id;
                END IF;
                RETURN NEW;  -- Pipeline stops — user review or auto-duplicate
            END IF;

            UPDATE public.tracks SET fingerprinted = TRUE
            WHERE id = NEW.track_id AND user_id = NEW.user_id;

            IF v_track.source = 'exportify' THEN
                IF v_ca_enabled THEN
                    v_payload := jsonb_build_object(
                        'local_path',  v_track.local_path,
                        'artist',      COALESCE(v_track.artist, ''),
                        'album',       COALESCE(v_track.album, ''),
                        'title',       COALESCE(v_track.title, ''),
                        'spotify_uri', COALESCE(v_track.spotify_uri, '')
                    );
                    IF v_ca_sources IS NOT NULL THEN
                        v_payload := v_payload || jsonb_build_object('settings', v_ca_sources);
                    END IF;
                    PERFORM public._insert_next_job(NEW.user_id, NEW.track_id, 'cover_art', v_payload);
                ELSE
                    v_payload := public._build_metadata_payload(NEW.track_id);
                    IF v_payload IS NOT NULL THEN
                        PERFORM public._insert_next_job(NEW.user_id, NEW.track_id, 'metadata', v_payload);
                    END IF;
                END IF;
            ELSE
                PERFORM public._insert_next_job(
                    NEW.user_id, NEW.track_id, 'spotify_lookup',
                    jsonb_build_object(
                        'artist',      COALESCE(v_track.artist, ''),
                        'title',       COALESCE(v_track.title, ''),
                        'duration_ms', COALESCE(v_track.duration_ms, 0),
                        'spotify_uri', COALESCE(v_track.spotify_uri, '')
                    )
                );
            END IF;

        -- ── SPOTIFY LOOKUP ───────────────────────────────────────────────────
        WHEN 'spotify_lookup' THEN
            IF (v_result ->> 'matched')::BOOLEAN IS NOT FALSE THEN
                UPDATE public.tracks SET
                    enriched_spotify = TRUE,
                    album        = COALESCE(v_result ->> 'album',        album),
                    release_date = COALESCE(v_result ->> 'release_date', release_date),
                    year         = COALESCE((v_result ->> 'year')::INT,  year),
                    genres       = COALESCE(v_result ->> 'genres',       genres),
                    record_label = COALESCE(v_result ->> 'record_label', record_label),
                    popularity   = COALESCE((v_result ->> 'popularity')::INT, popularity),
                    explicit     = COALESCE((v_result ->> 'explicit')::BOOLEAN, explicit),
                    isrc         = COALESCE(v_result ->> 'isrc',         isrc),
                    duration_ms  = COALESCE((v_result ->> 'duration_ms')::INT, duration_ms),
                    spotify_uri  = COALESCE(v_result ->> 'spotify_uri',  spotify_uri)
                WHERE id = NEW.track_id AND user_id = NEW.user_id;
            ELSE
                UPDATE public.tracks SET enriched_spotify = TRUE
                WHERE id = NEW.track_id AND user_id = NEW.user_id;
            END IF;

            SELECT * INTO v_track FROM public.tracks WHERE id = NEW.track_id;

            IF v_ca_enabled THEN
                v_payload := jsonb_build_object(
                    'local_path',  v_track.local_path,
                    'artist',      COALESCE(v_track.artist, ''),
                    'album',       COALESCE(v_track.album, ''),
                    'title',       COALESCE(v_track.title, ''),
                    'spotify_uri', COALESCE(v_track.spotify_uri, '')
                );
                IF v_ca_sources IS NOT NULL THEN
                    v_payload := v_payload || jsonb_build_object('settings', v_ca_sources);
                END IF;
                PERFORM public._insert_next_job(NEW.user_id, NEW.track_id, 'cover_art', v_payload);
            ELSIF v_aa_enabled THEN
                PERFORM public._insert_next_job(
                    NEW.user_id, NEW.track_id, 'audio_analysis',
                    jsonb_build_object('local_path', v_track.local_path, 'track_id', NEW.track_id)
                );
            ELSE
                v_payload := public._build_metadata_payload(NEW.track_id);
                IF v_payload IS NOT NULL THEN
                    PERFORM public._insert_next_job(NEW.user_id, NEW.track_id, 'metadata', v_payload);
                END IF;
            END IF;

        -- ── COVER ART ────────────────────────────────────────────────────────
        WHEN 'cover_art' THEN
            UPDATE public.tracks SET
                cover_art_written    = TRUE,
                cover_art_embedded_at = NOW(),
                spotify_uri = COALESCE(v_result ->> 'spotify_uri', spotify_uri)
            WHERE id = NEW.track_id AND user_id = NEW.user_id;

            SELECT * INTO v_track FROM public.tracks WHERE id = NEW.track_id;

            IF v_track.source != 'exportify' AND v_aa_enabled THEN
                PERFORM public._insert_next_job(
                    NEW.user_id, NEW.track_id, 'audio_analysis',
                    jsonb_build_object('local_path', v_track.local_path, 'track_id', NEW.track_id)
                );
            ELSE
                v_payload := public._build_metadata_payload(NEW.track_id);
                IF v_payload IS NOT NULL THEN
                    PERFORM public._insert_next_job(NEW.user_id, NEW.track_id, 'metadata', v_payload);
                END IF;
            END IF;

        -- ── AUDIO ANALYSIS ───────────────────────────────────────────────────
        WHEN 'audio_analysis' THEN
            UPDATE public.tracks SET
                enriched_audio = TRUE,
                tempo        = COALESCE((v_result ->> 'tempo')::REAL,        tempo),
                key          = COALESCE((v_result ->> 'key')::INT,           key),
                mode         = COALESCE((v_result ->> 'mode')::INT,          mode),
                danceability = COALESCE((v_result ->> 'danceability')::REAL,  danceability),
                energy       = COALESCE((v_result ->> 'energy')::REAL,       energy),
                loudness     = COALESCE((v_result ->> 'loudness')::REAL,     loudness)
            WHERE id = NEW.track_id AND user_id = NEW.user_id;

            v_payload := public._build_metadata_payload(NEW.track_id);
            IF v_payload IS NOT NULL THEN
                PERFORM public._insert_next_job(NEW.user_id, NEW.track_id, 'metadata', v_payload);
            END IF;

        -- ── METADATA ─────────────────────────────────────────────────────────
        WHEN 'metadata' THEN
            UPDATE public.tracks SET
                metadata_written = TRUE,
                metadata_source  = v_result ->> 'metadata_source',
                local_path       = COALESCE(v_result ->> 'local_path', local_path)
            WHERE id = NEW.track_id AND user_id = NEW.user_id;

        -- ── FOLDER IMPORT (no track-level update needed) ─────────────────────
        WHEN 'folder_import' THEN
            NULL;  -- folder_import creates its own fingerprint jobs directly

        ELSE
            NULL;

        END CASE;

    END IF;

    -- ── FAILED ───────────────────────────────────────────────────────────────
    IF NEW.status = 'failed' THEN
        CASE NEW.job_type
        WHEN 'download' THEN
            IF COALESCE(NEW.retry_count, 0) >= 3 THEN
                UPDATE public.tracks SET acquisition_status = 'failed'
                WHERE id = NEW.track_id AND user_id = NEW.user_id;
            END IF;
        WHEN 'audio_analysis' THEN
            v_payload := public._build_metadata_payload(NEW.track_id);
            IF v_payload IS NOT NULL THEN
                PERFORM public._insert_next_job(NEW.user_id, NEW.track_id, 'metadata', v_payload);
            END IF;
        ELSE
            NULL;
        END CASE;
    END IF;

    -- ── BATCH COMPLETE ───────────────────────────────────────────────────────
    IF NEW.job_type = 'metadata' OR NEW.status = 'failed' THEN
        SELECT count(*) INTO _active_count
        FROM public.pipeline_jobs
        WHERE user_id = NEW.user_id
          AND status IN ('pending', 'claimed', 'running');

        IF _active_count = 0 THEN
            SELECT
                count(*) FILTER (WHERE status = 'done'),
                count(*) FILTER (WHERE status = 'failed')
            INTO _done_count, _failed_count
            FROM public.pipeline_jobs
            WHERE user_id = NEW.user_id
              AND completed_at > NOW() - INTERVAL '24 hours';

            INSERT INTO public.push_notifications (user_id, type, title, body, url, data)
            VALUES (
                NEW.user_id,
                'batch_complete',
                'Pipeline complete',
                _done_count || ' tracks processed (' ||
                    _done_count || ' succeeded, ' || _failed_count || ' failed)',
                '/pipeline',
                jsonb_build_object('done', _done_count, 'failed', _failed_count)
            );
        END IF;
    END IF;

    RETURN NEW;
END;
$$;
```

- [ ] **Step 2: Apply migration**

Run: `supabase db push` or use Supabase MCP `apply_migration` tool.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260329100000_pending_review_status.sql
git commit -m "feat(db): add pending_review status, update chain trigger for folder duplicates"
```

---

### Task 3: Web API — Agent commands CRUD

**Files:**
- Create: `web/app/api/agents/commands/route.ts`
- Create: `web/app/api/agents/commands/[id]/route.ts`

- [ ] **Step 1: Create the commands list/create route**

```typescript
// web/app/api/agents/commands/route.ts
import { NextRequest, NextResponse } from "next/server";
import {
  getAuthUser,
  isAuthError,
} from "@/lib/api-server/auth";
import { createServiceClient } from "@/lib/supabase/service";
import { jsonError } from "@/lib/api-server/errors";

// GET — agent polls for pending commands (auth: API key)
export async function GET(request: NextRequest) {
  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  if (!user.agentId) {
    return jsonError("Requires agent API key", 403);
  }

  const limit = Math.min(
    Number(request.nextUrl.searchParams.get("limit") ?? 5),
    20,
  );

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("agent_commands")
    .select("*")
    .eq("agent_id", user.agentId)
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) return jsonError(error.message, 500);
  return NextResponse.json(data);
}

// POST — web UI creates a command (auth: JWT)
export async function POST(request: NextRequest) {
  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  let body: { agent_id?: string; command_type?: string; payload?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  const { agent_id, command_type, payload } = body;
  if (!agent_id || typeof agent_id !== "string") {
    return jsonError("agent_id is required", 400);
  }
  if (!command_type || typeof command_type !== "string") {
    return jsonError("command_type is required", 400);
  }

  const validCommands = ["browse_folder"];
  if (!validCommands.includes(command_type)) {
    return jsonError(`Invalid command_type: ${command_type}`, 400);
  }

  // Verify agent belongs to user
  const supabase = createServiceClient();
  const { data: agent } = await supabase
    .from("agents")
    .select("id")
    .eq("id", agent_id)
    .eq("user_id", user.userId)
    .single();

  if (!agent) {
    return jsonError("Agent not found", 404);
  }

  const { data, error } = await supabase
    .from("agent_commands")
    .insert({
      user_id: user.userId,
      agent_id,
      command_type,
      payload: payload ?? {},
    })
    .select("id, status")
    .single();

  if (error) return jsonError(error.message, 500);
  return NextResponse.json(data, { status: 201 });
}
```

- [ ] **Step 2: Create the single-command route**

```typescript
// web/app/api/agents/commands/[id]/route.ts
import { NextRequest, NextResponse } from "next/server";
import {
  getAuthUser,
  isAuthError,
} from "@/lib/api-server/auth";
import { createServiceClient } from "@/lib/supabase/service";
import { jsonError } from "@/lib/api-server/errors";

type Params = { params: Promise<{ id: string }> };

// GET — web UI polls for command result (auth: JWT)
export async function GET(request: NextRequest, { params }: Params) {
  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  const { id } = await params;
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("agent_commands")
    .select("*")
    .eq("id", id)
    .eq("user_id", user.userId)
    .single();

  if (error || !data) return jsonError("Command not found", 404);
  return NextResponse.json(data);
}

// PUT — agent reports status/result (auth: API key)
export async function PUT(request: NextRequest, { params }: Params) {
  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  const { id } = await params;
  let body: { status?: string; result?: unknown; error?: string };
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  const updates: Record<string, unknown> = {};
  if (body.status) {
    const valid = ["running", "completed", "failed"];
    if (!valid.includes(body.status)) {
      return jsonError(`Invalid status: ${body.status}`, 400);
    }
    updates.status = body.status;
    if (body.status === "completed" || body.status === "failed") {
      updates.completed_at = new Date().toISOString();
    }
  }
  if (body.result !== undefined) updates.result = body.result;
  if (body.error !== undefined) updates.error = body.error;

  const supabase = createServiceClient();
  const { error } = await supabase
    .from("agent_commands")
    .update(updates)
    .eq("id", id);

  if (error) return jsonError(error.message, 500);
  return new NextResponse(null, { status: 204 });
}
```

- [ ] **Step 3: Commit**

```bash
git add web/app/api/agents/commands/route.ts web/app/api/agents/commands/\[id\]/route.ts
git commit -m "feat(api): add agent commands CRUD endpoints"
```

---

### Task 4: Web API — Folder import trigger

**Files:**
- Create: `web/app/api/catalog/import/folder/route.ts`

- [ ] **Step 1: Write the route**

```typescript
// web/app/api/catalog/import/folder/route.ts
import { NextRequest, NextResponse } from "next/server";
import {
  getAuthUser,
  isAuthError,
} from "@/lib/api-server/auth";
import { createServiceClient } from "@/lib/supabase/service";
import { jsonError } from "@/lib/api-server/errors";

// POST — create a folder_import pipeline job
export async function POST(request: NextRequest) {
  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  let body: { path?: string; recursive?: boolean; agent_id?: string };
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  const { path, agent_id } = body;
  if (!path || typeof path !== "string" || path.trim().length === 0) {
    return jsonError("path is required", 400);
  }
  if (!agent_id || typeof agent_id !== "string") {
    return jsonError("agent_id is required", 400);
  }

  // Verify agent belongs to user
  const supabase = createServiceClient();
  const { data: agent } = await supabase
    .from("agents")
    .select("id")
    .eq("id", agent_id)
    .eq("user_id", user.userId)
    .single();

  if (!agent) {
    return jsonError("Agent not found", 404);
  }

  const { data, error } = await supabase
    .from("pipeline_jobs")
    .insert({
      user_id: user.userId,
      track_id: null,
      job_type: "folder_import",
      payload: {
        path: path.trim(),
        recursive: body.recursive !== false,
        user_id: user.userId,
        agent_id,
      },
    })
    .select("id, status")
    .single();

  if (error) return jsonError(error.message, 500);
  return NextResponse.json(data, { status: 201 });
}
```

- [ ] **Step 2: Commit**

```bash
git add web/app/api/catalog/import/folder/route.ts
git commit -m "feat(api): add folder import trigger endpoint"
```

---

### Task 5: Web API — Duplicate review endpoint

**Files:**
- Create: `web/app/api/catalog/import/folder/review/route.ts`

- [ ] **Step 1: Write the route**

```typescript
// web/app/api/catalog/import/folder/review/route.ts
import { NextRequest, NextResponse } from "next/server";
import {
  getAuthUser,
  isAuthError,
} from "@/lib/api-server/auth";
import { createServiceClient } from "@/lib/supabase/service";
import { jsonError } from "@/lib/api-server/errors";

interface Decision {
  track_id: number;
  action: "keep" | "skip" | "replace";
  duplicate_track_id?: number;
}

// POST — process user decisions for pending_review tracks
export async function POST(request: NextRequest) {
  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  let body: { decisions?: Decision[] };
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  const { decisions } = body;
  if (!Array.isArray(decisions) || decisions.length === 0) {
    return jsonError("decisions array is required", 400);
  }

  const supabase = createServiceClient();
  const results = { kept: 0, skipped: 0, replaced: 0, errors: 0 };

  for (const { track_id, action, duplicate_track_id } of decisions) {
    if (!["keep", "skip", "replace"].includes(action)) {
      results.errors++;
      continue;
    }

    // Verify track belongs to user and is pending_review
    const { data: track } = await supabase
      .from("tracks")
      .select("id, artist, title, duration_ms, spotify_uri, source")
      .eq("id", track_id)
      .eq("user_id", user.userId)
      .eq("acquisition_status", "pending_review")
      .single();

    if (!track) {
      results.errors++;
      continue;
    }

    if (action === "skip") {
      await supabase
        .from("tracks")
        .update({ acquisition_status: "duplicate" })
        .eq("id", track_id);
      results.skipped++;
    } else if (action === "keep" || action === "replace") {
      if (action === "replace" && duplicate_track_id) {
        // Delete the old track's DB record (file on disk left untouched)
        await supabase
          .from("tracks")
          .delete()
          .eq("id", duplicate_track_id)
          .eq("user_id", user.userId);
      }

      // Resume pipeline: set available + create spotify_lookup job
      await supabase
        .from("tracks")
        .update({ acquisition_status: "available" })
        .eq("id", track_id);

      await supabase
        .from("pipeline_jobs")
        .insert({
          user_id: user.userId,
          track_id,
          job_type: "spotify_lookup",
          payload: {
            artist: track.artist ?? "",
            title: track.title ?? "",
            duration_ms: track.duration_ms ?? 0,
            spotify_uri: track.spotify_uri ?? "",
          },
        });

      if (action === "keep") results.kept++;
      else results.replaced++;
    }
  }

  return NextResponse.json(results);
}
```

- [ ] **Step 2: Commit**

```bash
git add web/app/api/catalog/import/folder/review/route.ts
git commit -m "feat(api): add duplicate review endpoint with keep/skip/replace actions"
```

---

### Task 6: Web API — Metadata report endpoint

**Files:**
- Create: `web/app/api/catalog/import/folder/[jobId]/report/route.ts`

- [ ] **Step 1: Write the route**

```typescript
// web/app/api/catalog/import/folder/[jobId]/report/route.ts
import { NextRequest, NextResponse } from "next/server";
import {
  getAuthUser,
  isAuthError,
} from "@/lib/api-server/auth";
import { createServiceClient } from "@/lib/supabase/service";
import { jsonError } from "@/lib/api-server/errors";

type Params = { params: Promise<{ jobId: string }> };

const TRACKED_FIELDS = [
  "artist",
  "title",
  "album",
  "tempo",
  "key",
  "genres",
  "cover_art_written",
] as const;

// GET — metadata completeness report for a folder import batch
export async function GET(request: NextRequest, { params }: Params) {
  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  const { jobId } = await params;
  const supabase = createServiceClient();

  // Get the folder_import job result to find track_ids
  const { data: job } = await supabase
    .from("pipeline_jobs")
    .select("result")
    .eq("id", jobId)
    .eq("user_id", user.userId)
    .eq("job_type", "folder_import")
    .single();

  if (!job?.result) {
    return jsonError("Job not found or not yet complete", 404);
  }

  const trackIds: number[] = (job.result as { track_ids?: number[] }).track_ids ?? [];
  if (trackIds.length === 0) {
    return NextResponse.json({ total: 0, fully_enriched: 0, missing: {}, tracks: [] });
  }

  const { data: tracks } = await supabase
    .from("tracks")
    .select(
      "id, title, artist, album, tempo, key, genres, cover_art_written, local_path, acquisition_status",
    )
    .in("id", trackIds)
    .eq("user_id", user.userId);

  if (!tracks) {
    return NextResponse.json({ total: 0, fully_enriched: 0, missing: {}, tracks: [] });
  }

  const missing: Record<string, number> = {};
  let fullyEnriched = 0;

  const trackDetails = tracks.map((t) => {
    const missingFields: string[] = [];
    for (const field of TRACKED_FIELDS) {
      const val = t[field];
      if (val === null || val === undefined || val === "" || val === false) {
        missingFields.push(field);
        missing[field] = (missing[field] ?? 0) + 1;
      }
    }
    if (missingFields.length === 0) fullyEnriched++;
    return {
      id: t.id,
      title: t.title,
      artist: t.artist,
      local_path: t.local_path,
      acquisition_status: t.acquisition_status,
      missing_fields: missingFields,
    };
  });

  return NextResponse.json({
    total: tracks.length,
    fully_enriched: fullyEnriched,
    missing,
    tracks: trackDetails,
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add web/app/api/catalog/import/folder/\[jobId\]/report/route.ts
git commit -m "feat(api): add folder import metadata completeness report"
```

---

### Task 7: Frontend API client functions

**Files:**
- Modify: `web/lib/api.ts` (after line 416, after existing agent functions)

- [ ] **Step 1: Add the API functions**

Add after the existing `deleteAgent` function (around line 416):

```typescript
// ── Agent Commands ───────────────────────────────────────────────────────────

export interface AgentCommand {
  id: string;
  command_type: string;
  status: string;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  created_at: string;
  completed_at: string | null;
}

export async function sendAgentCommand(
  agentId: string,
  commandType: string,
  payload: Record<string, unknown>,
): Promise<{ id: string }> {
  const res = await apiClient("/agents/commands", {
    method: "POST",
    body: JSON.stringify({ agent_id: agentId, command_type: commandType, payload }),
  });
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

export async function getAgentCommandResult(
  commandId: string,
): Promise<AgentCommand> {
  const res = await apiClient(`/agents/commands/${commandId}`);
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

// ── Folder Import ────────────────────────────────────────────────────────────

export async function importFolder(
  agentId: string,
  path: string,
  recursive = true,
): Promise<{ id: string }> {
  const res = await apiClient("/catalog/import/folder", {
    method: "POST",
    body: JSON.stringify({ agent_id: agentId, path, recursive }),
  });
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

export interface ReviewDecision {
  track_id: number;
  action: "keep" | "skip" | "replace";
  duplicate_track_id?: number;
}

export async function reviewDuplicates(
  decisions: ReviewDecision[],
): Promise<{ kept: number; skipped: number; replaced: number; errors: number }> {
  const res = await apiClient("/catalog/import/folder/review", {
    method: "POST",
    body: JSON.stringify({ decisions }),
  });
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

export interface FolderImportReport {
  total: number;
  fully_enriched: number;
  missing: Record<string, number>;
  tracks: Array<{
    id: number;
    title: string;
    artist: string;
    local_path: string;
    acquisition_status: string;
    missing_fields: string[];
  }>;
}

export async function getFolderImportReport(
  jobId: string,
): Promise<FolderImportReport> {
  const res = await apiClient(`/catalog/import/folder/${jobId}/report`);
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}
```

- [ ] **Step 2: Commit**

```bash
git add web/lib/api.ts
git commit -m "feat(api): add frontend client functions for folder import"
```

---

## Stream B — Python Agent

### Task 8: `browse_folder` command handler

**Files:**
- Create: `djtoolkit/agent/commands/__init__.py`
- Create: `djtoolkit/agent/commands/browse_folder.py`
- Create: `tests/test_browse_folder.py`

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_browse_folder.py
"""Tests for browse_folder agent command."""

import pytest
from pathlib import Path


@pytest.fixture
def audio_folder(tmp_path: Path) -> Path:
    """Create a temp folder with audio files and subdirectories."""
    sub = tmp_path / "Techno"
    sub.mkdir()
    (tmp_path / "track1.mp3").write_bytes(b"\x00" * 1024)
    (tmp_path / "track2.flac").write_bytes(b"\x00" * 2048)
    (tmp_path / "readme.txt").write_bytes(b"not audio")
    (tmp_path / ".hidden.mp3").write_bytes(b"\x00" * 512)
    (sub / "deep.wav").write_bytes(b"\x00" * 4096)
    return tmp_path


def test_browse_lists_audio_and_dirs(audio_folder: Path):
    from djtoolkit.agent.commands.browse_folder import browse_folder

    result = browse_folder({"path": str(audio_folder)})

    assert result["path"] == str(audio_folder)
    assert result["parent"] == str(audio_folder.parent)

    names = [e["name"] for e in result["entries"]]
    # Dirs first, then audio files. No hidden files, no .txt
    assert "Techno" in names
    assert "track1.mp3" in names
    assert "track2.flac" in names
    assert "readme.txt" not in names
    assert ".hidden.mp3" not in names

    # Dirs listed before files
    types = [e["type"] for e in result["entries"]]
    dir_idx = types.index("dir")
    file_indices = [i for i, t in enumerate(types) if t == "file"]
    assert all(dir_idx < fi for fi in file_indices)


def test_browse_empty_dir(tmp_path: Path):
    from djtoolkit.agent.commands.browse_folder import browse_folder

    result = browse_folder({"path": str(tmp_path)})
    assert result["entries"] == []


def test_browse_default_path():
    from djtoolkit.agent.commands.browse_folder import browse_folder

    result = browse_folder({})
    assert result["path"] == str(Path.home())


def test_browse_nonexistent_path():
    from djtoolkit.agent.commands.browse_folder import browse_folder

    with pytest.raises(ValueError, match="Not a directory"):
        browse_folder({"path": "/nonexistent/path/xyz"})


def test_browse_file_entry_has_size(audio_folder: Path):
    from djtoolkit.agent.commands.browse_folder import browse_folder

    result = browse_folder({"path": str(audio_folder)})
    file_entries = [e for e in result["entries"] if e["type"] == "file"]
    for entry in file_entries:
        assert isinstance(entry["size_bytes"], int)
        assert entry["size_bytes"] > 0
        assert entry["extension"] in {".mp3", ".flac"}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `poetry run pytest tests/test_browse_folder.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'djtoolkit.agent.commands'`

- [ ] **Step 3: Write the implementation**

```python
# djtoolkit/agent/commands/__init__.py
```

```python
# djtoolkit/agent/commands/browse_folder.py
"""Agent command: browse a local directory and return its contents."""

from __future__ import annotations

from pathlib import Path

from djtoolkit.importers.folder import AUDIO_EXTENSIONS


def browse_folder(payload: dict) -> dict:
    """List directory contents filtered to audio files and subdirectories.

    Args:
        payload: {"path": "/some/dir"} or {} for home directory.

    Returns:
        {"path": str, "parent": str|None, "entries": [{name, type, size_bytes, extension}]}
    """
    raw_path = payload.get("path")
    path = Path(raw_path).expanduser().resolve() if raw_path else Path.home()

    if not path.is_dir():
        raise ValueError(f"Not a directory: {path}")

    entries: list[dict] = []
    try:
        for item in sorted(path.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower())):
            if item.name.startswith("."):
                continue

            if item.is_dir():
                entries.append({
                    "name": item.name,
                    "type": "dir",
                    "size_bytes": None,
                    "extension": None,
                })
            elif item.is_file() and item.suffix.lower() in AUDIO_EXTENSIONS:
                entries.append({
                    "name": item.name,
                    "type": "file",
                    "size_bytes": item.stat().st_size,
                    "extension": item.suffix.lower(),
                })
    except PermissionError:
        raise ValueError(f"Permission denied: {path}")

    return {
        "path": str(path),
        "entries": entries,
        "parent": str(path.parent) if path != path.parent else None,
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `poetry run pytest tests/test_browse_folder.py -v`
Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add djtoolkit/agent/commands/__init__.py djtoolkit/agent/commands/browse_folder.py tests/test_browse_folder.py
git commit -m "feat(agent): add browse_folder command handler"
```

---

### Task 9: Agent client — command methods

**Files:**
- Modify: `djtoolkit/agent/client.py` (after line 156)

- [ ] **Step 1: Add the command methods**

Add after the `batch_claim_downloads` method (after line 156):

```python
    # ── Agent commands ────────────────────────────────────────────────────

    async def poll_commands(self, limit: int = 5) -> list[dict]:
        """Fetch pending agent commands."""
        try:
            resp = await self._request(
                "GET", "/agents/commands", params={"limit": str(limit)},
            )
            if resp.status_code == 200:
                self._consecutive_errors = 0
                return resp.json()
            return []
        except Exception:
            return []

    async def report_command_result(
        self, cmd_id: str, *,
        result: dict | None = None,
        error: str | None = None,
    ) -> bool:
        """Report command completion or failure."""
        body: dict = {
            "status": "completed" if error is None else "failed",
        }
        if result is not None:
            body["result"] = result
        if error is not None:
            body["error"] = error
        try:
            resp = await self._request(
                "PUT", f"/agents/commands/{cmd_id}", json=body,
            )
            return resp.status_code == 204
        except Exception:
            return False

    async def claim_command(self, cmd_id: str) -> bool:
        """Mark a command as running."""
        try:
            resp = await self._request(
                "PUT", f"/agents/commands/{cmd_id}",
                json={"status": "running"},
            )
            return resp.status_code == 204
        except Exception:
            return False
```

- [ ] **Step 2: Commit**

```bash
git add djtoolkit/agent/client.py
git commit -m "feat(agent): add command polling and reporting to AgentClient"
```

---

### Task 10: Agent daemon — command subscription + poll loop

**Files:**
- Modify: `djtoolkit/agent/daemon.py` (lines 318-320, 322-400, 525-529)

- [ ] **Step 1: Add command_wake event**

After `realtime_wake = asyncio.Event()` (line 319), add:

```python
    command_wake = asyncio.Event()
```

- [ ] **Step 2: Add command Realtime channel in `_realtime_loop()`**

Inside `_realtime_loop()`, after the existing channel subscription (after line 367, before `await channel.subscribe()`), add a second channel:

```python
                # Agent commands channel — instant wake for interactive requests
                def _on_command_event(payload: Any) -> None:
                    log.debug("Realtime: new agent_command event")
                    command_wake.set()

                cmd_channel = sb_client.channel("agent-commands")
                cmd_channel.on_postgres_changes(
                    RealtimePostgresChangesListenEvent.Insert,
                    _on_command_event,
                    table="agent_commands",
                    schema="public",
                    filter="status=eq.pending",
                )
                await cmd_channel.subscribe()
```

- [ ] **Step 3: Add `_command_poll_loop()` function**

Add after `_realtime_loop()` (after line 400):

```python
    async def _command_poll_loop() -> None:
        """Poll for agent commands (browse_folder, etc.) and execute inline."""
        from djtoolkit.agent.commands.browse_folder import browse_folder

        while not shutdown_event.is_set():
            try:
                commands = await client.poll_commands(limit=5)
                for cmd in commands:
                    cmd_id = cmd["id"]
                    cmd_type = cmd.get("command_type", "")
                    payload = cmd.get("payload") or {}

                    await client.claim_command(cmd_id)

                    try:
                        match cmd_type:
                            case "browse_folder":
                                result = browse_folder(payload)
                            case _:
                                raise ValueError(f"Unknown command: {cmd_type}")

                        await client.report_command_result(cmd_id, result=result)
                        log.info("Command %s completed: %s", cmd_type, cmd_id[:8])

                    except Exception as exc:
                        log.warning("Command %s failed: %s", cmd_id[:8], exc)
                        await client.report_command_result(cmd_id, error=str(exc))

            except Exception as exc:
                log.debug("Command poll error: %s", exc)

            # Wait for Realtime wake or poll interval
            try:
                await asyncio.wait_for(
                    asyncio.ensure_future(command_wake.wait()),
                    timeout=30.0 if not realtime_connected else 120.0,
                )
                command_wake.clear()
            except asyncio.TimeoutError:
                pass

            if shutdown_event.is_set():
                break
```

- [ ] **Step 4: Add the loop to the TaskGroup**

At line 529 (after `tg.create_task(_realtime_loop())`), add:

```python
        tg.create_task(_command_poll_loop())
```

- [ ] **Step 5: Commit**

```bash
git add djtoolkit/agent/daemon.py
git commit -m "feat(agent): add command subscription and poll loop to daemon"
```

---

### Task 11: `folder_import` job handler

**Files:**
- Create: `djtoolkit/agent/jobs/folder_import.py`
- Create: `tests/test_folder_import_job.py`

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_folder_import_job.py
"""Tests for folder_import agent job."""

import pytest
from pathlib import Path
from unittest.mock import MagicMock, patch, call


@pytest.fixture
def audio_folder(tmp_path: Path) -> Path:
    """Create temp folder with tagged audio files."""
    (tmp_path / "song1.mp3").write_bytes(b"\x00" * 1024)
    (tmp_path / "song2.flac").write_bytes(b"\x00" * 2048)
    (tmp_path / "notes.txt").write_bytes(b"not audio")
    return tmp_path


@pytest.fixture
def mock_supabase():
    """Mock Supabase client with chained method calls."""
    sb = MagicMock()
    # auth mock
    sb.auth.sign_in_with_password.return_value = MagicMock()
    sb.auth.sign_out.return_value = None
    # table mock: tracks.select().eq().eq().execute() returns empty (no existing)
    select_chain = MagicMock()
    select_chain.eq.return_value = select_chain
    select_chain.execute.return_value = MagicMock(data=[])
    # table mock: tracks.insert().select().single().execute() returns new track
    insert_chain = MagicMock()
    insert_chain.select.return_value = insert_chain
    insert_chain.single.return_value = insert_chain
    insert_chain.execute.return_value = MagicMock(data={"id": 42})
    # pipeline_jobs insert
    pj_insert = MagicMock()
    pj_insert.execute.return_value = MagicMock(data={"id": "job-1"})

    def table_router(name):
        mock = MagicMock()
        if name == "tracks":
            mock.select.return_value = select_chain
            mock.insert.return_value = insert_chain
        elif name == "pipeline_jobs":
            mock.insert.return_value = pj_insert
        return mock

    sb.table.side_effect = table_router
    return sb


@pytest.mark.asyncio
async def test_folder_import_scans_audio_files(audio_folder, mock_supabase):
    from djtoolkit.agent.jobs.folder_import import run
    from djtoolkit.config import Config

    cfg = Config()

    with patch("djtoolkit.agent.jobs.folder_import.create_client", return_value=mock_supabase):
        result = await run(cfg, {
            "path": str(audio_folder),
            "user_id": "test-user-id",
            "recursive": True,
        }, {
            "supabase_url": "https://test.supabase.co",
            "supabase_anon_key": "test-key",
            "agent_email": "agent@test.com",
            "agent_password": "pass",
        })

    # Should find 2 audio files, skip .txt
    assert result["inserted"] == 2
    assert result["path"] == str(audio_folder)
    assert len(result["track_ids"]) == 2


@pytest.mark.asyncio
async def test_folder_import_empty_folder(tmp_path, mock_supabase):
    from djtoolkit.agent.jobs.folder_import import run
    from djtoolkit.config import Config

    cfg = Config()

    with patch("djtoolkit.agent.jobs.folder_import.create_client", return_value=mock_supabase):
        result = await run(cfg, {
            "path": str(tmp_path),
            "user_id": "test-user-id",
        }, {
            "supabase_url": "https://test.supabase.co",
            "supabase_anon_key": "test-key",
            "agent_email": "agent@test.com",
            "agent_password": "pass",
        })

    assert result["inserted"] == 0
    assert result["track_ids"] == []
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `poetry run pytest tests/test_folder_import_job.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'djtoolkit.agent.jobs.folder_import'`

- [ ] **Step 3: Write the implementation**

```python
# djtoolkit/agent/jobs/folder_import.py
"""Agent job: import tracks from a local folder into the catalogue."""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path

from djtoolkit.config import Config
from djtoolkit.importers.folder import AUDIO_EXTENSIONS, _read_tags
from djtoolkit.utils.search_string import build as build_search_string

log = logging.getLogger(__name__)


async def run(cfg: Config, payload: dict, credentials: dict) -> dict:
    """Scan a folder for audio files, insert tracks, and queue fingerprint jobs.

    Returns: {inserted, skipped_existing, track_ids, path}
    """
    folder = Path(payload["path"]).expanduser().resolve()
    recursive = payload.get("recursive", True)
    user_id = payload.get("user_id")

    if not user_id:
        raise ValueError("user_id required in folder_import payload")
    if not folder.is_dir():
        raise FileNotFoundError(f"Folder not found: {folder}")

    # Scan for audio files
    pattern = folder.rglob("*") if recursive else folder.iterdir()
    audio_files = [
        p for p in pattern
        if p.is_file() and p.suffix.lower() in AUDIO_EXTENSIONS
    ]

    if not audio_files:
        return {"inserted": 0, "skipped_existing": 0, "track_ids": [], "path": str(folder)}

    log.info("Found %d audio files in %s", len(audio_files), folder)

    # Connect to Supabase
    from supabase import create_client

    sb = create_client(credentials["supabase_url"], credentials["supabase_anon_key"])
    sb.auth.sign_in_with_password({
        "email": credentials["agent_email"],
        "password": credentials["agent_password"],
    })

    loop = asyncio.get_running_loop()
    stats = {"inserted": 0, "skipped_existing": 0}
    track_ids: list[int] = []

    for audio_path in audio_files:
        source_id = str(audio_path)

        # Check if already imported
        existing = sb.table("tracks").select("id").eq(
            "source_id", source_id,
        ).eq("user_id", user_id).execute()

        if existing.data:
            stats["skipped_existing"] += 1
            continue

        # Read tags (CPU-bound)
        tags = await loop.run_in_executor(None, _read_tags, audio_path)
        artist = tags.get("artist") or audio_path.parent.name
        title = tags.get("title") or audio_path.stem

        row = {
            "user_id": user_id,
            "title": title,
            "artist": artist,
            "artists": artist,
            "album": tags.get("album") or "",
            "year": tags.get("year"),
            "genres": tags.get("genres") or "",
            "local_path": str(audio_path),
            "source": "folder",
            "source_id": source_id,
            "acquisition_status": "available",
            "search_string": build_search_string(artist, title),
        }

        result = sb.table("tracks").insert(row).select("id").single().execute()
        if not result.data:
            continue

        track_id = result.data["id"]
        track_ids.append(track_id)
        stats["inserted"] += 1

        # Create fingerprint pipeline job
        sb.table("pipeline_jobs").insert({
            "user_id": user_id,
            "track_id": track_id,
            "job_type": "fingerprint",
            "payload": {
                "track_id": track_id,
                "local_path": str(audio_path),
            },
        }).execute()

        log.info("Imported: %s - %s (%s)", artist, title, audio_path.name)

    sb.auth.sign_out()

    return {
        "inserted": stats["inserted"],
        "skipped_existing": stats["skipped_existing"],
        "track_ids": track_ids,
        "path": str(folder),
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `poetry run pytest tests/test_folder_import_job.py -v`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add djtoolkit/agent/jobs/folder_import.py tests/test_folder_import_job.py
git commit -m "feat(agent): add folder_import job handler"
```

---

### Task 12: Executor dispatch — add `folder_import`

**Files:**
- Modify: `djtoolkit/agent/executor.py` (line 149)

- [ ] **Step 1: Add the dispatch case and executor function**

Before `case _:` at line 149, add:

```python
        case "folder_import":
            return await execute_folder_import(payload, cfg, credentials)
```

Then add the executor function after the existing `execute_metadata` function (before the end of file):

```python
async def execute_folder_import(
    payload: dict, cfg: Config, credentials: dict,
) -> dict[str, Any]:
    """Scan a folder, insert tracks, queue fingerprint jobs."""
    from djtoolkit.agent.jobs.folder_import import run
    return await run(cfg, payload, credentials)
```

- [ ] **Step 2: Commit**

```bash
git add djtoolkit/agent/executor.py
git commit -m "feat(agent): add folder_import to executor dispatch"
```

---

## Stream C — Metadata Writer

### Task 13: Version extraction + updated `_target_filename()`

**Files:**
- Modify: `djtoolkit/metadata/writer.py` (lines 26–37)
- Create: `tests/test_version_extraction.py`

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_version_extraction.py
"""Tests for version extraction and filename normalization."""

import pytest


@pytest.fixture(autouse=True)
def _import():
    """Pre-import to make test collection faster."""
    global _extract_version, _target_filename
    from djtoolkit.metadata.writer import _extract_version, _target_filename


def test_parenthetical_remix():
    from djtoolkit.metadata.writer import _extract_version
    base, version = _extract_version("Midnight City (Eric Prydz Remix)")
    assert base == "Midnight City"
    assert version == "Eric Prydz Remix"


def test_parenthetical_radio_edit():
    from djtoolkit.metadata.writer import _extract_version
    base, version = _extract_version("Latch (Radio Edit)")
    assert base == "Latch"
    assert version == "Radio Edit"


def test_bracketed_version():
    from djtoolkit.metadata.writer import _extract_version
    base, version = _extract_version("Song [Club Mix]")
    assert base == "Song"
    assert version == "Club Mix"


def test_dash_separated_remix():
    from djtoolkit.metadata.writer import _extract_version
    base, version = _extract_version("It's A Memory - Oliver Remix")
    assert base == "It's A Memory"
    assert version == "Oliver Remix"


def test_no_version():
    from djtoolkit.metadata.writer import _extract_version
    base, version = _extract_version("Blue Monday")
    assert base == "Blue Monday"
    assert version is None


def test_original_mix_stripped():
    from djtoolkit.metadata.writer import _extract_version
    base, version = _extract_version("Levels (Original Mix)")
    assert base == "Levels"
    assert version is None


def test_original_version_stripped():
    from djtoolkit.metadata.writer import _extract_version
    base, version = _extract_version("Track (Original Version)")
    assert base == "Track"
    assert version is None


def test_non_version_parenthetical_kept():
    from djtoolkit.metadata.writer import _extract_version
    base, version = _extract_version("Song (feat. Artist)")
    assert base == "Song (feat. Artist)"
    assert version is None


def test_extended_mix():
    from djtoolkit.metadata.writer import _extract_version
    base, version = _extract_version("Strobe (Extended Mix)")
    assert base == "Strobe"
    assert version == "Extended Mix"


def test_target_filename_with_version():
    from djtoolkit.metadata.writer import _target_filename
    result = _target_filename("Disclosure", "Latch (Radio Edit)", ".mp3")
    assert result == "Disclosure - Latch (Radio Edit).mp3"


def test_target_filename_without_version():
    from djtoolkit.metadata.writer import _target_filename
    result = _target_filename("New Order", "Blue Monday", ".flac")
    assert result == "New Order - Blue Monday.flac"


def test_target_filename_dash_remix_normalized():
    from djtoolkit.metadata.writer import _target_filename
    result = _target_filename("Fred Falke", "It's A Memory - Oliver Remix", ".mp3")
    assert result == "Fred Falke - It's A Memory (Oliver Remix).mp3"


def test_target_filename_original_mix_dropped():
    from djtoolkit.metadata.writer import _target_filename
    result = _target_filename("Avicii", "Levels (Original Mix)", ".mp3")
    assert result == "Avicii - Levels.mp3"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `poetry run pytest tests/test_version_extraction.py -v`
Expected: FAIL — `ImportError: cannot import name '_extract_version'`

- [ ] **Step 3: Write the implementation**

Replace lines 26–37 of `djtoolkit/metadata/writer.py` with:

```python
_UNSAFE_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')

# Version keywords that indicate a remix/edit/version suffix
_VERSION_KEYWORDS = re.compile(
    r'\b(remix|edit|mix|version|rework|dub|bootleg|extended|club|radio|'
    r'acoustic|live|instrumental|vip|remaster|remastered)\b',
    re.IGNORECASE,
)
_ORIGINAL_MIX_RE = re.compile(r'^original\s+(mix|version)$', re.IGNORECASE)
_PAREN_SUFFIX_RE = re.compile(r'\s*[\(\[](.*?)[\)\]]\s*$')
_DASH_SUFFIX_RE = re.compile(r'\s+-\s+(.*?)\s*$')


def _safe_name(name: str) -> str:
    return _UNSAFE_CHARS.sub("_", name).strip()


def _extract_version(title: str) -> tuple[str, str | None]:
    """Extract version/remix info from a track title.

    Returns (clean_title, version_string_or_None).
    """
    # Try parenthetical/bracketed suffix
    match = _PAREN_SUFFIX_RE.search(title)
    if match:
        candidate = match.group(1).strip()
        if _VERSION_KEYWORDS.search(candidate):
            clean = title[:match.start()].strip()
            if _ORIGINAL_MIX_RE.match(candidate):
                return clean, None
            return clean, candidate

    # Try dash-separated suffix
    match = _DASH_SUFFIX_RE.search(title)
    if match:
        candidate = match.group(1).strip()
        if _VERSION_KEYWORDS.search(candidate):
            clean = title[:match.start()].strip()
            if _ORIGINAL_MIX_RE.match(candidate):
                return clean, None
            return clean, candidate

    return title, None


def _target_filename(artist: str, title: str, suffix: str) -> str:
    """Normalize to 'Artist - Title (Version).ext' format."""
    clean_title, version = _extract_version(title)
    artist = _safe_name(artist or "Unknown Artist")
    clean_title = _safe_name(clean_title or "Unknown Title")
    if version:
        return f"{artist} - {clean_title} ({_safe_name(version)}){suffix}"
    return f"{artist} - {clean_title}{suffix}"
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `poetry run pytest tests/test_version_extraction.py -v`
Expected: All 13 tests PASS

- [ ] **Step 5: Run existing metadata writer tests to check for regressions**

Run: `poetry run pytest tests/ -k "metadata or writer or mover" -v`
Expected: All existing tests still PASS

- [ ] **Step 6: Commit**

```bash
git add djtoolkit/metadata/writer.py tests/test_version_extraction.py
git commit -m "feat(metadata): extract version from title, rename to Artist - Title (Version).ext"
```

---

## Stream D — Web UI (depends on Streams A+B)

### Task 14: FolderBrowser component

**Files:**
- Create: `web/components/folder-import/FolderBrowser.tsx`

- [ ] **Step 1: Write the component**

```tsx
// web/components/folder-import/FolderBrowser.tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import { sendAgentCommand, getAgentCommandResult } from "@/lib/api";
import { ActionButton } from "@/components/ui/ActionButton";

interface FileEntry {
  name: string;
  type: "file" | "dir";
  size_bytes: number | null;
  extension: string | null;
}

interface FolderBrowserProps {
  agentId: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}

function formatSize(bytes: number | null): string {
  if (bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FolderBrowser({ agentId, onSelect, onClose }: FolderBrowserProps) {
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const browse = useCallback(
    async (path?: string) => {
      setLoading(true);
      setError(null);
      try {
        const { id } = await sendAgentCommand(agentId, "browse_folder", {
          path: path ?? null,
        });

        // Poll for result
        let attempts = 0;
        while (attempts < 30) {
          await new Promise((r) => setTimeout(r, 500));
          const cmd = await getAgentCommandResult(id);
          if (cmd.status === "completed" && cmd.result) {
            const r = cmd.result as {
              path: string;
              parent: string | null;
              entries: FileEntry[];
            };
            setCurrentPath(r.path);
            setParentPath(r.parent);
            setEntries(r.entries);
            setLoading(false);
            return;
          }
          if (cmd.status === "failed") {
            setError(cmd.error ?? "Command failed");
            setLoading(false);
            return;
          }
          attempts++;
        }
        setError("Agent did not respond in time");
      } catch (e) {
        setError(e instanceof Error ? e.message : "Unknown error");
      } finally {
        setLoading(false);
      }
    },
    [agentId],
  );

  useEffect(() => {
    browse();
  }, [browse]);

  const audioCount = entries.filter((e) => e.type === "file").length;
  const dirCount = entries.filter((e) => e.type === "dir").length;

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.5)",
          zIndex: 59,
        }}
      />

      {/* Modal */}
      <div
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          zIndex: 60,
          background: "var(--hw-surface)",
          border: "1px solid var(--hw-border-light)",
          borderRadius: 10,
          width: 540,
          maxHeight: 520,
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 16px 48px rgba(0,0,0,0.4)",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "16px 20px",
            borderBottom: "1px solid var(--hw-border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span
            className="font-mono"
            style={{
              fontSize: 11,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: 2,
              color: "var(--hw-text-secondary)",
            }}
          >
            Browse Agent Filesystem
          </span>
          <button onClick={onClose} className="font-mono" style={{ background: "none", border: "none", color: "var(--hw-text-muted)", cursor: "pointer", fontSize: 16 }}>
            &times;
          </button>
        </div>

        {/* Path bar */}
        <div
          style={{
            padding: "10px 20px",
            borderBottom: "1px solid var(--hw-border)",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <button
            onClick={() => parentPath && browse(parentPath)}
            disabled={!parentPath || loading}
            className="font-mono"
            style={{
              background: "var(--hw-raised)",
              border: "1px solid var(--hw-border-light)",
              borderRadius: 5,
              color: "var(--hw-text-dim)",
              padding: "6px 10px",
              cursor: parentPath ? "pointer" : "not-allowed",
              fontSize: 11,
              fontWeight: 700,
              opacity: parentPath ? 1 : 0.4,
            }}
          >
            &#x25B2; Up
          </button>
          <div
            className="font-mono"
            style={{
              fontSize: 12,
              color: "var(--hw-text-dim)",
              background: "var(--hw-input-bg)",
              border: "1px solid var(--hw-input-border)",
              borderRadius: 5,
              padding: "6px 12px",
              flex: 1,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {currentPath ?? "Loading..."}
          </div>
        </div>

        {/* File list */}
        <div style={{ flex: 1, overflowY: "auto", minHeight: 200 }}>
          {loading && (
            <div style={{ padding: 40, textAlign: "center", color: "var(--hw-text-muted)" }}>
              Browsing...
            </div>
          )}
          {error && (
            <div style={{ padding: 40, textAlign: "center", color: "var(--hw-error-text)" }}>
              {error}
            </div>
          )}
          {!loading && !error && entries.length === 0 && (
            <div style={{ padding: 40, textAlign: "center", color: "var(--hw-text-muted)" }}>
              Empty directory
            </div>
          )}
          {!loading &&
            !error &&
            entries.map((entry) => (
              <div
                key={entry.name}
                onClick={() => {
                  if (entry.type === "dir" && currentPath) {
                    browse(`${currentPath}/${entry.name}`);
                  }
                }}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 80px 60px",
                  gap: 8,
                  alignItems: "center",
                  padding: "8px 20px",
                  borderBottom: "1px solid var(--hw-border)",
                  cursor: entry.type === "dir" ? "pointer" : "default",
                  transition: "background 0.1s",
                }}
                onMouseEnter={(e) =>
                  (e.currentTarget.style.background = "var(--hw-card-hover)")
                }
                onMouseLeave={(e) =>
                  (e.currentTarget.style.background = "transparent")
                }
              >
                <span
                  style={{
                    fontSize: 13,
                    color:
                      entry.type === "dir"
                        ? "var(--led-blue-on)"
                        : "var(--hw-text)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {entry.type === "dir" ? "📁 " : "🎵 "}
                  {entry.name}
                </span>
                <span
                  className="font-mono"
                  style={{
                    fontSize: 10,
                    color: "var(--hw-text-muted)",
                    textAlign: "right",
                  }}
                >
                  {entry.type === "dir" ? "" : formatSize(entry.size_bytes)}
                </span>
                <span
                  className="font-mono"
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: 1,
                    color: "var(--hw-text-dim)",
                    textAlign: "right",
                  }}
                >
                  {entry.type === "dir" ? "DIR" : entry.extension}
                </span>
              </div>
            ))}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "14px 20px",
            borderTop: "1px solid var(--hw-border)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span
            className="font-mono"
            style={{ fontSize: 10, color: "var(--hw-text-dim)" }}
          >
            {audioCount} audio file{audioCount !== 1 ? "s" : ""} &middot;{" "}
            {dirCount} folder{dirCount !== 1 ? "s" : ""}
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <ActionButton variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </ActionButton>
            <ActionButton
              size="sm"
              onClick={() => currentPath && onSelect(currentPath)}
              disabled={!currentPath || audioCount === 0}
            >
              Import This Folder
            </ActionButton>
          </div>
        </div>
      </div>
    </>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add web/components/folder-import/FolderBrowser.tsx
git commit -m "feat(ui): add FolderBrowser modal component"
```

---

### Task 15: DuplicateReview component

**Files:**
- Create: `web/components/folder-import/DuplicateReview.tsx`

- [ ] **Step 1: Write the component**

This is a large component. Create it with the hardware-inspired design matching the approved mockup. It should:
- Accept `pendingTracks` array (tracks with `acquisition_status = 'pending_review'`) and their matched duplicates
- Show side-by-side comparison cards with "VS" divider
- Three action buttons per card: Keep Both, Skip, Replace
- Batch actions: Keep All, Skip All
- Call `reviewDuplicates()` from `web/lib/api.ts` on user action

The component should follow the exact patterns shown in the mockup at `/tmp/djtoolkit-folder-import-mockup.html` (Screen 3), using the same CSS variables and font styles as the existing `web/app/(app)/import/page.tsx`.

- [ ] **Step 2: Commit**

```bash
git add web/components/folder-import/DuplicateReview.tsx
git commit -m "feat(ui): add DuplicateReview component with keep/skip/replace actions"
```

---

### Task 16: FolderImportReport component

**Files:**
- Create: `web/components/folder-import/FolderImportReport.tsx`

- [ ] **Step 1: Write the component**

This component should:
- Accept a `jobId` prop, call `getFolderImportReport()` from `web/lib/api.ts`
- Show LCD-style summary (total, fully enriched, incomplete)
- Per-field completeness progress bars
- Per-track detail table with checkmarks/crosses
- Follow the mockup at `/tmp/djtoolkit-folder-import-mockup.html` (Screen 4)

- [ ] **Step 2: Commit**

```bash
git add web/components/folder-import/FolderImportReport.tsx
git commit -m "feat(ui): add FolderImportReport component"
```

---

### Task 17: Import page integration — Local Folder source card

**Files:**
- Modify: `web/app/(app)/import/page.tsx` (~line 1142)

- [ ] **Step 1: Add state and imports**

At the top of the component, add:
- Import `FolderBrowser` from `@/components/folder-import/FolderBrowser`
- Import `importFolder`, `fetchAgents` from `@/lib/api`
- Add state: `folderBrowserOpen`, `selectedAgent`, `folderImportJobId`
- On mount, fetch agents list for the agent selector

- [ ] **Step 2: Add the Local Folder source card**

Before the `<SectionHeader label="DJ Software" />` at ~line 1142, add a new `SourceCard`:

```tsx
{/* Local Folder */}
<SourceCard
  icon={SRC_ICONS.agent}
  title="Local Folder"
  desc="Browse and import audio files from your agent's machine"
  badge="NEW"
>
  <ActionButton
    variant="outline"
    onClick={() => setFolderBrowserOpen(true)}
    disabled={!selectedAgent}
  >
    Browse Files
  </ActionButton>
  {!selectedAgent && (
    <p className="mt-2 font-mono text-[10px]" style={{ color: "var(--hw-text-muted)" }}>
      No agent connected — install the agent first
    </p>
  )}
</SourceCard>

{folderBrowserOpen && selectedAgent && (
  <FolderBrowser
    agentId={selectedAgent}
    onClose={() => setFolderBrowserOpen(false)}
    onSelect={async (path) => {
      setFolderBrowserOpen(false);
      const { id } = await importFolder(selectedAgent, path);
      setFolderImportJobId(id);
    }}
  />
)}
```

- [ ] **Step 3: Commit**

```bash
git add web/app/\(app\)/import/page.tsx
git commit -m "feat(ui): add Local Folder source card to import page"
```

---

## Verification

### End-to-end test plan

1. **Apply migrations** — `supabase db push`
2. **Run Python tests** — `poetry run pytest tests/test_version_extraction.py tests/test_browse_folder.py tests/test_folder_import_job.py -v`
3. **Run all existing tests** — `poetry run pytest` (regression check)
4. **Start web dev** — `cd web && npm run dev`
5. **Start agent** — `poetry run djtoolkit agent run`
6. **Browse test** — open `https://localhost:3000/import`, click "Local Folder", verify folder browser modal opens, navigate directories, see audio files
7. **Import test** — select a folder with 3-5 test audio files, click "Import This Folder", verify tracks appear in pipeline
8. **Duplicate test** — re-import the same folder, verify duplicates show as `pending_review`, test Keep/Skip/Replace actions
9. **Rename test** — after pipeline completes, verify files renamed to `Artist - Title (Version).ext`
10. **Report test** — check the metadata report shows correct field completeness
