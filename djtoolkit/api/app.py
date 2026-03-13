"""FastAPI app — serves REST API."""

from contextlib import asynccontextmanager

from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded

from djtoolkit.api.auth_routes import router as auth_router
from djtoolkit.api.catalog_routes import router as catalog_router
from djtoolkit.api.pipeline_routes import router as pipeline_router, _stale_job_sweeper
from djtoolkit.api.rate_limit import limiter
from djtoolkit.api.spotify_auth_routes import router as spotify_auth_router, _cleanup_expired_states
from djtoolkit.db.postgres import close_pool, get_pool



@asynccontextmanager
async def lifespan(app: FastAPI):
    import asyncio
    # Warm up the asyncpg pool on startup (if SUPABASE_DATABASE_URL is set).
    try:
        await get_pool()
    except RuntimeError:
        pass  # local-only mode without Supabase — pool stays None
    # Start stale job recovery background task
    sweeper = asyncio.create_task(_stale_job_sweeper())
    state_cleaner = asyncio.create_task(_cleanup_expired_states())
    yield
    sweeper.cancel()
    state_cleaner.cancel()
    await close_pool()


app = FastAPI(title="djtoolkit", version="0.1.0", lifespan=lifespan)

# ─── Rate limiting ───────────────────────────────────────────────────────────
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# Allow the Next.js dev server and any deployed UI origin.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",   # Next.js dev
        "http://localhost:5173",   # Vite dev (future)
        "https://djtoolkit.com",   # production UI (update when deployed)
    ],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["Content-Type", "Authorization"],
)

# SECURITY: Legacy routes.py (11 unauthenticated SQLite endpoints: /tracks,
# /pipeline/*, /logs, /soulseek/health, /db/check) removed from the cloud app.
# These were designed for local-only use with ui/index.html and must not be
# exposed on the public FastAPI server. The file is kept for local CLI usage
# (`make ui`) but is no longer mounted here.
app.include_router(auth_router, prefix="/api")
app.include_router(spotify_auth_router, prefix="/api")
app.include_router(catalog_router, prefix="/api")
app.include_router(pipeline_router, prefix="/api")


@app.get("/health")
async def health():
    return {"status": "ok"}
