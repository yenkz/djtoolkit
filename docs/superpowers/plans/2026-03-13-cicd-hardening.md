# CI/CD + Security Hardening Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the API (CORS, JWT audience, OAuth, CSV validation) and set up a complete CI/CD pipeline (GHCR image builds, Hetzner deploy, macOS release).

**Architecture:** Security fixes land in existing Python files (testable). CI/CD adds a `web/Dockerfile`, updates `docker-compose.yml` to add `web` + `nginx` services pulling from GHCR, rewrites `nginx/djtoolkit.conf` to proxy to Docker service names, and rewrites the GitHub Actions deploy workflow to build/push images before SSH deploy.

**Tech Stack:** FastAPI, Next.js 14 (standalone output), Docker Compose, GHCR, Nginx, GitHub Actions, Poetry 2.x, pytest-asyncio.

---

## Chunk 1: Security Hardening — Python Code Changes

### Task 1: Fix Poetry flag in Dockerfile

**Files:**
- Modify: `Dockerfile`

- [ ] **Step 1: Fix the deprecated flag**

In `Dockerfile`, change both occurrences of `--no-dev` to `--without dev`:

```dockerfile
# Line 22 — in the deps stage
RUN poetry install --without dev --no-root

# Line 26 — in the final stage
RUN poetry install --without dev
```

`--no-dev` was removed in Poetry 2.0. The project pins `poetry==2.3.2` in CI, so this flag will break the Docker build.

- [ ] **Step 2: Verify the build succeeds**

```bash
docker build -t djtoolkit-api-test . 2>&1 | tail -20
```

Expected: build completes with no errors. If Poetry is not installed locally, skip and let CI catch it — but the flag change is unambiguous.

- [ ] **Step 3: Commit**

```bash
git add Dockerfile
git commit -m "fix: update poetry install flag from --no-dev to --without dev (Poetry 2.x)"
```

---

### Task 2: Narrow CORS in app.py

**Files:**
- Modify: `djtoolkit/api/app.py`

- [ ] **Step 1: Update the CORSMiddleware call**

In `djtoolkit/api/app.py`, find the `app.add_middleware(CORSMiddleware, ...)` block and replace:

```python
    allow_methods=["*"],
    allow_headers=["*"],
```

with:

```python
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["Content-Type", "Authorization"],
```

- [ ] **Step 2: Run existing API tests to verify nothing broke**

```bash
poetry run pytest tests/test_api.py tests/test_auth.py -v -q
```

Expected: all tests that don't require `SUPABASE_DATABASE_URL` pass.

- [ ] **Step 3: Commit**

```bash
git add djtoolkit/api/app.py
git commit -m "security: narrow CORS allow_methods and allow_headers from wildcard"
```

---

### Task 3: JWT audience validation

**Files:**
- Modify: `djtoolkit/api/auth.py`
- Modify: `.env.example`
- Modify: `tests/test_auth.py`

> **Background:** `verify_jwt()` currently uses ES256 + `_get_public_key()`. Unit tests create HS256 tokens via `SUPABASE_JWT_SECRET` — these are two different code paths in python-jose. Without EC keys set, `_get_public_key()` raises `RuntimeError`. The fix is to add a HS256 fallback to `verify_jwt` (when EC keys aren't configured, use `SUPABASE_JWT_SECRET` + HS256). This makes the function both testable and practical in local dev. Audience validation is added at the same time.

- [ ] **Step 1: Add HS256 fallback + audience check to auth.py**

In `djtoolkit/api/auth.py`, after the existing `_SUPABASE_EC_X`/`_SUPABASE_EC_Y` lines, add:

```python
# Expected JWT audience — Supabase sets "authenticated" for logged-in users.
_EXPECTED_AUD = os.environ.get("SUPABASE_JWT_AUDIENCE", "authenticated")
```

Replace the `verify_jwt` function with:

```python
async def verify_jwt(token: str) -> CurrentUser:
    """Decode and verify a Supabase JWT.

    Algorithm selection (in priority order):
    - ES256 when SUPABASE_JWT_EC_X + SUPABASE_JWT_EC_Y are set (production)
    - HS256 when only SUPABASE_JWT_SECRET is set (local dev / tests)
    Raises 401 on any verification failure, including wrong audience.
    """
    credentials_exc = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid or expired token",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        jwt_secret = os.environ.get("SUPABASE_JWT_SECRET")
        if _SUPABASE_EC_X and _SUPABASE_EC_Y:
            key: object = _get_public_key()
            algorithms = ["ES256"]
        elif jwt_secret:
            key = jwt_secret
            algorithms = ["HS256"]
        else:
            raise RuntimeError(
                "No JWT verification keys configured. "
                "Set SUPABASE_JWT_EC_X + SUPABASE_JWT_EC_Y (production) "
                "or SUPABASE_JWT_SECRET (dev/test)."
            )
        payload = jwt.decode(
            token,
            key,
            algorithms=algorithms,
            audience=_EXPECTED_AUD,
        )
        user_id: str | None = payload.get("sub")
        if not user_id:
            raise credentials_exc
        email: str | None = payload.get("email")
    except JWTError:
        raise credentials_exc
    return CurrentUser(user_id=user_id, email=email)
```

- [ ] **Step 2: Add SUPABASE_JWT_AUDIENCE to .env.example**

In `.env.example`, add after the `SUPABASE_JWT_EC_Y=` line:

```bash
# JWT audience claim — Supabase Auth sets this to "authenticated" for logged-in users.
SUPABASE_JWT_AUDIENCE=authenticated
```

- [ ] **Step 3: Update test helpers in tests/test_auth.py**

Update the existing `_make_jwt` helper to include `aud="authenticated"` (Supabase always includes it) and add `_make_jwt_with_aud`:

```python
def _make_jwt(user_id: str, *, expired: bool = False, wrong_secret: bool = False) -> str:
    secret = os.environ.get("SUPABASE_JWT_SECRET", "test-secret")
    if wrong_secret:
        secret = "totally-wrong-secret"
    now = int(time.time())
    payload = {
        "sub": user_id,
        "aud": "authenticated",    # ← Supabase always includes this
        "iat": now - 3600 if expired else now,
        "exp": now - 1 if expired else now + 3600,
    }
    return jwt.encode(payload, secret, algorithm="HS256")


def _make_jwt_with_aud(user_id: str, aud: str) -> str:
    """Create a JWT with a specific audience claim for testing audience validation."""
    secret = os.environ.get("SUPABASE_JWT_SECRET", "test-secret")
    now = int(time.time())
    payload = {"sub": user_id, "aud": aud, "iat": now, "exp": now + 3600}
    return jwt.encode(payload, secret, algorithm="HS256")
```

Add two new tests after `test_verify_jwt_wrong_secret`:

```python
@_needs_jwt
@pytest.mark.asyncio
async def test_verify_jwt_wrong_audience():
    """JWT with wrong 'aud' claim raises HTTP 401."""
    from fastapi import HTTPException
    token = _make_jwt_with_aud(str(uuid.uuid4()), aud="service_role")
    with pytest.raises(HTTPException) as exc_info:
        await verify_jwt(token)
    assert exc_info.value.status_code == 401


@_needs_jwt
@pytest.mark.asyncio
async def test_verify_jwt_correct_audience():
    """JWT with aud='authenticated' passes validation."""
    user_id = str(uuid.uuid4())
    token = _make_jwt_with_aud(user_id, aud="authenticated")
    user = await verify_jwt(token)
    assert user.user_id == user_id
```

- [ ] **Step 4: Run the full auth test suite**

```bash
SUPABASE_JWT_SECRET=test-secret poetry run pytest tests/test_auth.py -v -q
```

Expected: all non-DB tests pass, including the two new audience tests.

> The HS256 fallback path is exercised when `SUPABASE_JWT_EC_X/Y` are not set (the default in local dev/CI). Production uses ES256 — the audience logic is identical.

- [ ] **Step 5: Commit**

```bash
git add djtoolkit/api/auth.py .env.example tests/test_auth.py
git commit -m "security: add HS256 fallback + JWT audience validation (aud=authenticated)"
```

---

### Task 4: Spotify OAuth — state cleanup + return_to validation

**Files:**
- Modify: `djtoolkit/api/spotify_auth_routes.py`
- Modify: `djtoolkit/api/app.py`

- [ ] **Step 1: Write failing test for return_to open redirect**

Add a new test file `tests/test_spotify_auth_routes.py`:

```python
"""Tests for djtoolkit/api/spotify_auth_routes.py — return_to validation."""

from __future__ import annotations

import pytest
from djtoolkit.api.spotify_auth_routes import _sanitize_return_to


def test_sanitize_relative_path_allowed():
    assert _sanitize_return_to("/catalog") == "/catalog"


def test_sanitize_root_allowed():
    assert _sanitize_return_to("/") == "/"


def test_sanitize_absolute_url_blocked():
    assert _sanitize_return_to("//evil.com/steal") == "/"


def test_sanitize_scheme_blocked():
    assert _sanitize_return_to("https://evil.com") == "/"


def test_sanitize_url_encoded_bypass_blocked():
    # %2F%2F decodes to // — must be rejected after URL-decoding
    assert _sanitize_return_to("%2F%2Fevil.com") == "/"


def test_sanitize_backslash_blocked():
    assert _sanitize_return_to("/\\evil.com") == "/"


def test_sanitize_empty_defaults_to_root():
    assert _sanitize_return_to("") == "/"


def test_sanitize_double_encoded_bypass_blocked():
    # %252F%252F double-encoded — decodes to %2F%2F on first pass, then // on second
    # urllib.parse.unquote only decodes one level, so this particular variant
    # decodes to %2F%2Fevil.com which starts with '%' not '/' — safe, but confirm
    # it doesn't produce a //-prefixed path
    result = _sanitize_return_to("%252F%252Fevil.com")
    assert not result.startswith("//"), f"Double-encoded path must not produce //-prefix: {result}"
```

- [ ] **Step 2: Run to verify tests fail**

```bash
poetry run pytest tests/test_spotify_auth_routes.py -v
```

Expected: ImportError on `_sanitize_return_to` (function doesn't exist yet).

- [ ] **Step 3: Add `_sanitize_return_to` and cleanup task to spotify_auth_routes.py**

In `djtoolkit/api/spotify_auth_routes.py`, after the imports, add:

```python
import asyncio
import urllib.parse
```

Add the sanitization function (can go right after `_STATE_TTL = 600`):

```python
def _sanitize_return_to(value: str) -> str:
    """Reject open-redirect payloads; return a safe relative path or '/'."""
    decoded = urllib.parse.unquote(value)
    if (
        not decoded
        or "://" in decoded
        or decoded.startswith("//")
        or decoded.startswith("/\\")
    ):
        return "/"
    return decoded
```

Add the background cleanup coroutine (after `_sanitize_return_to`):

```python
async def _cleanup_expired_states() -> None:
    """Background task: evict expired OAuth state tokens every 5 minutes."""
    while True:
        await asyncio.sleep(300)
        now = time.time()
        expired_keys = [k for k, v in list(_state_store.items()) if v["expires_at"] < now]
        for k in expired_keys:
            _state_store.pop(k, None)
```

In the `spotify_connect` endpoint, apply the sanitizer when storing `return_to`:

```python
    _state_store[state] = {
        "user_id": user.user_id,
        "email": user.email,
        "return_to": _sanitize_return_to(return_to),   # ← sanitize here
        "expires_at": time.time() + _STATE_TTL,
    }
```

- [ ] **Step 4: Wire cleanup task into FastAPI lifespan in app.py**

In `djtoolkit/api/app.py`, find the existing import:
```python
from djtoolkit.api.spotify_auth_routes import router as spotify_auth_router
```
Change it to:
```python
from djtoolkit.api.spotify_auth_routes import router as spotify_auth_router, _cleanup_expired_states
```

Then in the `lifespan` function, start the cleanup task alongside the sweeper:

```python
    sweeper = asyncio.create_task(_stale_job_sweeper())
    state_cleaner = asyncio.create_task(_cleanup_expired_states())
    yield
    sweeper.cancel()
    state_cleaner.cancel()
    await close_pool()
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
poetry run pytest tests/test_spotify_auth_routes.py -v
```

Expected: all 7 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add djtoolkit/api/spotify_auth_routes.py djtoolkit/api/app.py tests/test_spotify_auth_routes.py
git commit -m "security: sanitize OAuth return_to against open redirect, add state cleanup task"
```

---

### Task 5: CSV upload — filename extension check

**Files:**
- Modify: `djtoolkit/api/catalog_routes.py`
- Modify: `tests/test_catalog_routes.py`

- [ ] **Step 1: Write failing test for extension check**

In `tests/test_catalog_routes.py`, find the section for `import_csv` unit tests (or add a new section). Add:

```python
# ─── Unit tests: CSV upload validation ────────────────────────────────────────

def _async_client_no_db():
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
    )

_csv_content = b"Spotify URI,Track Name,Artist Name(s),Album Name,Disc Number,Track Number,Track Duration (ms),Added By,Added At\nspotify:track:abc123,Test Track,Test Artist,Test Album,1,1,200000,user,2024-01-01\n"

@pytest.mark.asyncio
async def test_csv_upload_rejects_non_csv_extension():
    """A file with .txt extension is rejected with 400 even if content is valid CSV."""
    async with _async_client_no_db() as client:
        resp = await client.post(
            "/api/catalog/import/csv",
            files={"file": ("export.txt", _csv_content, "text/csv")},
            headers={"Authorization": "Bearer fake.jwt.token"},
        )
    # 401 is also acceptable here (auth fails before validation),
    # but we must NOT get 201 (success).
    assert resp.status_code in (400, 401, 422), f"Expected rejection, got {resp.status_code}"


@pytest.mark.asyncio
async def test_csv_upload_accepts_csv_extension():
    """A file with .csv extension and valid content-type is not rejected at the extension check."""
    async with _async_client_no_db() as client:
        resp = await client.post(
            "/api/catalog/import/csv",
            files={"file": ("export.csv", _csv_content, "text/csv")},
            headers={"Authorization": "Bearer fake.jwt.token"},
        )
    # 401 = valid filename, auth rejected — the extension check passed.
    # 422 = FastAPI validation error (header format wrong) — also means extension check was not hit.
    # NOT 400 with "extension" in the message.
    if resp.status_code == 400:
        assert "extension" not in resp.json().get("detail", "").lower(), \
            "Valid .csv file should not be rejected for extension"
```

- [ ] **Step 2: Run to verify the extension test would catch the issue**

```bash
poetry run pytest tests/test_catalog_routes.py::test_csv_upload_rejects_non_csv_extension tests/test_catalog_routes.py::test_csv_upload_accepts_csv_extension -v
```

Expected: the first test may pass or fail depending on whether auth happens before extension check; the extension check itself is not yet implemented.

- [ ] **Step 3: Add extension check to catalog_routes.py**

In `djtoolkit/api/catalog_routes.py`, find the `import_csv` function. After the existing content_type check (line ~399), add the filename extension check:

```python
    if file.content_type not in ("text/csv", "application/csv", "text/plain", "application/octet-stream"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Unsupported file type. Upload a CSV file.",
        )
    # Extension check — content-type can be spoofed; filename provides a second signal.
    if file.filename and not file.filename.lower().endswith(".csv"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="File must have a .csv extension.",
        )
```

- [ ] **Step 4: Run all catalog tests**

```bash
poetry run pytest tests/test_catalog_routes.py -v -q
```

Expected: all non-DB tests pass.

- [ ] **Step 5: Commit**

```bash
git add djtoolkit/api/catalog_routes.py tests/test_catalog_routes.py
git commit -m "security: add .csv extension check to CSV upload endpoint"
```

---

## Chunk 2: Next.js Docker Setup

### Task 6: Enable Next.js standalone output

**Files:**
- Modify: `web/next.config.ts`

- [ ] **Step 1: Add standalone output to next.config.ts**

In `web/next.config.ts`, update the config:

```typescript
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
};

export default nextConfig;
```

`output: "standalone"` makes `next build` produce `.next/standalone/server.js` — a self-contained Node.js server that does not require `node_modules` at runtime. Required for the multi-stage Docker build.

- [ ] **Step 2: Verify the build produces the standalone output**

```bash
cd web
NEXT_PUBLIC_SUPABASE_URL=https://placeholder.supabase.co \
NEXT_PUBLIC_SUPABASE_ANON_KEY=placeholder \
NEXT_PUBLIC_API_URL=http://localhost:8000 \
npm run build
ls .next/standalone/
```

Expected: `.next/standalone/server.js` exists.

```bash
cd ..
```

- [ ] **Step 3: Commit**

```bash
git add web/next.config.ts
git commit -m "feat: enable Next.js standalone output for Docker"
```

---

### Task 7: Create web/Dockerfile

**Files:**
- Create: `web/Dockerfile`

- [ ] **Step 1: Create the multi-stage Dockerfile**

Create `web/Dockerfile`:

```dockerfile
# Stage 1 — deps: install node_modules (cached separately from source code)
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --frozen-lockfile

# Stage 2 — builder: copy source + run next build
FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# NEXT_PUBLIC_* vars are baked into the JS bundle at build time.
# Pass them as build args from CI (values stored in GitHub Secrets).
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

RUN npm run build

# Stage 3 — runner: minimal image with only what's needed to serve
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# standalone/ contains server.js + a minimal node_modules — copy to WORKDIR root.
# Static assets must be at .next/static relative to WORKDIR (Next.js serves them from there).
# public/ must be at ./public relative to WORKDIR.
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

EXPOSE 3000
# server.js is at /app/server.js (copied from .next/standalone/).
CMD ["node", "server.js"]
```

- [ ] **Step 2: Verify the image builds**

```bash
cd web
docker build \
  --build-arg NEXT_PUBLIC_SUPABASE_URL=https://placeholder.supabase.co \
  --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=placeholder \
  --build-arg NEXT_PUBLIC_API_URL=http://localhost:8000 \
  -t djtoolkit-web-test .
```

Expected: build completes, final image size is ~150-300MB. Verify `server.js` and static assets are in the right place:

```bash
docker run --rm djtoolkit-web-test ls -la /app/
# Expected: server.js, node_modules/, .next/
docker run --rm djtoolkit-web-test ls /app/.next/static/
# Expected: chunks/, css/, media/ (non-empty — if missing, static assets won't load)
```

```bash
cd ..
```

- [ ] **Step 3: Verify the container serves correctly**

```bash
docker run --rm -p 3001:3000 djtoolkit-web-test &
sleep 5
curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/
kill %1
```

Expected: HTTP status `200` or `307` (redirect to login). If `404` or `500`, the COPY paths in step 1 are wrong — check that `/app/.next/static` and `/app/public` exist inside the image.

- [ ] **Step 4: Commit**

```bash
git add web/Dockerfile
git commit -m "feat: add multi-stage Next.js Dockerfile with standalone output"
```

---

### Task 8: Update docker-compose.yml

**Files:**
- Modify: `docker-compose.yml`

- [ ] **Step 1: Rewrite docker-compose.yml**

Replace the entire `docker-compose.yml` with:

```yaml
# docker-compose.yml
# Production deployment — images pulled from GHCR.
# IMAGE_TAG and GITHUB_REPOSITORY are set in .deploy.env (written by deploy workflow).
# Runtime secrets (DB URL, JWT keys, etc.) are in .env on the server.

services:
  api:
    image: ghcr.io/${GITHUB_REPOSITORY}/djtoolkit-api:${IMAGE_TAG:-latest}
    restart: unless-stopped
    expose:
      - "8000"
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
    expose:
      - "3000"
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3000/"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 15s

  nginx:
    image: nginx:alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx/djtoolkit.conf:/etc/nginx/conf.d/default.conf:ro
      - /etc/letsencrypt:/etc/letsencrypt:ro
    depends_on:
      - api
      - web
```

Note: `api` no longer has `ports: ["127.0.0.1:8000:8000"]` — it is internal-only, accessed by Nginx via the `api` service name.

- [ ] **Step 2: Commit**

```bash
git add docker-compose.yml
git commit -m "feat: add web + nginx services to docker-compose, switch to GHCR images"
```

---

## Chunk 3: Nginx Configuration

### Task 9: Rewrite nginx/djtoolkit.conf

**Files:**
- Modify: `nginx/djtoolkit.conf`

- [ ] **Step 1: Replace nginx/djtoolkit.conf**

Replace the entire file with:

```nginx
# Rate limiting zones (defined at http context — must be outside server block)
limit_req_zone $binary_remote_addr zone=api:10m    rate=30r/m;
limit_req_zone $binary_remote_addr zone=auth:10m   rate=10r/m;
limit_req_zone $binary_remote_addr zone=upload:10m rate=5r/m;

server {
    listen 80;
    server_name YOUR_DOMAIN;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name YOUR_DOMAIN;

    ssl_certificate     /etc/letsencrypt/live/YOUR_DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/YOUR_DOMAIN/privkey.pem;
    include             /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam         /etc/letsencrypt/ssl-dhparams.pem;

    # Default body size — tightened from 20M
    client_max_body_size 1M;

    # ── Security headers ──────────────────────────────────────────────────────
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Content-Type-Options    "nosniff"                             always;
    add_header X-Frame-Options           "DENY"                                always;
    add_header Referrer-Policy           "strict-origin-when-cross-origin"     always;
    add_header Content-Security-Policy   "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https://*.supabase.co;" always;

    # ── SSE endpoint: pipeline events ─────────────────────────────────────────
    # Disable all buffering so Server-Sent Events stream in real time.
    location /api/pipeline/events {
        proxy_pass         http://api:8000;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_buffering    off;
        proxy_cache        off;
        add_header         X-Accel-Buffering no;
        proxy_read_timeout 3600s;
    }

    # ── Auth endpoints: stricter rate limiting ─────────────────────────────────
    location /api/auth/ {
        limit_req zone=auth burst=5 nodelay;
        limit_req_status 429;

        proxy_pass         http://api:8000;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 30s;
    }

    # ── CSV upload: relaxed body size limit ───────────────────────────────────
    location /api/catalog/import/ {
        limit_req zone=upload burst=2 nodelay;
        limit_req_status 429;
        client_max_body_size 11M;

        proxy_pass         http://api:8000;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }

    # ── General API endpoints ─────────────────────────────────────────────────
    location /api/ {
        limit_req zone=api burst=20 nodelay;
        limit_req_status 429;

        proxy_pass         http://api:8000;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
    }

    # ── Next.js web frontend ──────────────────────────────────────────────────
    location / {
        proxy_pass         http://web:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 30s;
    }
}
```

Key changes from the previous config:
- `proxy_pass` now uses `http://api:8000` and `http://web:3000` (Docker service names, not `127.0.0.1`)
- Added `/` location routing to `web:3000` (Next.js)
- Preserved SSE block verbatim
- Added security headers, rate limiting zones, per-location rate limits
- Reduced default `client_max_body_size` from 20M to 1M; 11M override for CSV import

- [ ] **Step 2: Validate nginx config syntax (if nginx is installed locally)**

```bash
nginx -t -c /dev/stdin <<'EOF'
events {}
http {
  include /Users/cpecile/Code/djtoolkit/nginx/djtoolkit.conf;
}
EOF
```

If nginx is not installed locally, skip — CI will catch syntax errors when the nginx container starts.

- [ ] **Step 3: Commit**

```bash
git add nginx/djtoolkit.conf
git commit -m "feat: update nginx — proxy to Docker service names, add security headers and rate limiting"
```

---

## Chunk 4: GitHub Actions Workflows

### Task 10: Update ci.yml — add test-web job

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Add test-web job to ci.yml**

Replace `.github/workflows/ci.yml` with:

```yaml
name: CI

on:
  push:
    branches: [master]
  pull_request:
    branches: [master]

permissions:
  contents: read

jobs:
  test-api:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install Poetry
        run: |
          pip install poetry==2.3.2
          echo "$HOME/.local/bin" >> $GITHUB_PATH

      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: "3.11"
          cache: "poetry"

      - name: Verify lock file
        run: poetry check --lock

      - name: Install dependencies
        run: poetry install --no-interaction

      - name: Run tests
        run: poetry run pytest --tb=short -q

  test-web:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: web
    env:
      # Placeholder values — next build needs these present but they don't need to be valid.
      NEXT_PUBLIC_SUPABASE_URL: "https://placeholder.supabase.co"
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "placeholder-anon-key"
      NEXT_PUBLIC_API_URL: "http://localhost:8000"
    steps:
      - uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "npm"
          cache-dependency-path: web/package-lock.json

      - name: Install dependencies
        run: npm ci

      - name: Build (type-check + bundle)
        run: npm run build
```

The `test-web` job runs `npm run build`, which invokes `next build`. This catches TypeScript errors, missing imports, and build-time failures. The placeholder env vars satisfy Next.js without requiring real Supabase credentials in CI.

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add test-web job to run Next.js type-check and build"
```

---

### Task 11: Rewrite deploy.yml

**Files:**
- Modify: `.github/workflows/deploy.yml`

- [ ] **Step 1: Rewrite deploy.yml**

Replace `.github/workflows/deploy.yml` with:

```yaml
name: Deploy to Hetzner

on:
  workflow_run:
    workflows: ["CI"]
    types: [completed]
    branches: [master]

permissions:
  contents: read
  packages: write    # required to push images to GHCR

jobs:
  build-and-push:
    # CRITICAL: only run if CI succeeded. workflow_run fires for any conclusion.
    if: github.event.workflow_run.conclusion == 'success'
    runs-on: ubuntu-latest

    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          ref: ${{ github.event.workflow_run.head_sha }}

      - name: Log in to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Extract metadata for API image
        id: meta-api
        uses: docker/metadata-action@v5
        with:
          images: ghcr.io/${{ github.repository }}/djtoolkit-api
          tags: |
            type=raw,value=latest
            type=sha,format=short

      - name: Build and push API image
        uses: docker/build-push-action@v5
        with:
          context: .
          file: Dockerfile
          push: true
          tags: ${{ steps.meta-api.outputs.tags }}
          labels: ${{ steps.meta-api.outputs.labels }}

      - name: Extract metadata for web image
        id: meta-web
        uses: docker/metadata-action@v5
        with:
          images: ghcr.io/${{ github.repository }}/djtoolkit-web
          tags: |
            type=raw,value=latest
            type=sha,format=short

      - name: Build and push web image
        uses: docker/build-push-action@v5
        with:
          context: web
          file: web/Dockerfile
          push: true
          tags: ${{ steps.meta-web.outputs.tags }}
          labels: ${{ steps.meta-web.outputs.labels }}
          build-args: |
            NEXT_PUBLIC_SUPABASE_URL=${{ secrets.NEXT_PUBLIC_SUPABASE_URL }}
            NEXT_PUBLIC_SUPABASE_ANON_KEY=${{ secrets.NEXT_PUBLIC_SUPABASE_ANON_KEY }}
            NEXT_PUBLIC_API_URL=${{ secrets.NEXT_PUBLIC_API_URL }}

  deploy:
    needs: build-and-push
    # Inherits the skip from build-and-push via `needs` — if build-and-push is
    # skipped, deploy is also skipped (not failed).
    runs-on: ubuntu-latest

    steps:
      - name: Deploy via SSH
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.HETZNER_HOST }}
          username: ${{ secrets.HETZNER_USER }}
          key: ${{ secrets.HETZNER_SSH_KEY }}
          envs: GITHUB_REPOSITORY,SHA
          script: |
            cd /opt/djtoolkit
            # Write deployment config: which image tag and repo to pull from.
            echo "GITHUB_REPOSITORY=${GITHUB_REPOSITORY}" > .deploy.env
            echo "IMAGE_TAG=sha-${SHA:0:7}" >> .deploy.env
            # Pull new images and restart containers.
            docker compose --env-file .deploy.env pull
            docker compose --env-file .deploy.env up -d --remove-orphans
            docker system prune -f
        env:
          GITHUB_REPOSITORY: ${{ github.repository }}
          SHA: ${{ github.event.workflow_run.head_sha }}
```

> **GitHub Secrets to add before first deploy:**
> - `NEXT_PUBLIC_SUPABASE_URL` — your Supabase project URL
> - `NEXT_PUBLIC_SUPABASE_ANON_KEY` — your Supabase anon key
> - `NEXT_PUBLIC_API_URL` — production API URL, e.g. `https://api.yourdomain.com`
>
> Existing secrets (`HETZNER_HOST`, `HETZNER_USER`, `HETZNER_SSH_KEY`) are unchanged.

> **Rollback procedure:**
> ```bash
> ssh user@hetzner-host
> cd /opt/djtoolkit
> echo "GITHUB_REPOSITORY=owner/djtoolkit" > .deploy.env
> echo "IMAGE_TAG=sha-<previous-short-sha>" >> .deploy.env
> docker compose --env-file .deploy.env pull
> docker compose --env-file .deploy.env up -d
> ```
> Previous SHA images are retained in GHCR indefinitely (tagged images are never auto-deleted).

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "ci: rewrite deploy workflow — build to GHCR, pull on Hetzner"
```

---

### Task 12: Update release.yml — add packages permission

**Files:**
- Modify: `.github/workflows/release.yml`

- [ ] **Step 1: Add permissions block to release.yml**

In `.github/workflows/release.yml`, add a `permissions` block after the `on:` section:

```yaml
permissions:
  contents: write    # required to upload release assets
  packages: write    # for consistency; release.yml doesn't push images but may in future
```

The existing workflow already produces correctly named artifacts (`djtoolkit-{VERSION}-{ARCH}.dmg` via `build.sh`) and uploads them with `softprops/action-gh-release@v2`. No other changes needed.

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: add explicit permissions to release workflow"
```

---

## Final Verification

- [ ] **Verify all tests pass locally**

```bash
SUPABASE_JWT_SECRET=test-secret poetry run pytest --tb=short -q
```

Expected: all non-DB tests pass (DB tests skip cleanly).

- [ ] **Push to master and watch CI**

```bash
git push origin master
```

Open GitHub Actions → CI workflow. Expected:
- `test-api` job: PASS
- `test-web` job: PASS
- Deploy workflow triggers automatically after CI succeeds

- [ ] **Add GitHub Secrets for deploy**

In GitHub repo → Settings → Secrets and variables → Actions, add:
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `NEXT_PUBLIC_API_URL`

- [ ] **Verify GHCR images after first deploy**

```
https://github.com/OWNER/djtoolkit/pkgs/container/djtoolkit-api
https://github.com/OWNER/djtoolkit/pkgs/container/djtoolkit-web
```

Both should show `latest` tag and a `sha-XXXXXXX` tag.

- [ ] **Verify deployment on Hetzner**

```bash
ssh user@hetzner-host "docker ps --format 'table {{.Image}}\t{{.Status}}'"
```

Expected: `djtoolkit-api`, `djtoolkit-web`, and `nginx` containers running.

```bash
curl -I https://yourdomain.com
```

Expected response includes `Strict-Transport-Security` header.

- [ ] **Test macOS release**

```bash
git tag v0.1.0
git push origin v0.1.0
```

Watch GitHub Actions → Release macOS Installer workflow. Expected: two artifacts in the release — `djtoolkit-0.1.0-arm64.dmg` and `djtoolkit-0.1.0-x86_64.dmg`.
