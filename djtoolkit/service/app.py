"""FastAPI application factory."""

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from djtoolkit.service.config import get_settings
from djtoolkit.service.routes.health import router as health_router
from djtoolkit.service.routes.import_collection import router as import_router
from djtoolkit.service.routes.export_collection import router as export_router

VERCEL_ORIGIN_REGEX = r"https://djtoolkit(-[a-z0-9]+)?-yenkzs-projects\.vercel\.app"


def create_app() -> FastAPI:
    settings = get_settings()

    app = FastAPI(
        title="djtoolkit API",
        version="0.1.0",
        docs_url="/docs",
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_origin_regex=VERCEL_ORIGIN_REGEX,
        allow_credentials=True,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
    )

    @app.exception_handler(Exception)
    async def unhandled_exception_handler(request: Request, exc: Exception):
        """Catch-all so unhandled errors still get CORS headers
        (CORSMiddleware wraps the response, but only if one is returned)."""
        return JSONResponse(
            status_code=500,
            content={"detail": f"Internal server error: {exc}"},
        )

    app.include_router(health_router)
    app.include_router(import_router)
    app.include_router(export_router)

    return app
