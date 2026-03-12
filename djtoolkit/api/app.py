"""FastAPI app — serves REST API and static UI."""

from pathlib import Path
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from djtoolkit.api.routes import router
from djtoolkit.api.auth_routes import router as auth_router
from djtoolkit.db.postgres import close_pool, get_pool

_UI_DIR = Path(__file__).parent.parent.parent / "ui"


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Warm up the asyncpg pool on startup (if SUPABASE_DATABASE_URL is set).
    try:
        await get_pool()
    except RuntimeError:
        pass  # local-only mode without Supabase — pool stays None
    yield
    await close_pool()


app = FastAPI(title="djtoolkit", version="0.1.0", lifespan=lifespan)

# Allow the Next.js dev server and any deployed UI origin.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",   # Next.js dev
        "http://localhost:5173",   # Vite dev (future)
        "https://djtoolkit.com",   # production UI (update when deployed)
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router, prefix="/api")
app.include_router(auth_router, prefix="/api")

# Serve the single-page UI
if _UI_DIR.exists():
    app.mount("/static", StaticFiles(directory=_UI_DIR), name="static")

    @app.get("/", response_class=FileResponse)
    async def index():
        return FileResponse(_UI_DIR / "index.html")
