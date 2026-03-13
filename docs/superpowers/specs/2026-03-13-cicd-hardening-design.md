# CI/CD + Security Hardening — Design Spec

**Date:** 2026-03-13
**Status:** Approved

---

## Overview

Two parallel goals addressed in a single implementation:

1. **CI/CD automation** — GitHub Actions workflows for testing, building Docker images (pushed to GHCR), deploying to Hetzner, and releasing the macOS installer.
2. **Security hardening** — Nginx headers + rate limiting, CORS narrowing, JWT audience validation, Spotify OAuth cleanup, CSV content-type whitelist.

---

## CI/CD Design

### Strategy: Build in CI, pull on server (Approach B)

CI builds Docker images for both the FastAPI API and the Next.js web frontend, pushes them to GitHub Container Registry (GHCR). The Hetzner server never builds — it only pulls pre-built images and restarts containers. This keeps the server lean and makes deploys fast and reproducible.

**Image names:**
- `ghcr.io/OWNER/djtoolkit-api:latest` + `ghcr.io/OWNER/djtoolkit-api:<git-sha>`
- `ghcr.io/OWNER/djtoolkit-web:latest` + `ghcr.io/OWNER/djtoolkit-web:<git-sha>`

SHA tags enable rollback: `docker pull ghcr.io/.../djtoolkit-api:<previous-sha>`.

---

### Files Changed

| File | Change |
|------|--------|
| `web/Dockerfile` | NEW — multi-stage Next.js build (deps → builder → runner) |
| `web/next.config.ts` | Add `output: 'standalone'` |
| `docker-compose.yml` | Add `web` service; switch `api` + `web` to pull from GHCR images |
| `nginx/djtoolkit.conf` | Split routing + security headers + rate limiting (see Hardening) |
| `.github/workflows/ci.yml` | Add `test-web` job (type-check + Next.js build) |
| `.github/workflows/deploy.yml` | Rewrite: build + push to GHCR, then SSH pull + restart |
| `.github/workflows/release.yml` | Minor: consistent artifact naming, explicit version |

---

### `web/Dockerfile` (multi-stage)

```
Stage 1 — deps:    node:20-alpine, install node_modules from package-lock.json
Stage 2 — builder: copy source + deps, run `next build` (requires NEXT_PUBLIC_* build args)
Stage 3 — runner:  node:20-alpine, copy .next/standalone + .next/static, run `node server.js`
```

`output: 'standalone'` in `next.config.ts` produces a self-contained `.next/standalone/` directory with a minimal `server.js` — no full `node_modules` in the runtime image. Results in a ~150MB image vs ~600MB without standalone.

Build args needed at image build time (injected by CI, values from GitHub Secrets):
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `NEXT_PUBLIC_API_URL`

> Note: `NEXT_PUBLIC_*` vars are baked into the browser bundle at build time by Next.js. They are not secrets (all are public-safe), but must be available when `next build` runs.

---

### `docker-compose.yml` changes

Add `web` service alongside existing `api`:

```yaml
services:
  api:
    image: ghcr.io/${GITHUB_REPOSITORY}/djtoolkit-api:${IMAGE_TAG:-latest}
    restart: unless-stopped
    expose: ["8000"]      # internal only — Nginx proxies externally
    env_file: .env
    healthcheck: ...

  web:
    image: ghcr.io/${GITHUB_REPOSITORY}/djtoolkit-web:${IMAGE_TAG:-latest}
    restart: unless-stopped
    expose: ["3000"]      # internal only
    env_file: .env
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3000/"]

  nginx:
    image: nginx:alpine
    restart: unless-stopped
    ports: ["80:80", "443:443"]
    volumes:
      - ./nginx/djtoolkit.conf:/etc/nginx/conf.d/default.conf:ro
      - /etc/letsencrypt:/etc/letsencrypt:ro
    depends_on: [api, web]
```

Move port binding to Nginx service. API and web are internal-only (`expose`, not `ports`).

---

### `nginx/djtoolkit.conf` routing split

```
location /api/pipeline/events  → proxy api:8000 (SSE: buffering off, timeout 3600s)
location /api/                  → proxy api:8000
location /                      → proxy web:3000
```

All three locations get standard proxy headers (`Host`, `X-Real-IP`, `X-Forwarded-For`, `X-Forwarded-Proto`).

---

### CI Workflow (`ci.yml`)

Two parallel jobs:

```
test-api:
  runs-on: ubuntu-latest
  steps: checkout → poetry install → pytest

test-web:
  runs-on: ubuntu-latest
  steps: checkout → node 20 setup → npm ci → next build (type errors fail the build)
```

Both must pass before deploy proceeds.

---

### Deploy Workflow (`deploy.yml`)

Trigger: push to `master`, only after CI passes (`workflow_run: ci / completed / success`).

Two sequential jobs:

```
build-and-push:
  runs-on: ubuntu-latest
  steps:
    - checkout
    - docker/login-action → ghcr.io (GITHUB_TOKEN)
    - docker/build-push-action → djtoolkit-api (tags: latest + sha)
    - docker/build-push-action → djtoolkit-web (tags: latest + sha, build-args: NEXT_PUBLIC_*)

deploy:
  needs: build-and-push
  runs-on: ubuntu-latest
  steps:
    - appleboy/ssh-action:
        script: |
          cd /opt/djtoolkit
          echo "IMAGE_TAG=${GITHUB_SHA}" > .image-tag.env
          docker compose pull
          docker compose up -d --remove-orphans
          docker system prune -f
```

GitHub Secrets required:
- `HETZNER_HOST`, `HETZNER_USER`, `HETZNER_SSH_KEY` (existing)
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_API_URL` (new)

---

### Release Workflow (`release.yml`)

Existing workflow is mostly correct. Minor changes:
- Explicit `VERSION` extraction: `${GITHUB_REF_NAME#v}` (already present, keep)
- Artifact naming: `djtoolkit-${VERSION}-arm64.dmg` and `djtoolkit-${VERSION}-x86_64.dmg` (make arch explicit in filename)
- No changes to the build matrix (macos-14 = arm64, macos-13 = x86_64 is correct)

---

## Security Hardening

### Nginx (`nginx/djtoolkit.conf`)

**Security headers** (add to `server` block, `always` so they apply on error responses too):

```nginx
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
add_header X-Content-Type-Options    "nosniff"                             always;
add_header X-Frame-Options           "DENY"                                always;
add_header Referrer-Policy           "strict-origin-when-cross-origin"     always;
add_header Content-Security-Policy   "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https://*.supabase.co;" always;
```

**Rate limiting** (add before `server` block):

```nginx
limit_req_zone $binary_remote_addr zone=api:10m     rate=30r/m;
limit_req_zone $binary_remote_addr zone=auth:10m    rate=10r/m;
limit_req_zone $binary_remote_addr zone=upload:10m  rate=5r/m;

# Applied per location:
# /api/auth/*  → limit_req zone=auth burst=5 nodelay;
# /api/catalog/import/* → limit_req zone=upload burst=2 nodelay;
# /api/*       → limit_req zone=api burst=20 nodelay;
```

**Body size** — tighten default, override for CSV upload:

```nginx
client_max_body_size 1M;   # default
# /api/catalog/import/csv location: client_max_body_size 11M;
```

---

### FastAPI app (`djtoolkit/api/app.py`)

Narrow CORS from wildcards:

```python
allow_methods=["GET", "POST", "PUT", "DELETE"],
allow_headers=["Content-Type", "Authorization"],
```

---

### JWT verification (`djtoolkit/api/auth.py`)

Enable audience validation. Supabase JWTs carry `aud: "authenticated"` for logged-in users. Read expected audience from env:

```python
_EXPECTED_AUD = os.environ.get("SUPABASE_JWT_AUDIENCE", "authenticated")

payload = jwt.decode(
    token,
    _get_public_key(),
    algorithms=["ES256"],
    audience=_EXPECTED_AUD,
)
# Remove options={"verify_aud": False}
```

Add `SUPABASE_JWT_AUDIENCE=authenticated` to `.env.example`.

---

### Spotify OAuth state cleanup (`djtoolkit/api/spotify_auth_routes.py`)

Add a background cleanup task to evict expired state tokens (prevents unbounded dict growth):

```python
async def _cleanup_expired_states():
    while True:
        await asyncio.sleep(300)   # every 5 minutes
        now = time.time()
        expired = [k for k, v in _state_store.items() if v["expires_at"] < now]
        for k in expired:
            _state_store.pop(k, None)
```

Start the task in the FastAPI lifespan alongside the existing stale job sweeper.

Add `return_to` path validation to prevent open redirect:

```python
# Reject anything that looks like an absolute URL
if "://" in return_to or return_to.startswith("//"):
    return_to = "/"
```

---

### CSV upload content-type (`djtoolkit/api/catalog_routes.py`)

Narrow allowed MIME types and add extension check:

```python
ALLOWED_CSV_TYPES = {"text/csv", "application/csv"}

if file.content_type not in ALLOWED_CSV_TYPES:
    raise HTTPException(400, "File must be a CSV (text/csv or application/csv)")
if file.filename and not file.filename.lower().endswith(".csv"):
    raise HTTPException(400, "File must have a .csv extension")
```

---

## Secrets in CI

All secrets are injected at runtime — never baked into images:
- `.env` on the Hetzner server holds runtime secrets (DB URL, JWT keys, Fernet key, etc.)
- `NEXT_PUBLIC_*` vars are build-time only (safe to expose; baked into browser bundle)
- GitHub Secrets hold CI-time values only

---

## Verification Checklist

1. `ci.yml` — push a commit with a TypeScript error in `web/`; confirm `test-web` job fails
2. `deploy.yml` — push to master; confirm both images appear in GHCR; confirm `docker ps` on Hetzner shows new SHA
3. Rollback — update `.image-tag.env` on server to previous SHA, `docker compose up -d`; verify old version serves
4. Nginx rate limiting — send >30 req/min to `/api/` from one IP; confirm 429 response
5. HSTS — confirm `Strict-Transport-Security` header present in `curl -I https://...`
6. JWT audience — send a JWT with `aud: "service_role"` to a protected endpoint; confirm 401
7. OAuth open redirect — call `/api/auth/spotify/connect?return_to=//evil.com`; confirm redirect goes to `/`
8. CSV content-type — POST a `.txt` file to `/api/catalog/import/csv`; confirm 400
9. macOS release — push a `v*` tag; confirm two `.dmg` artifacts created in GitHub release
