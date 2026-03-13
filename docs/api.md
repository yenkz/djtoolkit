# REST API & Web UI

djtoolkit includes a FastAPI backend and a single-page web dashboard for monitoring and controlling the pipeline without the CLI.

---

## Starting the server

```bash
make api    # starts at http://localhost:8000
```

The API is served at `/api/` and the dashboard at `/`.

---

## Endpoints

### Tracks

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/tracks` | List tracks (paginated). Optional `?acquisition_status=available&limit=100&offset=0` |
| `GET` | `/api/tracks/stats` | Track counts by acquisition status + processing flag totals |
| `GET` | `/api/tracks/{id}` | Get a single track by ID |

**`GET /api/tracks/stats` response:**
```json
{
  "by_acquisition_status": [
    {"acquisition_status": "available", "n": 412},
    {"acquisition_status": "candidate", "n": 88}
  ],
  "processing_flags": {
    "fingerprinted": 390,
    "enriched_spotify": 380,
    "enriched_audio": 200,
    "metadata_written": 375,
    "normalized": 0,
    "total": 500
  }
}
```

### Pipeline actions

All pipeline actions run in the background and stream progress to the log endpoint.

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/pipeline/download` | Start the Soulseek download pipeline |
| `POST` | `/api/pipeline/fingerprint` | Run Chromaprint fingerprinting |
| `POST` | `/api/pipeline/metadata` | Write metadata tags to files |
| `POST` | `/api/tracks/reset-failed` | Reset all `failed` tracks to `candidate` |

### Logs

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/logs?since=0` | Return in-memory log lines. `since` skips the first N entries (for polling). |

The log buffer holds the last 200 lines from all djtoolkit modules.

### Utilities

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/soulseek/health` | Check if Soulseek credentials are configured |
| `GET` | `/api/db/check` | Run SQLite integrity check |

**`GET /api/soulseek/health` response:**
```json
{"ok": true, "message": "Credentials configured"}
```

---

## Web UI

The web frontend is a Next.js app in `web/`, communicating with the FastAPI backend via REST API. See `web/` for details.

---

## Configuration

The API server reads `djtoolkit.toml` from the working directory where `make api` is run. To use a different config file, edit `_CONFIG_PATH` in `djtoolkit/api/routes.py` or set the path before starting.
