# djtoolkit/api

FastAPI backend serving the REST API.

---

## Files

| File | Description |
|---|---|
| `app.py` | FastAPI application factory — mounts API routers, CORS, lifespan |
| `routes.py` | All REST endpoint handlers |

---

## Architecture

```
FastAPI app (app.py)
  └── /api/*     → APIRouter (routes.py)
```

The app reads `djtoolkit.toml` from the current working directory on each request via `load_config()`. No global state is held between requests.

---

## Key design decisions

- **Background tasks** — pipeline operations (download, fingerprint, metadata) are dispatched as FastAPI `BackgroundTasks` so the HTTP response returns immediately
- **In-memory log buffer** — a `logging.Handler` captures all `djtoolkit.*` log output into a `deque(maxlen=200)`, exposed at `GET /api/logs`. The UI polls this endpoint to show live progress
- **Graceful error handling** — all routes that import pipeline modules are wrapped in `try/except` to always return valid JSON even if an optional dependency is not installed
- **No auth** — designed for local use only; do not expose externally

---

## Running locally

```bash
make api   # poetry run uvicorn djtoolkit.api.app:app --reload --port 8000
```

The `--reload` flag restarts the server on code changes during development.

---

## Adding a new endpoint

1. Add the route handler to `routes.py`
2. If it triggers a pipeline operation, use `background_tasks.add_task(_run_safe, fn, cfg, "name")`
3. If it reads/writes the DB, use `with connect(cfg.db_path) as conn:`
4. Document it in [docs/api.md](../../docs/api.md)

---

## See also

Full API reference: [docs/api.md](../../docs/api.md)
