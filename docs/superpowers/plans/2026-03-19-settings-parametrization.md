# Settings Parametrization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make web UI settings actually drive pipeline behavior by snapshotting them into job payloads and having the agent read them.

**Architecture:** New `job-settings.ts` helper fetches user settings from Supabase and returns job-type-specific subsets. All job creation points embed `payload.settings`. The agent's `executor.py` reads settings from payload, falling back to local config. Enabled toggles gate job creation in the chaining engine.

**Tech Stack:** TypeScript (Next.js API routes), Python (agent executor), Supabase (PostgreSQL JSONB)

**Spec:** `docs/superpowers/specs/2026-03-19-settings-parametrization-design.md`

---

### Task 1: Create `job-settings.ts` helper

**Files:**
- Create: `web/lib/api-server/job-settings.ts`
- Test: `web/lib/api-server/__tests__/job-settings.test.ts`

- [ ] **Step 0: Install vitest**

The web project has no test runner. Install vitest:

```bash
cd web && npm install -D vitest
```

Create `web/vitest.config.ts`:

```typescript
import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname) },
  },
});
```

- [ ] **Step 1: Write tests for `isStepEnabled` and `getJobSettings`**

Create `web/lib/api-server/__tests__/job-settings.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { isStepEnabled, getJobSettings } from "../job-settings";

describe("isStepEnabled", () => {
  it("returns true for fingerprint when not set (default enabled)", () => {
    expect(isStepEnabled({}, "fingerprint")).toBe(true);
  });

  it("returns true for cover_art when not set (default enabled)", () => {
    expect(isStepEnabled({}, "cover_art")).toBe(true);
  });

  it("returns false for audio_analysis when not set (default disabled)", () => {
    expect(isStepEnabled({}, "audio_analysis")).toBe(false);
  });

  it("returns false for loudnorm when not set (default disabled)", () => {
    expect(isStepEnabled({}, "loudnorm")).toBe(false);
  });

  it("respects explicit false for fingerprint", () => {
    expect(isStepEnabled({ fingerprint_enabled: false }, "fingerprint")).toBe(false);
  });

  it("respects explicit true for audio_analysis", () => {
    expect(isStepEnabled({ analysis_enabled: true }, "audio_analysis")).toBe(true);
  });
});

describe("getJobSettings", () => {
  it("returns download settings for download job type", () => {
    const settings = {
      min_score: 0.75,
      duration_tolerance_ms: 3000,
      search_timeout_sec: 20,
      coverart_sources: ["itunes"],
      fingerprint_enabled: false,
    };
    const result = getJobSettings(settings, "download");
    expect(result).toEqual({
      min_score: 0.75,
      duration_tolerance_ms: 3000,
      search_timeout_sec: 20,
    });
  });

  it("returns cover_art settings for cover_art job type", () => {
    const settings = {
      min_score: 0.75,
      coverart_sources: ["itunes", "deezer"],
    };
    const result = getJobSettings(settings, "cover_art");
    expect(result).toEqual({
      coverart_sources: ["itunes", "deezer"],
    });
  });

  it("returns empty object for job types with no tuning params", () => {
    const settings = { min_score: 0.75, coverart_sources: ["itunes"] };
    expect(getJobSettings(settings, "fingerprint")).toEqual({});
    expect(getJobSettings(settings, "metadata")).toEqual({});
    expect(getJobSettings(settings, "audio_analysis")).toEqual({});
  });

  it("returns empty object when settings has no relevant keys", () => {
    expect(getJobSettings({}, "download")).toEqual({});
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run lib/api-server/__tests__/job-settings.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `job-settings.ts`**

Create `web/lib/api-server/job-settings.ts`:

```typescript
/**
 * Job settings helper — extracts user settings relevant to each job type
 * and checks enabled toggles for pipeline step gating.
 */

import { SupabaseClient } from "@supabase/supabase-js";

/** Keys from user_settings relevant to each job type. */
const JOB_SETTINGS_KEYS: Record<string, string[]> = {
  download: ["min_score", "duration_tolerance_ms", "search_timeout_sec"],
  cover_art: ["coverart_sources"],
};

/** Toggle key mapping and defaults for each gatable step. */
const STEP_TOGGLES: Record<string, { key: string; defaultEnabled: boolean }> = {
  fingerprint: { key: "fingerprint_enabled", defaultEnabled: true },
  cover_art: { key: "coverart_enabled", defaultEnabled: true },
  audio_analysis: { key: "analysis_enabled", defaultEnabled: false },
  loudnorm: { key: "loudnorm_enabled", defaultEnabled: false },
};

/**
 * Fetch user_settings.settings JSONB for a user.
 * Returns empty object if no settings row exists.
 */
export async function getUserSettings(
  supabase: SupabaseClient,
  userId: string
): Promise<Record<string, unknown>> {
  const { data } = await supabase
    .from("user_settings")
    .select("settings")
    .eq("user_id", userId)
    .maybeSingle();

  return (data?.settings as Record<string, unknown>) ?? {};
}

/**
 * Extract only the settings keys relevant to a given job type.
 * Pure function — operates on an already-fetched settings object.
 */
export function getJobSettings(
  settings: Record<string, unknown>,
  jobType: string
): Record<string, unknown> {
  const keys = JOB_SETTINGS_KEYS[jobType];
  if (!keys) return {};

  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in settings && settings[key] !== undefined) {
      result[key] = settings[key];
    }
  }
  return result;
}

/**
 * Check if a pipeline step is enabled based on user settings.
 * Pure function — operates on an already-fetched settings object.
 */
export function isStepEnabled(
  settings: Record<string, unknown>,
  step: "fingerprint" | "cover_art" | "audio_analysis" | "loudnorm"
): boolean {
  const toggle = STEP_TOGGLES[step];
  if (!toggle) return true;

  const value = settings[toggle.key];
  if (value === undefined || value === null) return toggle.defaultEnabled;
  return Boolean(value);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run lib/api-server/__tests__/job-settings.test.ts`
Expected: PASS (all 10 tests)

- [ ] **Step 5: Commit**

```bash
git add web/lib/api-server/job-settings.ts web/lib/api-server/__tests__/job-settings.test.ts
git commit -m "feat: add job-settings helper for settings-to-payload extraction"
```

---

### Task 2: Wire settings into job chaining (`job-result.ts`)

**Files:**
- Modify: `web/lib/api-server/job-result.ts`

This is the most complex task. The chaining engine needs to:
1. Fetch user settings once at the top of `applyJobResult()`
2. Check enabled toggles before creating each chained job
3. Embed `settings` in payloads for `download` and `cover_art` jobs
4. Skip disabled steps, jumping to the next step in the chain

- [ ] **Step 1: Add imports and settings fetch to `applyJobResult()`**

At the top of `web/lib/api-server/job-result.ts`, add the import:

```typescript
import { getUserSettings, getJobSettings, isStepEnabled } from "./job-settings";
```

Inside `applyJobResult()`, right after the `trackId` assignment (after line 110), add:

```typescript
  // Fetch user settings once for toggle checks and payload injection
  const userSettings = await getUserSettings(supabase, userId);
```

- [ ] **Step 2: Modify the `download` case to check `fingerprint_enabled`**

In the `download` case (lines 113-138), modify the chaining logic with:
- If `fingerprint_enabled` → queue fingerprint (existing behavior)
- If `fingerprint_enabled` is false → skip to the next step based on source:
  - exportify: skip to `cover_art` (or `metadata` if `coverart_enabled` is false)
  - non-exportify: skip to `spotify_lookup` (always runs, no toggle)

Replace from `// Auto-queue fingerprint job` (line 128) through the closing `break;` (line 138):

```typescript
      // Chain: download → [fingerprint?] → next step
      if (isStepEnabled(userSettings, "fingerprint")) {
        if (!(await hasActiveJob(supabase, trackId, "fingerprint"))) {
          await supabase.from("pipeline_jobs").insert({
            user_id: userId,
            track_id: trackId,
            job_type: "fingerprint",
            payload: { track_id: trackId, local_path: localPath },
          });
        }
      } else {
        // Fingerprint disabled — skip ahead based on track source
        const { data: track } = await supabase
          .from("tracks")
          .select("local_path, artist, album, title, source, spotify_uri, duration_ms")
          .eq("id", trackId)
          .single();

        if (track?.local_path) {
          if (track.source === "exportify") {
            await queueNextExportifyStep(supabase, userId, trackId, track, userSettings, "fingerprint");
          } else {
            // Non-exportify always goes to spotify_lookup
            if (!(await hasActiveJob(supabase, trackId, "spotify_lookup"))) {
              await supabase.from("pipeline_jobs").insert({
                user_id: userId,
                track_id: trackId,
                job_type: "spotify_lookup",
                payload: {
                  track_id: trackId,
                  artist: track.artist ?? "",
                  title: track.title ?? "",
                  duration_ms: track.duration_ms ?? null,
                  spotify_uri: track.spotify_uri ?? null,
                },
              });
            }
          }
        }
      }

      break;
```

- [ ] **Step 3: Add `queueNextExportifyStep` and `queueNextNonExportifyStep` helpers**

Add these before `applyJobResult()` in the same file. These handle skip logic when a step is disabled:

```typescript
/**
 * Queue the next enabled step for an exportify track.
 * Chain: [cover_art?] → metadata
 * `afterStep` indicates which step just completed or was skipped.
 */
async function queueNextExportifyStep(
  supabase: SupabaseClient,
  userId: string,
  trackId: number,
  track: Record<string, unknown>,
  settings: Record<string, unknown>,
  afterStep: "fingerprint" | "cover_art"
): Promise<void> {
  // After fingerprint → try cover_art
  if (afterStep === "fingerprint" && isStepEnabled(settings, "cover_art")) {
    if (!(await hasActiveJob(supabase, trackId, "cover_art"))) {
      const coverArtSettings = getJobSettings(settings, "cover_art");
      await supabase.from("pipeline_jobs").insert({
        user_id: userId,
        track_id: trackId,
        job_type: "cover_art",
        payload: {
          track_id: trackId,
          local_path: track.local_path,
          artist: track.artist ?? "",
          album: track.album ?? "",
          title: track.title ?? "",
          spotify_uri: track.spotify_uri ?? null,
          ...(Object.keys(coverArtSettings).length > 0 && { settings: coverArtSettings }),
        },
      });
    }
    return;
  }

  // After cover_art (or skipped cover_art) → metadata
  if (await hasActiveJob(supabase, trackId, "metadata")) return;
  const metaPayload = await buildMetadataPayload(supabase, trackId, userId);
  if (metaPayload) {
    await supabase.from("pipeline_jobs").insert({
      user_id: userId,
      track_id: trackId,
      job_type: "metadata",
      payload: metaPayload,
    });
  }
}

/**
 * Queue the next enabled step for a non-exportify track.
 * Chain: [cover_art?] → [audio_analysis?] → metadata
 * `afterStep` indicates which step just completed or was skipped.
 */
async function queueNextNonExportifyStep(
  supabase: SupabaseClient,
  userId: string,
  trackId: number,
  track: Record<string, unknown>,
  settings: Record<string, unknown>,
  afterStep: "cover_art" | "audio_analysis"
): Promise<void> {
  // After cover_art → try audio_analysis
  if (afterStep === "cover_art" && isStepEnabled(settings, "audio_analysis")) {
    if (!(await hasActiveJob(supabase, trackId, "audio_analysis"))) {
      await supabase.from("pipeline_jobs").insert({
        user_id: userId,
        track_id: trackId,
        job_type: "audio_analysis",
        payload: {
          track_id: trackId,
          local_path: track.local_path as string,
        },
      });
    }
    return;
  }

  // After audio_analysis (or skipped) → metadata
  if (await hasActiveJob(supabase, trackId, "metadata")) return;
  const metaPayload = await buildMetadataPayload(supabase, trackId, userId);
  if (metaPayload) {
    await supabase.from("pipeline_jobs").insert({
      user_id: userId,
      track_id: trackId,
      job_type: "metadata",
      payload: metaPayload,
    });
  }
}
```

- [ ] **Step 4: Modify the `fingerprint` case to use toggle-aware chaining**

In the `fingerprint` case (lines 141-248), inside the `else` branch of the duplicate check (the `} else {` at line 192 — NOT the `if (dupe)` branch), replace the "Auto-queue next job based on track source" block (lines 203-245) with:

```typescript
        // Auto-queue next job based on track source
        const { data: track } = await supabase
          .from("tracks")
          .select("local_path, artist, album, title, source, spotify_uri, duration_ms")
          .eq("id", trackId)
          .single();

        if (!track?.local_path) break;

        if (track.source === "exportify") {
          await queueNextExportifyStep(supabase, userId, trackId, track, userSettings, "fingerprint");
        } else {
          // Non-exportify tracks → spotify_lookup (always runs)
          if (!(await hasActiveJob(supabase, trackId, "spotify_lookup"))) {
            await supabase.from("pipeline_jobs").insert({
              user_id: userId,
              track_id: trackId,
              job_type: "spotify_lookup",
              payload: {
                track_id: trackId,
                artist: track.artist ?? "",
                title: track.title ?? "",
                duration_ms: track.duration_ms ?? null,
                spotify_uri: track.spotify_uri ?? null,
              },
            });
          }
        }
```

- [ ] **Step 5: Modify the `spotify_lookup` case to check `coverart_enabled`**

In the `spotify_lookup` case (lines 251-298), replace the cover_art job insertion (lines 281-295) with toggle-aware logic:

```typescript
      if (track?.local_path) {
        if (isStepEnabled(userSettings, "cover_art")) {
          if (!(await hasActiveJob(supabase, trackId, "cover_art"))) {
            const coverArtSettings = getJobSettings(userSettings, "cover_art");
            await supabase.from("pipeline_jobs").insert({
              user_id: userId,
              track_id: trackId,
              job_type: "cover_art",
              payload: {
                track_id: trackId,
                local_path: track.local_path,
                artist: track.artist ?? "",
                album: track.album ?? "",
                title: track.title ?? "",
                spotify_uri: track.spotify_uri ?? null,
                ...(Object.keys(coverArtSettings).length > 0 && { settings: coverArtSettings }),
              },
            });
          }
        } else {
          // Cover art disabled — skip to next non-exportify step
          await queueNextNonExportifyStep(
            supabase, userId, trackId, track as Record<string, unknown>, userSettings, "cover_art"
          );
        }
      }
```

- [ ] **Step 6: Modify the `cover_art` case to check `analysis_enabled`**

In the `cover_art` case (lines 300-355), replace the chaining logic after the track fetch (lines 327-352):

```typescript
      if (track.source !== "exportify") {
        // Non-exportify → check audio_analysis toggle
        await queueNextNonExportifyStep(
          supabase, userId, trackId, track, userSettings, "cover_art"
        );
      } else {
        // Exportify → queue metadata directly
        await queueNextExportifyStep(
          supabase, userId, trackId, track, userSettings, "cover_art"
        );
      }
```

- [ ] **Step 7: Verify the existing TypeScript compiles**

Run: `cd web && npx tsc --noEmit`
Expected: No errors related to `job-result.ts` or `job-settings.ts`

- [ ] **Step 8: Commit**

```bash
git add web/lib/api-server/job-result.ts
git commit -m "feat: wire user settings into job chaining with toggle gates"
```

---

### Task 3: Embed settings in download job creation endpoints

**Files:**
- Modify: `web/app/api/catalog/import/csv/route.ts` (lines 373-388)
- Modify: `web/app/api/catalog/import/trackid/route.ts` (lines 173-189)
- Modify: `web/app/api/pipeline/jobs/bulk/route.ts` (lines 76-87)
- Modify: `web/app/api/catalog/tracks/[id]/reset/route.ts` (lines 51-62)

All four endpoints follow the same pattern: fetch user settings, then embed `settings` in the download job payload.

- [ ] **Step 1: Modify CSV import route**

In `web/app/api/catalog/import/csv/route.ts`, add import at top:

```typescript
import { getUserSettings, getJobSettings } from "@/lib/api-server/job-settings";
```

Before the job creation block (around line 373), add:

```typescript
    const userSettings = await getUserSettings(supabase, user.userId);
    const downloadSettings = getJobSettings(userSettings, "download");
```

Modify the `jobRows` map to embed settings in the payload:

```typescript
    const jobRows = importedTracks.map((track) => ({
      user_id: user.userId,
      track_id: track.id,
      job_type: "download",
      payload: {
        track_id: track.id,
        search_string: track.search_string ?? "",
        artist: track.artist ?? "",
        title: track.title ?? "",
        duration_ms: track.duration_ms ?? 0,
        ...(Object.keys(downloadSettings).length > 0 && { settings: downloadSettings }),
      },
    }));
```

- [ ] **Step 2: Modify TrackID import route**

In `web/app/api/catalog/import/trackid/route.ts`, same pattern. Add import, fetch settings before the job creation block (around line 173), embed in payload:

```typescript
import { getUserSettings, getJobSettings } from "@/lib/api-server/job-settings";
```

Before job creation:

```typescript
        const userSettings = await getUserSettings(supabase, user.userId);
        const downloadSettings = getJobSettings(userSettings, "download");
```

Modify the `jobRows` map payload to include:

```typescript
        ...(Object.keys(downloadSettings).length > 0 && { settings: downloadSettings }),
```

- [ ] **Step 3: Modify bulk jobs route**

In `web/app/api/pipeline/jobs/bulk/route.ts`, add import, fetch settings once before the loop (around line 76), embed in each job's payload:

```typescript
import { getUserSettings, getJobSettings } from "@/lib/api-server/job-settings";
```

Before the loop:

```typescript
  const userSettings = await getUserSettings(supabase, user.userId);
  const downloadSettings = getJobSettings(userSettings, "download");
```

Add to the payload object:

```typescript
        ...(Object.keys(downloadSettings).length > 0 && { settings: downloadSettings }),
```

- [ ] **Step 4: Modify track reset route**

In `web/app/api/catalog/tracks/[id]/reset/route.ts`, add import, fetch settings before the job insert (around line 51), embed in payload:

```typescript
import { getUserSettings, getJobSettings } from "@/lib/api-server/job-settings";
```

Before job insert:

```typescript
  const userSettings = await getUserSettings(supabase, user.userId);
  const downloadSettings = getJobSettings(userSettings, "download");
```

Add to the payload object:

```typescript
      ...(Object.keys(downloadSettings).length > 0 && { settings: downloadSettings }),
```

- [ ] **Step 5: Verify TypeScript compiles**

Run: `cd web && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add web/app/api/catalog/import/csv/route.ts \
        web/app/api/catalog/import/trackid/route.ts \
        web/app/api/pipeline/jobs/bulk/route.ts \
        web/app/api/catalog/tracks/\[id\]/reset/route.ts
git commit -m "feat: embed user settings in download job payloads"
```

---

### Task 4: Fix and update Spotify import route (prerequisite + settings)

**Files:**
- Modify: `web/app/api/catalog/import/spotify/route.ts` (lines 204-239)

The Spotify import route has two bugs:
1. Uses `stage: "download"` instead of `job_type: "download"`
2. Has no `payload` object (agent gets empty values)

Fix both, then embed settings.

- [ ] **Step 1: Fix Spotify import job creation**

In `web/app/api/catalog/import/spotify/route.ts`, add import at top:

```typescript
import { getUserSettings, getJobSettings } from "@/lib/api-server/job-settings";
```

Replace the job creation block (lines 222-240). The tracks are already in the DB at this point, but we only have `trackId` — we need to fetch track data to build proper payloads:

```typescript
  // Create pipeline jobs for newly imported tracks
  let jobsCreated = 0;
  if (queueJobs && trackIds.length > 0) {
    const userSettings = await getUserSettings(supabase, user.userId);
    const downloadSettings = getJobSettings(userSettings, "download");

    // Fetch track data needed for download payloads (batch by 100)
    const trackDataMap = new Map<number, Record<string, unknown>>();
    for (let i = 0; i < trackIds.length; i += 100) {
      const batch = trackIds.slice(i, i + 100);
      const { data: rows } = await supabase
        .from("tracks")
        .select("id, search_string, artist, title, duration_ms")
        .eq("user_id", user.userId)
        .in("id", batch);
      for (const row of rows ?? []) {
        trackDataMap.set(row.id, row);
      }
    }

    const jobs = trackIds.map((trackId: number) => {
      const track = trackDataMap.get(trackId) ?? {};
      return {
        user_id: user.userId,
        track_id: trackId,
        job_type: "download",
        payload: {
          track_id: trackId,
          search_string: (track.search_string as string) ?? "",
          artist: (track.artist as string) ?? "",
          title: (track.title as string) ?? "",
          duration_ms: (track.duration_ms as number) ?? 0,
          ...(Object.keys(downloadSettings).length > 0 && { settings: downloadSettings }),
        },
      };
    });

    const { data: createdJobs, error: jobError } = await supabase
      .from("pipeline_jobs")
      .insert(jobs)
      .select("id");

    if (!jobError && createdJobs) {
      jobsCreated = createdJobs.length;
    }
  }
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd web && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add web/app/api/catalog/import/spotify/route.ts
git commit -m "fix: spotify import — use job_type, add payload with settings"
```

---

### Task 5: Agent-side — read settings from payload in executors

**Files:**
- Modify: `djtoolkit/agent/executor.py`
- Test: `tests/test_executor_settings.py`

- [ ] **Step 1: Write tests for settings override behavior**

Create `tests/test_executor_settings.py`:

```python
"""Tests for payload.settings override in job executors."""

from copy import deepcopy
from djtoolkit.config import Config


def _make_cfg() -> Config:
    """Return a default Config for testing."""
    return Config()


class TestApplyDownloadSettings:
    """Test that download executor reads settings from payload."""

    def test_override_min_score(self):
        cfg = _make_cfg()
        assert cfg.matching.min_score == 0.86  # default
        assert cfg.matching.min_score_title == 0.70  # default

        from djtoolkit.agent.executor import _apply_download_settings
        _apply_download_settings(cfg, {"min_score": 0.5})
        assert cfg.matching.min_score == 0.5
        assert cfg.matching.min_score_title == 0.5

    def test_override_duration_tolerance(self):
        cfg = _make_cfg()
        from djtoolkit.agent.executor import _apply_download_settings
        _apply_download_settings(cfg, {"duration_tolerance_ms": 5000})
        assert cfg.matching.duration_tolerance_ms == 5000

    def test_override_search_timeout(self):
        cfg = _make_cfg()
        from djtoolkit.agent.executor import _apply_download_settings
        _apply_download_settings(cfg, {"search_timeout_sec": 30})
        assert cfg.soulseek.search_timeout_sec == 30

    def test_empty_settings_keeps_defaults(self):
        cfg = _make_cfg()
        original_score = cfg.matching.min_score
        from djtoolkit.agent.executor import _apply_download_settings
        _apply_download_settings(cfg, {})
        assert cfg.matching.min_score == original_score

    def test_missing_settings_key_keeps_defaults(self):
        """Backward compat: payload with no 'settings' key."""
        cfg = _make_cfg()
        original_score = cfg.matching.min_score
        from djtoolkit.agent.executor import _apply_download_settings
        _apply_download_settings(cfg, {})
        assert cfg.matching.min_score == original_score


class TestApplyCoverArtSettings:
    """Test that cover_art executor reads sources from payload."""

    def test_override_sources_with_name_mapping(self):
        from djtoolkit.agent.executor import _resolve_cover_art_sources
        cfg = _make_cfg()
        sources = _resolve_cover_art_sources(
            cfg, {"coverart_sources": ["coverartarchive", "itunes", "spotify"]}
        )
        assert sources == ["coverart", "itunes", "spotify"]

    def test_fallback_to_config_sources(self):
        from djtoolkit.agent.executor import _resolve_cover_art_sources
        cfg = _make_cfg()
        sources = _resolve_cover_art_sources(cfg, {})
        assert sources == ["coverart", "itunes", "deezer"]

    def test_unknown_sources_pass_through(self):
        from djtoolkit.agent.executor import _resolve_cover_art_sources
        cfg = _make_cfg()
        sources = _resolve_cover_art_sources(cfg, {"coverart_sources": ["newservice"]})
        assert sources == ["newservice"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `poetry run pytest tests/test_executor_settings.py -v`
Expected: FAIL — `_apply_download_settings` not found

- [ ] **Step 3: Add `_apply_download_settings` helper to `executor.py`**

In `djtoolkit/agent/executor.py`, add after the imports (after line 18):

```python
# ─── Payload settings helpers ────────────────────────────────────────────────

_COVER_ART_SOURCE_MAP = {"coverartarchive": "coverart"}


def _apply_download_settings(cfg: Config, settings: dict) -> None:
    """Override cfg matching/soulseek fields from payload settings."""
    if "min_score" in settings:
        cfg.matching.min_score = settings["min_score"]
        cfg.matching.min_score_title = settings["min_score"]
    if "duration_tolerance_ms" in settings:
        cfg.matching.duration_tolerance_ms = settings["duration_tolerance_ms"]
    if "search_timeout_sec" in settings:
        cfg.soulseek.search_timeout_sec = settings["search_timeout_sec"]


def _resolve_cover_art_sources(cfg: Config, settings: dict) -> list[str]:
    """Return cover art sources from payload settings or config fallback."""
    if "coverart_sources" in settings:
        return [_COVER_ART_SOURCE_MAP.get(s, s) for s in settings["coverart_sources"]]
    return [s.strip() for s in cfg.cover_art.sources.split() if s.strip()]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `poetry run pytest tests/test_executor_settings.py -v`
Expected: PASS (all 8 tests)

- [ ] **Step 5: Wire `_apply_download_settings` into `execute_download()`**

In `execute_download()` (starts at line 126), add as the first line of the function body, after the docstring (line 133) and before the lazy imports (line 134):

```python
    # Apply user settings from payload (overrides local config)
    _apply_download_settings(cfg, payload.get("settings", {}))
```

This must go before any code that reads `cfg.matching.*` or `cfg.soulseek.*`.

- [ ] **Step 6: Wire `_apply_download_settings` into `execute_download_batch()`**

In `execute_download_batch()` (starts at line 175), add after the docstring (line 193) and before the lazy imports (line 195). Read settings from the first job's payload:

```python
    # Apply user settings from first job's payload (single-user batches)
    first_payload = (jobs[0].get("payload") or {}) if jobs else {}
    _apply_download_settings(cfg, first_payload.get("settings", {}))
```

- [ ] **Step 7: Wire `_resolve_cover_art_sources` into `execute_cover_art()`**

In `execute_cover_art()` (line 334), replace the sources resolution line (line 354):

```python
    ca = cfg.cover_art
    sources = _resolve_cover_art_sources(cfg, payload.get("settings", {}))
```

Remove the old `sources = [s.strip() for s in ca.sources.split() if s.strip()]` line.

- [ ] **Step 8: Run full test suite**

Run: `poetry run pytest tests/test_executor_settings.py -v`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add djtoolkit/agent/executor.py tests/test_executor_settings.py
git commit -m "feat: agent reads tuning settings from job payload with config fallback"
```

---

### Task 6: End-to-end verification

- [ ] **Step 1: Verify TypeScript compilation**

Run: `cd web && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 2: Run Python tests**

Run: `poetry run pytest tests/test_executor_settings.py -v`
Expected: All pass

- [ ] **Step 3: Run JS tests**

Run: `cd web && npx vitest run lib/api-server/__tests__/job-settings.test.ts`
Expected: All pass

- [ ] **Step 4: Commit (if any fixups needed)**

```bash
git add -A
git commit -m "chore: fixups from end-to-end verification"
```
