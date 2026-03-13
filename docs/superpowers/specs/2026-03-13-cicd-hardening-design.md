# CI/CD + Security Hardening — Design Spec

**Date:** 2026-03-13
**Status:** Approved

---

## Overview

Two parallel goals addressed in a single implementation:

1. **CI/CD automation** — GitHub Actions workflows for testing, building Docker images (pushed to GHCR), deploying to Hetzner, and releasing the macOS installer.
2. **Security hardening** — Nginx headers + rate limiting, CORS narrowing, JWT audience validation, Spotify OAuth cleanup, CSV validation.

---

## CI/CD Design

### Strategy: Build in CI, pull on server

CI builds Docker images for both the FastAPI API and the Next.js web frontend, pushes them to GitHub Container Registry (GHCR). The Hetzner server never builds — it only pulls pre-built images and restarts containers.

**Image names:**
- `ghcr.io/OWNER/REPO/djtoolkit-api:latest` + `ghcr.io/OWNER/REPO/djtoolkit-api:<git-sha>`
- `ghcr.io/OWNER/REPO/djtoolkit-web:latest` + `ghcr.io/OWNER/REPO/djtoolkit-web:<git-sha>`

`OWNER/REPO` is `${{ github.repository }}` in Actions, lowercased for GHCR.

> **One image per environment.** `NEXT_PUBLIC_*` vars are baked into the JavaScript bundle at `next build` time — they cannot be injected at container runtime. Each deployment environment (e.g. staging vs production) requires a separate image built with the correct env var values. This project targets a single production environment, so one image set per deploy is correct.

---

### Files Changed

| File | Change |
|------|--------|
| `web/Dockerfile` | NEW — multi-stage Next.js build (deps → builder → runner) |
| `web/next.config.ts` | Add `output: 'standalone'` |
| `docker-compose.yml` | Add `web` + `nginx` services; switch `api` + `web` to pull from GHCR images |
| `nginx/djtoolkit.conf` | Update `proxy_pass` targets to service names; split routing; security headers; rate limiting |
| `.github/workflows/ci.yml` | Add `test-web` job with placeholder env vars |
| `.github/workflows/deploy.yml` | Rewrite: build + push to GHCR, then SSH pull + restart |
| `.github/workflows/release.yml` | Add `packages: write` permission; keep existing build matrix |

---

### `web/Dockerfile` (multi-stage)

```
Stage 1 — deps:
  base: node:20-alpine
  COPY package.json package-lock.json
  RUN npm ci --frozen-lockfile

Stage 2 — builder:
  base: node:20-alpine
  COPY --from=deps /app/node_modules
  COPY . .
  ARG NEXT_PUBLIC_SUPABASE_URL
  ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
  ARG NEXT_PUBLIC_API_URL
  ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
  ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY
  ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
  RUN npm run build

Stage 3 — runner:
  base: node:20-alpine
  COPY --from=builder /app/.next/standalone ./
  COPY --from=builder /app/.next/static ./.next/static
  COPY --from=builder /app/public ./public
  EXPOSE 3000
  ENV PORT=3000
  ENV HOSTNAME="0.0.0.0"
  CMD ["node", "server.js"]
```

`output: 'standalone'` in `next.config.ts` produces `.next/standalone/server.js` — a self-contained Node server with no full `node_modules` in the runtime image (~150MB vs ~600MB).

---

### `docker-compose.yml` — full service set

```yaml
services:
  api:
    image: ghcr.io/${GITHUB_REPOSITORY}/djtoolkit-api:${IMAGE_TAG:-latest}
    restart: unless-stopped
    expose: ["8000"]          # internal only — Nginx proxies
    env_file: .env
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 20s

  web:
    image: ghcr.io/${GITHUB_REPOSITORY}/djtoolkit-web:${IMAGE_TAG:-latest}
    restart: unless-stopped
    expose: ["3000"]          # internal only
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3000/"]
      interval: 30s
      timeout: 10s
      retries: 3

  nginx:
    image: nginx:alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx/djtoolkit.conf:/etc/nginx/conf.d/default.conf:ro
      - /etc/letsencrypt:/etc/letsencrypt:ro
    depends_on: [api, web]
```

`GITHUB_REPOSITORY` and `IMAGE_TAG` are set in a `.env` on the Hetzner server (see Rollback section).

---

### `nginx/djtoolkit.conf` — complete config

Key changes from current config:
1. `proxy_pass` targets change from `http://127.0.0.1:8000` to `http://api:8000` and `http://web:3000` (Docker service names)
2. Add `/` location proxying to `web:3000`
3. Preserve the existing `/api/pipeline/events` SSE block verbatim (buffering off, timeout 3600s) — do not remove it
4. Reduce global `client_max_body_size` from 20M to 1M; override to 11M only in the CSV import location
5. Add security headers to the `server` block (see Hardening)
6. Add rate limiting zones before the `server` block (see Hardening)

Routing summary:
```
location /api/pipeline/events  → proxy api:8000  (SSE: buffering off, cache off, timeout 3600s)
location /api/                  → proxy api:8000  (rate limit: api zone)
location /                      → proxy web:3000
```

---

### CI Workflow (`ci.yml`)

Two parallel jobs, both must pass before deploy is triggered:

```
permissions:
  contents: read

jobs:
  test-api:
    runs-on: ubuntu-latest
    steps: checkout → poetry 2.3.2 install → python 3.11 setup → poetry install → pytest

  test-web:
    runs-on: ubuntu-latest
    env:
      NEXT_PUBLIC_SUPABASE_URL: "https://placeholder.supabase.co"
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "placeholder-key"
      NEXT_PUBLIC_API_URL: "http://localhost:8000"
    steps: checkout → node 20 setup → npm ci → npm run build
```

The placeholder env vars are sufficient for type-checking and build validation — `next build` needs them present but not valid for a CI check. No secrets needed in `test-web`.

---

### Deploy Workflow (`deploy.yml`)

Trigger: `workflow_run` on the CI workflow, **only on success**:

```yaml
on:
  workflow_run:
    workflows: ["CI"]
    types: [completed]
    branches: [master]

permissions:
  contents: read
  packages: write    # required to push to GHCR

jobs:
  build-and-push:
    if: github.event.workflow_run.conclusion == 'success'   # CRITICAL: gate on CI success
    runs-on: ubuntu-latest
    steps:
      - checkout
      - docker/login-action → ghcr.io with GITHUB_TOKEN
      - docker/metadata-action → tags (latest + sha)
      - docker/build-push-action for api (Dockerfile at repo root)
      - docker/build-push-action for web (Dockerfile at web/, build-args from secrets)

  deploy:
    needs: build-and-push
    runs-on: ubuntu-latest
    steps:
      - appleboy/ssh-action:
          script: |
            cd /opt/djtoolkit
            export IMAGE_TAG="${{ github.event.workflow_run.head_sha }}"
            echo "GITHUB_REPOSITORY=${{ github.repository }}" > .deploy.env
            echo "IMAGE_TAG=${IMAGE_TAG}" >> .deploy.env
            docker compose --env-file .deploy.env pull
            docker compose --env-file .deploy.env up -d --remove-orphans
            docker system prune -f
```

GitHub Secrets required:
- `HETZNER_HOST`, `HETZNER_USER`, `HETZNER_SSH_KEY` (existing)
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_API_URL` (new — used in `build-and-push` as build-args)

---

### Rollback Procedure

To roll back to a previous deployment:

```bash
# SSH to Hetzner
ssh user@hetzner-host
cd /opt/djtoolkit

# Set image tag to a previous git SHA
echo "GITHUB_REPOSITORY=owner/djtoolkit" > .deploy.env
echo "IMAGE_TAG=<previous-sha>" >> .deploy.env

docker compose --env-file .deploy.env pull
docker compose --env-file .deploy.env up -d
```

Previous SHA images are retained in GHCR (both `latest` and `<sha>` tags are pushed on every deploy). GHCR does not auto-delete tagged images.

---

### Release Workflow (`release.yml`)

Add `packages: write` permission (required for GHCR push, though release.yml doesn't push images — added for consistency and future use).

The existing build matrix (`macos-14` = arm64, `macos-13` = x86_64) is correct.

`build.sh` already produces `djtoolkit-{VERSION}-{ARCH}.dmg` (e.g. `djtoolkit-1.0.0-arm64.dmg`). No change to `build.sh` needed. The `release.yml` upload glob `files: "*.dmg"` correctly picks up both arch-specific files.

---

## Security Hardening

### Nginx (`nginx/djtoolkit.conf`)

**Security headers** (add to `server` block, `always` so they apply on error responses):

```nginx
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
add_header X-Content-Type-Options    "nosniff"                             always;
add_header X-Frame-Options           "DENY"                                always;
add_header Referrer-Policy           "strict-origin-when-cross-origin"     always;
add_header Content-Security-Policy   "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https://*.supabase.co;" always;
```

**Rate limiting** (add before `server` block):

```nginx
limit_req_zone $binary_remote_addr zone=api:10m    rate=30r/m;
limit_req_zone $binary_remote_addr zone=auth:10m   rate=10r/m;
limit_req_zone $binary_remote_addr zone=upload:10m rate=5r/m;
```

Applied per location:
- `/api/auth/*` → `limit_req zone=auth burst=5 nodelay;`
- `/api/catalog/import/*` → `limit_req zone=upload burst=2 nodelay;` + `client_max_body_size 11M;`
- `/api/*` (catch-all) → `limit_req zone=api burst=20 nodelay;`

Default global `client_max_body_size` reduced from current 20M to 1M. The existing 20M was over-permissive; the only large upload endpoint is CSV import at `/api/catalog/import/csv` (API-enforced 10MB limit + Nginx 11MB). No other current upload endpoint exists.

---

### FastAPI app (`djtoolkit/api/app.py`)

Narrow CORS from wildcards to explicit values:

```python
allow_methods=["GET", "POST", "PUT", "DELETE"],
allow_headers=["Content-Type", "Authorization"],
```

---

### JWT verification (`djtoolkit/api/auth.py`)

Enable audience validation. Supabase JWTs carry `aud: "authenticated"` for logged-in users.

```python
_EXPECTED_AUD = os.environ.get("SUPABASE_JWT_AUDIENCE", "authenticated")

payload = jwt.decode(
    token,
    _get_public_key(),
    algorithms=["ES256"],
    audience=_EXPECTED_AUD,
    # Remove: options={"verify_aud": False}
)
```

**Affected call sites** — both must be updated (not just `auth.py`):
1. `djtoolkit/api/auth.py` → `verify_jwt()` — remove `options={"verify_aud": False}`
2. `djtoolkit/api/spotify_auth_routes.py` — calls `verify_jwt(token)` directly on the `token` query parameter in `GET /auth/spotify/connect`. This token is a Supabase JWT from the logged-in web user and will carry `aud="authenticated"`, so enabling validation here is correct — but the implementor must verify this and not accidentally miss this call site.

Add `SUPABASE_JWT_AUDIENCE=authenticated` to `.env.example`.

---

### Spotify OAuth state cleanup (`djtoolkit/api/spotify_auth_routes.py`)

Add background asyncio task, started in the FastAPI lifespan (alongside the existing stale job sweeper in `app.py`):

```python
async def _cleanup_expired_states():
    while True:
        await asyncio.sleep(300)
        now = time.time()
        for k in [k for k, v in _state_store.items() if v["expires_at"] < now]:
            _state_store.pop(k, None)
```

`return_to` open redirect fix — validate on the **URL-decoded** value before storing in state:

```python
import urllib.parse
decoded_return_to = urllib.parse.unquote(return_to)
if "://" in decoded_return_to or decoded_return_to.startswith("//") or decoded_return_to.startswith("/\\"):
    return_to = "/"
```

---

### API Dockerfile (`Dockerfile`)

Fix deprecated Poetry flag: `--no-dev` → `--without dev` (Poetry 2.x, consistent with the pinned `poetry==2.3.2` in CI).

---

### CSV upload validation (`djtoolkit/api/catalog_routes.py`)

Keep `text/plain` and `application/octet-stream` in the content-type allowlist (real-world browsers and Windows clients use these for CSV exports). Add filename extension check as the primary guard:

```python
ALLOWED_CSV_TYPES = {"text/csv", "application/csv", "text/plain", "application/octet-stream"}

if file.content_type not in ALLOWED_CSV_TYPES:
    raise HTTPException(400, "Unsupported file type")
if file.filename and not file.filename.lower().endswith(".csv"):
    raise HTTPException(400, "File must have a .csv extension")
```

---

## Verification Checklist

1. **CI gate** — push a commit with a TypeScript error in `web/`; confirm `test-web` job fails and deploy does NOT trigger
2. **CI gate** — push a failing pytest; confirm `test-api` fails and deploy does NOT trigger
3. **Images in GHCR** — merge to master with passing CI; confirm both images appear in GHCR with `latest` + SHA tags
4. **Hetzner running new SHA** — `docker ps` on server shows new image SHA after deploy
5. **Rollback** — update `.deploy.env` to previous SHA, `docker compose pull + up -d`; verify old version serves
6. **Rate limiting** — send >30 req/min to `/api/` from one IP; confirm 429 response
7. **HSTS** — `curl -I https://yourdomain.com` includes `Strict-Transport-Security`
8. **JWT audience** — send a valid JWT with `aud: "service_role"` to a protected endpoint; confirm 401
9. **OAuth open redirect** — call `/api/auth/spotify/connect?token=...&return_to=//evil.com`; confirm `return_to` is sanitized to `/`
10. **CSV extension check** — POST a `.txt` file with valid CSV content to `/api/catalog/import/csv`; confirm 400
11. **Nginx proxy** — both `/api/health` (FastAPI) and `/` (Next.js) respond correctly
12. **macOS release** — push a `v*` tag; confirm `djtoolkit-{version}-arm64.dmg` and `djtoolkit-{version}-x86_64.dmg` appear in GitHub release assets
