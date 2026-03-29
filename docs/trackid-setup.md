# Track Identification Setup Guide

## Overview

djtoolkit identifies tracks in DJ mixes (YouTube, SoundCloud) using **Shazam audio fingerprinting**. The analysis runs on the Hetzner FastAPI service (`api.djtoolkit.net`).

**How it works:**
1. User submits a YouTube/SoundCloud URL from the web UI or CLI
2. Hetzner service downloads the audio via `yt-dlp` (through a SOCKS5 proxy for YouTube)
3. Audio is sampled at 45-second intervals
4. Each 10-second sample is sent to Shazam for identification
5. Results are deduplicated and returned to the web UI

A typical 1-hour mix takes ~5 minutes to analyze (~75 Shazam calls at 2.5s intervals).

---

## Architecture

```
Web UI (Vercel)
  ↓ POST /api/catalog/import/trackid
  ↓ (creates job in trackid_import_jobs, forwards to Hetzner)
Hetzner FastAPI (api.djtoolkit.net)
  ↓ Background task:
  ↓   1. yt-dlp downloads audio (via NordVPN SOCKS5 proxy)
  ↓   2. pydub extracts 10s samples every 45s
  ↓   3. shazamio identifies each sample
  ↓   4. Deduplicate by artist+title
  ↓   5. Write results to Supabase (trackid_import_jobs)
  ↓
Web UI polls trackid_import_jobs status → displays results
```

---

## Server Requirements

### Hetzner Server

- **OS**: Ubuntu (Debian-based)
- **RAM**: 4GB minimum (streaming audio processing keeps memory under 500MB)
- **Docker + Docker Compose**
- **Deno**: Installed in the Docker image for yt-dlp's YouTube signature solving

### Docker Services

| Service | Image | Purpose |
|---------|-------|---------|
| `api` | `ghcr.io/yenkz/djtoolkit/djtoolkit-api` | FastAPI service with yt-dlp, shazamio, pydub |

### Key Dependencies (in Docker image)

- `yt-dlp` — downloads audio from YouTube/SoundCloud
- `shazamio` — async Shazam client for track identification
- `pydub` — audio segmentation
- `ffmpeg` — audio format conversion
- `deno` — JavaScript runtime for yt-dlp's YouTube signature solving

---

## YouTube Proxy Setup (NordVPN)

YouTube blocks downloads from server/datacenter IPs. A SOCKS5 proxy through NordVPN routes traffic through residential IPs.

### 1. Get NordVPN Service Credentials

1. Log in to [NordVPN dashboard](https://my.nordvpn.com/)
2. Go to **Services** → **NordVPN**
3. Find **Service credentials** (username and password)
4. These are NOT your account login — they're separate credentials for proxy/manual connections

### 2. NordVPN SOCKS5 Server

Use the `nordhold.net` SOCKS5 servers (NOT `nordvpn.com`):

| Server | Location |
|--------|----------|
| `amsterdam.nl.socks.nordhold.net:1080` | Netherlands |
| `nl.socks.nordhold.net:1080` | Netherlands |
| `stockholm.se.socks.nordhold.net:1080` | Sweden |
| `us.socks.nordhold.net:1080` | United States |
| `dallas.us.socks.nordhold.net:1080` | Dallas, US |

### 3. Configure on Server

Add the proxy URL to `.env.service` on the Hetzner server:

```bash
ssh root@<SERVER_IP> "echo 'YTDLP_PROXY=socks5://USERNAME:PASSWORD@amsterdam.nl.socks.nordhold.net:1080' >> /opt/djtoolkit/.env.service"
```

Then restart the container:

```bash
ssh root@<SERVER_IP> "cd /opt/djtoolkit && docker compose up -d --force-recreate api"
```

### 4. Verify

```bash
# Test proxy connectivity
docker compose exec api curl -x socks5://USER:PASS@amsterdam.nl.socks.nordhold.net:1080 -s -o /dev/null -w '%{http_code}' --connect-timeout 10 https://www.youtube.com
# Should return: 200

# Test yt-dlp download
docker compose exec api yt-dlp -f bestaudio -x --audio-format mp3 --proxy 'socks5://USER:PASS@amsterdam.nl.socks.nordhold.net:1080' -o '/tmp/test.%(ext)s' 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
```

---

## Deployment

### CI/CD (`.github/workflows/deploy-api.yml`)

On push to `master` (when `djtoolkit/**`, `Dockerfile`, `docker-compose.yml`, or `pyproject.toml` change):

1. Runs tests
2. Builds Docker image and pushes to GHCR
3. Copies `docker-compose.yml` to Hetzner via SCP
4. SSHs into Hetzner and runs `docker compose pull && docker compose up -d`

### Manual Deployment

```bash
# From local machine
cd ~/Code/djtoolkit

# Copy compose file (if CI didn't update it)
scp docker-compose.yml root@<SERVER_IP>:/opt/djtoolkit/

# Restart with latest image
ssh root@<SERVER_IP> "cd /opt/djtoolkit && docker compose pull && docker compose up -d --remove-orphans"
```

---

## Environment Variables

### `.env.service` on Hetzner (`/opt/djtoolkit/.env.service`)

| Variable | Required | Description |
|----------|----------|-------------|
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Supabase service role key |
| `CORS_ORIGINS` | No | Allowed CORS origins (defaults include djtoolkit.net) |
| `YTDLP_PROXY` | Yes (for YouTube) | Primary SOCKS5 proxy URL (e.g., `socks5://user:pass@stockholm.se.socks.nordhold.net:1080`) |
| `YTDLP_PROXY_CREDS` | Recommended | NordVPN service credentials as `user:pass` — enables automatic fallback to other NordVPN servers if primary fails |

---

## Supported URL Formats

### YouTube
- `https://www.youtube.com/watch?v=VIDEO_ID`
- `https://youtu.be/VIDEO_ID`
- `https://youtube.com/embed/VIDEO_ID`

### SoundCloud
- `https://soundcloud.com/artist/set-name`
- SoundCloud does NOT require a proxy (no bot detection)

---

## Troubleshooting

### "Sign in to confirm you're not a bot"

YouTube is blocking the server IP. Check:
1. `YTDLP_PROXY` is set in `.env.service`
2. Container has the env var: `docker compose exec api env | grep YTDLP`
3. Proxy is reachable: `docker compose exec api curl -x socks5://... https://www.youtube.com`
4. If proxy times out, try a different NordVPN SOCKS5 server

### "Requested format is not available"

yt-dlp can't find audio formats. Usually means the JS runtime (deno) isn't working:
1. Check: `docker compose exec api deno --version`
2. Check: `docker compose exec api yt-dlp --verbose --skip-download 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' 2>&1 | grep "JS runtimes"`
3. Should show `JS runtimes: deno-X.X.X`

### OOM (Out of Memory) on 4GB server

The analyzer uses streaming/sampling to stay under 500MB. If OOM occurs:
1. Check: `dmesg | grep -i 'oom\|killed' | tail -5`
2. The audio file is loaded by pydub (AudioSegment) — for very long mixes (3+ hours), this could still be an issue
3. Consider upgrading the server to 8GB

### 0 tracks identified

1. Check the logs: `docker compose logs --tail 50 api`
2. Verify audio was downloaded (look for "Downloaded audio: ... MB")
3. Verify sample points were generated (look for "Generated N sample points")
4. If Shazam returns no matches, the mix might contain unreleased/unidentifiable tracks

### Progress not showing in web UI

The Hetzner service writes progress to `trackid_import_jobs` table. The web UI polls this table via `/api/catalog/import/trackid/[jobId]/status`. If progress isn't updating:
1. Check the job status directly: query `trackid_import_jobs` in Supabase
2. The background task might have crashed — check `docker compose logs api`

---

## Key Files

| File | Purpose |
|------|---------|
| `djtoolkit/service/analyzer.py` | Core analysis engine (download → sample → identify → dedup) |
| `djtoolkit/service/routes/trackid.py` | FastAPI endpoint `POST /trackid/analyze` |
| `djtoolkit/service/app.py` | FastAPI app factory (registers trackid router) |
| `djtoolkit/importers/trackid.py` | Python CLI importer (calls Hetzner service) |
| `web/app/api/catalog/import/trackid/route.ts` | Next.js POST route (forwards to Hetzner) |
| `web/app/api/catalog/import/trackid/[jobId]/status/route.ts` | Next.js status polling (reads from Supabase) |
| `Dockerfile` | Docker image with ffmpeg, deno, yt-dlp |
| `docker-compose.yml` | Service definition |

---

## Analysis Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| Sample interval | 45 seconds | Time between Shazam samples |
| Sample duration | 10 seconds | Length of each audio clip sent to Shazam |
| Skip intro | 30 seconds | Skip the first 30s (often intro/jingle) |
| Cooldown | 2.5 seconds | Delay between Shazam requests (rate limiting) |
| Confidence threshold | 0.7 | Minimum confidence to include a track (configurable in Settings UI) |
