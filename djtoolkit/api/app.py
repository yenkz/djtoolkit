"""FastAPI app — serves REST API and static UI."""

from pathlib import Path
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from djtoolkit.api.routes import router

_UI_DIR = Path(__file__).parent.parent.parent / "ui"


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield


app = FastAPI(title="djtoolkit", version="0.1.0", lifespan=lifespan)

app.include_router(router, prefix="/api")

# Serve the single-page UI
if _UI_DIR.exists():
    app.mount("/static", StaticFiles(directory=_UI_DIR), name="static")

    @app.get("/", response_class=FileResponse)
    async def index():
        return FileResponse(_UI_DIR / "index.html")
