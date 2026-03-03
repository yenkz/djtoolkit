# djtoolkit/downloader

Downloads tracks from Soulseek via the [slskd](https://github.com/slskd/slskd) REST API.

---

## Files

| File | Description |
|---|---|
| `slskd.py` | slskd REST client, search/score/download loop, transfer polling |

---

## How it works

```
candidate tracks → search slskd → score results → enqueue best match → poll until complete
```

1. **Search** — `POST /api/v0/searches` with the track's `search_string`
2. **Poll search** — `GET /api/v0/searches/{id}` until `isComplete: true`
3. **Score results** — fuzzy-match each result's title+artist against expected metadata using `thefuzz`; filter by `duration_tolerance_ms` and `min_score`
4. **Download** — `POST /api/v0/transfers/downloads/{username}/{filename}` for the best match
5. **Poll transfer** — `GET /api/v0/transfers/downloads` until `state: Completed` or `state: Errored`

---

## Public API

```python
from djtoolkit.downloader.slskd import run, poll_downloads, health_check

# Full download pipeline (search + download + poll)
stats = run(cfg)
# stats = {"attempted": 50, "downloaded": 42, "failed": 8}

# Only check status of in-flight transfers (without starting new searches)
poll_downloads(cfg)

# Check if slskd is reachable and connected to Soulseek
ok, message = health_check(cfg)
```

---

## Configuration

All slskd settings live under `[slskd]` in `djtoolkit.toml`:

```toml
[slskd]
host              = "http://localhost:5030"
api_key           = ""           # set via SLSKD_API_KEY env var
search_timeout_ms = 90000
response_limit    = 100

[matching]
min_score          = 0.86
min_score_title    = 0.78
duration_tolerance_ms = 2000
```

---

## Important implementation notes

- `slskd_api` is **lazy-imported** inside `_make_client()` — never at module level. This prevents import errors from crashing the FastAPI server if the package is missing.
- Search responses are fetched from `/searches/{id}/responses` (a separate endpoint), not inline in the search state object.
- The health check uses `requests` directly on `/api/v0/application` and checks `server.state == "Connected"`.
- The `url_base` config value must **not** include `/api/v0` — the `slskd_api` package appends it internally.

---

## Prerequisites

- Docker Desktop running
- slskd container up: `make slskd-up`
- Logged in to Soulseek via the slskd web UI at `http://localhost:5030`
