# Security Backlog

Findings from the security audit on 2026-03-19. Critical and high issues have been fixed.
Remaining items ordered by priority.

---

## Medium

### SEC-01: PostgREST filter injection in search
- **Files:** `web/app/api/catalog/tracks/route.ts:89`, `web/app/api/pipeline/tracks/route.ts:43`
- **Issue:** User `search` param interpolated directly into `.or()` filter string. Crafted input (e.g. `%,user_id.eq.OTHER_UUID`) could inject filter conditions.
- **Fix:** Sanitize PostgREST special chars (`,`, `.`, `(`, `)`) or use `.ilike()` with separate filter calls instead of raw `.or()` string interpolation.

### SEC-02: IDOR — Agent DELETE orphans other users' pipeline_jobs
- **File:** `web/app/api/agents/[id]/route.ts:25`
- **Issue:** `pipeline_jobs` cleanup (`SET agent_id = null`) is not scoped by `user_id`.
- **Fix:** Add `.eq("user_id", user.userId)` to the update query.

### SEC-03: Rate limiting completely disabled
- **File:** `web/lib/api-server/rate-limit.ts`
- **Issue:** All rate limiting is a no-op stub. Auth endpoints, bulk operations, and write-heavy routes are open to abuse.
- **Fix:** Re-enable Upstash or in-memory rate limiting before public deployment.

### SEC-04: Pipeline track retry leaks existence via 403 vs 404
- **File:** `web/app/api/pipeline/tracks/[id]/retry/route.ts:21`
- **Issue:** Fetches track without `user_id` scoping, then returns 403 for other users' tracks instead of indistinguishable 404.
- **Fix:** Add `.eq("user_id", user.userId)` to the initial query and return 404 for both not-found and not-owned.

### SEC-05: Pillow pinned at ^10.0 — multiple CVEs in 10.x
- **File:** `pyproject.toml`
- **Issue:** Pillow 10.4.0 is two majors behind (latest 12.1.1) with heap buffer overflow fixes in 11.x/12.x.
- **Fix:** Update to `Pillow = "^12.0"` and run `uv lock --upgrade-package pillow`.

### SEC-06: Weak Supabase password policy
- **File:** `supabase/config.toml:175`
- **Issue:** `minimum_password_length = 6`, no complexity requirements, `secure_password_change = false`, `enable_confirmations = false`.
- **Fix:** Set min 8 chars, add `password_requirements = "lower_upper_letters_digits"`, enable secure password change and email confirmations for production.

---

## Low

### SEC-07: Spotify error response body logged
- **File:** `web/app/api/auth/spotify/callback/route.ts:90`
- **Issue:** Full response body logged on token exchange failure — may contain sensitive OAuth details in Vercel runtime logs.
- **Fix:** Log only the status code, not the body.

### SEC-08: Supabase error messages leaked to clients
- **Files:** `web/app/api/pipeline/tracks/route.ts:53`, `web/app/api/pipeline/tracks/bulk/route.ts` (multiple), `web/app/api/catalog/import/spotify/route.ts:197`
- **Issue:** `error.message` from Supabase returned in HTTP responses, exposing table names, column names, constraint details.
- **Fix:** Return generic "Internal server error" and log the real error server-side.

### SEC-09: `.vercel/` directory not gitignored
- **Issue:** Contains Vercel project/org IDs, could be accidentally staged.
- **Fix:** Add `.vercel/` to `.gitignore`.

### SEC-10: `*.pkg` and `djtoolkit-ui/` not gitignored
- **Issue:** Untracked files that could be accidentally committed.
- **Fix:** Add `*.pkg` and `djtoolkit-ui/` to `.gitignore`.

### SEC-11: Job claim race condition (TOCTOU)
- **Files:** `web/app/api/pipeline/jobs/[id]/claim/route.ts`, `web/app/api/pipeline/jobs/batch/claim/route.ts`
- **Issue:** Two-step SELECT-then-UPDATE claim pattern; concurrent agents could claim the same job.
- **Fix:** Implement a PostgreSQL function using `FOR UPDATE SKIP LOCKED` and call via `.rpc()`.

### SEC-12: Open user signups enabled
- **File:** `supabase/config.toml:169`
- **Issue:** `enable_signup = true` allows anyone to create an account.
- **Fix:** Set `enable_signup = false` if not intended for public registration, or add invite/allowlist.

### SEC-13: Click/Typer version constraint stale
- **File:** `pyproject.toml`
- **Issue:** Click pinned `<8.2.0` due to old Typer incompatibility. Typer is now at 0.24+ which supports Click 8.2+.
- **Fix:** Update `typer = "^0.24"` and remove the explicit `click` pin.

### SEC-14: `python-multipart` version constraint too narrow
- **File:** `pyproject.toml`
- **Issue:** `^0.0.22` means `>=0.0.22,<0.0.23` in Poetry — blocks future minor versions.
- **Fix:** Change to `python-multipart = ">=0.0.22"`.

### SEC-15: ~~Docker pip install without hash pinning~~ (Resolved)
- **Status:** Fixed — Poetry replaced by uv. uv binary is copied from official container image (`ghcr.io/astral-sh/uv`), no pip install needed.

---

## Informational (no action needed)

- **Supabase project ref in git history** — cleaned in `516c120`, still in history. Low risk while repo is private.
- **CLI uses service_role key** — by design for local CLI. Document that it must never be shared.
- **RLS uses `current_setting()` pattern** — works but non-standard. Consider migrating to `auth.uid()` for consistency.
- **Audit logs not append-only** — consider `REVOKE UPDATE, DELETE ON audit_logs FROM service_role`.
