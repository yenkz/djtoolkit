# Local Folder Import via Agent

## Context

Users with the agent installed often have existing music on disk they want to bring into the djtoolkit catalogue. Currently, folder import is CLI-only (`djtoolkit import folder`), requires direct terminal access, and doesn't chain into the agent's enrichment pipeline. This feature lets users browse their agent's filesystem from the web UI, import audio files, and automatically enrich them — with a human review step for duplicates.

**End-to-end flow:**
```
Web UI browse (agent_commands) → Select folder → folder_import job →
  per-track: fingerprint → [duplicate? → pending_review → user decision] →
    spotify_lookup → cover_art → audio_analysis → metadata (tags + rename)
```

Files stay in their original folder, renamed in place to `Artist - Title (Version).ext`.

---

## Phase 1: Database — `agent_commands` table + schema changes

### Step 1.1: Migration — `agent_commands` table
**Create:** `supabase/migrations/YYYYMMDD_agent_commands.sql`

```sql
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

-- Agent poll: pending commands for a specific agent
CREATE INDEX idx_agent_commands_agent_pending
    ON public.agent_commands (agent_id, status) WHERE status = 'pending';

-- Realtime publication
ALTER PUBLICATION supabase_realtime ADD TABLE public.agent_commands;
```

RLS: same pattern as `pipeline_jobs` — user_id isolation + agent Realtime access.

### Step 1.2: Add `pending_review` to acquisition_status
**Modify:** New migration file

Add `'pending_review'` to the `acquisition_status` CHECK constraint on `tracks` table. This status means "fingerprint found a duplicate match, awaiting user decision."

### Step 1.3: Chain trigger update for duplicate review gate
**Modify:** New migration (or update existing `chain_pipeline_job()`)

In the `WHEN 'fingerprint'` branch (currently at `optimize_chain_trigger.sql:230-236`), change:

```sql
-- BEFORE: auto-mark as duplicate
IF (v_result ->> 'is_duplicate')::BOOLEAN IS TRUE THEN
    UPDATE public.tracks SET acquisition_status = 'duplicate', fingerprinted = TRUE
    WHERE id = NEW.track_id AND user_id = NEW.user_id;
    RETURN NEW;
END IF;

-- AFTER: review gate for folder imports
IF (v_result ->> 'is_duplicate')::BOOLEAN IS TRUE THEN
    IF v_track.source = 'folder' THEN
        -- Pause for user review — store matched track ID in result
        UPDATE public.tracks SET
            acquisition_status = 'pending_review',
            fingerprinted = TRUE
        WHERE id = NEW.track_id AND user_id = NEW.user_id;
    ELSE
        UPDATE public.tracks SET
            acquisition_status = 'duplicate',
            fingerprinted = TRUE
        WHERE id = NEW.track_id AND user_id = NEW.user_id;
    END IF;
    RETURN NEW;  -- Pipeline stops, user review or auto-duplicate
END IF;
```

The fingerprint job result already includes `is_duplicate`. We also need the matching track's ID — the `execute_fingerprint` function in `executor.py` should include `duplicate_of_track_id` in its result when a duplicate is found. This requires updating the cloud-side trigger that detects duplicates (it checks fingerprints table for matching chromaprint).

---

## Phase 2: Agent — Commands + Folder Import Job

### Step 2.1: `browse_folder` command
**Create:** `djtoolkit/agent/commands/__init__.py` (empty)
**Create:** `djtoolkit/agent/commands/browse_folder.py`

- `browse_folder(payload: dict) -> dict`
- Lists directory at `payload["path"]` (default: home dir)
- Returns `{path, parent, entries: [{name, type, size_bytes, extension}]}`
- Filters: audio files (reuse `AUDIO_EXTENSIONS` from `importers/folder.py`) + directories
- Skips hidden files (dotfiles), sorts dirs first then files alphabetically

### Step 2.2: Agent client additions
**Modify:** `djtoolkit/agent/client.py`

Add three methods to `AgentClient`:
- `poll_commands(limit=5) -> list[dict]` — `GET /api/agents/commands`
- `update_command_status(cmd_id, status)` — `PUT /api/agents/commands/{id}`
- `report_command_result(cmd_id, result=None, error=None)` — `PUT /api/agents/commands/{id}`

### Step 2.3: Daemon — command subscription + poll loop
**Modify:** `djtoolkit/agent/daemon.py`

1. Add `command_wake` asyncio.Event alongside existing `realtime_wake`
2. In `_realtime_loop()`, add second Realtime channel subscribing to `agent_commands` INSERTs
3. Add `_command_poll_loop()` to the TaskGroup — polls for pending commands, dispatches inline (commands are fast, no thread pool needed)
4. Command dispatch: `match command_type: case "browse_folder": ...`

### Step 2.4: `folder_import` job
**Create:** `djtoolkit/agent/jobs/folder_import.py`

- `async run(cfg, payload, credentials) -> dict`
- Reuses `_read_tags()` and `AUDIO_EXTENSIONS` from `djtoolkit/importers/folder.py`
- Reuses `build_search_string()` from `djtoolkit/utils/search_string.py`
- Flow:
  1. Scan folder (recursive by default) for audio files
  2. For each file: read tags via mutagen, fallback to filename/parent
  3. Insert track via Supabase client (agent has creds): `source="folder"`, `acquisition_status="available"`, `source_id=filepath`
  4. Skip files already in DB (check `source_id` match first, don't upsert)
  5. Create `fingerprint` pipeline_job for each new track
- Returns `{inserted, skipped_existing, track_ids, path}`

### Step 2.5: Executor dispatch
**Modify:** `djtoolkit/agent/executor.py`

Add `"folder_import"` case to `execute_job()` dispatch (around line 440+ where other cases live). Delegates to `folder_import.run()`.

---

## Phase 3: Metadata Writer — Rename Pattern Update

### Step 3.1: Version extraction
**Modify:** `djtoolkit/metadata/writer.py`

Add `_extract_version(title: str) -> tuple[str, str | None]`:
- Check for parenthetical `(...)` or bracketed `[...]` at end of title containing version keywords: `remix`, `edit`, `mix`, `version`, `rework`, `dub`, `bootleg`, `extended`, `club`, `radio`, `acoustic`, `live`, `instrumental`, `vip`, `remaster`
- Check for dash-separated suffix: ` - Something Remix/Edit/etc.`
- Skip "Original Mix" / "Original Version" (redundant)
- Return `(clean_title, version_or_None)`

### Step 3.2: Updated `_target_filename()`
**Modify:** `djtoolkit/metadata/writer.py` (line 33-37)

```python
def _target_filename(artist: str, title: str, suffix: str) -> str:
    clean_title, version = _extract_version(title)
    artist = _safe_name(artist or "Unknown Artist")
    clean_title = _safe_name(clean_title or "Unknown Title")
    if version:
        return f"{artist} - {clean_title} ({_safe_name(version)}){suffix}"
    return f"{artist} - {clean_title}{suffix}"
```

This applies to ALL metadata writes (not just folder imports), which is the desired behavior.

---

## Phase 4: Web API Routes

### Step 4.1: Agent commands CRUD
**Create:** `web/app/api/agents/commands/route.ts`
- `GET` — agent polls for pending commands (auth: API key, resolves agent_id server-side)
- `POST` — web UI creates a command (auth: JWT, body: `{agent_id, command_type, payload}`)

**Create:** `web/app/api/agents/commands/[id]/route.ts`
- `GET` — web UI polls for command result (auth: JWT)
- `PUT` — agent reports result/status (auth: API key)

### Step 4.2: Folder import trigger
**Create:** `web/app/api/catalog/import/folder/route.ts`
- `POST` — creates a `folder_import` pipeline_job
- Body: `{path, recursive?, agent_id}`
- Includes `user_id` in payload so agent can use it for track insertion

### Step 4.3: Duplicate review endpoint
**Create:** `web/app/api/catalog/import/folder/review/route.ts`
- `POST` — processes user decisions for `pending_review` tracks
- Body: `{decisions: [{track_id, action: "keep" | "skip" | "replace"}]}`
- **keep**: set `acquisition_status='available'`, create `spotify_lookup` job (resume pipeline)
- **skip**: set `acquisition_status='duplicate'`
- **replace**: delete old track's DB record (file on disk left untouched — user manages their own files), set new track to `available`, create `spotify_lookup` job

### Step 4.4: Missing metadata report
**Create:** `web/app/api/catalog/import/folder/[jobId]/report/route.ts`
- `GET` — reads `folder_import` job result `track_ids`, queries tracks, returns field completeness
- Tracked fields: artist, title, album, tempo, key, genres, cover_art_written

### Step 4.5: API client functions
**Modify:** `web/lib/api.ts` (or equivalent)

Add: `sendAgentCommand()`, `getAgentCommandResult()`, `importFolder()`, `reviewDuplicates()`, `getFolderImportReport()`

---

## Phase 5: Web UI Components

### Step 5.1: Folder browser
**Create:** `web/components/ui/FolderBrowser.tsx`
- Modal/panel that sends `browse_folder` commands to the selected agent
- Shows directories + audio files, navigable
- "Go Up" button using `parent` from result
- "Import This Folder" action button
- Loading/error states for when agent is offline

### Step 5.2: Import page integration
**Modify:** `web/app/(app)/import/page.tsx` (route: `https://www.djtoolkit.net/import`)
- Add "Local Folder" import source card alongside existing sources on the `/import` page
- Opens FolderBrowser on click

### Step 5.3: Duplicate review screen
**Create:** `web/components/ui/DuplicateReview.tsx`
- Shows `pending_review` tracks with their matched duplicates side-by-side
- Per-track: new track info vs existing track info (artist, title, path, enrichment status)
- Three action buttons: Keep Both / Skip / Replace
- Batch actions: "Keep All" / "Skip All"

### Step 5.4: Missing metadata report
**Create:** `web/components/ui/FolderImportReport.tsx`
- Summary: "12/15 tracks fully enriched, 3 missing fields"
- Breakdown by field: genres (2), cover art (1)
- Per-track detail table with checkmarks/X for each field

---

## Critical Files Summary

### New files (13)
| File | Purpose |
|------|---------|
| `supabase/migrations/YYYYMMDD_agent_commands.sql` | agent_commands table, RLS, indexes |
| `supabase/migrations/YYYYMMDD_pending_review.sql` | acquisition_status + trigger update |
| `djtoolkit/agent/commands/__init__.py` | Package init |
| `djtoolkit/agent/commands/browse_folder.py` | browse_folder command handler |
| `djtoolkit/agent/jobs/folder_import.py` | folder_import job handler |
| `web/app/api/agents/commands/route.ts` | Agent commands GET/POST |
| `web/app/api/agents/commands/[id]/route.ts` | Single command GET/PUT |
| `web/app/api/catalog/import/folder/route.ts` | Folder import trigger |
| `web/app/api/catalog/import/folder/review/route.ts` | Duplicate review decisions |
| `web/app/api/catalog/import/folder/[jobId]/report/route.ts` | Metadata report |
| `web/components/ui/FolderBrowser.tsx` | Folder browser component |
| `web/components/ui/DuplicateReview.tsx` | Duplicate review component |
| `web/components/ui/FolderImportReport.tsx` | Import report component |

### Modified files (6)
| File | Change |
|------|--------|
| `djtoolkit/agent/daemon.py` | Command subscription + poll loop |
| `djtoolkit/agent/client.py` | poll_commands, report_command_result methods |
| `djtoolkit/agent/executor.py` | folder_import dispatch case |
| `djtoolkit/metadata/writer.py` | `_extract_version()` + updated `_target_filename()` |
| `web/lib/api.ts` | API client functions for commands/import/review |
| `web/app/(app)/import/page.tsx` | "Local Folder" source card (route: `/import`) |

### Reused existing code
| What | From |
|------|------|
| `AUDIO_EXTENSIONS` | `djtoolkit/importers/folder.py:16` |
| `_read_tags()` | `djtoolkit/importers/folder.py:19` |
| `build_search_string()` | `djtoolkit/utils/search_string.py` |
| `_safe_name()` | `djtoolkit/metadata/writer.py:29` |
| Chain trigger (fingerprint → spotify_lookup → ...) | `optimize_chain_trigger.sql:260-270` |
| Realtime subscription pattern | `daemon.py:322-398` |
| `_insert_next_job()` helper | `optimize_chain_trigger.sql:113-129` |

---

## Verification

### Unit tests
- `tests/test_version_extraction.py` — `_extract_version()` with all examples + edge cases (Original Mix, multiple parens, dash-separated, no version)
- `tests/test_browse_folder.py` — empty dir, audio filter, hidden files, non-existent path
- `tests/test_folder_import_job.py` — mock Supabase, verify track insertion + fingerprint job creation, re-import skip

### Integration tests
- **Agent command round-trip:** send browse_folder via API → agent picks up → result returned
- **Full pipeline:** import folder → fingerprint → (duplicate: verify pending_review) → review decision → pipeline resumes → metadata written + file renamed
- **Rename verification:** import files with various title formats, verify rename output matches `Artist - Title (Version).ext`

### Manual testing
1. `djtoolkit agent run` with a test folder of 5-10 audio files
2. Trigger import from web UI → verify folder browser works
3. Verify duplicate detection pauses correctly
4. Approve/skip/replace a duplicate → verify pipeline resumes
5. Check final filenames match expected pattern
6. Check missing metadata report accuracy
